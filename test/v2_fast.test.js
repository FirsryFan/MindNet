'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Graph, Config, CognitiveModel, createKernel, listMechanisms } = require('../src/index.js');
const { FastEngine } = require('../src/v2/engine.js');
const { MechanismKernel } = require('../src/core/kernel.js');
const { PROFILES } = require('../mechanisms/index.js');
const { makeGraph } = require('./helpers.js');

const CONFIG = () => new Config();

function v2Engine(graph, options) {
  const opts = Object.assign({ seed: 11, hours: 0, profile: 'v2' }, options || {});
  const kernel = createKernel(graph, CONFIG(), opts);
  return new FastEngine(graph, CONFIG(), Object.assign({}, opts, { kernel }));
}

function legacyEngine(graph, options) {
  const opts = Object.assign({ seed: 11, hours: 0, profile: 'legacy' }, options || {});
  const kernel = createKernel(graph, CONFIG(), opts);
  return new FastEngine(graph, CONFIG(), Object.assign({}, opts, { kernel }));
}

function stateMap(graph) {
  const out = {};
  for (const n of graph.nodes.values()) out[n.id] = n.state;
  return out;
}

// ------------------------------------------------------------------ 规律 2
test('v1.3 · 规律 2 翻转：200 节点星图不再 1 轮全亮（容量约束生效）', () => {
  const nodes = [['C', { ms: 0.9 }]];
  const edges = [];
  for (let i = 0; i < 200; i += 1) {
    nodes.push([`L${i}`, { ms: 0.9 }]);
    edges.push(['C', `L${i}`, 0.9]);
  }
  const g = makeGraph(nodes, edges);

  const m1 = new CognitiveModel(g, CONFIG());
  m1.start_diffusion(['C'], []);
  m1.step();
  const v1Conscious = Array.from(g.nodes.values()).filter((n) => n.state === 'CONSCIOUS').length;
  assert.equal(v1Conscious, 201, 'v1.1 的行为：一轮全亮');

  const g2 = makeGraph(nodes, edges);
  const e2 = v2Engine(g2);
  e2.start_diffusion(['C'], []);
  const st = e2.step();
  const v2Conscious = Array.from(g2.nodes.values()).filter((n) => n.state === 'CONSCIOUS').length;
  assert.ok(v2Conscious <= 20, `v2 应在容量内（实际 ${v2Conscious}，v1.1 是 201）`);
  assert.ok(v2Conscious >= 2, '不应一个都不亮');
  assert.ok(st.activated.length < 25);
});

// ------------------------------------------------------------------ 规律 3
test('v1.3 · 规律 3 翻转：10 条弱线索汇聚能把节点拉进意识（v1.1 判 INACTIVE）', () => {
  const nodes = [['Y', { weight: 1 }]];
  const edges = [];
  for (let i = 0; i < 10; i += 1) {
    nodes.push([`S${i}`, { ms: 0.5 }]);
    edges.push([`S${i}`, 'Y', 0.08]); // 单条 0.04 < ST 0.05；十条合计 0.40 ≥ CT 0.3
  }
  const starts = nodes.slice(1).map((n) => n[0]);

  const g1 = makeGraph(nodes, edges);
  const m1 = new CognitiveModel(g1, CONFIG());
  m1.start_diffusion(starts, []);
  m1.run_until_stop();
  assert.equal(g1.get_node('Y').state, 'INACTIVE', 'v1.1：取最大值，汇聚无效');

  const g2 = makeGraph(nodes, edges);
  // 隔离「汇聚」与「容量」：把带宽开大，单独检验求和 + 亚阈累积
  const e2 = v2Engine(g2, { overrides: { 'attention.capacity.W_DAR': 100, 'attention.capacity.W_FA': 100 } });
  e2.start_diffusion(starts, []);
  e2.run_until_stop(12);
  assert.notEqual(g2.get_node('Y').state, 'INACTIVE', 'v2：求和 + 亚阈累积应当把它拉起来');
  assert.equal(e2.ever_activated.includes('Y'), true);
  // 直接比较两种汇总方式给出的驱动力：v1.1 取最大值 = 0.04，v2 求和 = 0.40
  const v2Peak = e2._peakDrive.get('Y') || 0;
  assert.ok(v2Peak >= 0.35, `v2 的峰值驱动应当接近十条之和（实际 ${v2Peak}）`);
});

// ------------------------------------------------------------------ 规律 4
test('v1.3 · 规律 4 翻转：信号随距离衰减（v1.1 每跳一样强）', () => {
  const chain = ['A', 'B', 'C', 'D', 'E', 'F'];
  const nodes = chain.map((id) => [id, { ms: 0.9 }]);
  const edges = chain.slice(0, -1).map((id, i) => [id, chain[i + 1], 0.9]);

  const g2 = makeGraph(nodes, edges);
  const e2 = v2Engine(g2);
  e2.start_diffusion(['A'], []);
  e2.run_until_stop(12);
  const peaks = chain.map((id) => e2._peakDrive.get(id) || 0);
  // A 是起点（没有入边），从 B 开始看：驱动应逐跳下降
  for (let i = 2; i < peaks.length; i += 1) {
    assert.ok(peaks[i] < peaks[i - 1] + 1e-9, `第 ${i} 跳的峰值驱动应小于前一跳：${peaks.join(', ')}`);
  }
  assert.ok(peaks[peaks.length - 1] < peaks[1], '末端驱动必须明显弱于第一跳');

  // 对照 v1.1：每跳首次 Impact 都是 ms·ls = 0.81
  const g1 = makeGraph(nodes, edges);
  const m1 = new CognitiveModel(g1, CONFIG());
  m1.start_diffusion(['A'], []);
  m1.run_until_stop();
  const v1Impacts = m1.kc_breakdown().gap.map((r) => r.impact);
  assert.ok(v1Impacts.every((x) => Math.abs(x - 0.81) < 1e-9), `v1.1 每跳都是 0.81：${v1Impacts}`);
});

// ------------------------------------------------------------ 概率点火
test('v1.3 · 概率点火：T=0 硬阈值；T>0 可复现但跨 seed 不同', () => {
  const build = () => makeGraph(
    [['A', { ms: 0.8 }], ['B', { ct: 0.35 }]],
    [['A', 'B', 0.9]]
  );
  // T=0：不同 seed 结果一致（硬阈值）
  const hard = [];
  for (const seed of [1, 2, 3]) {
    const g = build();
    const e = v2Engine(g, { seed, overrides: { 'attention.ignition.T_ign': 0 } });
    e.start_diffusion(['A'], []);
    e.run_until_stop(4);
    hard.push(g.get_node('B').state);
  }
  assert.equal(new Set(hard).size, 1, 'T=0 时应当与随机种子无关');

  // T>0：同 seed 可复现
  const run = (seed) => {
    const g = build();
    const e = v2Engine(g, { seed, overrides: { 'attention.ignition.T_ign': 0.5 } });
    e.start_diffusion(['A'], []);
    e.run_until_stop(6);
    return JSON.stringify(stateMap(g)) + JSON.stringify(e.target_steps());
  };
  assert.equal(run(7), run(7), '同 seed 必须逐位一致');
  const diff = new Set([run(7), run(8), run(9), run(10)]);
  assert.ok(diff.size > 1, 'T 较大时不同 seed 应出现不同结果（意识进入是概率性的）');
});

// ------------------------------------------------------------ 节律门控
test('v1.3 · 节律门控：半秒在会拖慢传递；完全不在则彻底想不起来', () => {
  const build = () => makeGraph(
    [['A', { ms: 0.9 }], ['B', {}], ['C', {}]],
    [['A', 'B', 0.9], ['B', 'C', 0.9]]
  );
  // 用「B 第一次进入意识的轮次」做指标：B 不是目标，不会被目标偏置提前点亮
  const run = (duty) => {
    const g = build();
    const e = v2Engine(g, {
      overrides: { 'rhythm.gate.duty': duty, 'rhythm.gate.T0_seconds': 1, 'rhythm.gate.tick_ms': 250 },
    });
    e.start_diffusion(['A'], ['C']);
    let firstConscious = null;
    for (let r = 1; r <= 30 && !e.stopped; r += 1) {
      e.step();
      if (firstConscious === null && g.get_node('B').state === 'CONSCIOUS') firstConscious = r;
    }
    return { firstConscious, ever: e.ever_activated, reason: e.stop_reason };
  };

  const awake = run(1);
  const half = run(0.5);
  const dark = run(0.05); // duty=0.05 × 4 tick ⇒ 0 个开放 tick，等价于全程走神

  assert.equal(awake.firstConscious, 1, '全开门控下 B 应当在第 1 轮进入意识');
  assert.ok(half.firstConscious === null || half.firstConscious > awake.firstConscious,
    `半秒在应当更慢：全开 ${awake.firstConscious} 轮，半开 ${half.firstConscious} 轮`);
  assert.equal(dark.ever.includes('B'), false, '完全不在状态时连 B 都点不亮');
  assert.equal(dark.reason, 'cooling', '全程走神应以思维冷却收场');
});

// -------------------------------------------------- 负荷自适应节拍
test('v1.3 · 负荷自适应：装得越满，一个思维周期越长', () => {
  const { cycleTicksFor } = require('../mechanisms/rhythm.gate.js');
  const o = { T0_seconds: 1, tick_ms: 250, lambda_load: 1 };
  assert.equal(cycleTicksFor(0, o), 4);
  assert.equal(cycleTicksFor(4, o), 8);

  // 运行时：高负荷图里，同样 3 轮会推进更多 tick
  const low = makeGraph([['A', { ms: 0.9 }], ['B', {}]], [['A', 'B', 0.9]]);
  const eLow = v2Engine(low);
  eLow.start_diffusion(['A'], []);
  for (let i = 0; i < 3; i += 1) eLow.step();

  const nodes = [['A', { ms: 0.9 }]];
  const edges = [];
  for (let i = 0; i < 8; i += 1) { nodes.push([`N${i}`, { ms: 0.9 }]); edges.push(['A', `N${i}`, 0.9]); }
  const high = makeGraph(nodes, edges);
  const eHigh = v2Engine(high);
  eHigh.start_diffusion(['A'], []);
  for (let i = 0; i < 3; i += 1) eHigh.step();

  assert.ok(eHigh.kernel.tick > eLow.kernel.tick,
    `高负荷图应推进更多 tick：${eHigh.kernel.tick} vs ${eLow.kernel.tick}`);
});

// ------------------------------------------------------ v1.1 差分等价
test('v1.3 · 差分等价：FastEngine + legacy_v1 逐轮复现 v1.1 的状态演化', () => {
  const cases = [
    {
      name: '链',
      nodes: [['A', { ms: 0.9 }], ['B', { ms: 0.8 }], ['C', { ms: 0.7 }], ['D', { ms: 0.6 }]],
      edges: [['A', 'B', 0.9], ['B', 'C', 0.8], ['C', 'D', 0.7]],
      starts: ['A'], targets: [],
    },
    {
      name: '菱形',
      nodes: [['A', { ms: 1.0 }], ['B', { ms: 0.8 }], ['C', { ms: 0.6 }], ['D', { ms: 0.7 }]],
      edges: [['A', 'B', 0.9], ['A', 'C', 0.5], ['B', 'D', 0.9], ['C', 'D', 0.9]],
      starts: ['A'], targets: ['D'],
    },
    {
      name: '扇出 + 阈值边界',
      nodes: [['A', { ms: 0.5 }], ['B', { ct: 0.3 }], ['C', { ct: 0.35 }], ['D', { st: 0.3 }]],
      edges: [['A', 'B', 0.6], ['A', 'C', 0.7], ['A', 'D', 0.5]],
      starts: ['A'], targets: [],
    },
  ];
  for (const c of cases) {
    const g1 = makeGraph(c.nodes, c.edges);
    const g2 = makeGraph(c.nodes, c.edges);
    const m1 = new CognitiveModel(g1, CONFIG());
    const e2 = legacyEngine(g2);
    m1.start_diffusion(c.starts, c.targets);
    e2.start_diffusion(c.starts, c.targets);
    const rounds = 4;
    for (let r = 1; r <= rounds; r += 1) {
      const s1 = m1.stopped ? null : m1.step();
      const s2 = e2.stopped ? null : e2.step();
      if (!s1 && !s2) break;
      assert.deepEqual(stateMap(g2), stateMap(g1), `第 ${r} 轮状态不一致（${c.name}）`);
    }
    assert.deepEqual(e2.target_steps(), m1.target_steps(), `目标步数不一致（${c.name}）`);
    const a1 = g1.node_ids().map((id) => g1.get_node(id).al);
    const a2 = g2.node_ids().map((id) => g2.get_node(id).al);
    assert.deepEqual(a2, a1, `al 必须与 v1.1 一致（${c.name}）`);
  }
});

// ---------------------------------------------------------- 协议与确定性
test('v1.3 · 输出协议与确定性：同 seed 同结果、四字段齐全、无不变量告警', () => {
  const build = () => makeGraph(
    [['trig', { ms: 0.9 }], ['unit', { ms: 0.8 }], ['sine', { ms: 0.7 }], ['solve', { ms: 0.6 }], ['polar', { ms: 0.2 }]],
    [['trig', 'unit', 0.9], ['unit', 'sine', 0.8], ['sine', 'solve', 0.9], ['solve', 'polar', 0.3]]
  );
  const run = () => {
    const g = build();
    const e = v2Engine(g, { seed: 5 });
    e.start_diffusion(['trig'], ['solve', 'polar']);
    const result = e.run_until_stop(20);
    return { result, hash: e.kernel.stateHash(), warnings: e.kernel.warnings.length, engine: e };
  };
  const a = run();
  const b = run();
  assert.deepEqual(Object.keys(a.result).sort(), ['final_states', 'kc', 'target_steps', 'targets_all_reached']);
  assert.deepEqual(a.result.kc, b.result.kc, '同 seed 的 KC 必须一致');
  assert.equal(a.hash, b.hash, '同 seed 的状态指纹必须一致');
  assert.equal(a.warnings, 0, '正常路径不应产生内核告警');
  assert.equal(a.result.targets_all_reached, true, '解三角形应当被激活');
  // 目标偏置会让「目标」从第 1 轮起就半亮，所以 target_steps 恒为 1；
  // 传播距离要看峰值驱动是否随距离递减
  const peaks = ['unit', 'sine', 'solve'].map((id) => a.engine._peakDrive.get(id) || 0);
  assert.ok(peaks[0] > peaks[1] && peaks[1] > peaks[2], `峰值驱动应随距离递减：${peaks.join(' > ')}`);
  assert.ok(peaks[2] > 0, '末端仍应收到信号（不是零）');
});

// ------------------------------------------------------------ 机制清单
test('v1.3 · 机制清单：profile v2 装载六个模块，legacy 与 v2 快层互斥', () => {
  const ids = listMechanisms().map((m) => m.id);
  for (const id of PROFILES.v2) assert.ok(ids.includes(id), `缺少模块 ${id}`);
  assert.deepEqual(PROFILES.legacy, ['memory.dsr', 'legacy_v1']);

  const g = makeGraph([['A', {}]], []);
  const ok = createKernel(g, CONFIG(), { profile: 'v2' });
  assert.deepEqual(ok.enabledIds(), PROFILES.v2);

  // legacy_v1 与 v2 快层同时装载必须报错（冲突检测）
  assert.throws(() => {
    const g2 = makeGraph([['A', {}]], []);
    const k = new MechanismKernel(g2, CONFIG(), { seed: 1 });
    const loaded = require('../mechanisms/index.js').loadMechanisms();
    k.load(loaded.filter((x) => ['legacy_v1', 'dynamics.shunting'].includes(x.manifest.id)).map((x) => x.manifest));
  }, /不能同时启用/);
});
