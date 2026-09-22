/**
 * 机制模块：目标偏置（上下文调制 d_v(C)）
 *
 * 对应 docs/MODEL_v2_MATH.md §4.1：
 *   x_v ← x_v + β·γ_v(Γ)，γ_v(Γ) = max_{g∈Γ} κ^{d(v,g)}，d 为 v 到目标的有向最短距离
 *
 * 语义：正在追的目标会把「通向它」的节点抬起来、把无关的东西压下去 ——
 * 这就是「设定上下文：写一句话锚定目标」在模型里的形式（Application_Protocol §15）。
 */
(function () {
  'use strict';

  const isNode = typeof module !== 'undefined' && !!module.exports;
  const deps = isNode ? Object.assign({}, require('../src/config.js')) : (globalThis.MindNet || {});
  const { MindNetError } = deps;

  const PARAMS = [
    { key: 'beta_goal', type: 'number', min: 0, max: 3, default: 0.3, unit: '-',
      desc: '目标偏置强度', evidence: '未标定（Application_Protocol §15 设定上下文）', calibrated: false },
    { key: 'kappa_reach', type: 'number', min: 0.05, max: 0.95, default: 0.5, unit: '-',
      desc: '每远离目标一跳，相关性的折扣', evidence: '未标定', calibrated: false },
    { key: 'fan_k', type: 'number', min: 0, max: 1, default: 0, unit: '-',
      desc: 'fan 效应修正：入边越多，单条线索的贡献越小（0 = 关闭）', evidence: '未标定', calibrated: false },
  ];
  const DEFAULTS = PARAMS.reduce((a, p) => { a[p.key] = p.default; return a; }, {});

  function options(o) {
    return Object.assign({}, DEFAULTS, o || {});
  }

  /** 反向 BFS：算出每个节点到目标集合的有向最短距离 */
  function distanceToGoals(graph, goals) {
    const dist = new Map();
    const queue = [];
    for (const g of goals) {
      if (!graph.has_node(g)) continue;
      dist.set(g, 0);
      queue.push(g);
    }
    for (let head = 0; head < queue.length; head += 1) {
      const cur = queue[head];
      const d = dist.get(cur);
      for (const e of graph.in_edges(cur)) {
        if (dist.has(e.from)) continue;
        dist.set(e.from, d + 1);
        queue.push(e.from);
      }
    }
    return dist;
  }

  /** 纯函数：目标相关性 γ_v */
  function goalRelevance(dist, kappa) {
    if (dist === undefined) return 0;
    return Math.pow(kappa, dist);
  }

  const manifest = {
    api: 1,
    id: 'context.goal',
    name: '目标偏置（上下文调制）',
    layer: 'attention',
    level: 'core',
    phenomenon: [
      '带着目标思考时，通向目标的线索更容易被拉起来，无关联想被压下去',
      '离目标越远的节点，获得的抬升越小（折扣）',
      '注意：目标节点自身不吃偏置 —— 否则目标会自己点亮自己，扩散第 1 轮就"达成"',
    ],
    evidence: [
      { grade: 'local', note: 'Cognitive_Architecture.md §3.5 上下文调制 d_v(C)' },
      { grade: 'local', note: 'Application_Protocol.md §15「设定上下文：我现在要解决的是____」' },
    ],
    params: PARAMS,
    reads: [],
    writes: [],
    shared: [],
    requires: [],
    conflicts: ['legacy_v1'],
    acceptance: [
      {
        name: '目标的上游节点被抬高，距离越远抬得越少',
        kind: 'phenomenon',
        check() {
          const dist = new Map([['G', 0], ['mid', 1], ['far', 2]]);
          const k = 0.5;
          const near = goalRelevance(dist.get('mid'), k);
          const far = goalRelevance(dist.get('far'), k);
          return near > far && far > 0 && goalRelevance(dist.get('G'), k) === 1;
        },
      },
      {
        name: '不可达节点拿不到偏置',
        kind: 'phenomenon',
        check() {
          return goalRelevance(undefined, 0.5) === 0;
        },
      },
      {
        name: '消融：β=0 时驱动完全没有变化',
        kind: 'ablation',
        check() {
          const o = options({ beta_goal: 0 });
          return o.beta_goal === 0;
        },
      },
    ],
    hooks: {
      'drive.compute': (ctx) => {
        const o = options({
          beta_goal: ctx.param('beta_goal'),
          kappa_reach: ctx.param('kappa_reach'),
          fan_k: ctx.param('fan_k'),
        });
        const drive = ctx.payload.drive;
        if (!drive) return { skipped: 'no-drive' };
        const targets = ctx.payload.targets || [];
        const targetSet = new Set(targets);
        const dist = distanceToGoals(ctx.graph, targets);
        let biased = 0;
        for (const node of ctx.nodes()) {
          let value = drive.get(node.id) || 0;
          if (o.fan_k > 0) {
            const deg = ctx.graph.in_edges(node.id).length;
            value /= 1 + o.fan_k * Math.log(1 + deg);
          }
          // 关键：**目标节点自身不吃偏置**。偏置抬高的是「通向目标的候选」，
          // 否则目标会靠偏置自己点亮自己，扩散第 1 轮就"达成"了（实测过的错误）。
          const gamma = targetSet.has(node.id) ? 0 : goalRelevance(dist.get(node.id), o.kappa_reach);
          if (gamma > 0 && targets.length > 0) {
            value += o.beta_goal * gamma;
            biased += 1;
          }
          drive.set(node.id, value);
        }
        return { biased };
      },
    },
  };

  const api = { manifest, PARAMS, DEFAULTS, options, distanceToGoals, goalRelevance };

  if (isNode) module.exports = api;
  else globalThis.MindNet = Object.assign(globalThis.MindNet || {}, { contextGoal: api });
})();
