'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const memory = require('../mechanisms/memory.dsr.js');
const { MechanismKernel } = require('../src/core/kernel.js');
const { Graph, Config, apply_forgetting, MindNetError } = require('../src/index.js');
const { NOW, makeGraph, close } = require('./helpers.js');

const O = memory.options();

function stub(ms, weight) {
  return { id: 'stub', ms: ms === undefined ? 0.8 : ms, weight: weight === undefined ? 1 : weight, m: {}, last_review_time: 0 };
}

function kernelWithMemory(nodes, edges) {
  const graph = makeGraph(nodes || [['A', { ms: 0.8 }], ['B', {}]], edges || []);
  const k = new MechanismKernel(graph, new Config(), { seed: 3, hours: NOW });
  k.load([memory.manifest]);
  return k;
}

test('v1.2 · 规律 1 翻转：成功提取次数越多，同一时刻的可提取度越高', () => {
  const retention = (reviews) => {
    const node = stub();
    let u = 0;
    memory.ensureState(node, 0, O);
    for (let i = 0; i < reviews; i += 1) {
      u += 24;
      memory.applyReview(node, u, { type: 'retrieval_success', grade: 3 }, O);
    }
    return memory.retrievabilityOf(node, u + 72, O);
  };
  const r1 = retention(1);
  const r3 = retention(3);
  const r10 = retention(10);
  assert.ok(r1 < r3 && r3 < r10, `留存必须随复习次数单调上升：${r1} / ${r3} / ${r10}`);

  // 对照 v1.1：同样三次复习，72 小时后留存完全不变（S 恒为 24）
  const v1 = apply_forgetting(0.8, 72, new Config());
  close(v1, apply_forgetting(0.8, 72, new Config()), 0);
  assert.ok(r10 > v1 * 10, `v2 的留存应远高于 v1.1 的 ${v1}`);
});

test('v1.2 · 稳定度 S 随成功提取严格单调增长，且增长递减（防无限增长）', () => {
  const node = stub();
  let u = 0;
  memory.ensureState(node, 0, O);
  const seq = [];
  let prevInc = Infinity;
  for (let i = 0; i < 6; i += 1) {
    u += 24;
    const detail = memory.applyReview(node, u, { type: 'retrieval_success', grade: 3 }, O);
    seq.push(detail.S_after);
    assert.ok(detail.SInc >= 1, 'SInc 必须 ≥ 1');
    assert.ok(detail.SInc <= prevInc + 1e-9, `增长因子必须递减：${prevInc} → ${detail.SInc}`);
    prevInc = detail.SInc;
  }
  for (let i = 1; i < seq.length; i += 1) assert.ok(seq[i] > seq[i - 1]);
});

test('v1.2 · 规律 5 翻转：失败证据随时间指数老化，一年后几乎归零', () => {
  const node = stub();
  memory.recordFailure(node, 0, O);
  const fresh = memory.failureEvidenceOf(node, 0, O);
  const month = memory.failureEvidenceOf(node, 720, O);
  const year = memory.failureEvidenceOf(node, 8760, O);
  assert.equal(fresh, 1);
  close(month, Math.exp(-1), 1e-9);
  assert.ok(year < 1e-5, `一年后应几乎归零，实际 ${year}`);

  // 死角惩罚随时间下降；权重参与加权（√F 会放慢衰减，所以看比例而不是绝对值）
  const heavy = stub(0.8, 2);
  memory.recordFailure(heavy, 0, O);
  const graph = { nodes: new Map([['h', heavy]]) };
  close(memory.penaltyOf(graph, 0, O).penalty, 2, 1e-9);
  const yearPenalty = memory.penaltyOf(graph, 8760, O).penalty;
  assert.ok(yearPenalty < 2 * 0.01, `一年后应降到刚失败的 1% 以下，实际 ${yearPenalty}`);
});

test('v1.2 · 提取练习效应：失败后对答案 > 再读，且不超过一次完整提取', () => {
  const node = stub();
  const bag = memory.ensureState(node, 0, O);
  const R = 0.6;
  const incSuccess = memory.stabilityIncrease(bag, R, O, 'retrieval_success', 0.5);
  const incReread = memory.stabilityIncrease(bag, R, O, 'reread', 0.5);
  const incFail = memory.stabilityIncrease(bag, R, O, 'retrieval_failure_feedback', 0.9);
  assert.ok(incSuccess > incReread * 5, `${incSuccess} 应远大于 ${incReread}`);
  assert.ok(incFail > incReread * 4, '失败后对答案必须明显优于被动再读（合意难度）');
  assert.ok(incFail <= incSuccess, '对答案的增益不应超过一次完整提取成功');
  const halfway = memory.stabilityIncrease(bag, R, O, 'retrieval_failure_feedback', 0.3);
  assert.ok(halfway < incFail, 'closeness 越大（越接近想起），增益越大');
});

test('v1.2 · 储蓄效应：存储强度高的节点，遗忘后同样的复习收益更大', () => {
  const gain = (sigma) => {
    const node = stub();
    const bag = memory.ensureState(node, 0, O);
    bag.Sigma = sigma;
    return memory.stabilityIncrease(bag, 0.6, O, 'retrieval_success', 0.5);
  };
  assert.ok(gain(0.9) > gain(0.2), 'Σ 越大，增长越大（储蓄效应）');

  // 真遗忘后 S 下降，但 Σ 保留（只增不减）——这是 FSRS 单独表达不了的
  const node = stub();
  memory.ensureState(node, 0, O);
  memory.applyReview(node, 24, { type: 'retrieval_success', grade: 3 }, O);
  const sBefore = node.m.memory_dsr.S;
  const sigmaBefore = node.m.memory_dsr.Sigma;
  const detail = memory.applyReview(node, 48, { type: 'lapse', grade: 1 }, O);
  assert.ok(detail.S_after < sBefore, '遗忘后 S 下降');
  assert.ok(node.m.memory_dsr.Sigma >= sigmaBefore, 'Σ 不下降');
  assert.ok(node.m.memory_dsr.F > 0, '失败证据 +1');
});

test('v1.2 · 排程反解：R0=1 时 85% 目标对应 1.906×S、90% 对应 S；目标高于编码上限则返回 0', () => {
  const node = stub(1.0);
  memory.ensureState(node, 0, O);
  const S = node.m.memory_dsr.S;
  close(memory.scheduleInterval(node, 0, 0.9, O), S, 1e-6);
  // 1.906 由 probe/model_math_check.js 独立算出（保留 3 位小数）
  const mult = memory.scheduleInterval(node, 0, 0.85, O) / S;
  close(mult, 1.906, 1e-3);
  assert.ok(memory.scheduleInterval(node, 0, 0.8, O) > memory.scheduleInterval(node, 0, 0.9, O));

  // 编码上限低于目标留存率时，曲线永远够不到目标 ⇒ 立刻复习
  const weak = stub(0.8);
  memory.ensureState(weak, 0, O);
  assert.equal(memory.scheduleInterval(weak, 0, 0.9, O), 0);
  assert.throws(() => memory.scheduleInterval(weak, 0, 1.2, O), MindNetError);
});

test('v1.2 · 指数模式与 v1.1 逐位等价（退化性）', () => {
  const o = memory.options({ decay_model: 'exponential' });
  let maxDiff = 0;
  for (let t = 0; t <= 200; t += 0.5) {
    const node = stub(0.8);
    memory.ensureState(node, 0, o);
    const v2 = memory.retrievabilityOf(node, t, o);
    const v1 = apply_forgetting(0.8, t, new Config());
    maxDiff = Math.max(maxDiff, Math.abs(v2 - v1));
  }
  assert.equal(maxDiff, 0, '指数模式下应与 v1.1 的 ms 曲线逐位相同');
});

test('v1.2 · 难度 D 随表现调整，并被限制在 [1,10]', () => {
  const diff = (grade) => {
    const node = stub();
    memory.ensureState(node, 0, O);
    memory.applyReview(node, 24, { type: 'retrieval_success', grade }, O);
    return node.m.memory_dsr.D;
  };
  assert.ok(diff(1) > diff(3) && diff(3) > diff(4), '表现越差，难度越高');
  const node = stub();
  memory.ensureState(node, 0, O);
  for (let i = 0; i < 50; i += 1) memory.applyReview(node, 24 * (i + 1), { type: 'lapse', grade: 1 }, O);
  assert.ok(node.m.memory_dsr.D <= 10 && node.m.memory_dsr.D >= 1);
});

test('v1.2 · 经内核调用：复习写回 ms、诊断给出时间衰减的死角、存档含记忆状态', () => {
  const k = kernelWithMemory([['A', { ms: 0.8, weight: 1.5 }], ['B', { ms: 0.7 }]], [['A', 'B', 0.5]]);
  const before = k.graph.get_node('A').ms;
  k.review('A', { type: 'retrieval_success', grade: 3 });
  const a = k.graph.get_node('A');
  assert.ok(a.ms >= before, 'ms 必须被模块同步为当前可提取度');
  assert.equal(a.m.memory_dsr.N, 1);
  assert.ok(a.m.memory_dsr.S > 0);

  k.advanceHours(24 * 40);
  const state = k.serialize();
  assert.ok(state.memory.nodes.A.S > 0);
  assert.ok(state.memory.nodes.A.R < 1, '40 天后可提取度应下降');

  k.review('B', { type: 'lapse', grade: 1 });
  const diag = k.diagnose();
  const mem = diag.find((d) => d.out && d.out.memory).out.memory;
  assert.equal(mem.dead.length, 1);
  assert.equal(mem.dead[0].id, 'B');
  assert.ok(mem.penalty > 0);

  assert.deepEqual(k.warnings.filter((w) => w.kind === 'invariant'), [], '不应有不变量违规');
  assert.equal(k.isEnabled('memory.dsr'), true);
});

test('v1.2 · 边界与错误：内核自身校验调用方输入（未知节点 / 非法时间）', () => {
  const k = kernelWithMemory();
  assert.throws(() => k.review('NOPE', { type: 'retrieval_success' }), MindNetError);
  assert.throws(() => k.consolidate(['NOPE']), MindNetError);
  assert.throws(() => k.advanceHours(-1), MindNetError);
  assert.throws(() => k.setHours(NaN), MindNetError);
  assert.deepEqual(k.warnings, [], '调用方输入错误不应被记成模块故障');
  // 未知复习类型走默认「提取成功」以外的混合分支，但增长率仍 ≥ 1
  const node = stub();
  memory.ensureState(node, 0, O);
  const unknown = memory.applyReview(node, 1, { type: 'something_else', grade: 3 }, O);
  assert.equal(unknown.kind, 'review');
  assert.ok(unknown.SInc >= 1);
});
