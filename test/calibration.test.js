'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const cal = require('../src/calibration.js');
const feedback = require('../src/feedback.js');
const memoryDsr = require('../mechanisms/memory.dsr.js');
const beliefMod = require('../mechanisms/metacognition.belief.js');
const { close } = require('./helpers.js');

test('标定 · 稳定度 S：由一次延迟回忆闭式反解，且与模型曲线自洽', () => {
  // 造一个已知 S 的节点，用模型算出 R(t)，再由 R(t) 反解 S，必须回到原值
  const node = { id: 'n', ms: 0.8, weight: 1, m: {}, last_review_time: 0 };
  for (const S of [6, 19.2, 48, 200]) {
    node.m = { memory_dsr: { R0: 0.8, S, Sigma: 0.8, D: 5, N: 0, F: 0, lastFail: null, lastReview: 0, history: [], initializedAt: 0 } };
    const t = 12;
    const Rt = memoryDsr.retrievabilityOf(node, t, { decay_model: 'power' });
    const est = cal.estimateStability({ R0: 0.8, Rt, tHours: t });
    close(est.S, S, 1e-3);
  }
});

test('标定 · 稳定度 S：延迟测试没忘时给出"下界"而不是假的精确值', () => {
  const est = cal.estimateStability({ R0: 0.9, Rt: 0.9, tHours: 6 });
  assert.ok(est.S > 1000);
  assert.match(est.note, /下界/);
  assert.throws(() => cal.estimateStability({ R0: 0.8, Rt: 0.5, tHours: 0 }), /正的延迟时间/);
});

test('标定 · 反馈闭环：答对上调 S、答错下调，且与 src/feedback.js 是同一条规则', () => {
  const up = cal.refineStability(24, { tHours: 48, correct: true });
  const down = cal.refineStability(24, { tHours: 48, correct: false });
  assert.ok(up > 24 && down < 24);
  assert.ok(up < 24 * 1.4 && down > 24 * 0.6, '单条证据的位移必须有界（±40%）');
  // 这里只是别名：真正的实现只有一份，改了那边这边必须跟着变
  assert.equal(up, feedback.updateStability({ S: 24, R0: 0.8, tHours: 48, correct: true }).S);
  assert.equal(down, feedback.updateStability({ S: 24, R0: 0.8, tHours: 48, correct: false }).S);
  // 连续答对会升（增益递减 ⇒ 越往后每步越小，但不会单向漂移到无穷）
  let s = 24;
  const steps = [];
  for (let i = 0; i < 5; i += 1) {
    const before = s;
    s = cal.refineStability(s, { tHours: 24, correct: true, count: i });
    steps.push(s / before);
  }
  assert.ok(s > 24, `五次答对后 S 应当上升，实际 ${s}`);
  assert.ok(steps[0] > steps[4], `步长应当递减：${steps.map((x) => x.toFixed(4)).join(' → ')}`);
});

test('标定 · 复习类型比：再读增益 1 倍、主动回忆 9 倍 ⇒ 系数约 0.125', () => {
  const est = cal.estimateReviewTypeRatio({ S_before: 20, S_reread: 40, S_retrieval: 200 });
  close(est.kappa_reread_ratio, 1 / 9, 1e-3);
  // 两组增益相同时退化为 1（即没有差别）
  const same = cal.estimateReviewTypeRatio({ S_before: 20, S_reread: 200, S_retrieval: 200 });
  close(same.kappa_reread_ratio, 1, 1e-6);
});

test('标定 · 容量：正确率跌破 50% 处插值', () => {
  const est = cal.estimateCapacity([
    { n: 3, accuracy: 1.0 },
    { n: 4, accuracy: 0.9 },
    { n: 5, accuracy: 0.6 },
    { n: 6, accuracy: 0.3 },
    { n: 7, accuracy: 0.1 },
  ]);
  // 5→6 之间从 0.6 掉到 0.3，过 0.5 的位置 = 5 + (0.6−0.5)/(0.6−0.3) = 5.33
  close(est.W_DAR, 5.33, 0.02);
  const thin = cal.estimateCapacity([{ n: 4, accuracy: 1 }]);
  assert.equal(thin.W_DAR, 4, '样本不足时沿用默认值');
});

test('标定 · 节律：走神占比与连续专注段推出 duty / p_off / p_on', () => {
  // 60 个采样点（每 0.5 分钟一个 = 30 分钟），每 10 个点里有 4 个走神
  const samples = [];
  for (let i = 0; i < 60; i += 1) samples.push({ tMinutes: i * 0.5, focused: i % 10 < 6 });
  const est = cal.estimateRhythm(samples);
  close(est.duty, 0.6, 0.02);
  assert.ok(est.p_off > 0 && est.p_off < 0.2, `p_off = ${est.p_off}`);
  assert.ok(est.p_on > est.p_off, '走神少 ⇒ 转回专注的概率应当更大');
  const thin = cal.estimateRhythm([{ tMinutes: 0, focused: true }]);
  assert.equal(thin.duty, 0.5, '样本不足时沿用默认 duty');
});

test('标定 · 元认知：用实际回忆率反解 b0，并给出校准度与阈值', () => {
  const items = [];
  for (let i = 0; i < 12; i += 1) {
    items.push({ belief: 0.5 + (i % 3) * 0.15, recalled: i % 4 === 0, fluency: 0.4 + (i % 5) * 0.1, R0: 0.8 });
  }
  const est = cal.fitBeliefBias({ items, beliefOf: beliefMod.beliefOf });
  assert.ok(est.b0 > -6 && est.b0 < 6, `b0 应落在搜索区间内，实际 ${est.b0}`);
  assert.ok(est.delta >= 0.05 && est.delta <= 0.6);
  assert.ok(est.calibration > 0);
  // b0 越大越自信：二分求解应当把预测均值压到实际回忆率附近
  const observed = items.filter((x) => x.recalled).length / items.length;
  const mean = items.reduce((s, x) => s + beliefMod.beliefOf(x.fluency, x.R0, 0, {
    b0: est.b0, w_fluency: 1.5, w_encoding: 0.8, w_recency: 0.8, tau_recency_hours: 6,
  }), 0) / items.length;
  assert.ok(Math.abs(mean - observed) < 0.06, `拟合后均值 ${mean} 应接近实际 ${observed}`);
});

test('标定 · 成本与目标：归一化到「回忆一次 = 1」，并组装成 overrides', () => {
  const costs = cal.estimateCosts({ retrieval: 3, link: 5, offload: 1 });
  assert.equal(costs.cost_retrieval, 1);
  close(costs.cost_link, 5 / 3, 1e-3);
  close(costs.cost_offload, 1 / 3, 1e-3);

  const overrides = cal.buildOverrides({
    legacy_k: 26, W_DAR: 3.5, duty: 0.62, p_off: 0.03, p_on: 0.09,
    tau_vig_minutes: 26, b0: 1.2, delta: 0.18, cost_link: 1.7, cost_offload: 0.3,
    kappa_reread_ratio: 0.12, target_retention: 0.85, S_hours: 40,
  });
  assert.equal(overrides['attention.capacity.W_DAR'], 3.5);
  assert.equal(overrides['rhythm.gate.duty'], 0.62);
  assert.equal(overrides['memory.dsr.kappa_reread_ratio'], 0.12);
  assert.equal(overrides['calibration.target_retention'], 0.85);
  assert.equal(overrides['memory.dsr.legacy_k'], 26);
  // 未被估计出来的参数不应出现在 overrides 里
  assert.equal(overrides['attention.ignition.T_ign'], undefined);
});

test('标定 · 这些 overrides 必须真的能被内核接受（参数名不能写错）', () => {
  const { Graph, Config, createKernel } = require('../src/index.js');
  const { makeGraph } = require('./helpers.js');
  const overrides = cal.buildOverrides({
    legacy_k: 26, W_DAR: 3.5, duty: 0.62, p_off: 0.03, p_on: 0.09, tau_vig_minutes: 26,
    b0: 1.2, delta: 0.18, cost_link: 1.7, cost_offload: 0.3, kappa_reread_ratio: 0.12,
  });
  const g = makeGraph([['A', { ms: 0.9 }], ['B', { ms: 0.6 }]], [['A', 'B', 0.9]]);
  const kernel = createKernel(g, new Config(), { seed: 1, hours: 0, profile: 'v2', overrides });
  // 逐条核对：内核解析出来的值必须等于我们写进去的值
  assert.equal(kernel.param('attention.capacity.W_DAR'), 3.5);
  assert.equal(kernel.param('rhythm.gate.duty'), 0.62);
  assert.equal(kernel.param('metacognition.belief.b0'), 1.2);
  assert.equal(kernel.param('control.planner.cost_link'), 1.7);
  assert.equal(kernel.param('memory.dsr.kappa_reread_ratio'), 0.12);
});

test('标定 · 人话说明：用模型自己的公式算「这对你意味着什么」', () => {
  const lines = cal.describeEffects({ S_hours: 40, R0: 0.9, duty: 0.62, W_DAR: 3.5, kappa_reread_ratio: 0.12, bias: 0.2, target_retention: 0.85 });
  assert.equal(lines.length, 5);
  assert.match(lines[0], /小时后复习/);
  // 用模型公式独立核对间隔：R0=0.9、目标 0.85 时可达 ⇒ 1.906 倍只是个近似，
  // 这里直接按闭式重算一遍，两者必须一致
  const stub = {
    id: 'x', ms: 0.9, weight: 1, last_review_time: 0,
    m: { memory_dsr: { R0: 0.9, S: 40, Sigma: 0.9, D: 5, N: 0, F: 0, lastFail: null, lastReview: 0, history: [], initializedAt: 0 } },
  };
  const interval = memoryDsr.scheduleInterval(stub, 0, 0.85, { decay_model: 'power' });
  const expected = (40 / cal.CURVE_C) * (Math.pow(0.85 / 0.9, -1 / cal.GAMMA) - 1);
  assert.ok(Math.abs(interval - expected) < 1e-6, `排程间隔应与闭式一致：${interval} vs ${expected}`);
  // 口径提醒：S 的定义是"降到 0.9×R0"。R0=0.9 时"85% 绝对留存"比 0.9×R0 更宽松，
  // 所以间隔反而短于 S —— 这正是标定文档里必须讲清楚的一点。
  assert.ok(interval < 40, `R0=0.9、目标 0.85 时，间隔应短于 S（实际 ${interval}）`);
});
