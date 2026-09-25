/**
 * MindNet 反馈：拿到"某道题隔了 t 小时答对/答错"之后，**体检模型准不准**
 *
 * ⚠ 分工（2026-09 定案，见 docs/IO_PROTOCOL.md §6）：
 *   每条线索的 `S` 只由**机制**（mechanisms/memory.dsr.js）改 —— 那是模型的物理，
 *   懂难度、懂储蓄效应、懂三种复习类型的差别。
 *   本模块**不写任何节点的 S**，它做两件事：
 *     1. 用一条独立的估计律持续累计"模型预测 vs 你的实际表现"，给出偏差读数
 *        （compareWithGraph：机制算的 S 与账本估的 S 差多少、往哪个方向差）；
 *     2. 把攒够的证据换成**参数**建议（suggestOverrides：新知识的初始强度 k 等）。
 *   为什么不让本模块直接改 S：同一个事件被两条规则记账，数字会互相抵消或翻倍，
 *   状态就不可复算了；而且单条线索的 S 靠对错最多只能定到 ±70%（100 条）/ ±30%（400 条，
 *   见下面的 Fisher 信息推导），拿这么吵的估计去覆盖物理公式是拿噪声换模型。
 *
 * 与标定的区别：
 *   标定 = 一次性的先验（用文献默认值就够，个人差异靠这一步修）
 *   反馈 = 日常持续的证据流（每做一道题一条），它才是真正把你和模型对齐的东西
 *
 * 估计律（与 docs/MODEL_v2_MATH.md 同源，不另造模型）：
 *   p  = R0 · Ψ(t/S)                 ← 模型预测这次能想起来的概率
 *   e  = y − p                       ← y=1 答对、y=0 答错；这就是"预测误差"
 *   u  = 4p(1−p)                     ← 信息量权重：p≈0.5 时最有信息，p≈0/1 时几乎为零
 *   S' = S · exp(α · e · u)          ← 按误差方向走，步长由信息量决定
 *   附带：D' = clip(D − d·e·u·?, 1, 10)（答错且模型原本有把握 ⇒ 难度上调）
 *
 * 为什么是「误差」而不是「答对就加分」：
 *   如果写成"答对 S 就乘 1.15、答错就除 1.15"，那么只要目标留存低于 100%（比如 85%），
 *   答对的次数永远多于答错，S 会**单调漂移**、永远不收敛。
 *   用 e = y − p 时，E[e] = 0 恰好等价于"模型校准" —— 于是平衡点就是你的真实记忆强度。
 *   这一点在 test/feedback.test.js 里有专门的收敛测试与无偏测试。
 *
 * 一条必须写下来的事实（决定了这个模块该怎么用）：
 *   一道题只有"对/错"两种结果，它对 S 的信息量是可以算出来的（Fisher 信息）：
 *   I = (∂p/∂log S)² / (p(1−p))，在 t ≈ 3.9·S（那时 p ≈ 0.7）取到最大值 I ≈ 0.0359。
 *   于是 n 道题之后 log S 的标准误 ≈ 1/√(n·I)：
 *     50 道 → ±110%，200 道 → ±45%，400 道 → ±30%，900 道 → ±19%（probe 见 docs/FEEDBACK.md）。
 *   ⇒ 反馈是"慢变量"：它调的是**量级**（这条线索比我以为的结实/脆弱几倍），不是小数点。
 *   ⇒ 也正因为如此，标定页不需要让你精确测 S，用文献默认值起步、让反馈慢慢拧就行。
 *
 * 增益递减（Robbins–Monro）：
 *   固定增益下估计值会永远在真值附近抖动（稳态误差 ~±60%），既不收敛也不好看。
 *   让增益随证据条数衰减 gain_k = max(α_min, α/(1+k/K))，
 *   于是"前几条快速靠近、之后越来越稳"，同时又留了一个地板，
 *   保证你本人真的变强/变弱时它还跟得上（不会变成一块化石）。
 *
 * 另外三条护栏：
 *   1. 单步位移硬上限 ±40%，一条脏数据毁不掉估计；
 *   2. 每次更新都记在案，可回放、可复现（同事件序列 ⇒ 同结果）；
 *   3. 起点是"标定/文献默认值"，所以它只做微调，不做从零重学。
 */
(function () {
  'use strict';

  const isNode = typeof module !== 'undefined' && !!module.exports;
  const deps = isNode
    ? Object.assign({}, require('./config.js'), require('../mechanisms/memory.dsr.js'))
    : (globalThis.MindNet || {});
  const { MindNetError } = deps;
  const memoryDsr = deps.memoryDsr || (isNode ? require('../mechanisms/memory.dsr.js') : null);

  const DEFAULTS = Object.freeze({
    alpha: 0.35,        // 起始步长（log 空间）
    alpha_min: 0.05,    // 步长地板：留一点"跟得上你的变化"的余量
    gain_tau: 20,       // 步长衰减尺度：第 K 条证据时步长减半
    d_feedback: 0.15,   // 难度调整尺度
    max_step: 0.4,      // 单步最大相对位移（±40%）
    S_min: 0.1,
    S_max: 100000,
    decay_model: 'power',   // 与 memory.dsr 同一条曲线，反馈才对得上排程
  });

  function clamp(x, lo, hi) {
    const v = Number(x);
    if (!Number.isFinite(v)) return lo;
    return v < lo ? lo : v > hi ? hi : v;
  }

  function round(x, n) {
    const f = Math.pow(10, n === undefined ? 6 : n);
    return Math.round((Number(x) || 0) * f) / f;
  }

  /**
   * 模型预测的可提取度：R = R0·Ψ(t/S)。
   *
   * 必须复用 memory.dsr 自己的 psi 与它自己的默认参数：
   * 之前这里手写 `psi(z, {decay_model:'power'})`，漏掉了 gamma，
   * 于是 `curveC(undefined)` = NaN，clamp 又把 NaN 静默变成 0 ——
   * 结果 p 恒为 0、u 恒为 0、S 一步都不动（测试里表现为"记了反馈却没反应"）。
   * 所以这里显式检查有限性，宁可报错也不静默给 0。
   */
  function predictedRetrievability(S, R0, tHours, opts) {
    const o = Object.assign({}, DEFAULTS, opts || {});
    const r0 = clamp(R0 === undefined ? 0.8 : R0, 0, 1);
    const s = Math.max(0.01, Number(S) || 0);
    const z = Math.max(0, Number(tHours) || 0) / s;
    if (!memoryDsr || typeof memoryDsr.psi !== 'function') {
      // 浏览器里 memory.dsr 没加载时的退化：指数近似（口径一致，只是形状更粗）
      return clamp(r0 * Math.exp(-z), 0, 1);
    }
    // 把完整参数交给 memory.dsr 自己的 options()：这样曲线参数（gamma / decay_model）
    // 只有一个来源，也允许调用方显式覆盖；缺参数会在这里变成 NaN 并被下面的检查抓住。
    const mo = typeof memoryDsr.options === 'function' ? memoryDsr.options(o) : o;
    const psi = memoryDsr.psi(z, mo);
    if (!Number.isFinite(psi)) {
      throw new MindNetError(`遗忘曲线参数不完整：Ψ(${round(z, 4)}) 不是有限数（检查 memory.dsr 的 gamma / decay_model）`);
    }
    return clamp(r0 * psi, 0, 1);
  }

  /**
   * 单条证据的**账本估计**更新（纯函数）。
   *
   * 注意它更新的是"账本里的估计值"，**不是图里的 S** —— 这个估计值只用于体检与参数建议
   * （见文件头的分工说明）。名字保留是为了不破坏既有调用方。
   * @param {object} p { S, R0, tHours, correct, count?, options? }
   *        count = 这个节点此前已经收过几条证据（用来算递减增益）
   * @returns {object} { S, delta_ratio, R_at_test, weight, error, gain, D_delta }
   */
  function updateStability(p) {
    const o = Object.assign({}, DEFAULTS, p.options || {});
    const S0 = clamp(p.S, o.S_min, o.S_max);
    const R = predictedRetrievability(S0, p.R0 === undefined ? 0.8 : p.R0, p.tHours, o);
    const u = 4 * R * (1 - R);                     // ∈ [0,1]：信息量权重
    const y = p.correct ? 1 : 0;
    const e = y - R;                               // ∈ [−1,1]：预测误差（无漂移的关键）
    const gain = gainAt(p.count, o);
    const raw = Math.exp(gain * e * u);
    const bounded = clamp(raw, 1 - o.max_step, 1 + o.max_step);
    const S1 = clamp(S0 * bounded, o.S_min, o.S_max);
    return {
      S: round(S1, 4),
      delta_ratio: round(S1 / S0, 4),
      R_at_test: round(R, 4),
      weight: round(u, 4),
      error: round(e, 4),
      gain: round(gain, 4),
      // 答错且原本有把握 ⇒ 难度上调；答对且原本没把握 ⇒ 难度略下调
      D_delta: round(-o.d_feedback * e * u * 2, 4),
    };
  }

  /** 递减增益：前几条走得快，之后越来越稳，但保留地板值 */
  function gainAt(count, options) {
    const o = Object.assign({}, DEFAULTS, options || {});
    const k = Math.max(0, Number(count) || 0);
    return Math.max(o.alpha_min, o.alpha / (1 + k / o.gain_tau));
  }

  /**
   * 一道题最多能提供多少信息（Fisher 信息的上确界，与更新律无关）。
   * 推导：p = R0·(1+c·x)^(−γ)、x = t/S ⇒ ∂p/∂log S = p·γ·u/(1+u)、u = c·x
   *       I(x) = (∂p/∂log S)²/(p(1−p))，在 x ≈ 3.88（p ≈ 0.7）取到最大 ≈ 0.0359。
   * 用途：给用户一个"还差多少题"的诚实刻度，而不是假装反馈能精确定值。
   */
  const FISHER_I_BEST = 0.0359;

  /** n 条证据之后 log S 的标准误下界（最好情况，实际只会更差） */
  function seLogSBest(count) {
    const n = Math.max(0, Number(count) || 0);
    if (n <= 0) return Infinity;
    return 1 / Math.sqrt(n * FISHER_I_BEST);
  }

  /** 把标准误翻译成人话：±x% */
  function seAsPercent(count) {
    const se = seLogSBest(count);
    if (!Number.isFinite(se)) return null;
    return round((Math.exp(se) - 1) * 100, 1);
  }

  /** 一个节点的反馈账本 */
  class FeedbackLog {
    constructor(options) {
      const o = options || {};
      this.alpha = o.alpha === undefined ? DEFAULTS.alpha : o.alpha;
      this.nodes = {};   // id → { R0, S, D, count, correct, lastAt, origin }
      this.events = [];
      this.version = 1;
    }

    /**
     * 从一个图/引擎记忆状态里取初值（称为"起点"）。
     * 之后所有反馈都在这个起点上累加，因此可以随时回放重算。
     */
    harvest(graph) {
      let n = 0;
      for (const node of graph.nodes.values()) {
        const bag = node.m && node.m.memory_dsr;
        const R0 = bag ? bag.R0 : (typeof node.ms === 'number' ? node.ms : 0.8);
        const S = bag ? bag.S : 24 * R0;
        this.nodes[node.id] = {
          R0: round(R0, 4),
          S: round(S, 4),
          D: bag ? bag.D : 5.1618,
          count: 0,
          correct: 0,
          lastAt: null,
          origin: { R0: round(R0, 4), S: round(S, 4), D: bag ? bag.D : 5.1618 },
        };
        n += 1;
      }
      return n;
    }

    /** 记一条结果：{ node, tHours, correct, at } */
    record(event) {
      const id = event.node;
      if (typeof id !== 'string' || !id) throw new MindNetError('反馈事件必须带 node');
      if (typeof event.correct !== 'boolean') throw new MindNetError('反馈事件必须带 correct（true/false）');
      const tHours = Number(event.tHours);
      if (!Number.isFinite(tHours) || tHours < 0) throw new MindNetError('反馈事件必须带非负的 tHours');
      let ledger = this.nodes[id];
      if (!ledger) {
        ledger = { R0: 0.8, S: 19.2, D: 5.1618, count: 0, correct: 0, lastAt: null, origin: { R0: 0.8, S: 19.2, D: 5.1618 } };
        this.nodes[id] = ledger;
      }
      const upd = updateStability({
        S: ledger.S, R0: ledger.R0, tHours, correct: event.correct,
        count: ledger.count, options: { alpha: this.alpha },
      });
      ledger.S = upd.S;
      ledger.D = clamp(ledger.D + upd.D_delta, 1, 10);
      ledger.count += 1;
      if (event.correct) ledger.correct += 1;
      ledger.lastAt = event.at === undefined ? null : event.at;
      const record = Object.assign({ node: id, tHours, correct: event.correct, at: event.at === undefined ? null : event.at }, upd);
      this.events.push(record);
      return record;
    }

    /** 回放：从起点重新应用所有事件（用来验证"顺序无关性"之外的确定性） */
    replay() {
      const fresh = new FeedbackLog({ alpha: this.alpha });
      for (const [id, ledger] of Object.entries(this.nodes)) {
        const origin = ledger.origin || { R0: ledger.R0, S: ledger.S, D: ledger.D };
        fresh.nodes[id] = Object.assign({}, ledger, { R0: origin.R0, S: origin.S, D: origin.D, count: 0, correct: 0, origin });
      }
      for (const ev of this.events) fresh.record({ node: ev.node, tHours: ev.tHours, correct: ev.correct, at: ev.at });
      return fresh;
    }

    /**
     * 体检报告：把「账本估计的 S」与「图里机制算出的 S」摆在一起对照。
     *
     * 这是本模块在新分工下的主要产出 —— 它**不改**图里的 S（那是机制的活），
     * 只回答"我估的和你算的差多少、差在哪个方向"。
     * @returns {object} { rows, bias_ratio, bias_note, samples }
     */
    compareWithGraph(graph) {
      if (!graph || typeof graph.get_node !== 'function') {
        throw new MindNetError('compareWithGraph 需要传入 Graph');
      }
      const rows = [];
      for (const [id, ledger] of Object.entries(this.nodes)) {
        if (!ledger.count) continue;
        const node = graph.get_node(id);
        const bag = node && node.m && node.m.memory_dsr;
        if (!bag) continue;
        rows.push({
          node: id,
          graph_S: round(bag.S, 3),
          ledger_S: round(ledger.S, 3),
          ratio: bag.S > 0 ? round(ledger.S / bag.S, 3) : null,
          count: ledger.count,
          se_best_pct: seAsPercent(ledger.count),
        });
      }
      rows.sort((a, b) => b.count - a.count);
      const usable = rows.filter((r) => r.ratio !== null && r.count >= 3);
      const bias = usable.length
        ? Math.exp(usable.reduce((s, r) => s + Math.log(r.ratio), 0) / usable.length)
        : null;
      return {
        rows,
        samples: usable.length,
        bias_ratio: bias === null ? null : round(bias, 3),
        bias_note: bias === null
          ? `有效样本 ${usable.length} 个（每个节点至少 3 条证据）—— 还看不出系统性偏差`
          : (Math.abs(bias - 1) < 0.15
            ? `机制算出的 S 与账本估计基本一致（比值 ${round(bias, 2)}，${usable.length} 个节点）`
            : `机制算出的 S 系统性${bias > 1 ? '偏保守' : '偏乐观'} ${round(Math.abs(bias - 1) * 100, 0)}%（比值 ${round(bias, 2)}，${usable.length} 个节点）—— 调参数或者继续攒证据`),
      };
    }

    /**
     * 本模块**唯一**的"写"出口：把体检结论变成参数覆盖（不碰任何节点的 S）。
     * @returns {object} 形如 { 'memory.dsr.legacy_k': 31.2 }，可直接当 overrides 用
     */
    suggestOverrides() {
      const out = {};
      const k = this.suggestLegacyK();
      if (k.samples >= 3) out['memory.dsr.legacy_k'] = k.legacy_k;
      return out;
    }

    /**
     * 全局建议：把这些节点的 S 换算成"初始稳定度系数 k"，取中位数。
     * 用途：新节点的初值 —— 让新学的东西一开始就用你的量级，而不是文献的 24 小时。
     */
    suggestLegacyK(fallback) {
      const ratios = Object.entries(this.nodes)
        .filter(([, l]) => l.count > 0 && l.R0 > 0.05)
        .map(([, l]) => l.S / l.R0)
        .sort((a, b) => a - b);
      if (ratios.length < 3) return { legacy_k: fallback === undefined ? 24 : fallback, samples: ratios.length, note: '样本不足 3 个，沿用默认 24 小时' };
      const mid = ratios.length % 2 ? ratios[(ratios.length - 1) / 2] : (ratios[ratios.length / 2 - 1] + ratios[ratios.length / 2]) / 2;
      return {
        legacy_k: round(clamp(mid, 1, 2000), 3),
        samples: ratios.length,
        note: `${ratios.length} 个节点的 S/R0 中位数 ⇒ 新节点初始稳定度建议 k ≈ ${round(mid, 1)} 小时（默认 24）`,
      };
    }

    /** 人话报告 */
    report() {
      const rows = Object.entries(this.nodes).map(([id, l]) => ({
        node: id,
        count: l.count,
        accuracy: l.count ? round(l.correct / l.count, 3) : null,
        S_before: l.origin ? l.origin.S : null,
        S_after: l.S,
        ratio: l.origin && l.origin.S ? round(l.S / l.origin.S, 3) : null,
        R0: l.R0,
        D: round(l.D, 3),
        se_best_pct: seAsPercent(l.count),
      })).sort((a, b) => b.count - a.count);
      const total = rows.reduce((s, r) => s + r.count, 0);
      const correct = rows.reduce((s, r) => s + (r.accuracy === null ? 0 : r.accuracy * r.count), 0);
      return {
        events: total,
        accuracy: total ? round(correct / total, 3) : null,
        rows,
        suggestion: this.suggestLegacyK(),
        se_best_pct: seAsPercent(total),
        note: '对/错只有 1 bit 信息：证据越多越准，但慢。上表 se_best_pct 是"最好情况"下的误差下界。',
      };
    }

    toJSON() {
      return { version: this.version, alpha: this.alpha, nodes: this.nodes, events: this.events };
    }

    static fromJSON(obj) {
      const log = new FeedbackLog({ alpha: obj && obj.alpha });
      if (obj && obj.nodes) log.nodes = JSON.parse(JSON.stringify(obj.nodes));
      if (obj && Array.isArray(obj.events)) log.events = JSON.parse(JSON.stringify(obj.events));
      return log;
    }

    /** 读写文件（Node 侧） */
    saveToFile(path) {
      if (typeof require !== 'function') throw new MindNetError('浏览器环境不支持写文件');
      require('fs').writeFileSync(path, `${JSON.stringify(this.toJSON(), null, 2)}\n`, 'utf8');
      return path;
    }

    static loadFromFile(path) {
      if (typeof require !== 'function') throw new MindNetError('浏览器环境不支持读文件');
      const fs = require('fs');
      if (!fs.existsSync(path)) return new FeedbackLog();
      return FeedbackLog.fromJSON(JSON.parse(fs.readFileSync(path, 'utf8')));
    }
  }

  const api = {
    DEFAULTS, FISHER_I_BEST, updateStability, predictedRetrievability,
    gainAt, seLogSBest, seAsPercent, FeedbackLog,
  };

  if (isNode) module.exports = api;
  else globalThis.MindNet = Object.assign(globalThis.MindNet || {}, { feedback: api });
})();
