'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Config, createKernel } = require('../src/index.js');
const { FastEngine } = require('../src/v2/engine.js');
const belief = require('../mechanisms/metacognition.belief.js');
const bottleneck = require('../mechanisms/diagnosis.bottleneck.js');
const planner = require('../mechanisms/control.planner.js');
const { PROFILES } = require('../mechanisms/index.js');
const { makeGraph } = require('./helpers.js');

const CFG = () => new Config();

function v2(graph, options) {
  const opts = Object.assign({ seed: 3, hours: 0, profile: 'v2' }, options || {});
  const config = CFG();
  const kernel = createKernel(graph, config, opts);
  return new FastEngine(graph, config, Object.assign({}, opts, { kernel }));
}

test('v2.0 · 元认知：集中重复抬高自信，但不抬高可提取性（流畅性错觉）', () => {
  const g = makeGraph(
    [['A', { ms: 0.9 }], ['strong', { ms: 0.5 }], ['weak', { ms: 0.5 }]],
    [['A', 'strong', 0.9], ['A', 'weak', 0.25]]
  );
  const e = v2(g);
  e.start_diffusion(['A'], []);
  for (let i = 0; i < 5; i += 1) e.step();

  const report = e.control_report();
  const rows = {};
  for (const r of report.metacognition.rows) rows[r.node] = r;

  // 两个节点的记忆状态完全一样（都没复习过）
  assert.equal(g.get_node('strong').ms, g.get_node('weak').ms, '两者的可提取度相同');
  // 但被反复点亮的那个，自信明显更高
  assert.ok(rows.strong.belief > rows.weak.belief + 0.05,
    `集中重复应抬高自信：strong=${rows.strong.belief} vs weak=${rows.weak.belief}`);  assert.ok(Math.abs(rows.strong.R - rows.weak.R) < 1e-9, '可提取度没有差别');
});

test('v2.0 · 元认知：危险区 = 自信高而可提取度低', () => {
  // 编码很浅（ms=0.3 ⇒ R0 上限 0.3）但被强线索反复点亮 ⇒ 感觉熟、其实取不出
  const g = makeGraph([['A', { ms: 0.9 }], ['shallow', { ms: 0.3 }]], [['A', 'shallow', 0.95]]);
  const e = v2(g);
  e.start_diffusion(['A'], []);
  for (let i = 0; i < 4; i += 1) e.step();
  const meta = e.control_report().metacognition;
  const dangerIds = meta.danger.map((d) => d.node);
  assert.ok(dangerIds.includes('shallow'), `shallow 应进危险区：${JSON.stringify(meta.danger)}`);
  assert.ok(meta.calibration > 0, '校准度应当大于 0（自信与实际有偏差）');
});

test('v2.0 · 卡点分类：没有入口 / 线索太弱 / 差点想起 / 超载 各归各位', () => {
  // 星图：中心 C 强连 12 个叶子（制造容量竞争）+ 孤立节点 + 极弱连接 + 接近阈值的节点
  const nodes = [['C', { ms: 0.9 }], ['lonely', { ms: 0.6 }], ['faint', { ms: 0.6 }], ['nearly', { ms: 0.6 }]];
  const edges = [['C', 'faint', 0.08], ['C', 'nearly', 0.23]];
  for (let i = 0; i < 12; i += 1) { nodes.push([`L${i}`, { ms: 0.9 }]); edges.push(['C', `L${i}`, 0.95]); }
  const g = makeGraph(nodes, edges);
  // T_ign=0 ⇒ 硬阈值，分类可判定（否则弱节点可能被 ~1% 的概率幸运点亮）
  const e = v2(g, { overrides: { 'attention.ignition.T_ign': 0 } });
  e.start_diffusion(['C'], []);
  for (let i = 0; i < 3; i += 1) e.step();

  const report = e.control_report();
  const rows = {};
  for (const b of report.diagnosis) rows[b.node] = b;

  assert.equal(rows.lonely.type, 'empty', '没有入边 ⇒ 空');
  assert.equal(rows.lonely.subtype, 'no_entry');
  assert.equal(rows.faint.type, 'empty', '有入口但线索太弱 ⇒ 空（too_faint）');
  assert.equal(rows.faint.subtype, 'too_faint');
  assert.equal(rows.nearly.type, 'weak', `接近阈值的节点应是「差点想起」，实际 ${JSON.stringify(rows.nearly)}`);

  const overloaded = report.diagnosis.filter((b) => b.type === 'overload');
  assert.ok(overloaded.length >= 1, `应当有节点被判为超载（被容量挤出），实际 ${JSON.stringify(Object.keys(rows))}`);
  assert.ok(!overloaded[0].prescriptions.includes('add_in_edges'), '超载不是知识缺口');
  assert.ok(overloaded[0].prescriptions.includes('offload_working_memory'));
});

test('v2.0 · 规划器：能模拟的给数值，不能模拟的明说（不假装算过）', () => {
  const nodes = [['A', { ms: 0.9 }], ['mid', { ms: 0.6 }], ['goal', { ms: 0.6 }]];
  const edges = [['A', 'mid', 0.12], ['mid', 'goal', 0.9]];
  const g = makeGraph(nodes, edges);
  const e = v2(g);
  e.start_diffusion(['A'], ['goal']);
  for (let i = 0; i < 3; i += 1) e.step();

  const report = e.control_report();
  assert.ok(report.plan.length > 0, '应当产出处方清单');

  const simulated = report.plan.filter((p) => p.simulated);
  const ruleOnly = report.plan.filter((p) => !p.simulated);
  assert.ok(simulated.length > 0, '至少有可模拟的干预');
  for (const p of simulated) {
    assert.ok(typeof p.gain === 'number' && typeof p.value === 'number');
    assert.ok(p.metric === 'retention' || p.metric === 'reachability');
    assert.ok(p.why.length > 0);
  }
  for (const p of ruleOnly) assert.ok(p.why.length > 0, '不模拟也要说清为什么');

  // 排序：能算的排前面
  const firstRuleOnly = report.plan.findIndex((p) => !p.simulated);
  const lastSimulated = report.plan.map((p) => p.simulated).lastIndexOf(true);
  if (firstRuleOnly >= 0 && lastSimulated >= 0) assert.ok(lastSimulated < firstRuleOnly);
});

test('v2.0 · 规划器：对"差点想起来"的节点做一次提取，预测留存增益为正', () => {
  const nodes = [['A', { ms: 0.9 }], ['mid', { ms: 0.6 }], ['goal', { ms: 0.6 }]];
  const edges = [['A', 'mid', 0.12], ['mid', 'goal', 0.9]];
  const g = makeGraph(nodes, edges);
  const e = v2(g);
  e.start_diffusion(['A'], ['goal']);
  for (let i = 0; i < 3; i += 1) e.step();

  const plan = e.control_report().plan;
  const retrieval = plan.find((p) => p.metric === 'retention' && p.gain > 0);
  assert.ok(retrieval, `应有一次提取的留存增益为正：${JSON.stringify(plan.map((p) => [p.instruction, p.gain, p.simulated]))}`);
  assert.ok(retrieval.cost > 0 && retrieval.value > 0);
});

test('v2.0 · 规划器：补入边的反事实会在副本上真的加一条边（原图不被改动）', () => {
  const nodes = [['A', { ms: 0.9 }], ['B', { ms: 0.9 }], ['iso', { ms: 0.6 }]];
  const g = makeGraph(nodes, [['A', 'B', 0.9]]);
  const e = v2(g);
  e.start_diffusion(['A', 'B'], ['iso']);
  for (let i = 0; i < 2; i += 1) e.step();

  const before = g.edges.length;
  const outcome = planner.applyIntervention(e.clone(), 'iso', 'add_in_edges', {});
  assert.equal(outcome.applied, true);
  assert.equal(outcome.metric, 'reachability');
  assert.equal(g.edges.length, before, '原图不能被反事实改动');
});

test('v2.0 · 消融：sim_rounds=0（不模拟）时全部标为未模拟', () => {
  const nodes = [['A', { ms: 0.9 }], ['mid', { ms: 0.6 }], ['goal', { ms: 0.6 }]];
  const edges = [['A', 'mid', 0.12], ['mid', 'goal', 0.9]];
  const g = makeGraph(nodes, edges);
  const e = v2(g, { overrides: { 'control.planner.sim_rounds': 0 } });
  e.start_diffusion(['A'], ['goal']);
  for (let i = 0; i < 3; i += 1) e.step();
  const plan = e.control_report().plan;
  assert.ok(plan.length > 0);
  assert.equal(plan.filter((p) => p.simulated).length, 0, '不模拟时不应有 simulated 项');
});

test('v2.0 · 确定性：同 seed 的控制层报告完全一致', () => {
  const build = () => {
    const g = makeGraph(
      [['A', { ms: 0.9 }], ['mid', { ms: 0.6 }], ['goal', { ms: 0.6 }]],
      [['A', 'mid', 0.12], ['mid', 'goal', 0.9]]
    );
    const e = v2(g, { seed: 9 });
    e.start_diffusion(['A'], ['goal']);
    for (let i = 0; i < 3; i += 1) e.step();
    return e.control_report();
  };
  const a = build();
  const b = build();
  assert.deepEqual(a.plan, b.plan);
  assert.deepEqual(a.metacognition.danger, b.metacognition.danger);
  assert.deepEqual(a.diagnosis, b.diagnosis);
});

test('v2.0 · 协议：state() 里带控制层报告，且机制清单含三个控制层模块', () => {
  const g = makeGraph([['A', { ms: 0.9 }], ['B', { ms: 0.6 }]], [['A', 'B', 0.9]]);
  const e = v2(g);
  e.start_diffusion(['A'], ['B']);
  e.run_until_stop(6);
  const state = e.state();
  assert.ok(state.control && Array.isArray(state.control.plan));
  assert.ok(state.control.metacognition, '应有元认知报告');
  for (const id of ['metacognition.belief', 'diagnosis.bottleneck', 'control.planner']) {
    assert.ok(state.mechanisms.includes(id), `机制清单应含 ${id}`);
    assert.ok(PROFILES.v2.includes(id));
  }
});

test('v2.0 · 指令库：17 条应用协议指令在册，4 条执行层指令单独标注来源', () => {
  const ids = Object.keys(planner.INSTRUCTIONS);
  const app = ids.filter((k) => planner.INSTRUCTIONS[k].source === 'application');
  const exec = ids.filter((k) => planner.INSTRUCTIONS[k].source === 'executive');
  assert.equal(app.length, 17, `应用协议指令应为 17 条，实际 ${app.length}`);
  assert.equal(exec.length, 4, `执行层指令应为 4 条，实际 ${exec.length}`);
  assert.ok(bottleneck.PRESCRIPTION.overload.includes('offload_working_memory'));
  assert.equal(typeof belief.beliefOf(0.5, 0.8, 0), 'number');
});
