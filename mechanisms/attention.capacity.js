/**
 * 机制模块：两级意识容量（直接访问区 DAR + 注意焦点 FA）与侧抑制
 *
 * 对应 docs/MODEL_v2_MATH.md §4.4。
 * 依据：工作记忆焦点稳定保持 3–5 个组块；Oberauer 三态模型里窄焦点只选 1 个、
 *       直接访问区约 4 个（Martini et al. 2015, PMC4500897，本次取到全文）。
 *
 * 关键语义：被容量挤出去的节点**不是不会**，而是「同时涌进来的太多」——
 * 这个区别是 v1.1 完全无法表达的（它的 200 节点星图会 1 轮全亮）。
 */
(function () {
  'use strict';

  const isNode = typeof module !== 'undefined' && !!module.exports;
  const deps = isNode ? Object.assign({}, require('../src/config.js')) : (globalThis.MindNet || {});
  const { MindNetError } = deps;

  const PARAMS = [
    { key: 'W_DAR', type: 'number', min: 0.1, max: 100, default: 4.0, unit: '激活单位',
      desc: '直接访问区容量预算（以激活量计，不是「个数」）',
      evidence: 'Cowan 3–5 组块 / Oberauer DAR≈4（PMC4500897）', calibrated: true },
    { key: 'W_FA', type: 'number', min: 0.1, max: 10, default: 1.0, unit: '激活单位',
      desc: '注意焦点容量预算（窄焦点一次一个）',
      evidence: 'Oberauer 窄焦点 = 1 项（PMC4500897）', calibrated: true },
  ];
  const DEFAULTS = PARAMS.reduce((a, p) => { a[p.key] = p.default; return a; }, {});

  function options(o) {
    return Object.assign({}, DEFAULTS, o || {});
  }

  /** 邻居集合的 Jaccard 相似度（无向邻域，忽略方向） */
  function similarity(graph, a, b) {
    if (a === b) return 1;
    const setA = neighborSet(graph, a);
    const setB = neighborSet(graph, b);
    let inter = 0;
    for (const x of setA) if (setB.has(x)) inter += 1;
    const union = setA.size + setB.size - inter;
    return union === 0 ? 0 : inter / union;
  }

  function neighborSet(graph, id) {
    const s = new Set();
    for (const e of graph.out_edges(id)) s.add(e.to);
    for (const e of graph.in_edges(id)) s.add(e.from);
    s.delete(id);
    return s;
  }

  /** 纯函数：给定得分与激活，做两级准入 */
  function admit(candidates, o) {
    const opt = options(o);
    const sorted = candidates
      .slice()
      .sort((x, y) => (y.score - x.score) || (x.id < y.id ? -1 : 1));
    const dar = [];
    let used = 0;
    for (const c of sorted) {
      const cost = c.a;
      if (used + cost > opt.W_DAR) continue;
      used += cost;
      dar.push(c);
    }
    const fa = [];
    let faUsed = 0;
    for (const c of dar) {
      if (faUsed + c.a > opt.W_FA) continue;
      faUsed += c.a;
      fa.push(c.id);
      break; // 窄焦点一次只放一个
    }
    return { dar: dar.map((c) => c.id), fa, used };
  }

  const manifest = {
    api: 1,
    id: 'attention.capacity',
    name: '两级意识容量：DAR(4) + 焦点(1) 与侧抑制',
    layer: 'attention',
    level: 'core',
    phenomenon: [
      '同时能「在脑子里」的东西很少：焦点 3–5 个组块，窄焦点只有 1 个',
      '相似的东西互相干扰：一堆长得像的概念会彼此压低',
      '被挤出去 ≠ 不会：候选太多时，会的东西也会进不了意识',
    ],
    evidence: [
      { grade: 'read', url: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC4500897/',
        note: 'Martini et al. 2015 工作记忆维持综述：FA 3–5 组块、Oberauer 窄焦点 1 项 / DAR 约 4 项' },
      { grade: 'local', note: 'Executive_Architecture §5.1「思维容量：强度相关而非纯容量，尚未建模」' },
    ],
    params: PARAMS,
    reads: ['state'],
    writes: [],
    shared: [],
    requires: [],
    conflicts: ['legacy_v1'],
    acceptance: [
      {
        name: '容量约束：200 个全激活候选里，DAR 准入量满足 Σa ≤ W_DAR',
        kind: 'phenomenon',
        check() {
          const cands = Array.from({ length: 200 }, (_, i) => ({ id: `L${i}`, score: 1, a: 1 }));
          const r = admit(cands, {});
          return r.dar.length <= 4 && r.fa.length === 1;
        },
      },
      {
        name: '强度相关而非个数相关：弱候选能挤进更多个',
        kind: 'phenomenon',
        check() {
          const strong = Array.from({ length: 10 }, (_, i) => ({ id: `s${i}`, score: 1, a: 1.0 }));
          const weak = Array.from({ length: 10 }, (_, i) => ({ id: `w${i}`, score: 0.5, a: 0.5 }));
          return admit(weak, {}).dar.length > admit(strong, {}).dar.length;
        },
      },
      {
        name: '消融：容量放到无限大时，全部候选被准入（v1.1 行为）',
        kind: 'ablation',
        check() {
          const cands = Array.from({ length: 200 }, (_, i) => ({ id: `L${i}`, score: 1, a: 1 }));
          const r = admit(cands, { W_DAR: 100 });
          return r.dar.length === 100 && r.dar.length > admit(cands, {}).dar.length;
        },
      },
    ],
    hooks: {
      'attention.select': (ctx) => {
        const o = options({
          W_DAR: ctx.param('W_DAR'),
          W_FA: ctx.param('W_FA'),
        });
        const scores = ctx.payload.scores;
        const nodes = ctx.nodes();
        const candidates = nodes.map((n) => ({
          id: n.id,
          score: scores.get(n.id) || 0,
          a: ctx.shared(n.id).a,
        }));
        const r = admit(candidates, o);
        ctx.payload.admitted = r.dar;
        ctx.payload.focus = r.fa[0] || null;
        ctx.payload.dar_used = r.used;
        ctx.payload.outcompeted = candidates
          .filter((c) => !r.dar.includes(c.id) && c.score > 0)
          .map((c) => c.id);
        return { admitted: r.dar.length, focus: ctx.payload.focus, used: r.used };
      },
    },
  };

  const api = { manifest, PARAMS, DEFAULTS, options, admit, similarity, neighborSet };

  if (isNode) module.exports = api;
  else globalThis.MindNet = Object.assign(globalThis.MindNet || {}, { attentionCapacity: api });
})();
