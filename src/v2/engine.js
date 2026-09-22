/**
 * MindNet v2 快层引擎（v1.3）
 *
 * 它是一根「时间轴 + 管线」，不含任何具体动力学：
 *   每轮按槽位顺序推进，把共享状态（node.m.core.a / .q）交给模块去算。
 *   没有模块时退化为「静态场」：激活不变、按硬阈值点火、无容量限制。
 *
 * 管线（与 docs/MODEL_v2_MATH.md §4 对应）：
 *   round.before → [tick.before → tick.gate] × 节拍长度 → drive.compute
 *   → activation.update → attention.select → ignite.check → state.after → round.after
 *
 * 输出与 v1.1 的 §8.2 协议保持一致（kc / target_steps / targets_all_reached / final_states）。
 */
(function () {
  'use strict';

  const isNode = typeof module !== 'undefined' && !!module.exports;
  const deps = isNode
    ? Object.assign({}, require('../config.js'), require('../model.js'), require('../core/kernel.js'))
    : (globalThis.MindNet || {});
  const { Config, MindNetError, STATE, MechanismKernel } = deps;

  const STOP = Object.freeze({
    ALL_TARGETS_REACHED: 'all_targets_reached',
    COOLING: 'cooling',
    MAX_ROUNDS: 'max_rounds',
  });

  function clamp01(x) {
    const v = Number(x);
    if (!Number.isFinite(v)) return 0;
    return v < 0 ? 0 : v > 1 ? 1 : v;
  }

  function round6(x) {
    return Math.round((Number(x) || 0) * 1e6) / 1e6;
  }

  class FastEngine {
    /**
     * @param {object} graph Graph 实例
     * @param {object} [config] Config 实例
     * @param {object} [options] { kernel, seed, hours, overrides, mechanisms }
     */
    constructor(graph, config, options) {
      const opts = options || {};
      if (!graph || typeof graph.get_node !== 'function') {
        throw new MindNetError('FastEngine 需要传入 Graph 实例');
      }
      this.graph = graph;
      this.config = config instanceof Config ? config : new Config(config);
      this.kernel = opts.kernel || new MechanismKernel(graph, this.config, opts);
      this._resetRuntime();
      this._running = false;
    }

    /** 共享快状态（激活 a / 亚阈 q） */
    core(nodeId) {
      return this.kernel.shared(nodeId);
    }

    // ------------------------------------------------------------ 生命周期

    start_diffusion(initial_nodes, target_nodes) {
      const initial = initial_nodes === undefined || initial_nodes === null ? [] : initial_nodes;
      const targets = target_nodes === undefined || target_nodes === null ? [] : target_nodes;
      if (!Array.isArray(initial)) throw new MindNetError('initial_nodes 必须是数组');
      if (!Array.isArray(targets)) throw new MindNetError('target_nodes 必须是数组');
      this._requireNodes(initial, '起点');
      this._requireNodes(targets, '目标节点');

      this._resetRuntime();
      for (const node of this.graph.nodes.values()) {
        node.reset_runtime();
        const c = this.core(node.id);
        c.a = 0;
        c.q = 0;
      }
      this._max_rounds = this.config.max_rounds;
      this._running = true;
      this._stopped = false;
      this._stop_reason = null;
      this._targets_all_reached = false;

      for (const id of initial) {
        if (this._starts.has(id)) continue;
        this._starts.add(id);
        this._start_order.push(id);
        const c = this.core(id);
        c.a = 1; // 注意焦点：被维持在意识里的东西
        this.graph.get_node(id).state = STATE.CONSCIOUS;
        this.graph.get_node(id).al = 1;
      }
      for (const id of targets) {
        if (this._target_set.has(id)) continue;
        this._targets.push(id);
        this._target_set.add(id);
        if (this._starts.has(id)) this._target_steps.set(id, 0);
      }
      this._prev_snapshot = this._snapshot();
      if (this._targets.length > 0 && this._all_targets_active()) {
        this._stop(STOP.ALL_TARGETS_REACHED, true);
      }
      return this;
    }

    add_initial_nodes(ids) {
      if (!Array.isArray(ids)) throw new MindNetError('add_initial_nodes 需要传入数组');
      if (!this._running) throw new MindNetError('尚未调用 start_diffusion()，无法追加起点');
      if (this._stopped) {
        throw new MindNetError(`扩散已停止（${this._stop_reason}），无法追加起点；请重新 start_diffusion()`);
      }
      this._requireNodes(ids, '追加起点');
      const queued = [];
      const skipped = [];
      for (const id of ids) {
        if (this._starts.has(id) || this._pending_starts.includes(id)) {
          skipped.push(id);
          continue;
        }
        this._pending_starts.push(id);
        queued.push(id);
      }
      return { queued, skipped };
    }

    // ------------------------------------------------------------------ 每轮

    step() {
      if (!this._running) throw new MindNetError('尚未调用 start_diffusion()');
      if (this._stopped) return this._status([]);

      this._rounds += 1;
      const nodes = Array.from(this.graph.nodes.values());
      const activated = [];

      // 0) 追加起点在下一轮开始时生效
      if (this._pending_starts.length > 0) {
        const pending = this._pending_starts;
        this._pending_starts = [];
        for (const id of pending) {
          this._starts.add(id);
          this._start_order.push(id);
          const c = this.core(id);
          c.a = 1;
          activated.push({ id, state: STATE.CONSCIOUS, drive: null, reason: 'added_start' });
        }
      }

      const payload = {
        round: this._rounds,
        tick: this.kernel.tick,
        hours: this.kernel.hours,
        starts: this._start_order.slice(),
        targets: this._targets.slice(),
        cycleTicks: 1,
        availability: 1,
        drive: null,
        scores: null,
        next: null,
        admitted: null,
        focus: null,
        conscious: null,
        subconscious: null,
        notes: [],
      };

      // 1) 轮前：节拍长度、预算、目标/上下文
      this.kernel.run('round.before', payload);
      const cycle = Math.max(1, Math.round(payload.cycleTicks || 1));
      payload.cycleTicks = cycle;

      // 2) tick 循环：节律门控决定这一轮有多少时间是「在」的
      let openTicks = 0;
      for (let i = 0; i < cycle; i += 1) {
        this.kernel.tick += 1;
        const tickPayload = {
          round: this._rounds,
          tick: this.kernel.tick,
          hours: this.kernel.hours,
          cycle,
          index: i,
        };
        this.kernel.run('tick.before', tickPayload);
        const gate = this.kernel.run('tick.gate', tickPayload);
        if (!gate.blocked) openTicks += 1;
      }
      payload.availability = openTicks / cycle;
      payload.openTicks = openTicks;

      // 3) 驱动：入边求和 + 亚阈累积（模块可改写 payload.drive）
      payload.drive = this._rawDrive();
      this.kernel.run('drive.compute', payload);

      // 4) 激活更新（模块写 payload.next；没模块就不变）
      this.kernel.run('activation.update', payload);
      if (payload.next) this._applyActivation(payload.next);
      // 4b) 注意焦点由注意力「按住」：起点每轮被重新拉满 ——
      //     这就是「把问题按在脑子里」的机制表达（也是 v1.1「起点永久亮着」的 v2 版本）。
      for (const id of this._start_order) this.core(id).a = 1;

      // 5) 竞争得分与容量准入
      payload.scores = this._scores();
      payload.candidates = this._candidates(payload.scores);
      this.kernel.run('attention.select', payload);
      const admitted = payload.admitted
        ? new Set(payload.admitted)
        : new Set(payload.candidates.map((c) => c.id));

      // 6) 点火（先给默认，再让模块覆盖）
      const fallback = this._defaultIgnition(admitted, payload.scores);
      payload.conscious = fallback.conscious;
      payload.subconscious = fallback.subconscious;
      this.kernel.run('ignite.check', payload);
      const conscious = new Set(payload.conscious || []);
      const subconscious = new Set(payload.subconscious || []);
      // 注意焦点永远在意识里（这是「把问题按在脑子里」的机制表达）
      for (const id of this._start_order) conscious.add(id);

      // 7) 落状态（先只落状态；al 在 state.after 之后再同步，
      //    这样模块可以在 state.after 里调整激活，al 始终反映本轮最终的激活值）
      for (const node of nodes) {
        const before = node.state;
        if (conscious.has(node.id)) node.state = STATE.CONSCIOUS;
        else if (subconscious.has(node.id)) node.state = STATE.SUBCONSCIOUS;
        else node.state = STATE.INACTIVE;
        if (node.state !== STATE.INACTIVE) {
          this._recordActivation(node.id, payload.drive ? payload.drive.get(node.id) : 0);
          if (before === STATE.INACTIVE) {
            activated.push({
              id: node.id,
              state: node.state,
              drive: round6(payload.drive ? payload.drive.get(node.id) || 0 : 0),
              reason: 'ignite',
            });
          }
        } else if ((payload.drive ? payload.drive.get(node.id) || 0 : 0) > 0) {
          this._attempted.add(node.id);
        }
      }

      this.kernel.run('state.after', payload);
      for (const node of nodes) node.al = clamp01(this.core(node.id).a);
      this.kernel.run('round.after', payload);

      // 8) 停止判定（顺序与 v1.1 一致：目标 → 冷却 → 最大轮次）
      if (this._targets.length > 0 && this._all_targets_active()) {
        this._stop(STOP.ALL_TARGETS_REACHED, true);
        return this._status(activated);
      }
      const snapshot = this._snapshot();
      if (snapshot === this._prev_snapshot) this._quiet += 1;
      else this._quiet = 0;
      this._prev_snapshot = snapshot;
      if (this._quiet >= this.config.stable_rounds) {
        this._stop(STOP.COOLING, false);
        return this._status(activated);
      }
      if (this._rounds >= this._max_rounds) {
        this._stop(STOP.MAX_ROUNDS, this._targets.length > 0 && this._all_targets_active());
        return this._status(activated);
      }
      return this._status(activated);
    }

    run_until_stop(max_rounds) {
      if (!this._running) throw new MindNetError('尚未调用 start_diffusion()');
      if (max_rounds !== undefined && max_rounds !== null) {
        if (typeof max_rounds !== 'number' || max_rounds <= 0) throw new MindNetError('max_rounds 必须是正数');
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

    // -------------------------------------------------------------- 内部

    _rawDrive() {
      const drive = new Map();
      for (const node of this.graph.nodes.values()) drive.set(node.id, 0);
      for (const u of this.graph.nodes.values()) {
        const au = this.core(u.id).a;
        if (!(au > 0)) continue;
        const strength = typeof u.ms === 'number' ? u.ms : 0;
        if (!(strength > 0)) continue;
        for (const e of this.graph.out_edges(u.id)) {
          drive.set(e.to, (drive.get(e.to) || 0) + au * strength * e.ls);
        }
      }
      for (const node of this.graph.nodes.values()) {
        const q = this.core(node.id).q || 0;
        if (q > 0) drive.set(node.id, (drive.get(node.id) || 0) + q);
      }
      return drive;
    }

    _scores() {
      const scores = new Map();
      for (const node of this.graph.nodes.values()) scores.set(node.id, this.core(node.id).a);
      return scores;
    }

    _candidates(scores) {
      return Array.from(scores.entries())
        .map(([id, score]) => ({ id, score }))
        .sort((a, b) => (b.score - a.score) || (a.id < b.id ? -1 : 1));
    }

    _applyActivation(next) {
      const read = (id) => (next instanceof Map ? next.get(id) : next[id]);
      for (const node of this.graph.nodes.values()) {
        const v = read(node.id);
        if (v === undefined) continue;
        this.core(node.id).a = clamp01(v);
      }
    }

    _defaultIgnition(admitted, scores) {
      const conscious = [];
      const subconscious = [];
      for (const id of admitted) {
        const node = this.graph.get_node(id);
        if (!node) continue;
        const score = scores.get(id) || 0;
        if (score >= node.ct_of(this.config)) conscious.push(id);
        else if (score >= node.st_of(this.config)) subconscious.push(id);
      }
      return { conscious, subconscious };
    }

    _recordActivation(id, drive) {
      if (!this._everActivated.has(id)) this._everActivated.add(id);
      const d = Number(drive) || 0;
      const prev = this._peakDrive.get(id);
      if (prev === undefined || d > prev) this._peakDrive.set(id, d);
      if (this._target_set.has(id) && !this._target_steps.has(id)) {
        this._target_steps.set(id, this._rounds);
      }
    }

    _all_targets_active() {
      for (const id of this._targets) {
        if (!this._everActivated.has(id)) return false;
      }
      return true;
    }

    _snapshot() {
      const ids = this.graph.node_ids().slice().sort();
      return ids.map((id) => `${id}:${this.graph.get_node(id).state}`).join('|');
    }

    _requireNodes(ids, label) {
      const missing = [];
      for (const id of ids) {
        if (typeof id !== 'string' || !this.graph.has_node(id)) missing.push(String(id));
      }
      if (missing.length > 0) throw new MindNetError(`${label}不存在于图中：${missing.join(', ')}`);
    }

    _resetRuntime() {
      this._rounds = 0;
      this._starts = new Set();
      this._start_order = [];
      this._targets = [];
      this._target_set = new Set();
      this._target_steps = new Map();
      this._everActivated = new Set();
      this._peakDrive = new Map();
      this._attempted = new Set();
      this._pending_starts = [];
      this._prev_snapshot = null;
      this._quiet = 0;
      this._stopped = false;
      this._stop_reason = null;
      this._targets_all_reached = false;
      this._max_rounds = this.config ? this.config.max_rounds : 100;
    }

    _stop(reason, targetsAllReached) {
      this._stopped = true;
      this._stop_reason = reason;
      this._targets_all_reached = !!targetsAllReached;
    }

    _status(activated) {
      return {
        round: this._rounds,
        activated: activated || [],
        availability: 1,
        stopped: this._stopped,
        stop_reason: this._stop_reason,
      };
    }

    // -------------------------------------------------------------- 结果

    /**
     * 死角惩罚：优先取记忆模块（时间衰减的失败证据），
     * 没有记忆模块时退化为 v1.1 口径（本次扩散尝试过、始终未激活 → 计数 1）。
     */
    _penalty() {
      const diag = this.kernel.diagnose();
      for (const d of diag) {
        if (d.out && d.out.memory && typeof d.out.memory.penalty === 'number') {
          return d.out.memory.penalty;
        }
      }
      let penalty = 0;
      for (const id of this._attempted) {
        if (this._starts.has(id) || this._everActivated.has(id)) continue;
        const node = this.graph.get_node(id);
        penalty += node.weight * Math.sqrt(1);
      }
      return round6(penalty);
    }

    get_kc() {
      let gap = 0;
      for (const node of this.graph.nodes.values()) {
        if (this._starts.has(node.id)) continue;
        if (!this._everActivated.has(node.id)) continue;
        const impact = this._peakDrive.get(node.id) || 0;
        gap += node.weight * Math.max(0, this.config.gap_constant * node.ct_of(this.config) - impact);
      }
      return { gap: round6(gap), penalty: round6(this._penalty()) };
    }

    final_states() {
      const out = {};
      for (const node of this.graph.nodes.values()) out[node.id] = node.state;
      return out;
    }

    target_steps() {
      const out = {};
      for (const id of this._targets) if (this._target_steps.has(id)) out[id] = this._target_steps.get(id);
      return out;
    }

    result() {
      return {
        kc: this.get_kc(),
        target_steps: this.target_steps(),
        targets_all_reached: this._targets_all_reached,
        final_states: this.final_states(),
      };
    }

    /** 扩展状态（协议四字段 + 运行时 + 机制清单 + 机制自己的存档） */
    state() {
      const nodes = {};
      for (const node of this.graph.nodes.values()) {
        const c = this.core(node.id);
        nodes[node.id] = Object.assign(node.to_object(this.config), {
          a: round6(c.a),
          q: round6(c.q),
          ever_activated: this._everActivated.has(node.id),
          peak_drive: round6(this._peakDrive.get(node.id) || 0),
        });
      }
      return Object.assign({}, this.result(), {
        rounds: this._rounds,
        stop_reason: this._stop_reason,
        availability_last: 1,
        nodes,
        mechanisms: this.kernel.enabledIds(),
        mechanism_state: this.kernel.serialize(),
        warnings: this.kernel.warnings.slice(),
      });
    }

    export_state(path) {
      const s = this.state();
      if (typeof path === 'string' && path !== '') {
        if (typeof require !== 'function') throw new MindNetError('浏览器环境不支持写文件');
        require('fs').writeFileSync(path, `${JSON.stringify(s, null, 2)}\n`, 'utf8');
      }
      return s;
    }

    // ---------------------------------------------------------- 只读视图

    get rounds() { return this._rounds; }
    get stop_reason() { return this._stop_reason; }
    get running() { return this._running; }
    get stopped() { return this._stopped; }
    get targets_all_reached() { return this._targets_all_reached; }
    get starts() { return this._start_order.slice(); }
    get targets() { return this._targets.slice(); }
    get ever_activated() { return Array.from(this._everActivated); }
    get attempted_this_diffusion() { return Array.from(this._attempted); }
    activation_of(nodeId) { return this.core(nodeId).a; }
    subthreshold_of(nodeId) { return this.core(nodeId).q; }
  }

  const api = { FastEngine, STOP_FAST: STOP };

  if (isNode) {
    module.exports = api;
  } else {
    globalThis.MindNet = Object.assign(globalThis.MindNet || {}, api);
  }
})();
