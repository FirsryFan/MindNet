'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Config, CognitiveModel, Graph, MindNetError, STATE } = require('../src/index.js');
const { NOW, makeGraph, tmpPath, cleanupTmp } = require('./helpers.js');

const EXAMPLE = path.join(__dirname, '..', 'example', 'graph.json');

test('空图：空 KC、空 final_states、冷却停止', () => {
  const m = new CognitiveModel(new Graph(), new Config());
  m.start_diffusion([], []);
  const result = m.run_until_stop();

  assert.deepEqual(result, {
    kc: { gap: 0, penalty: 0 },
    target_steps: {},
    targets_all_reached: false,
    final_states: {},
  });
  assert.equal(m.stop_reason, 'cooling');
});

test('Penalty：非起点 + 最终未激活 + visit_count > 0，按 weight 加权、按 sqrt(visit_count)', () => {
  const g = makeGraph(
    [['A', { ms: 1.0 }], ['B', { weight: 0.9 }], ['C', { weight: 0.4 }]],
    [
      ['A', 'B', 0.01], // impact 0.01 < ST → 尝试失败
      ['A', 'C', 0.02], // impact 0.02 < ST → 尝试失败
    ]
  );
  const m = new CognitiveModel(g, new Config());
  m.start_diffusion(['A'], []);
  m.run_until_stop();

  assert.equal(g.get_node('B').visit_count, 1);
  assert.equal(g.get_node('C').visit_count, 1);
  assert.deepEqual(m.get_kc(), { gap: 0, penalty: 1.3 }); // 0.9*1 + 0.4*1
});

test('Gap：只算非起点且已激活的节点，按 weight 加权', () => {
  const g = makeGraph(
    [['A', { ms: 0.5 }], ['B', { weight: 0.5 }]],
    [['A', 'B', 0.5]] // impact 0.25 → SUBCONSCIOUS；Gap 单点 = 1.2*0.3-0.25 = 0.11
  );
  const m = new CognitiveModel(g, new Config());
  m.start_diffusion(['A'], []);
  m.run_until_stop();

  assert.equal(g.get_node('B').state, STATE.SUBCONSCIOUS);
  assert.deepEqual(m.get_kc(), { gap: 0.055, penalty: 0 }); // 0.5 * 0.11
});

test('起点不参与 KC（即使它没有首次 Impact 记录）', () => {
  const g = makeGraph([['A', {}], ['B', {}]], [['A', 'B', 0.9]]);
  const m = new CognitiveModel(g, new Config());
  m.start_diffusion(['A', 'B'], []);
  m.run_until_stop();

  assert.equal(g.get_node('B').state, STATE.CONSCIOUS);
  assert.deepEqual(m.get_kc(), { gap: 0, penalty: 0 });
});

test('节点自定义 ct / st 优先于全局默认', () => {
  const g = makeGraph(
    [['A', { ms: 0.5 }], ['X', { ct: 0.9 }], ['Y', { st: 0.25 }]],
    [
      ['A', 'X', 1.0], // impact 0.50：全局 CT 0.3 会判显意识，自定义 CT 0.9 应为潜意识
      ['A', 'Y', 0.4], // impact 0.20：全局 ST 0.05 会判潜意识，自定义 ST 0.25 应为未激活
    ]
  );
  const m = new CognitiveModel(g, new Config());
  m.start_diffusion(['A'], []);
  m.run_until_stop();

  assert.equal(g.get_node('X').state, STATE.SUBCONSCIOUS);
  assert.equal(g.get_node('Y').state, STATE.INACTIVE);
  assert.equal(g.get_node('Y').visit_count, 1);
  // Gap(X) = 1.2*0.9 - 0.50 = 0.58；Penalty(Y) = 1.0 * sqrt(1)
  assert.deepEqual(m.get_kc(), { gap: 0.58, penalty: 1 });
});

test('kc_breakdown：逐节点明细之和等于 get_kc()，不改变算法', () => {
  const g = makeGraph(
    [['A', { ms: 0.5 }], ['B', { weight: 0.5 }], ['C', { weight: 0.4 }]],
    [
      ['A', 'B', 0.5],  // impact 0.25 → SUBCONSCIOUS，Gap 单点 0.11
      ['A', 'C', 0.02], // impact 0.01 → INACTIVE，Penalty 0.4
    ]
  );
  const m = new CognitiveModel(g, new Config());
  m.start_diffusion(['A'], []);
  m.run_until_stop();

  const kc = m.get_kc();
  const breakdown = m.kc_breakdown();
  const gapSum = breakdown.gap.reduce((s, r) => s + r.contribution, 0);
  const penaltySum = breakdown.penalty.reduce((s, r) => s + r.contribution, 0);
  assert.ok(Math.abs(gapSum - kc.gap) < 1e-6);
  assert.ok(Math.abs(penaltySum - kc.penalty) < 1e-6);
  assert.deepEqual(breakdown.gap.map((r) => r.id), ['B']);
  assert.deepEqual(breakdown.penalty.map((r) => r.id), ['C']);
  assert.equal(breakdown.gap[0].impact, 0.25);
});

test('export_state：返回状态对象，并可写入文件', () => {
  const g = makeGraph([['A', { ms: 1.0 }], ['B', {}]], [['A', 'B', 0.9]]);
  const m = new CognitiveModel(g, new Config());
  m.start_diffusion(['A'], ['B']);
  m.run_until_stop();

  const state = m.export_state();
  assert.deepEqual(state.kc, { gap: 0, penalty: 0 });
  assert.deepEqual(state.target_steps, { B: 1 });
  assert.equal(state.rounds, 1);
  assert.equal(state.stop_reason, 'all_targets_reached');
  assert.equal(state.nodes.B.state, STATE.CONSCIOUS);
  assert.equal(state.nodes.B.last_review_time, NOW);
  assert.equal(state.config.ct_default, 0.3);

  const file = tmpPath(`state_${process.pid}.json`);
  m.export_state(file);
  const fromDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(fromDisk.final_states, state.final_states);
  fs.unlinkSync(file);
  cleanupTmp();
});
