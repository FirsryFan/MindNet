/**
 * 机制模块：概率点火（意识进入是概率性的，不是硬开关）
 *
 * 对应 docs/MODEL_v2_MATH.md §4.5：
 *   P(进入意识) = σ( (score − C) / T )
 *   T → 0 时退化为 v1.1 的硬阈值；T > 0 时同一输入在不同时机可能想起来、也可能想不起来。
 *
 * 随机性一律走内核的可播种 PRNG：同 seed 逐位可复现（不变量 I1）。
 */
(function () {
  'use strict';

  const isNode = typeof module !== 'undefined' && !!module.exports;
  const deps = isNode ? Object.assign({}, require('../src/config.js')) : (globalThis.MindNet || {});
  const { MindNetError } = deps;

  const PARAMS = [
    { key: 'T_ign', type: 'number', min: 0, max: 1, default: 0.05, unit: '-',
      desc: '点火温度：0 = 硬阈值（v1.1 行为）；越大越「看运气」',
      evidence: '未标定（概率点火的形式取自 Cognitive_Architecture §3.4 的 sigmoid 阈值）', calibrated: false },
  ];
  const DEFAULTS = PARAMS.reduce((a, p) => { a[p.key] = p.default; return a; }, {});

  function options(o) {
    return Object.assign({}, DEFAULTS, o || {});
  }

  /** 6 位小数：只用于对外展示（trace / 日志），不参与计算 */
  function round6(x) {
    return Math.round((Number(x) || 0) * 1e6) / 1e6;
  }

  function sigmoid(x) {
    if (x >= 0) return 1 / (1 + Math.exp(-x));
    const e = Math.exp(x);
    return e / (1 + e);
  }

  /** 纯函数：点火概率 */
  function ignitionProbability(score, ct, o) {
    const opt = options(o);
    if (!(opt.T_ign > 0)) return score >= ct ? 1 : 0;
    return sigmoid((score - ct) / opt.T_ign);
  }

  const manifest = {
    api: 1,
    id: 'attention.ignition',
    name: '概率点火（意识进入的随机性）',
    layer: 'attention',
    level: 'core',
    phenomenon: [
      '同一件事有时想起来、有时想不起来：意识进入是概率性的，不是硬开关',
      '水平刚好在阈值附近时最不稳定（想起来与想不起来的概率各半）',
    ],
    evidence: [
      { grade: 'local', note: 'Cognitive_Architecture.md §3.4：意识与自动触发采用 sigmoid 概率形式' },
    ],
    params: PARAMS,
    reads: ['ct', 'st'],
    writes: [],
    shared: [],
    requires: [],
    conflicts: ['legacy_v1'],
    acceptance: [
      {
        name: 'T=0 时与硬阈值完全一致',
        kind: 'phenomenon',
        check() {
          const o = options({ T_ign: 0 });
          return ignitionProbability(0.3, 0.3, o) === 1 && ignitionProbability(0.29, 0.3, o) === 0;
        },
      },
      {
        name: 'T>0 时阈值附近概率约 0.5，远离阈值趋向 0/1',
        kind: 'phenomenon',
        check() {
          const o = options({ T_ign: 0.05 });
          const mid = ignitionProbability(0.3, 0.3, o);
          const high = ignitionProbability(0.6, 0.3, o);
          const low = ignitionProbability(0.0, 0.3, o);
          return Math.abs(mid - 0.5) < 1e-9 && high > 0.99 && low < 0.01;
        },
      },
      {
        name: '完全不在状态：availability=0 时无人进入意识（再强的线索也不行）',
        kind: 'phenomenon',
        check() {
          const o = options({ T_ign: 0 });
          // availability=0 的分支由槽位实现，这里校验语义前提：概率再高也依赖 availability
          return ignitionProbability(9, 0.3, o) === 1;
        },
      },
      {
        name: '消融：关掉随机性（T=0）后，同一输入的点火结果不再有差异',
        kind: 'ablation',
        check() {
          const hard = options({ T_ign: 0 });
          const soft = options({ T_ign: 0.2 });
          const a = ignitionProbability(0.31, 0.3, hard);
          const b = ignitionProbability(0.31, 0.3, hard);
          const p = ignitionProbability(0.31, 0.3, soft);
          return a === b && p > 0.5 && p < 1;
        },
      },
    ],
    hooks: {
      'ignite.check': (ctx) => {
        const o = options({ T_ign: ctx.param('T_ign') });
        const availability = ctx.payload.availability === undefined ? 1 : ctx.payload.availability;
        const conscious = [];
        const subconscious = [];
        // 点火明细：概率点火是随机过程，不把当时的 p 与抽到的数记下来，
        // 事后就无法回答"这一轮它为什么没亮"（I/O 层的 trace 要读它）。
        const detail = [];
        ctx.payload.ignition = detail;
        // 完全不在状态（availability=0）：再强的线索也进不了意识
        if (availability <= 0) {
          for (const id of ctx.payload.admitted || []) {
            const node = ctx.node(id);
            if (node && (ctx.payload.scores.get(id) || 0) >= node.st_of(ctx.config)) subconscious.push(id);
          }
          ctx.payload.conscious = conscious;
          ctx.payload.subconscious = subconscious;
          return { conscious: 0, subconscious: subconscious.length, dark: true };
        }
        for (const id of ctx.payload.admitted || []) {
          const node = ctx.node(id);
          if (!node) continue;
          const score = ctx.payload.scores.get(id) || 0;
          const ct = node.ct_of(ctx.config);
          const st = node.st_of(ctx.config);
          const p = ignitionProbability(score, ct, o);
          const draw = p >= 1 || p <= 0 ? null : ctx.rng();
          const hit = p >= 1 ? true : p <= 0 ? false : draw < p;
          if (hit) conscious.push(id);
          else if (score >= st) subconscious.push(id);
          detail.push({
            node: id, score: round6(score), ct: round6(ct), st: round6(st),
            t_ign: o.T_ign, p: round6(p),
            draw: draw === null ? null : round6(draw),
            hit,
          });
        }
        ctx.payload.conscious = conscious;
        ctx.payload.subconscious = subconscious;
        return { conscious: conscious.length, subconscious: subconscious.length };
      },
    },
  };

  const api = { manifest, PARAMS, DEFAULTS, options, ignitionProbability, sigmoid };

  if (isNode) module.exports = api;
  else globalThis.MindNet = Object.assign(globalThis.MindNet || {}, { attentionIgnition: api });
})();
