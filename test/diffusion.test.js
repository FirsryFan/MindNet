'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Config, CognitiveModel, MindNetError, STATE } = require('../src/index.js');
const { NOW, makeGraph } = require('./helpers.js');

test('§8.2 文档示例：node_1 起点 → node_2 目标，第一轮激活', () => {
  const g = makeGraph(
    [
      ['node_1', { name: '三角函数', weight: 0.9, ms: 0.8, ct: 0.3, st: 0.05 }],
      ['node_2', { name: '正弦定理', weight: 0.7, ms: 0.6, ct: 0.3, st: 0.05 }],
    ],
    [['node_1', 'node_2', 0.8]]
  );
  const m = new CognitiveModel(g, new Config());
  m.start_diffusion(['node_1'], ['node_2']);
  const result = m.run_until_stop();

  assert.deepEqual(result, {
    kc: { gap: 0, penalty: 0 },
    target_steps: { node_2: 1 },
    targets_all_reached: true,
    final_states: { node_1: STATE.CONSCIOUS, node_2: STATE.CONSCIOUS },
  });
  assert.equal(m.rounds, 1);
  assert.equal(m.stop_reason, 'all_targets_reached');
  assert.equal(g.get_node('node_2').al, 1.0, 'al 必须与 state 一致（CONSCIOUS → 1.0）');
});

test('不变式：任何一次停止后，al 都与 state 对应', () => {
  const g = makeGraph(
    [['A', { ms: 1.0 }], ['B', {}], ['C', {}], ['D', {}]],
    [
      ['A', 'B', 0.9],
      ['A', 'C', 0.05],
      ['A', 'D', 0.01],
    ]
  );
  const m = new CognitiveModel(g, new Config());
  m.start_diffusion(['A'], ['B']);
  m.run_until_stop();

  const expected = { CONSCIOUS: 1.0, SUBCONSCIOUS: 0.3, INACTIVE: 0.0 };
  for (const node of g.nodes.values()) {
    assert.equal(node.al, expected[node.state], `${node.id} 的 al 与 state 不一致`);
  }
});

test('状态判定：Impact ≥ CT → 显意识；ST ≤ Impact < CT → 潜意识；< ST → 未激活', () => {
  const g = makeGraph(
    [['A', { ms: 1.0 }], ['B', {}], ['C', {}], ['D', {}]],
    [
      ['A', 'B', 0.3],    // impact = 0.30 == CT → CONSCIOUS
      ['A', 'C', 0.05],   // impact = 0.05 == ST → SUBCONSCIOUS
      ['A', 'D', 0.049],  // impact = 0.049 < ST → INACTIVE，记一次尝试
    ]
  );
  const m = new CognitiveModel(g, new Config());
  m.start_diffusion(['A'], []);
  m.run_until_stop();

  assert.equal(g.get_node('B').state, STATE.CONSCIOUS);
  assert.equal(g.get_node('B').al, 1.0);
  assert.equal(g.get_node('C').state, STATE.SUBCONSCIOUS);
  assert.equal(g.get_node('C').al, 0.3);
  assert.equal(g.get_node('D').state, STATE.INACTIVE);
  assert.equal(g.get_node('D').al, 0.0);
  assert.equal(g.get_node('D').visit_count, 1);
  // Gap = (1.2*0.3 - 0.30) + (1.2*0.3 - 0.05) = 0.06 + 0.31 = 0.37
  assert.deepEqual(m.get_kc(), { gap: 0.37, penalty: 1 });
});

test('永久亮着：已激活节点不再被入边修改，仍作为源节点传播；首次 Impact 不被覆盖', () => {
  const g = makeGraph(
    [['A', { ms: 1.0 }], ['B', {}], ['C', { ms: 1.0 }]],
    [
      ['A', 'B', 0.15], // 第 1 轮：B impact 0.15 → SUBCONSCIOUS
      ['A', 'C', 0.9],  // 第 1 轮：C impact 0.90 → CONSCIOUS
      ['C', 'B', 0.9],  // 第 2 轮：B 已激活 → 必须跳过
    ]
  );
  const m = new CognitiveModel(g, new Config());
  m.start_diffusion(['A'], []);
  m.run_until_stop();

  assert.equal(g.get_node('B').state, STATE.SUBCONSCIOUS);
  assert.equal(g.get_node('B').al, 0.3);
  assert.equal(g.get_node('C').state, STATE.CONSCIOUS);
  // B 的 Gap 用首次 Impact 0.15：1.0 * (1.2*0.3 - 0.15) = 0.21
  assert.deepEqual(m.get_kc(), { gap: 0.21, penalty: 0 });
});

test('多起点共享扩散：同一轮内一起传播，跨轮才继续下传', () => {
  const g = makeGraph(
    [['A', { ms: 1.0 }], ['B', { ms: 1.0 }], ['C', { ms: 1.0 }], ['D', {}], ['E', {}]],
    [
      ['B', 'C', 0.9], // C 第 1 轮激活（同一起始轮）
      ['B', 'D', 0.9], // D 第 1 轮激活
      ['C', 'E', 0.9], // E 依赖 C → 第 2 轮激活
    ]
  );
  const m = new CognitiveModel(g, new Config());
  m.start_diffusion(['A', 'B'], ['D', 'E']);
  const result = m.run_until_stop();

  assert.deepEqual(result.target_steps, { D: 1, E: 2 });
  assert.equal(result.targets_all_reached, true);
  assert.equal(result.final_states.C, STATE.CONSCIOUS);
  assert.equal(m.rounds, 2);
});

test('追加起点：下一轮生效，已激活/已是起点则跳过，停止后不可追加', () => {
  const g = makeGraph(
    [['A', { ms: 1.0 }], ['B', { ms: 1.0 }], ['C', {}]],
    [['B', 'C', 0.9]]
  );
  const m = new CognitiveModel(g, new Config());
  m.start_diffusion(['A'], ['C']);

  m.step(); // 第 1 轮：A 无出边，C 未激活
  assert.equal(m.rounds, 1);
  assert.equal(g.get_node('B').state, STATE.INACTIVE);

  const added = m.add_initial_nodes(['B', 'A']);
  assert.deepEqual(added.queued, ['B']);
  assert.deepEqual(added.skipped, ['A']); // A 已是起点
  assert.equal(g.get_node('B').state, STATE.INACTIVE, '追加的起点要等下一轮才生效');

  m.step(); // 第 2 轮：B 变成显意识并传播 → C 激活
  assert.equal(g.get_node('B').state, STATE.CONSCIOUS);
  assert.equal(g.get_node('C').state, STATE.CONSCIOUS);
  assert.equal(m.target_steps().C, 2);
  assert.equal(m.stop_reason, 'all_targets_reached');

  assert.throws(() => m.add_initial_nodes(['A']), MindNetError);
  assert.throws(() => m.start_diffusion(['NOPE'], []), MindNetError);
  assert.throws(() => m.start_diffusion(['A'], ['NOPE']), MindNetError);
});

test('冷却停止：连续两轮状态完全无变化', () => {
  const g = makeGraph([['A', { ms: 1.0 }], ['B', {}]], [['A', 'B', 0.01]]);
  const m = new CognitiveModel(g, new Config());
  m.start_diffusion(['A'], []);
  const result = m.run_until_stop();

  assert.equal(m.rounds, 2);
  assert.equal(m.stop_reason, 'cooling');
  assert.equal(result.targets_all_reached, false);
  assert.deepEqual(result.final_states, { A: STATE.CONSCIOUS, B: STATE.INACTIVE });
  assert.equal(g.get_node('B').visit_count, 1);
});

test('最大轮次：到 max_rounds 强制停止，未达成目标不算达成', () => {
  const g = makeGraph(
    [['A', { ms: 0.9 }], ['B', { ms: 0.9 }], ['C', { ms: 0.9 }], ['D', { ms: 0.9 }], ['E', { ms: 0.9 }]],
    [
      ['A', 'B', 0.9],
      ['B', 'C', 0.9],
      ['C', 'D', 0.9],
      ['D', 'E', 0.9],
    ]
  );
  const m = new CognitiveModel(g, new Config());
  m.start_diffusion(['A'], ['E']);
  const result = m.run_until_stop(2);

  assert.equal(m.rounds, 2);
  assert.equal(m.stop_reason, 'max_rounds');
  assert.deepEqual(result.target_steps, {});
  assert.equal(result.targets_all_reached, false);
  assert.deepEqual(result.final_states, {
    A: STATE.CONSCIOUS,
    B: STATE.CONSCIOUS,
    C: STATE.CONSCIOUS,
    D: STATE.INACTIVE,
    E: STATE.INACTIVE,
  });
});

test('目标即起点：target_steps = 0，直接视为达成', () => {
  const g = makeGraph([['A', {}], ['B', {}]], [['A', 'B', 0.9]]);
  const m = new CognitiveModel(g, new Config());
  m.start_diffusion(['A'], ['A']);
  const result = m.run_until_stop();

  assert.equal(m.rounds, 0);
  assert.equal(m.stop_reason, 'all_targets_reached');
  assert.deepEqual(result.target_steps, { A: 0 });
  assert.equal(result.targets_all_reached, true);
  assert.equal(result.final_states.B, STATE.INACTIVE);
});

test('目标不可达：冷却停止，target_steps 为空', () => {
  const g = makeGraph([['A', { ms: 1.0 }], ['B', {}], ['Z', {}]], [['A', 'B', 0.9]]);
  const m = new CognitiveModel(g, new Config());
  m.start_diffusion(['A'], ['Z']);
  const result = m.run_until_stop();

  assert.equal(m.stop_reason, 'cooling');
  assert.equal(m.rounds, 3);
  assert.deepEqual(result.target_steps, {});
  assert.equal(result.targets_all_reached, false);
  assert.equal(result.final_states.Z, STATE.INACTIVE);
});

test('先失败后激活的节点不累加 visit_count；全程未激活才累加', () => {
  const g = makeGraph(
    [['A', { ms: 1.0 }], ['B', { ms: 1.0 }], ['D', {}]],
    [
      ['A', 'B', 0.9],
      ['A', 'D', 0.02], // 第 1 轮：D impact 0.02 < ST → 记一次尝试
      ['B', 'D', 0.9],  // 第 2 轮：D 被激活
    ]
  );
  const m = new CognitiveModel(g, new Config());
  m.start_diffusion(['A'], []);
  m.run_until_stop();

  assert.equal(g.get_node('D').state, STATE.CONSCIOUS);
  assert.equal(g.get_node('D').visit_count, 0, '最终已激活的节点不计入 visit_count');
  assert.deepEqual(m.attempted_this_diffusion, ['D']);
  assert.deepEqual(m.get_kc(), { gap: 0, penalty: 0 });
});

test('未开始扩散时 step() 报错；重复 start_diffusion 保留 visit_count', () => {
  const g = makeGraph([['A', { ms: 0.2 }], ['C', {}]], [['A', 'C', 0.1]]);
  const m = new CognitiveModel(g, new Config());
  assert.throws(() => m.step(), MindNetError);

  m.start_diffusion(['A'], []);
  m.run_until_stop();
  assert.equal(g.get_node('C').visit_count, 1);
  assert.equal(m.get_kc().penalty, 1);

  m.start_diffusion(['A'], []);
  assert.equal(g.get_node('C').state, STATE.INACTIVE, '运行时状态每次重置');
  m.run_until_stop();
  assert.equal(g.get_node('C').visit_count, 2, 'visit_count 跨扩散累计');
  assert.equal(m.get_kc().penalty, 1.414214); // sqrt(2) 保留 6 位
});
