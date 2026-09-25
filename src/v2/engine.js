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
  const { Config, MindNetError, STATE, MechanismKernel, Node, Edge } = deps;

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
      // 记住装配参数，供克隆（反事实模拟）复用
      this._options = {
        seed: opts.seed === undefined ? 11 : opts.seed,
        hours: opts.hours === undefined ? 0 : opts.hours,
        profile: opts.profile,
        mechanisms: opts.mechanisms,
        overrides: opts.overrides || {},
      };
      this._lastRound = null;
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
      // 峰值驱动要覆盖**所有**节点（不只是亮过的）：诊断需要知道
      // "这个节点到底收到了多少输入"，否则"线索太弱"会被记成 0%。
      for (const node of nodes) {
        const d = payload.drive ? payload.drive.get(node.id) || 0 : 0;
        const prev = this._peakDrive.get(node.id);
        if (prev === undefined || d > prev) this._peakDrive.set(node.id, d);
      }
      this.kernel.run('round.after', payload);
      this._lastRound = payload; // 供诊断读取「本轮为什么没亮」

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
      if (!this._firstActivation.has(id)) this._firstActivation.set(id, this._rounds);
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
      this._firstActivation = new Map();
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
      const diag = this.kernel.diagnose(this._diagnosePayload());
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
        availability_last: this._lastRound ? this._lastRound.availability : 1,
        nodes,
        // 起点/目标也带走：否则"导出 → 再导入"会丢掉这次是在验哪条路径
        initial_nodes: this._start_order.slice(),
        target_nodes: this._targets.slice(),
        mechanisms: this.kernel.enabledIds(),
        mechanism_state: this.kernel.serialize(),
        control: this.control_report(),
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

    // ------------------------------------------------------ 诊断 / 反事实

    /**
     * 诊断事实表：把「为什么这个节点没亮」摊平成可判定的字段，
     * 控制层模块（卡点分类、元认知、处方）都从这里读，不需要访问引擎内部。
     */
    diagnostic_facts() {
      const last = this._lastRound || {};
      const facts = {};
      for (const node of this.graph.nodes.values()) {
        const c = this.core(node.id);
        const mem = (node.m && node.m.memory_dsr) || null;
        facts[node.id] = {
          id: node.id,
          name: node.name,
          state: node.state,
          a: round6(c.a),
          q: round6(c.q),
          drive: round6(last.drive ? last.drive.get(node.id) || 0 : 0),
          score: round6(last.scores ? last.scores.get(node.id) || 0 : 0),
          peak_drive: round6(this._peakDrive.get(node.id) || 0),
          ct: node.ct_of(this.config),
          st: node.st_of(this.config),
          in_degree: this.graph.in_edges(node.id).length,
          out_degree: this.graph.out_edges(node.id).length,
          ever_activated: this._everActivated.has(node.id),
          first_activation_round: this._firstActivation.has(node.id) ? this._firstActivation.get(node.id) : null,
          activated_at_round: this._target_steps.has(node.id) ? this._target_steps.get(node.id) : null,
          outcompeted: Array.isArray(last.outcompeted) ? last.outcompeted.indexOf(node.id) >= 0 : false,
          is_target: this._target_set.has(node.id),
          is_start: this._starts.has(node.id),
          R: typeof node.ms === 'number' ? round6(node.ms) : 0,
          R0: mem ? round6(mem.R0) : null,
          S: mem ? round6(mem.S) : null,
          D: mem ? round6(mem.D) : null,
          F: mem ? round6(mem.F) : 0,
        };
      }
      return facts;
    }

    _diagnosePayload() {
      return {
        round: this._rounds,
        hours: this.kernel.hours,
        starts: this._start_order.slice(),
        targets: this._targets.slice(),
        facts: this.diagnostic_facts(),
        stopped: this._stopped,
        stop_reason: this._stop_reason,
        engine: this, // 反事实规划器需要克隆引擎；这是给规划器的受控入口
      };
    }

    /** 控制层报告：诊断 + 元认知 + 处方清单（由模块产出，引擎只汇总） */
    control_report() {
      const results = this.kernel.diagnose(this._diagnosePayload());
      const report = { facts: this.diagnostic_facts(), metacognition: null, diagnosis: [], plan: [], warnings: [] };
      report.baseline_reachability = this.reachability();
      for (const r of results) {
        const o = r.out || {};
        if (o.metacognition) report.metacognition = o.metacognition;
        if (Array.isArray(o.bottlenecks)) report.diagnosis = o.bottlenecks;
        if (Array.isArray(o.plan)) report.plan = o.plan;
        if (o.memory) report.memory = o.memory;
      }
      report.warnings = this.kernel.warnings.slice();
      return report;
    }

    /**
     * 克隆：用于反事实模拟（"如果现在做 X，3 轮后目标可达性提高多少"）。
     * 复制图、记忆状态、快状态与运行时计数；用同一 seed 重建内核，保证可比性。
     */
    clone() {
      const g = new (this.graph.constructor)();
      for (const n of this.graph.nodes.values()) {
        const copy = new Node({
          id: n.id, name: n.name, type: n.type, weight: n.weight, ms: n.ms,
          ct: n.ct, st: n.st, last_review_time: n.last_review_time,
          visit_count: n.visit_count, stm: n.stm,
        });
        copy.state = n.state;
        copy.al = n.al;
        copy.m = JSON.parse(JSON.stringify(n.m || {}));
        g.add_node(copy);
      }
      for (const e of this.graph.edges) {
        g.add_edge(new Edge({ id: e.id, from: e.from, to: e.to, ls: e.ls }));
      }
      const opts = Object.assign({}, this._options, {
        hours: this.kernel.hours,
        overrides: Object.assign({}, this._options.overrides), // 必须是独立副本
      });
      const kernel = new MechanismKernel(g, this.config, opts);
      const registry = isNode ? require('../../mechanisms/index.js') : null;
      if (registry) {
        const loaded = registry.loadMechanisms();
        const ids = this._options.mechanisms || registry.PROFILES[this._options.profile || 'v2'];
        kernel.load(registry.pickMechanisms(loaded, ids));
      }
      kernel.tick = this.kernel.tick;
      const copyEngine = new FastEngine(g, this.config, Object.assign({}, opts, { kernel }));
      copyEngine.start_diffusion(this._start_order.slice(), this._targets.slice());
      // 复刻运行时状态（start_diffusion 会重置节点，所以要在它之后再恢复）
      copyEngine._rounds = this._rounds;
      copyEngine._everActivated = new Set(this._everActivated);
      copyEngine._firstActivation = new Map(this._firstActivation);
      copyEngine._peakDrive = new Map(this._peakDrive);
      copyEngine._attempted = new Set(this._attempted);
      copyEngine._target_steps = new Map(this._target_steps);
      copyEngine._prev_snapshot = this._prev_snapshot;
      copyEngine._quiet = this._quiet;
      copyEngine._stopped = false;
      copyEngine._stop_reason = null;
      copyEngine._targets_all_reached = this._targets_all_reached;
      for (const n of this.graph.nodes.values()) {
        const c = copyEngine.graph.get_node(n.id);
        c.state = n.state;
        c.al = n.al;
        copyEngine.core(n.id).a = this.core(n.id).a;
        copyEngine.core(n.id).q = this.core(n.id).q;
      }
      return copyEngine;
    }

    /** 目标可达性标量：反事实比较用的统一指标 */
    reachability(targets) {
      const list = targets || this._targets;
      let score = 0;
      for (const id of list) {
        const node = this.graph.get_node(id);
        if (!node) continue;
        score += this.core(id).a;
        if (this._everActivated.has(id)) score += 0.5;
      }
      return round6(score);
    }

    // ------------------------------------------- 与 v1.1 同名的兼容接口
    // 可视化壳与 CLI 直接调用这几个名字；v2 用同一套语义实现，便于两种引擎切换对比。

    /** 复习更新（v1.1 叫 update_memory）：review_type='focused' 映射为一次成功提取 */
    update_memory(nodeId, options) {
      const opts = options || {};
      if (opts.review_type === 'focused') {
        return this.kernel.review(nodeId, {
          type: 'retrieval_success', grade: 3, current_real_time: opts.current_real_time,
        });
      }
      if (opts.review_type === 'process') {
        throw new MindNetError('过程访问复习在 v1.1 与 v2 都未实现（设计文档 §4.4）');
      }
      if (opts.type) return this.kernel.review(nodeId, opts);
      throw new MindNetError(`未知的 review_type "${opts.review_type}"（可用：focused / process，或直接给 type）`);
    }

    /** 全局记忆更新：把现实时间推到 u，模块据此同步可提取度 */
    update_global_memory(current_real_time) {
      const before = this.kernel.hours;
      this.kernel.setHours(current_real_time);
      const facts = this.diagnostic_facts();
      const updated = Object.keys(facts).map((id) => ({
        id,
        ms_before: null,
        ms_after: facts[id].R,
        elapsed_hours: current_real_time - before,
      }));
      return { current_real_time, updated, filled_missing: [] };
    }

    /** 逐节点 KC 明细（与 v1.1 的 kc_breakdown 同形，供壳直接渲染） */
    kc_breakdown() {
      const facts = this.diagnostic_facts();
      const gap = [];
      const penalty = [];
      for (const node of this.graph.nodes.values()) {
        if (this._starts.has(node.id)) continue;
        const f = facts[node.id];
        if (!f) continue;
        if (f.ever_activated) {
          const contribution = node.weight * Math.max(0, this.config.gap_constant * f.ct - f.peak_drive);
          gap.push({
            id: node.id,
            name: node.name,
            state: f.state,
            weight: node.weight,
            ct: f.ct,
            impact: round6(f.peak_drive),
            contribution: round6(contribution),
          });
        } else if (f.F > 0) {
          const contribution = node.weight * Math.sqrt(f.F);
          penalty.push({
            id: node.id,
            name: node.name,
            weight: node.weight,
            visit_count: Math.round(f.F),
            contribution: round6(contribution),
          });
        }
      }
      gap.sort((a, b) => b.contribution - a.contribution);
      penalty.sort((a, b) => b.contribution - a.contribution);
      return { gap, penalty };
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
