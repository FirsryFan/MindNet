'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  Config,
  CognitiveModel,
  apply_forgetting,
  update_global_memory,
  focused_review,
  update_memory,
  MindNetError,
} = require('../src/index.js');
const { NOW, makeGraph, close } = require('./helpers.js');

test('遗忘曲线：MS(t) = MS0 * exp(-t / (k * MS0))', () => {
  const config = new Config();
  // S = 24 * 0.8 = 19.2；t = 24 → exp(-1.25) = 0.28650479686019007
  close(apply_forgetting(0.8, 24, config), 0.22920383748815206, 1e-15);
  close(apply_forgetting(0.8, 0, config), 0.8, 1e-15);
});

test('遗忘曲线：MS0 <= 0 时 MS = 0；t <= 0 时不变', () => {
  const config = new Config();
  assert.equal(apply_forgetting(0, 10, config), 0);
  assert.equal(apply_forgetting(-0.5, 10, config), 0);
  assert.equal(apply_forgetting(0.5, 0, config), 0.5);
  assert.equal(apply_forgetting(0.5, -3, config), 0.5);
});

test('遗忘曲线：记忆越牢，衰减越慢（S 随 MS0 增大）', () => {
  const config = new Config();
  const weak = apply_forgetting(0.3, 24, config);
  const strong = apply_forgetting(0.9, 24, config);
  assert.ok(strong > weak, `MS0=0.9 的残留 ${strong} 应大于 MS0=0.3 的残留 ${weak}`);
  // 相对剩余比例也应更高
  assert.ok(strong / 0.9 > weak / 0.3);
});

test('全局记忆更新：超阈值才衰减，阈值内保持原样，缺失时间补当前时间', () => {
  const config = new Config();
  const g = makeGraph([['A', { ms: 0.8 }], ['B', { ms: 0.6 }], ['C', { ms: 0.7 }], ['D', { ms: 0 }]], []);
  g.get_node('A').last_review_time = 0;        // 缺失/为 0 → 补当前时间，不衰减
  g.get_node('B').last_review_time = NOW - 0.5; // 阈值内 → 完全不动
  g.get_node('C').last_review_time = NOW - 10;  // 超阈值 → 按 t=10 衰减
  g.get_node('D').last_review_time = NOW - 10;  // MS0 <= 0 → 归零

  const report = update_global_memory(g, config, NOW);

  assert.equal(g.get_node('A').last_review_time, NOW);
  assert.equal(g.get_node('A').ms, 0.8);
  assert.equal(g.get_node('B').ms, 0.6);
  assert.equal(g.get_node('B').last_review_time, NOW - 0.5);
  close(g.get_node('C').ms, 0.7 * Math.exp(-10 / (24 * 0.7)), 1e-15);
  assert.equal(g.get_node('C').last_review_time, NOW);
  assert.equal(g.get_node('D').ms, 0);
  assert.equal(g.get_node('D').last_review_time, NOW);

  assert.deepEqual(report.updated.map((u) => u.id), ['C', 'D']);
  assert.deepEqual(report.filled_missing, ['A']);
  assert.equal(report.current_real_time, NOW);
});

test('专注复习：ms 拉满为 1.0，衰减从当前时间重新开始', () => {
  const node = { ms: 0.31, last_review_time: 0 };
  focused_review(node, 4321);
  assert.equal(node.ms, 1.0);
  assert.equal(node.last_review_time, 4321);
});

test('update_memory 分发：focused 生效、process 抛未实现、未知类型报错', () => {
  const g = makeGraph([['A', { ms: 0.4 }]], []);
  update_memory(g, 'A', { review_type: 'focused', current_real_time: 555 });
  assert.equal(g.get_node('A').ms, 1.0);
  assert.equal(g.get_node('A').last_review_time, 555);

  assert.throws(() => update_memory(g, 'A', { review_type: 'process' }), (err) => {
    assert.equal(err.name, 'NotImplementedError');
    return true;
  });
  assert.throws(() => update_memory(g, 'A', { review_type: 'something' }), MindNetError);
  assert.throws(() => update_memory(g, 'NOPE', {}), MindNetError);
});

test('CognitiveModel 暴露记忆接口', () => {
  const g = makeGraph([['A', { ms: 0.5 }]], []);
  const m = new CognitiveModel(g, new Config());
  const report = m.update_global_memory(NOW);
  assert.equal(report.current_real_time, NOW);
  m.update_memory('A', { review_type: 'focused', current_real_time: NOW + 1 });
  assert.equal(g.get_node('A').ms, 1.0);
  assert.equal(g.get_node('A').last_review_time, NOW + 1);
});

test('Config：默认值逐项对应文档 §9；未知参数报错', () => {
  const c = new Config();
  assert.deepEqual(c.to_object(), {
    ct_default: 0.3,
    st_default: 0.05,
    state_coeff_conscious: 1.0,
    state_coeff_subconscious: 0.3,
    state_coeff_inactive: 0.0,
    max_rounds: 100,
    stable_rounds: 2,
    forgetting_k: 24.0,
    forget_update_threshold_hours: 1.0,
    gap_constant: 1.2,
  });
  assert.throws(() => new Config({ ct_defult: 0.4 }), MindNetError);
  const custom = Config.from_object({ max_rounds: 7 });
  assert.equal(custom.max_rounds, 7);
  assert.equal(custom.ct_default, 0.3);
});
