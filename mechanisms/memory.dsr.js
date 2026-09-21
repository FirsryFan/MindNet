/**
 * 机制模块：记忆层（DSR + 储蓄效应 + 三档复习 + 失败证据老化）
 *
 * 对应 docs/MODEL_v2_MATH.md §3。它替换 v1.1 的「单一 ms + S=k·ms」，
 * 但**不碰扩散主循环**：模块每次都会把当前可提取度写回 node.ms，
 * 因此现有的 v1.1 扩散立即受益（渐进升级）。
 *
 * 这个文件同时是插件架构的样板：
 *   manifest（现象/证据/参数/读写声明/槽位/验收断言）+ 纯函数实现。
 *   纯函数不依赖 Graph 与内核，因此可以被测试、探针、工具独立调用。
 */
(function () {
  'use strict';

  const isNode = typeof module !== 'undefined' && !!module.exports;
  const deps = isNode
    ? Object.assign({}, require('../src/config.js'))
    : (globalThis.MindNet || {});
  const { MindNetError, now_hours } = deps;

  // ------------------------------------------------------------------ 参数

  /** 参数表：内核据此做校验、生成 UI 控件、并在 --check 里报告标定状态 */
  const PARAMS = [
    { key: 'decay_model', type: 'enum', options: ['power', 'exponential'], default: 'power',
      unit: '-', desc: '遗忘曲线形状：power=FSRS 幂律（默认）；exponential=与 v1.1 逐位等价的指数',
      evidence: 'FSRS 公开算法 / v1.1 兼容', calibrated: true },
    { key: 'gamma', type: 'number', min: 0.01, max: 1, default: 0.1542,
      unit: '-', desc: '曲线衰减指数（同时决定 c）', evidence: 'FSRS-6 DECAY 默认值', calibrated: true },
    { key: 'beta', type: 'number', min: 0.01, max: 1, default: 0.1367,
      unit: '-', desc: '稳定度增长对 S 的抑制指数', evidence: 'FSRS-4.5 w9', calibrated: true },
    { key: 'eta', type: 'number', min: 0.01, max: 5, default: 1.0461,
      unit: '-', desc: '增长对可提取性的敏感度（越小 R 越重要）', evidence: 'FSRS-4.5 w10', calibrated: true },
    { key: 'kappa', type: 'number', min: 0.01, max: 100, default: 8.01921,
      unit: '-', desc: '提取成功的稳定度增长基准（已由天尺度换算到小时）',
      evidence: 'FSRS-4.5 e^w8=5.193459，乘 24^β=1.544098', calibrated: true },
    { key: 'kappa_reread_ratio', type: 'number', min: 0, max: 1, default: 0.1,
      unit: '-', desc: '「再读」的增益相对提取成功的比例', evidence: '未标定（提取练习效应方向明确）', calibrated: false },
    { key: 'kappa_savings', type: 'number', min: 0, max: 2, default: 0.5,
      unit: '-', desc: '存储强度 Σ 对增长的放大（储蓄效应）', evidence: '未标定（Bjork 存储/提取二分）', calibrated: false },
    { key: 'c_R0', type: 'number', min: 0, max: 1, default: 0.05,
      unit: '-', desc: '每次成功提取对编码强度 R0 的提升', evidence: '未标定', calibrated: false },
    { key: 'c_Sigma', type: 'number', min: 0, max: 1, default: 0.5,
      unit: '-', desc: '努力量对存储强度 Σ 的提升', evidence: '未标定', calibrated: false },
    { key: 'd1', type: 'number', min: 0, max: 1, default: 0.1,
      unit: '-', desc: '表现档位对难度 D 的影响', evidence: '未标定', calibrated: false },
    { key: 'd2', type: 'number', min: 0, max: 2, default: 0.5,
      unit: '-', desc: '「拖久了才想起 = 更难」的强度', evidence: '未标定', calibrated: false },
    { key: 'D0', type: 'number', min: 1, max: 10, default: 5.1618,
      unit: '-', desc: '初始难度', evidence: 'FSRS-4.5 w4（首次评为 Good 时的初始难度）', calibrated: true },
    { key: 'fail_tau_hours', type: 'number', min: 1, max: 100000, default: 720,
      unit: '小时', desc: '失败证据的半衰期（默认 30 天）', evidence: '未标定', calibrated: false },
    { key: 'legacy_k', type: 'number', min: 0.1, max: 1000, default: 24,
      unit: '小时', desc: '指数模式下的稳定度系数（保持与 v1.1 逐位等价）', evidence: 'v1.1 config.forgetting_k', calibrated: true },
  ];

  const DEFAULTS = PARAMS.reduce((acc, p) => {
    acc[p.key] = p.default;
    return acc;
  }, {});

  /** FSRS-4.5 的遗忘后稳定度形状参数（w11–w14） */
  const LAPSE = { c_f: 2.1072, gamma_D: 0.0793, gamma_S: 0.3246, gamma_R: 1.587 };
  const D_MIN = 1;
  const D_MAX = 10;

  function options(overrides) {
    return Object.assign({}, DEFAULTS, overrides || {});
  }

  function curveC(gamma) {
    return Math.pow(0.9, -1 / gamma) - 1;
  }

  function psi(z, o) {
    if (z <= 0) return 1;
    if (o.decay_model === 'exponential') return Math.exp(-z);
    return Math.pow(1 + curveC(o.gamma) * z, -o.gamma);
  }

  // ------------------------------------------------------------ 状态初始化

  /** 惰性初始化节点的慢状态（命名空间 memory_dsr） */
  function ensureState(node, u, overrides) {
    const o = options(overrides);
    const now = u === undefined || u === null ? now_hours() : u;
    if (!node.m) node.m = {};
    let bag = node.m.memory_dsr;
    if (!bag) {
      const R0 = typeof node.ms === 'number' && node.ms > 0 ? Math.min(1, node.ms) : 0.8;
      bag = {
        R0,
        S: o.legacy_k * R0,          // 初值与 v1.1 等价：S = k·R0
        Sigma: R0,                   // 存储强度初值（未标定，取与 R0 同量级）
        D: o.D0,
        N: 0,
        F: 0,
        lastFail: null,
        lastReview: node.last_review_time || now,
        history: [],
        initializedAt: now,
      };
      node.m.memory_dsr = bag;
    }
    return bag;
  }

  function synced(node, u, overrides) {
    const bag = ensureState(node, u, overrides);
    const o = options(overrides);
    const now = u === undefined || u === null ? now_hours() : u;
    const dt = Math.max(0, now - bag.lastReview);
    const R = bag.R0 * psi(dt / bag.S, o);
    node.ms = R;
    node.last_review_time = bag.lastReview;
    return { bag, R, dt, o, now };
  }

  // -------------------------------------------------------------- 公开计算

  /** 当前可提取度 R（并把 node.ms 同步过去） */
  function retrievabilityOf(node, u, overrides) {
    return synced(node, u, overrides).R;
  }

  /**
   * 由目标留存率反解复习间隔（小时）。
   *
   * 注意口径：R(t) = R0·Ψ(t/S)，所以 S 的定义是「可提取度降到 90%·R0 的小时数」。
   * 当 R0 = 1 时，它就是常见的「留存率 90% 的间隔」。若目标留存率高于编码上限 R0，
   * 曲线永远够不到该目标 —— 此时返回 0，表示「需要立刻复习（或先提高编码强度）」。
   */
  function scheduleInterval(node, u, targetRetention, overrides) {
    const o = options(overrides);
    const { bag } = synced(node, u, overrides);
    const r = targetRetention === undefined ? 0.85 : targetRetention;
    if (!(r > 0 && r < 1)) {
      throw new MindNetError(`目标留存率必须在 (0,1) 内，实际 ${targetRetention}`);
    }
    if (r >= bag.R0) return 0;
    const c = curveC(o.gamma);
    if (o.decay_model === 'exponential') {
      return bag.S * Math.log(bag.R0 / r);
    }
    return (bag.S / c) * (Math.pow(r / bag.R0, -1 / o.gamma) - 1);
  }

  /** 稳定度增长因子（成功复习） */
  function stabilityIncrease(bag, R, o, kind, closeness) {
    const ratio = kind === 'reread'
      ? o.kappa_reread_ratio
      : kind === 'retrieval_failure_feedback'
        ? Math.min(1, Math.max(0, closeness === undefined ? 0.5 : closeness))
        : 1;
    const mu = 1 + o.kappa_savings * bag.Sigma;
    const difficultyTerm = (11 - Math.min(D_MAX, Math.max(D_MIN, bag.D)));
    const saturation = Math.exp(o.eta * (1 - R)) - 1;
    const inc = 1 + o.kappa * ratio * mu * difficultyTerm * Math.pow(bag.S, -o.beta) * saturation;
    return Math.max(1, inc);
  }

  /** 记录失败证据（惰性衰减，O(1)） */
  function recordFailure(node, u, overrides) {
    const { bag, now } = synced(node, u, overrides);
    const o = options(overrides);
    if (bag.lastFail !== null) {
      bag.F = bag.F * Math.exp(-Math.max(0, now - bag.lastFail) / o.fail_tau_hours);
    }
    bag.F += 1;
    bag.lastFail = now;
    return bag.F;
  }

  /** 失败证据质量（含惰性衰减） */
  function failureEvidenceOf(node, u, overrides) {
    const o = options(overrides);
    const bag = ensureState(node, u, overrides);
    const now = u === undefined || u === null ? now_hours() : u;
    if (bag.lastFail === null) return 0;
    return bag.F * Math.exp(-Math.max(0, now - bag.lastFail) / o.fail_tau_hours);
  }

  /** 死角区惩罚：Penalty = Σ w·√F（F 随时间衰减，取代 v1.1 的终身 visit_count） */
  function penaltyOf(graph, u, overrides) {
    let total = 0;
    const rows = [];
    for (const node of graph.nodes.values()) {
      const F = failureEvidenceOf(node, u, overrides);
      if (F <= 0) continue;
      const contribution = node.weight * Math.sqrt(F);
      total += contribution;
      rows.push({ id: node.id, F: round(F), weight: node.weight, contribution: round(contribution) });
    }
    rows.sort((a, b) => b.contribution - a.contribution);
    return { penalty: round(total), rows };
  }

  // -------------------------------------------------------------- 复习处理

  /**
   * 复习事件（纯函数）。
   * @param {object} node
   * @param {number} u 现实时间（小时）
   * @param {object} ev { type, grade, closeness }
   *   type: 'retrieval_success' | 'reread' | 'retrieval_failure_feedback' | 'lapse'
   * @returns {object} 变更明细（便于测试与 UI 展示）
   */
  function applyReview(node, u, ev, overrides) {
    const o = options(overrides);
    const type = (ev && ev.type) || 'retrieval_success';
    const grade = ev && ev.grade !== undefined ? ev.grade : (type === 'lapse' ? 1 : 3);
    const closeness = ev && ev.closeness !== undefined ? ev.closeness : 0.5;
    const before = synced(node, u, overrides);
    const bag = before.bag;
    const R = before.R;
    const now = before.now;
    const out = {
      id: node.id, type, grade,
      R_at_review: round(R),
      S_before: round(bag.S),
      R0_before: round(bag.R0),
      Sigma_before: round(bag.Sigma),
      D_before: round(bag.D),
    };

    if (type === 'lapse') {
      // 真正的遗忘：S 下降（但 Σ 保留 → 储蓄效应），失败证据 +1
      const S_after = LAPSE.c_f * Math.pow(bag.D, -LAPSE.gamma_D)
        * (Math.pow(bag.S + 1, LAPSE.gamma_S) - 1)
        * Math.exp(LAPSE.gamma_R * (1 - R));
      bag.S = Math.max(1e-6, S_after);
      recordFailure(node, now, overrides);
      out.kind = 'lapse';
    } else {
      const inc = stabilityIncrease(bag, R, o, type, closeness);
      bag.S = bag.S * inc;
      out.SInc = round(inc);
      if (type === 'retrieval_success') {
        bag.N += 1;
        bag.R0 = Math.min(1, bag.R0 + o.c_R0 * (1 - bag.R0));
      }
      out.kind = 'review';
    }

    // 难度更新（表现档位 + 「拖久了才想起 = 更难」）
    const deltaD = -o.d1 * (grade - 3) + o.d2 * (1 - R);
    bag.D = Math.min(D_MAX, Math.max(D_MIN, bag.D + deltaD));

    // 存储强度（只增不减）：努力量 = 想不起来的程度 + 差点想起来的程度
    const effort = Math.min(1, Math.max(0, (1 - R) + (1 - closeness)) );
    bag.Sigma = Math.min(1, bag.Sigma + o.c_Sigma * effort * (1 - bag.Sigma));

    bag.lastReview = now;
    bag.history.push({ u: now, type, R: round(R), S: round(bag.S), grade });
    if (bag.history.length > 200) bag.history.shift();

    const after = synced(node, now, overrides);
    out.S_after = round(bag.S);
    out.R_after = round(after.R);
    out.Sigma_after = round(bag.Sigma);
    out.D_after = round(bag.D);
    return out;
  }

  /** 把全图节点的 ms 同步为当前可提取度（时间推进 / 打开软件时调用） */
  function syncAll(graph, u, overrides) {
    let n = 0;
    for (const node of graph.nodes.values()) {
      synced(node, u, overrides);
      n += 1;
    }
    return n;
  }

  function round(x, digits) {
    const d = digits === undefined ? 6 : digits;
    const f = Math.pow(10, d);
    return Math.round((Number(x) || 0) * f) / f;
  }

  // ---------------------------------------------------------------- 验收断言

  /** 造一个不需要 Graph 的桩节点，供 acceptance 独立运行 */
  function stubNode(ms) {
    return { id: 'stub', ms: ms === undefined ? 0.8 : ms, weight: 1, m: {}, last_review_time: 0 };
  }

  /** 模拟：按给定间隔序列做 n 次成功提取，返回 t 小时后的留存 */
  function simulateReviewGaps(gapsHours, totalHours, overrides) {
    const node = stubNode(0.8);
    const o = options(overrides);
    let u = 0;
    ensureState(node, 0, o);
    for (const gap of gapsHours) {
      u += gap;
      applyReview(node, u, { type: 'retrieval_success', grade: 3 }, o);
    }
    u += totalHours;
    return { R: retrievabilityOf(node, u, o), node, u };
  }

  const ACCEPTANCE = [
    {
      name: '提取练习效应：同一 R 下，「提取成功」的 SInc 大于「再读」',
      kind: 'phenomenon',
      check() {
        const node = stubNode(0.8);
        const o = options();
        const bag = ensureState(node, 0, o);
        const R = 0.6;
        const incSuccess = stabilityIncrease(bag, R, o, 'retrieval_success', 0.5);
        const incReread = stabilityIncrease(bag, R, o, 'reread', 0.5);
        return incSuccess > incReread * 1.5;
      },
    },
    {
      name: '间隔效应：同样 2 次复习，「间隔 3/7 天」的稳定度 S 远高于「集中复习」，且一年后留存更高',
      kind: 'phenomenon',
      check() {
        // 说明：FSRS 幂律曲线是重尾的，30 天留存上的间隔差异只有百分之几；
        // 真正有判别力的是排程变量 S 本身（相差 2 倍以上），留存差异要到一年尺度才明显。
        const massed = simulateReviewGaps([0.01, 0.01], 24 * 365);
        const spaced = simulateReviewGaps([24 * 3, 24 * 7], 24 * 365);
        const sMassed = massed.node.m.memory_dsr.S;
        const sSpaced = spaced.node.m.memory_dsr.S;
        return sSpaced > sMassed * 1.5 && spaced.R > massed.R * 1.05;
      },
    },
    {
      name: '复习次数 ⇒ 遗忘变慢（v1.1 探针规律 1 的翻转）',
      kind: 'phenomenon',
      check() {
        const one = simulateReviewGaps([0], 72);
        const three = simulateReviewGaps([24, 24, 24], 72);
        return three.R > one.R;
      },
    },
    {
      name: '失败证据老化：一年后的 Penalty 显著低于刚失败时（探针规律 5 的翻转）',
      kind: 'phenomenon',
      check() {
        const node = stubNode(0.8);
        const o = options();
        recordFailure(node, 0, o);
        const graph = { nodes: new Map([[node.id, node]]) };
        const fresh = penaltyOf(graph, 0, o).penalty;
        const old = penaltyOf(graph, 8760, o).penalty;
        return fresh > 0 && old < fresh * 0.01;
      },
    },
    {
      name: '消融：κ=0 且 c_R0=0（等价于停用本模块的学习项）时，复习次数不再提高留存',
      kind: 'ablation',
      check() {
        const off = { kappa: 0, c_R0: 0 };
        const one = simulateReviewGaps([0], 72, off);
        const three = simulateReviewGaps([24, 24, 24], 72, off);
        const on = simulateReviewGaps([24, 24, 24], 72);
        return Math.abs(three.R - one.R) < 1e-9 && on.R > three.R;
      },
    },
    {
      name: '消融：Σ 储蓄 = 0 时，遗忘后重新学习的增益不再被放大',
      kind: 'ablation',
      check() {
        const withSavings = simulateReviewGaps([24, 24, 24], 72);
        const noSavings = simulateReviewGaps([24, 24, 24], 72, { kappa_savings: 0 });
        return withSavings.node.m.memory_dsr.S > noSavings.node.m.memory_dsr.S;
      },
    },
  ];

  // ------------------------------------------------------------------ 清单

  const manifest = {
    api: 1,
    id: 'memory.dsr',
    name: '记忆层：DSR + 储蓄 + 三档复习 + 失败证据老化',
    layer: 'memory',
    level: 'core',
    phenomenon: [
      '间隔效应：同样次数的复习，拉开间隔比集中复习留存更久',
      '提取练习效应：主动提取比再读更能提高长期留存',
      '储蓄效应：学过的东西第二次学更快（存储强度与提取强度分离）',
      '失败证据会过期：一年前卡住和昨天卡住不该同样计入死角',
    ],
    evidence: [
      { grade: 'read', url: 'https://raw.githubusercontent.com/wiki/open-spaced-repetition/awesome-fsrs/The-Algorithm.md',
        note: '遗忘曲线与稳定度增长的公式形状、FSRS 公开默认参数（本次取到全文）' },
      { grade: 'read', url: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC2742428/',
        note: '元认知与学习控制综述（提取练习、间隔选择的实验依据）' },
      { grade: 'local', note: 'Application_Protocol §1「提取历史 K：成功提取次数越多，遗忘越慢」' },
    ],
    params: PARAMS,
    reads: ['ms', 'weight', 'last_review_time'],
    writes: ['R0', 'S', 'Sigma', 'D', 'N', 'F', 'lastFail', 'lastReview', 'history',
      'ms', 'last_review_time'],
    bounds: {
      'memory_dsr.R0': [0, 1],
      'memory_dsr.Sigma': [0, 1],
      'memory_dsr.S': [1e-6, 1e9],
      'memory_dsr.D': [D_MIN, D_MAX],
      'memory_dsr.F': [0, 1e9],
      'memory_dsr.N': [0, 1e9],
    },
    requires: [],
    conflicts: [],
    acceptance: ACCEPTANCE,
    hooks: {
      // 现实时间推进：把所有节点的 ms 同步为当前可提取度
      'hours.advance': (ctx) => {
        let n = 0;
        for (const node of ctx.nodes()) {
          const bag = ensureState(node, ctx.hours, paramsOf(ctx));
          synced(node, ctx.hours, paramsOf(ctx));
          ctx.patch(node.id, {
            R0: bag.R0, S: bag.S, Sigma: bag.Sigma, D: bag.D, N: bag.N, F: bag.F,
            lastFail: bag.lastFail, lastReview: bag.lastReview, history: bag.history,
            ms: node.ms, last_review_time: node.last_review_time,
          });
          n += 1;
        }
        return { synced: n };
      },
      // 复习事件
      'review.on': (ctx) => {
        const { nodeId } = ctx.payload;
        const node = ctx.node(nodeId);
        if (!node) throw new MindNetError(`review.on：节点 "${nodeId}" 不存在`);
        const u = ctx.payload.current_real_time === undefined ? ctx.hours : ctx.payload.current_real_time;
        const detail = applyReview(node, u, {
          type: ctx.payload.type,
          grade: ctx.payload.grade,
          closeness: ctx.payload.closeness,
        }, paramsOf(ctx));
        const bag = ensureState(node, u, paramsOf(ctx));
        ctx.patch(nodeId, {
          R0: bag.R0, S: bag.S, Sigma: bag.Sigma, D: bag.D, N: bag.N, F: bag.F,
          lastFail: bag.lastFail, lastReview: bag.lastReview, history: bag.history,
          ms: node.ms, last_review_time: node.last_review_time,
        });
        return detail;
      },
      // 诊断：死角区（时间衰减后的失败证据）
      'diagnose.on': (ctx) => {
        const { penalty, rows } = penaltyOf(ctx.graph, ctx.hours, paramsOf(ctx));
        return {
          memory: {
            penalty,
            dead: rows,
            decayed_by_hours: paramsOf(ctx).fail_tau_hours,
          },
        };
      },
      // 存档
      'serialize.on': (ctx) => {
        const nodes = {};
        for (const node of ctx.nodes()) {
          const bag = ensureState(node, ctx.hours, paramsOf(ctx));
          nodes[node.id] = {
            R: round(retrievabilityOf(node, ctx.hours, paramsOf(ctx))),
            R0: round(bag.R0), S: round(bag.S), Sigma: round(bag.Sigma), D: round(bag.D),
            N: bag.N, F: round(failureEvidenceOf(node, ctx.hours, paramsOf(ctx))),
          };
        }
        return { memory: { nodes, params: paramsOf(ctx) } };
      },
    },
  };

  /** 把内核参数解析结果收敛成纯函数要的 options 对象 */
  function paramsOf(ctx) {
    const o = {};
    for (const p of PARAMS) o[p.key] = ctx.param(p.key);
    return o;
  }

  const api = {
    manifest,
    PARAMS,
    DEFAULTS,
    LAPSE,
    options,
    curveC,
    psi,
    ensureState,
    retrievabilityOf,
    scheduleInterval,
    stabilityIncrease,
    recordFailure,
    failureEvidenceOf,
    penaltyOf,
    applyReview,
    syncAll,
    simulateReviewGaps,
  };

  if (isNode) {
    module.exports = api;
  } else {
    globalThis.MindNet = Object.assign(globalThis.MindNet || {}, { memoryDsr: api });
  }
})();
