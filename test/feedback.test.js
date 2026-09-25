'use strict';

/**
 * 反馈微调的测试。
 *
 * 这些测试的阈值不是随手定的：它们来自 probe/.tmp 里先跑出来的统计量
 * （20 个种子 × 400 条证据），并与 Fisher 信息下界对照。
 * 关键结论先说清楚，免得以后有人以为"收敛太慢是个 bug"：
 *   一道题只有对/错 1 bit，最优点（t ≈ 3.9·S，p ≈ 0.7）的 Fisher 信息 I ≈ 0.0359，
 *   于是 n 条证据后 log S 的标准误下界 = 1/√(nI)：100 条 → ±70%、400 条 → ±30%。
 *   实测 RMS 与下界之比 0.91~0.99 ⇒ 这个更新律已经把数据榨干了，慢是数据的性质，不是算法的缺陷。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {
  FeedbackLog, updateStability, predictedRetrievability, gainAt, seLogSBest, FISHER_I_BEST,
} = require('../src/feedback.js');
const memoryDsr = require('../mechanisms/memory.dsr.js');
const { createRng } = require('../src/core/rng.js');
const { makeGraph, close, tmpPath, cleanupTmp } = require('./helpers.js');

/** 造一个带记忆状态的桩节点（走模型自己的排程公式） */
function stubNode(S, R0) {
  return {
    id: 'n', ms: R0, weight: 1, last_review_time: 0,
    m: { memory_dsr: { R0, S, Sigma: R0, D: 5.1618, N: 0, F: 0, lastFail: null, lastReview: 0, history: [], initializedAt: 0 } },
  };
}

/** 一套"真实学习者"的模拟：真值 S_TRUE，按目标留存排程，对错由真实曲线抽样 */
const SIM = { R0: 0.9, S_TRUE: 40, TARGET: 0.7, START: 24 * 0.9 };

function newLedger(S) {
  return { R0: SIM.R0, S, D: 5.1618, count: 0, correct: 0, lastAt: null, origin: { R0: SIM.R0, S, D: 5.1618 } };
}

function simulate(seed, rounds, from) {
  const rng = createRng(seed);
  const log = new FeedbackLog();
  log.nodes.n = newLedger(from === undefined ? SIM.START : from);
  const trace = [];
  for (let i = 0; i < rounds; i += 1) {
    const t = memoryDsr.scheduleInterval(stubNode(log.nodes.n.S, SIM.R0), 0, SIM.TARGET, { decay_model: 'power' });
    const pTrue = predictedRetrievability(SIM.S_TRUE, SIM.R0, t);
    const rec = log.record({ node: 'n', tHours: t, correct: rng() < pTrue });
    trace.push({ t, pTrue, correct: rec.correct, S: log.nodes.n.S });
  }
  return { log, trace, S: log.nodes.n.S };
}

test('反馈 · 收敛方向：真实 S=40h，估计从 21.6h 出发，400 条证据后进入 ±35%', () => {
  // R0=0.9、目标留存 0.7：目标必须低于 R0，否则 scheduleInterval 返回 0，
  // 而 t=0 时 R 与 S 无关（Ψ(0)=1），反馈里就完全不含 S 的信息，估计只会随机游走。
  const { log, S, trace } = simulate(20260925, 400);
  assert.ok(Math.abs(S - SIM.S_TRUE) / SIM.S_TRUE < 0.35,
    `400 条后 S ≈ ${S.toFixed(1)}，应当在真实值 40 的 ±35% 内（前 3 条：${trace.slice(0, 3).map((h) => h.S.toFixed(1)).join(' → ')}）`);
  assert.ok(S > SIM.START * 1.15, `起点偏低近一倍，S 必须明显上调（${SIM.START.toFixed(1)} → ${S.toFixed(1)}）`);
  const acc = log.nodes.n.correct / log.nodes.n.count;
  assert.ok(acc > 0.6 && acc < 0.85, `实测正确率 ${acc.toFixed(3)} 应接近目标留存 ${SIM.TARGET}`);
});

test('反馈 · 效率：估计误差已到 Fisher 信息下界（不是算法慢，是数据少）', () => {
  const ROUNDS = 300;
  const seeds = Array.from({ length: 20 }, (_, i) => 1000 + i * 37);
  const errors = seeds.map((s) => Math.log(simulate(s, ROUNDS).S / SIM.S_TRUE));
  const mean = errors.reduce((a, b) => a + b, 0) / errors.length;
  const rms = Math.sqrt(errors.reduce((a, b) => a + b * b, 0) / errors.length);
  const bound = seLogSBest(ROUNDS);
  close(bound, 1 / Math.sqrt(ROUNDS * FISHER_I_BEST), 1e-12);
  assert.ok(rms / bound > 0.6 && rms / bound < 1.6,
    `20 个种子的 RMS=${rms.toFixed(3)} 应当落在信息下界 ${bound.toFixed(3)} 的 0.6~1.6 倍内（实测比值 ${(rms / bound).toFixed(2)}）`);
  assert.ok(Math.abs(mean) < 0.25, `群体平均 log 误差 ${mean.toFixed(3)} 不应有明显系统偏差`);
  // 反过来说：100 条证据在数学上就不可能定准 S —— 这条断言防止有人把阈值调紧
  assert.ok(seLogSBest(100) > 0.45, `100 条证据的标准误下界应大于 0.45（实际 ${seLogSBest(100).toFixed(3)}）`);
});

test('反馈 · 无偏性：模型本来就准时，平均位移趋近 0（不会单向漂移）', () => {
  // 每步都从真值 S 出发、按同一目标排程 ⇒ 只测"更新律本身有没有系统性漂移"，
  // 不受估计值变化影响。校准状态下 E[y−p] = 0，所以位移的期望必须为 0。
  for (const seed of [5, 6, 7]) {
    const rng = createRng(seed);
    const log = new FeedbackLog();
    log.nodes.n = newLedger(SIM.S_TRUE);
    let sum = 0;
    const N = 200;
    for (let i = 0; i < N; i += 1) {
      const t = memoryDsr.scheduleInterval(stubNode(SIM.S_TRUE, SIM.R0), 0, SIM.TARGET, { decay_model: 'power' });
      const p = predictedRetrievability(SIM.S_TRUE, SIM.R0, t);
      const before = log.nodes.n.S;
      log.record({ node: 'n', tHours: t, correct: rng() < p });
      sum += Math.log(log.nodes.n.S / before);
      log.nodes.n.S = before;                      // 复位，只累计单步位移
    }
    const meanDelta = sum / N;
    assert.ok(Math.abs(meanDelta) < 0.01,
      `seed ${seed}：平均 log 位移应当趋近 0，实际 ${meanDelta.toExponential(2)}（单向漂移会让 S 无限跑偏）`);
  }
});

test('反馈 · 递减增益：前几条走得快，之后稳住，但保留地板', () => {
  close(gainAt(0), 0.35, 1e-12);
  close(gainAt(20), 0.175, 1e-12);                 // 第 K 条证据时减半
  close(gainAt(10000), 0.05, 1e-12);               // 地板：你本人变了它还跟得上
  assert.ok(gainAt(50) > gainAt(200), '增益必须随证据递减');
  // 同一条证据，第 0 条时位移远大于第 100 条时
  const first = updateStability({ S: 20, R0: 0.9, tHours: 60, correct: false, count: 0 });
  const later = updateStability({ S: 20, R0: 0.9, tHours: 60, correct: false, count: 100 });
  assert.ok(Math.abs(Math.log(first.delta_ratio)) > 3 * Math.abs(Math.log(later.delta_ratio)),
    `第 0 条应显著大于第 100 条：${first.delta_ratio} vs ${later.delta_ratio}`);
  assert.equal(first.gain, 0.35);
  close(later.gain, gainAt(100), 1e-4);           // gain 会四舍五入到 4 位小数
});

test('反馈 · 信息量加权：p≈0.5 时的位移远大于 p≈0.95 时', () => {
  // 用模型自己的排程公式反解"考到某个留存率"需要隔多久，别手算时间点。
  const tNear = memoryDsr.scheduleInterval(stubNode(10, 1), 0, 0.95, { decay_model: 'power' });
  const tMid = memoryDsr.scheduleInterval(stubNode(10, 1), 0, 0.5, { decay_model: 'power' });
  assert.ok(tMid > tNear * 5, `低留存率的间隔应当远大于高留存率（${tMid.toFixed(1)}h vs ${tNear.toFixed(1)}h）`);

  const near = updateStability({ S: 10, R0: 1, tHours: tNear, correct: true });
  const mid = updateStability({ S: 10, R0: 1, tHours: tMid, correct: true });
  assert.ok(mid.R_at_test > 0.45 && mid.R_at_test < 0.55, `mid 的 p=${mid.R_at_test}`);
  assert.ok(near.R_at_test > 0.9, `near 的 p=${near.R_at_test}`);
  assert.ok(mid.delta_ratio - 1 > (near.delta_ratio - 1) * 3,
    `信息量权重应让中段位移远大于高段：${(mid.delta_ratio - 1).toFixed(4)} vs ${(near.delta_ratio - 1).toFixed(4)}`);
  // 答错时方向相反
  const wrong = updateStability({ S: 10, R0: 1, tHours: tMid, correct: false });
  assert.ok(wrong.delta_ratio < 1 && mid.delta_ratio > 1);
});

test('反馈 · 护栏：单步位移有上限、S 不会越界、缺参数时报错而不是静默给 0', () => {
  const huge = updateStability({ S: 10, R0: 1, tHours: 9.5, correct: false });
  assert.ok(huge.delta_ratio >= 0.6, `单步最多退 40%，实际 ${huge.delta_ratio}`);
  let S = 0.2;
  for (let i = 0; i < 50; i += 1) S = updateStability({ S, R0: 1, tHours: 1, correct: false }).S;
  assert.ok(S >= 0.1, `S 不应低于下界，实际 ${S}`);
  let big = 90000;
  for (let i = 0; i < 50; i += 1) big = updateStability({ S: big, R0: 1, tHours: 0.001, correct: true }).S;
  assert.ok(big <= 100000, `S 不应超过上界，实际 ${big}`);
  // 参数不完整时必须炸掉：曾经这里漏传 gamma，NaN 被 clamp 静默变成 0，
  // 于是 p≡0、u≡0、S 一步都不动 —— "记了反馈却没反应"就是这么来的。
  assert.throws(() => predictedRetrievability(10, 0.9, 20, { gamma: undefined }),
    /不是有限数|遗忘曲线/, '缺 gamma 应当报错');
  // 正常参数下 p 必须是个有意义的数（不是静默的 0）
  assert.ok(predictedRetrievability(19.2, 0.8, 20) > 0.5, '正常的 S=19.2h/隔 20h 时 p 应当明显大于 0');
});

test('反馈 · 回放确定性：同事件序列 ⇒ 同结果，且与逐步记录一致', () => {
  const log = new FeedbackLog();
  log.nodes.a = newLedger(19.2);
  const events = [
    { node: 'a', tHours: 20, correct: true },
    { node: 'a', tHours: 35, correct: false },
    { node: 'a', tHours: 12, correct: true },
    { node: 'a', tHours: 60, correct: true },
  ];
  for (const ev of events) log.record(ev);
  const replayed = log.replay();
  close(replayed.nodes.a.S, log.nodes.a.S, 1e-9);
  assert.equal(replayed.nodes.a.count, 4);
  assert.equal(replayed.events.length, 4);
  // 回放必须逐条一致（增益依赖条数，所以顺序也有意义）
  assert.deepEqual(replayed.events.map((e) => e.S), log.events.map((e) => e.S));
});

test('反馈 · 写回图：修正后的 S 会被引擎用于排程', () => {
  const g = makeGraph([['A', { ms: 0.8 }], ['B', { ms: 0.6 }]], [['A', 'B', 0.9]]);
  // 记忆状态是惰性初始化的（引擎第一次 sync 时才建），所以这里先走一次真实初始化
  for (const n of g.nodes.values()) memoryDsr.ensureState(n, 0);
  const log = new FeedbackLog();
  log.harvest(g);                        // 起点 = 图里现有的记忆状态
  close(log.nodes.A.S, 24 * 0.8, 1e-6);  // 引擎初值 S = legacy_k·R0 = 19.2（这里只差浮点尾数）
  for (let i = 0; i < 6; i += 1) log.record({ node: 'A', tHours: 30, correct: true });
  // 注意口径：R0=0.8，所以 85% 留存是够不到的（scheduleInterval 会返回 0）——用 70% 比较
  const before = g.get_node('A').m.memory_dsr.S;
  const beforeInterval = memoryDsr.scheduleInterval(g.get_node('A'), 0, 0.7, { decay_model: 'power' });
  const applied = log.applyToGraph(g);
  assert.equal(applied, 2);
  assert.ok(g.get_node('A').m.memory_dsr.S > before, 'S 应当被上调');
  // 排程随之变化：S 变大 ⇒ 同样的目标留存可以等更久
  const afterInterval = memoryDsr.scheduleInterval(g.get_node('A'), 0, 0.7, { decay_model: 'power' });
  assert.ok(afterInterval > beforeInterval * 1.1,
    `S 变大后排程应更远：${beforeInterval.toFixed(1)}h → ${afterInterval.toFixed(1)}h`);
  // 没反馈的节点保持原样
  close(g.get_node('B').m.memory_dsr.S, 24 * 0.6, 1e-6);
});

test('反馈 · 全局建议：k 取 S/R0 的中位数，样本不足时沿用默认', () => {
  const log = new FeedbackLog();
  log.nodes.a = { R0: 0.8, S: 40, D: 5, count: 3, correct: 2, lastAt: null, origin: { R0: 0.8, S: 19.2, D: 5 } };
  log.nodes.b = { R0: 0.6, S: 36, D: 5, count: 2, correct: 2, lastAt: null, origin: { R0: 0.6, S: 14.4, D: 5 } };
  log.nodes.c = { R0: 0.9, S: 54, D: 5, count: 4, correct: 3, lastAt: null, origin: { R0: 0.9, S: 21.6, D: 5 } };
  const s = log.suggestLegacyK();
  // S/R0 = 50 / 60 / 60 ⇒ 中位数 60
  close(s.legacy_k, 60, 1e-6);
  assert.equal(s.samples, 3);
  const thin = new FeedbackLog();
  thin.nodes.x = { R0: 0.8, S: 40, D: 5, count: 1, correct: 1, lastAt: null, origin: { R0: 0.8, S: 19.2, D: 5 } };
  assert.equal(thin.suggestLegacyK().legacy_k, 24, '样本不足时沿用默认 24');
});

test('反馈 · 持久化：写文件再读回，内容完全一致', () => {
  const log = new FeedbackLog();
  log.nodes.a = newLedger(19.2);
  log.record({ node: 'a', tHours: 24, correct: true, at: 1758000000000 });
  log.record({ node: 'a', tHours: 30, correct: false, at: 1758003600000 });
  const file = tmpPath(`feedback_${process.pid}.json`);
  log.saveToFile(file);
  const back = FeedbackLog.loadFromFile(file);
  assert.deepEqual(back.toJSON(), log.toJSON());
  fs.unlinkSync(file);
  // 不存在的文件 → 空账本
  const empty = FeedbackLog.loadFromFile(tmpPath('nope.json'));
  assert.equal(Object.keys(empty.nodes).length, 0);
  cleanupTmp();
});

test('反馈 · 报告：逐节点统计、总体准确率、"还差多少题"的诚实刻度', () => {
  const log = new FeedbackLog();
  log.nodes.a = newLedger(19.2);
  log.nodes.b = { R0: 0.7, S: 16.8, D: 5, count: 0, correct: 0, lastAt: null, origin: { R0: 0.7, S: 16.8, D: 5 } };
  for (let i = 0; i < 4; i += 1) log.record({ node: 'a', tHours: 20, correct: i < 3 });
  log.record({ node: 'b', tHours: 20, correct: false });
  const rep = log.report();
  assert.equal(rep.events, 5);
  close(rep.accuracy, 3 / 5, 1e-6);
  assert.equal(rep.rows[0].node, 'a');
  assert.equal(rep.rows[0].accuracy, 0.75);
  assert.ok(rep.rows[0].S_after !== rep.rows[0].S_before, 'S 应当被反馈改动过');
  assert.ok(rep.rows[0].se_best_pct > 0, '应当给出误差下界');
  assert.ok(rep.se_best_pct < rep.rows[1].se_best_pct, '证据越多，误差下界越小');
  assert.match(rep.note, /1 bit|信息/);
});
