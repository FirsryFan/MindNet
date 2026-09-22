/**
 * 机制模块：侧抑制 / 相似簇互压（前摄与倒摄干扰）
 *
 * 对应 docs/MODEL_v2_MATH.md §4.1 的抑制项 ι_v：
 *   ι_v = γ · sat( Σ_{u≠v} sim(u,v)·score_u )，sat(x) = x/(1+x)
 *   sim 用邻域集合的 Jaccard 相似度（共享邻居越多 = 越容易混）
 *
 * 为什么必须做饱和：早期版本直接用未归一化的求和，结果 200 个同构叶子
 * 之间的抑制量达到 18.1，把所有候选一次性压死（实测）。饱和后 ι ≤ γ，
 * 抑制强度有上界，不会因为图大就失控。
 *
 * 默认关闭（γ=0）：抑制强度需要按你的数据标定，未标定前不参与默认配置。
 */
(function () {
  'use strict';

  const isNode = typeof module !== 'undefined' && !!module.exports;
  const deps = isNode ? Object.assign({}, require('../src/config.js')) : (globalThis.MindNet || {});
  const { MindNetError } = deps;

  const PARAMS = [
    { key: 'gamma_inhibit', type: 'number', min: 0, max: 2, default: 0, unit: '-',
      desc: '侧抑制强度上界（0 = 关闭，因为该强度尚未标定）',
      evidence: '未标定（干扰现象有大量文献，但强度必须用数据定）', calibrated: false },
  ];
  const DEFAULTS = PARAMS.reduce((a, p) => { a[p.key] = p.default; return a; }, {});

  function options(o) {
    return Object.assign({}, DEFAULTS, o || {});
  }

  function neighborSet(graph, id) {
    const s = new Set();
    for (const e of graph.out_edges(id)) s.add(e.to);
    for (const e of graph.in_edges(id)) s.add(e.from);
    s.delete(id);
    return s;
  }

  function similarity(graph, a, b) {
    if (a === b) return 1;
    const setA = neighborSet(graph, a);
    const setB = neighborSet(graph, b);
    let inter = 0;
    for (const x of setA) if (setB.has(x)) inter += 1;
    const union = setA.size + setB.size - inter;
    return union === 0 ? 0 : inter / union;
  }

  function saturate(x) {
    const v = Math.max(0, x);
    return v / (1 + v);
  }

  /** 纯函数：给定原始相似度加权和，返回被抑制后的得分 */
  function inhibitedScore(score, rawInhibition, gamma) {
    return score - gamma * saturate(rawInhibition);
  }

  const manifest = {
    api: 1,
    id: 'attention.inhibition',
    name: '侧抑制：相似簇互压（前摄/倒摄干扰）',
    layer: 'attention',
    level: 'optional',
    phenomenon: [
      '长得像的东西会互相干扰：一堆相似概念同时在场时，每一个都更难被分清',
      '干扰强度有上界：不会因为库里相似条目多就无限压制（这是饱和形式的由来）',
    ],
    evidence: [
      { grade: 'search', url: 'https://www.sciencedirect.com/chapter/bookseries/abs/pii/S0079742114000061',
        note: '检索诱发遗忘/干扰的综述（本轮只到摘要级）' },
    ],
    params: PARAMS,
    reads: ['state'],
    writes: [],
    shared: [],
    requires: ['attention.capacity'],
    conflicts: ['legacy_v1'],
    acceptance: [
      {
        name: '饱和上界：抑制量永远不超过 γ',
        kind: 'phenomenon',
        check() {
          const huge = inhibitedScore(1, 1e6, 0.3);
          const zero = inhibitedScore(1, 0, 0.3);
          return Math.abs((1 - huge) - 0.3) < 1e-6 && Math.abs(zero - 1) < 1e-12;
        },
      },
      {
        name: '相似度：同一邻居集合的两个节点相似度为 1，无关节点为 0',
        kind: 'phenomenon',
        check() {
          const g = {
            out_edges: (id) => (id === 'a' || id === 'b' ? [{ to: 'hub' }] : []),
            in_edges: () => [],
          };
          return similarity(g, 'a', 'b') === 1 && similarity(g, 'a', 'z') === 0;
        },
      },
      {
        name: '消融：γ=0 时得分完全不变（默认关闭，不影响其它机制）',
        kind: 'ablation',
        check() {
          return inhibitedScore(0.42, 99, 0) === 0.42;
        },
      },
    ],
    hooks: {
      'attention.select': (ctx) => {
        const o = options({ gamma_inhibit: ctx.param('gamma_inhibit') });
        if (!(o.gamma_inhibit > 0)) return { skipped: 'gamma=0' };
        const scores = ctx.payload.scores;
        const hot = ctx.nodes().filter((n) => (scores.get(n.id) || 0) > 0);
        const base = new Map(hot.map((n) => [n.id, scores.get(n.id) || 0])); // 快照，避免边算边改
        let touched = 0;
        for (const v of hot) {
          let raw = 0;
          for (const u of hot) {
            if (u.id === v.id) continue;
            raw += similarity(ctx.graph, u.id, v.id) * base.get(u.id);
          }
          const next = inhibitedScore(base.get(v.id), raw, o.gamma_inhibit);
          if (next !== base.get(v.id)) touched += 1;
          scores.set(v.id, next);
        }
        return { inhibited: touched, gamma: o.gamma_inhibit };
      },
    },
  };

  const api = { manifest, PARAMS, DEFAULTS, options, similarity, saturate, inhibitedScore, neighborSet };

  if (isNode) module.exports = api;
  else globalThis.MindNet = Object.assign(globalThis.MindNet || {}, { attentionInhibition: api });
})();
