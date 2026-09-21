/**
 * MindNet —— 认知模型引擎 v1.1
 * 扩散引擎 + 知识贡献 KC（对应设计文档 §5 / §6 / §7 / §8）
 *
 * 每轮顺序严格按 §5.2：
 *   1 设置 AL → 2 计算影响力 → 3 汇总取最大入边 → 4 更新未激活目标节点
 *   → 5 永久亮着 → 6 目标检查 → 7 冷却检查 → 8 最大轮次检查
 *
 * 永久亮着：已激活（CONSCIOUS / SUBCONSCIOUS）的节点不再被入边修改，但继续作为源节点向外传播。
 */
(function () {
  'use strict';

  const isNode = typeof module !== 'undefined' && !!module.exports;
  const deps = isNode
    ? Object.assign({}, require('./config.js'), require('./model.js'), require('./memory.js'))
    : (globalThis.MindNet || {});
  const { Config, MindNetError, STATE, Graph, update_global_memory, update_memory } = deps;

  const STOP = Object.freeze({
    ALL_TARGETS_REACHED: 'all_targets_reached',
    COOLING: 'cooling',
    MAX_ROUNDS: 'max_rounds',
  });

  /** 输出时保留 6 位小数，避免 0.21000000000000002 这类浮点噪声；内部计算不做舍入 */
  function round6(x) {
    return Math.round(x * 1e6) / 1e6;
  }

  class CognitiveModel {
    /**
     * @param {Graph} graph
     * @param {Config|object} [config]
     */
    constructor(graph, config) {
      if (!(graph instanceof Graph)) {
        throw new MindNetError('CognitiveModel 需要传入 Graph 实例');
      }
      this.graph = graph;
      this.config = config instanceof Config ? config : new Config(config);
      this.memory_report = null;
      this._reset_runtime();
      this._running = false;
    }

    // ---------------------------------------------------------------- 记忆

    /** §7.2 全局记忆更新 */
    update_global_memory(current_real_time) {
      this.memory_report = update_global_memory(this.graph, this.config, current_real_time);
      return this.memory_report;
    }

    /** §7.8 复习更新：review_type = "focused"（本版） / "process"（未实现） */
    update_memory(node_id, options) {
      return update_memory(this.graph, node_id, options);
    }

    // ------------------------------------------------------------ 生命周期

    /**
     * §7.3 开始扩散。每次调用重置运行时状态，visit_count 跨扩散累计保留（§10.1）。
     * @param {string[]} [initial_nodes] 起点，可多个
     * @param {string[]} [target_nodes] 目标，可多个
     */
    start_diffusion(initial_nodes, target_nodes) {
      const initial = initial_nodes === undefined || initial_nodes === null ? [] : initial_nodes;
      const targets = target_nodes === undefined || target_nodes === null ? [] : target_nodes;
      if (!Array.isArray(initial)) throw new MindNetError('initial_nodes 必须是数组');
      if (!Array.isArray(targets)) throw new MindNetError('target_nodes 必须是数组');
      this._require_nodes(initial, '起点');
      this._require_nodes(targets, '目标节点');

      this._reset_runtime();
      for (const node of this.graph.nodes.values()) node.reset_runtime();

      this._max_rounds = this.config.max_rounds;
      this._running = true;
      this._stopped = false;
      this._stop_reason = null;
      this._targets_all_reached = false;
      this._finalized = false;

      for (const id of initial) {
        if (this._starts.has(id)) continue;
        const node = this.graph.get_node(id);
        node.state = STATE.CONSCIOUS;
        node.al = this.config.state_coeff_conscious;
        this._starts.add(id);
        this._start_order.push(id);
      }
      for (const id of targets) {
        if (this._target_set.has(id)) continue;
        this._targets.push(id);
        this._target_set.add(id);
        if (this._starts.has(id)) this._target_steps.set(id, 0);
      }

      // 冷却判定的基线：起点已点亮之后的状态（第 1 轮的「上一轮结束状态」）
      this._prev_snapshot = this._snapshot();

      if (this._targets.length > 0 && this._all_targets_active()) {
        this._stop(STOP.ALL_TARGETS_REACHED, true);
      }
      return this;
    }

    /**
     * §7.4 追加初始节点：下一轮生效；已激活的跳过；已停止的扩散不能再追加。
     * @returns {{queued: string[], skipped: string[]}}
     */
    add_initial_nodes(ids) {
      if (!Array.isArray(ids)) throw new MindNetError('add_initial_nodes 需要传入数组');
      if (!this._running) throw new MindNetError('尚未调用 start_diffusion()，无法追加起点');
      if (this._stopped) {
        throw new MindNetError(
          `扩散已停止（${this._stop_reason}），无法追加起点；如需继续请重新调用 start_diffusion()`
        );
      }
      this._require_nodes(ids, '追加起点');
      const queued = [];
      const skipped = [];
      for (const id of ids) {
        if (this._starts.has(id) || this._pending_starts.includes(id)) {
          skipped.push(id);
          continue;
        }
        const node = this.graph.get_node(id);
        if (node.is_active()) {
          skipped.push(id);
          continue;
        }
        this._pending_starts.push(id);
        queued.push(id);
      }
      return { queued, skipped };
    }

    /** §7.5 单步执行一轮 */
    step() {
      if (!this._running) throw new MindNetError('尚未调用 start_diffusion()');
      if (this._stopped) return this._status([]);

      this._rounds += 1;
      const activated = [];

      // 0. 追加起点在下一轮开始时生效
      if (this._pending_starts.length > 0) {
        const pending = this._pending_starts;
        this._pending_starts = [];
        for (const id of pending) {
          const node = this.graph.get_node(id);
          if (node.is_active()) continue; // 期间已被传播激活 → 跳过
          node.state = STATE.CONSCIOUS;
          node.al = this.config.state_coeff_conscious;
          this._starts.add(id);
          this._start_order.push(id);
          activated.push({ id, state: STATE.CONSCIOUS, impact: null, reason: 'added_start' });
        }
      }

      // 1. 设置 AL
      for (const node of this.graph.nodes.values()) node.al = this._al_of(node);

      // 2. 计算影响力 / 3. 汇总入边取最大值
      const incoming_max = new Map();
      for (const source of this.graph.nodes.values()) {
        if (source.state === STATE.INACTIVE) continue;
        const coefficient = source.ms * source.al; // MS_from × AL_from
        for (const edge of this.graph.out_edges(source.id)) {
          const impact = coefficient * edge.ls;
          const current = incoming_max.get(edge.to);
          if (current === undefined || impact > current) incoming_max.set(edge.to, impact);
        }
      }

      // 4. 更新仍未激活的目标节点（已激活的跳过，且不改任何属性）
      for (const node of this.graph.nodes.values()) {
        if (!incoming_max.has(node.id)) continue;
        if (node.is_active()) continue;
        const impact = incoming_max.get(node.id);
        const ct = node.ct_of(this.config);
        const st = node.st_of(this.config);
        if (impact >= ct) {
          node.state = STATE.CONSCIOUS;
          this._record_activation(node.id, impact);
          activated.push({ id: node.id, state: STATE.CONSCIOUS, impact: round6(impact), reason: 'threshold' });
        } else if (impact >= st) {
          node.state = STATE.SUBCONSCIOUS;
          this._record_activation(node.id, impact);
          activated.push({ id: node.id, state: STATE.SUBCONSCIOUS, impact: round6(impact), reason: 'threshold' });
        } else if (impact > 0) {
          this._attempted.add(node.id); // 本次扩散中被尝试激活过（扩散结束后 visit_count +1）
        }
      }

      // 4b. 让 al 与新的 state 保持一致（§3.1「al 由状态推导」）。
      //     这只影响报告值：下一轮的步骤 1 会按 state 重算 al，影响力计算不受影响。
      for (const node of this.graph.nodes.values()) {
        const expected = this._al_of(node);
        if (node.al !== expected) node.al = expected;
      }

      // 5. 永久亮着：上面已跳过激活节点，其 state/al/visit_count 不被入边修改；
      //    下一轮它们仍作为源节点参与传播（步骤 2 只看 state != INACTIVE）。

      // 6. 目标检查
      if (this._targets.length > 0 && this._all_targets_active()) {
        this._stop(STOP.ALL_TARGETS_REACHED, true);
        return this._status(activated);
      }

      // 7. 冷却检查：连续 stable_rounds 轮所有节点状态完全无变化
      const snapshot = this._snapshot();
      if (snapshot === this._prev_snapshot) this._stable_count += 1;
      else this._stable_count = 0;
      this._prev_snapshot = snapshot;
      if (this._stable_count >= this.config.stable_rounds) {
        this._stop(STOP.COOLING, false);
        return this._status(activated);
      }

      // 8. 最大轮次检查
      if (this._rounds >= this._max_rounds) {
        this._stop(STOP.MAX_ROUNDS, this._targets.length > 0 && this._all_targets_active());
        return this._status(activated);
      }

      return this._status(activated);
    }

    /** §7.6 运行至停止 */
    run_until_stop(max_rounds) {
      if (!this._running) throw new MindNetError('尚未调用 start_diffusion()');
      if (max_rounds !== undefined && max_rounds !== null) {
        if (typeof max_rounds !== 'number' || max_rounds <= 0) {
          throw new MindNetError('max_rounds 必须是正数');
        }
        this._max_rounds = max_rounds;
      }
      let guard = 0;
      while (!this._stopped) {
        this.step();
        guard += 1;
        if (guard > 1e6) throw new MindNetError('扩散轮次异常（超过 1000000 轮），已中断');
      }
      return this.result();
    }

    // -------------------------------------------------------------- 结果

    /** §6 KC：Gap 与 Penalty 分别保存，不合并 */
    get_kc() {
      let gap = 0;
      let penalty = 0;
      for (const node of this.graph.nodes.values()) {
        if (this._starts.has(node.id)) continue; // 起点不参与 KC
        if (node.state !== STATE.INACTIVE) {
          const impact = this._first_impact.has(node.id) ? this._first_impact.get(node.id) : 0.0;
          gap += node.weight * Math.max(0, this.config.gap_constant * node.ct_of(this.config) - impact);
        } else if (node.visit_count > 0) {
          penalty += node.weight * Math.sqrt(node.visit_count);
        }
      }
      return { gap: round6(gap), penalty: round6(penalty) };
    }

    /** 所有节点的最终状态 */
    final_states() {
      const out = {};
      for (const node of this.graph.nodes.values()) out[node.id] = node.state;
      return out;
    }

    /** 目标节点首次达到非 INACTIVE 的更新轮次（未激活目标不出现） */
    target_steps() {
      const out = {};
      for (const id of this._targets) {
        if (this._target_steps.has(id)) out[id] = this._target_steps.get(id);
      }
      return out;
    }

    /**
     * KC 的逐节点明细。只做展开，不改变 get_kc() 的算法；
     * 可视化壳用它列出「发展区缺口」与「死角区」各自来自哪些节点。
     */
    kc_breakdown() {
      const gap = [];
      const penalty = [];
      for (const node of this.graph.nodes.values()) {
        if (this._starts.has(node.id)) continue;
        if (node.state !== STATE.INACTIVE) {
          const impact = this._first_impact.has(node.id) ? this._first_impact.get(node.id) : 0.0;
          const ct = node.ct_of(this.config);
          const contribution = node.weight * Math.max(0, this.config.gap_constant * ct - impact);
          gap.push({
            id: node.id,
            name: node.name,
            state: node.state,
            weight: node.weight,
            ct,
            impact: round6(impact),
            contribution: round6(contribution),
          });
        } else if (node.visit_count > 0) {
          penalty.push({
            id: node.id,
            name: node.name,
            weight: node.weight,
            visit_count: node.visit_count,
            contribution: round6(node.weight * Math.sqrt(node.visit_count)),
          });
        }
      }
      gap.sort((a, b) => b.contribution - a.contribution);
      penalty.sort((a, b) => b.contribution - a.contribution);
      return { gap, penalty };
    }

    /** §8.2 输出协议（四个字段） */
    result() {
      return {
        kc: this.get_kc(),
        target_steps: this.target_steps(),
        targets_all_reached: this._targets_all_reached,
        final_states: this.final_states(),
      };
    }

    /** §7.9 导出状态；传入路径时写文件（仅 Node） */
    export_state(path) {
      const state = Object.assign({}, this.result(), {
        rounds: this._rounds,
        stop_reason: this._stop_reason,
        nodes: (() => {
          const out = {};
          for (const node of this.graph.nodes.values()) out[node.id] = node.to_object(this.config);
          return out;
        })(),
        config: this.config.to_object(),
      });
      if (typeof path === 'string' && path !== '') {
        if (typeof require !== 'function') {
          throw new MindNetError('浏览器环境不支持写文件，请改为使用返回值');
        }
        require('fs').writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
      }
      return state;
    }

    // ---------------------------------------------------------- 只读视图

    get rounds() {
      return this._rounds;
    }

    get stop_reason() {
      return this._stop_reason;
    }

    get running() {
      return this._running;
    }

    get stopped() {
      return this._stopped;
    }

    get targets_all_reached() {
      return this._targets_all_reached;
    }

    get starts() {
      return this._start_order.slice();
    }

    get targets() {
      return this._targets.slice();
    }

    get attempted_this_diffusion() {
      return Array.from(this._attempted);
    }

    // ------------------------------------------------------------ 内部

    _reset_runtime() {
      this._rounds = 0;
      this._starts = new Set();
      this._start_order = [];
      this._targets = [];
      this._target_set = new Set();
      this._target_steps = new Map();
      this._first_impact = new Map();
      this._pending_starts = [];
      this._attempted = new Set();
      this._prev_snapshot = null;
      this._stable_count = 0;
      this._stopped = false;
      this._stop_reason = null;
      this._targets_all_reached = false;
      this._finalized = false;
      this._max_rounds = this.config ? this.config.max_rounds : 100;
    }

    _al_of(node) {
      if (node.state === STATE.CONSCIOUS) return this.config.state_coeff_conscious;
      if (node.state === STATE.SUBCONSCIOUS) return this.config.state_coeff_subconscious;
      return this.config.state_coeff_inactive;
    }

    _record_activation(id, impact) {
      this._first_impact.set(id, impact);
      if (this._target_set.has(id) && !this._target_steps.has(id)) {
        this._target_steps.set(id, this._rounds);
      }
    }

    _all_targets_active() {
      for (const id of this._targets) {
        const node = this.graph.get_node(id);
        if (!node || node.state === STATE.INACTIVE) return false;
      }
      return true;
    }

    /** 状态快照（只含 state，用于冷却判定） */
    _snapshot() {
      const ids = this.graph.node_ids().slice().sort();
      return ids.map((id) => `${id}:${this.graph.get_node(id).state}`).join('|');
    }

    _status(activated) {
      return {
        round: this._rounds,
        activated: activated || [],
        stable_rounds_seen: this._stable_count,
        stopped: this._stopped,
        stop_reason: this._stop_reason,
      };
    }

    _stop(reason, targets_all_reached) {
      this._stopped = true;
      this._stop_reason = reason;
      this._targets_all_reached = !!targets_all_reached;
      this._finalize();
    }

    /** §5.3 扩散结束后统一更新 visit_count：非起点、最终仍 INACTIVE、且被尝试激活过，最多 +1 */
    _finalize() {
      if (this._finalized) return;
      this._finalized = true;
      for (const id of this._attempted) {
        if (this._starts.has(id)) continue;
        const node = this.graph.get_node(id);
        if (!node || node.state !== STATE.INACTIVE) continue;
        node.visit_count += 1;
      }
    }

    _require_nodes(ids, label) {
      const missing = [];
      for (const id of ids) {
        if (typeof id !== 'string' || !this.graph.has_node(id)) missing.push(String(id));
      }
      if (missing.length > 0) {
        throw new MindNetError(`${label}不存在于图中：${missing.join(', ')}`);
      }
    }
  }

  const api = { CognitiveModel, STOP, round6 };

  if (isNode) {
    module.exports = api;
  } else {
    globalThis.MindNet = Object.assign(globalThis.MindNet || {}, api);
  }
})();
