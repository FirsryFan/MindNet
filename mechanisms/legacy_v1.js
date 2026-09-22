/**
 * 机制模块：v1.1 兼容包（把旧规则原样实现成模块）
 *
 * 作用有两个：
 *   1. 证明插件架构能表达旧模型 —— 新旧不是两套代码，而是两份模块配置；
 *   2. 让「差分等价测试」成为可能：FastEngine + legacy_v1 应当逐轮复现 v1.1 引擎的状态演化。
 *
 * 它实现的四条旧规则：
 *   驱动的入边汇总取**最大值**（不是求和）
 *   激活 = 状态常数（1.0 / 0.3 / 0.0），没有衰减、没有距离代价
 *   容量无限（全部候选都准入）
 *   硬阈值判定 + **永久亮着**（一旦激活，此后不再降级）
 */
(function () {
  'use strict';

  const isNode = typeof module !== 'undefined' && !!module.exports;
  const deps = isNode
    ? Object.assign({}, require('../src/config.js'), require('../src/model.js'))
    : (globalThis.MindNet || {});
  const { MindNetError, STATE } = deps;

  const AL = { CONSCIOUS: 1.0, SUBCONSCIOUS: 0.3, INACTIVE: 0.0 };

  function alphaOf(state) {
    return AL[state] === undefined ? 0 : AL[state];
  }

  /** 纯函数：v1.1 的入边影响力（取最大值） */
  function legacyImpact(edges, msOf, stateOf, lsOf) {
    let best = 0;
    for (const e of edges) {
      const impact = msOf(e.from) * alphaOf(stateOf(e.from)) * lsOf(e);
      if (impact > best) best = impact;
    }
    return best;
  }

  /** 纯函数：v1.1 的阈值判定 */
  function legacyJudge(impact, ct, st) {
    if (impact >= ct) return STATE.CONSCIOUS;
    if (impact >= st) return STATE.SUBCONSCIOUS;
    return STATE.INACTIVE;
  }

  const manifest = {
    api: 1,
    id: 'legacy_v1',
    name: 'v1.1 兼容包（旧扩散规则）',
    layer: 'attention',
    level: 'optional',
    phenomenon: [
      '旧模型的行为：取最大值、硬阈值、永久亮着、容量无限 —— 作为可复现的兼容基线',
    ],
    evidence: [{ grade: 'local', note: 'docs/DESIGN_v1.1.md §5.2（v1.1 的每轮更新规则）' }],
    params: [],
    reads: ['ms', 'state', 'ct', 'st'],
    writes: [],
    shared: ['a', 'q'],
    requires: [],
    conflicts: ['dynamics.shunting', 'attention.capacity', 'attention.ignition', 'rhythm.gate', 'context.goal'],
    acceptance: [
      {
        name: '取最大值：10 条弱线索不会汇聚（v1.1 的行为）',
        kind: 'phenomenon',
        check() {
          const edges = Array.from({ length: 10 }, (_, i) => ({ from: `S${i}`, ls: 0.08 }));
          const impact = legacyImpact(edges, () => 0.5, () => STATE.CONSCIOUS, (e) => e.ls);
          return Math.abs(impact - 0.04) < 1e-12; // 求和会是 0.40
        },
      },
      {
        name: '硬阈值判定：impact ≥ ct → 显意识；≥ st → 潜意识',
        kind: 'phenomenon',
        check() {
          return legacyJudge(0.3, 0.3, 0.05) === STATE.CONSCIOUS
            && legacyJudge(0.29, 0.3, 0.05) === STATE.SUBCONSCIOUS
            && legacyJudge(0.01, 0.3, 0.05) === STATE.INACTIVE;
        },
      },
      {
        name: '消融：v2 的求和驱动与 v1.1 的取最大在同一图上给出不同结果',
        kind: 'ablation',
        check() {
          const edges = Array.from({ length: 10 }, (_, i) => ({ from: `S${i}`, ls: 0.08 }));
          const maxImpact = legacyImpact(edges, () => 0.5, () => STATE.CONSCIOUS, (e) => e.ls);
          const sumImpact = edges.reduce((s, e) => s + 0.5 * 1.0 * e.ls, 0);
          return sumImpact > maxImpact * 5;
        },
      },
    ],
    hooks: {
      // v1.1：AL = 状态常数
      'activation.update': (ctx) => {
        const next = new Map();
        for (const node of ctx.nodes()) {
          next.set(node.id, alphaOf(node.state));
          ctx.patchShared(node.id, { a: alphaOf(node.state), q: 0 });
        }
        ctx.payload.next = next;
        return { mode: 'state-constants' };
      },
      // v1.1：入边取最大值
      'drive.compute': (ctx) => {
        const drive = new Map();
        for (const node of ctx.nodes()) drive.set(node.id, 0);
        for (const node of ctx.nodes()) {
          const impact = legacyImpact(
            ctx.graph.in_edges(node.id),
            (id) => ctx.node(id).ms,
            (id) => ctx.node(id).state,
            (e) => e.ls
          );
          drive.set(node.id, impact);
        }
        ctx.payload.drive = drive;
        return { mode: 'max-aggregation' };
      },
      // v1.1：状态落定后把 AL 同步成状态常数（等价于 v1.1 的「4b 让 al 与 state 一致」）
      'state.after': (ctx) => {
        for (const node of ctx.nodes()) {
          ctx.patchShared(node.id, { a: alphaOf(node.state), q: 0 });
        }
        return { synced: ctx.nodes().length };
      },
      // v1.1：容量无限
      'attention.select': (ctx) => {
        ctx.payload.admitted = ctx.nodes().map((n) => n.id);
        ctx.payload.focus = null;
        return { admitted: ctx.payload.admitted.length };
      },
      // v1.1：硬阈值 + 永久亮着
      'ignite.check': (ctx) => {
        const store = ctx.store();
        if (!store.ever) store.ever = {};
        const conscious = [];
        const subconscious = [];
        for (const node of ctx.nodes()) {
          const id = node.id;
          // 永久亮着：曾被激活过的节点不再降级（等价于 v1.1 的「已激活则跳过」）
          if (!store.ever[id] && node.state !== STATE.INACTIVE) store.ever[id] = node.state;
          if (store.ever[id] === STATE.CONSCIOUS) { conscious.push(id); continue; }
          if (store.ever[id] === STATE.SUBCONSCIOUS) { subconscious.push(id); continue; }
          const impact = ctx.payload.drive.get(id) || 0;
          const verdict = legacyJudge(impact, node.ct_of(ctx.config), node.st_of(ctx.config));
          if (verdict === STATE.CONSCIOUS) { store.ever[id] = STATE.CONSCIOUS; conscious.push(id); }
          else if (verdict === STATE.SUBCONSCIOUS) { store.ever[id] = STATE.SUBCONSCIOUS; subconscious.push(id); }
        }
        ctx.payload.conscious = conscious;
        ctx.payload.subconscious = subconscious;
        return { conscious: conscious.length, subconscious: subconscious.length };
      },
    },
  };

  const api = { manifest, AL, alphaOf, legacyImpact, legacyJudge };

  if (isNode) module.exports = api;
  else globalThis.MindNet = Object.assign(globalThis.MindNet || {}, { legacyV1: api });
})();
