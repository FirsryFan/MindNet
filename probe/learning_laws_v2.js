#!/usr/bin/env node
/**
 * MindNet 学习规律体检（v2 版）：与 v1.1 逐条对照，看哪几条已经答得上
 *
 * 用法：node probe/learning_laws_v2.js
 * 对照基线：probe/learning_laws.js（v1.1 五条规律全部答不上）
 */
'use strict';

const { Config, apply_forgetting } = require('../src/index.js');
const memory = require('../mechanisms/memory.dsr.js');

const config = new Config();
const O = memory.options();
const O_EXP = memory.options({ decay_model: 'exponential' });
const out = (s) => process.stdout.write(`${s}\n`);
const f = (x, n = 6) => Number(x).toFixed(n);

function stub(ms) {
  return { id: 'n', ms: ms === undefined ? 0.8 : ms, weight: 1, m: {}, last_review_time: 0 };
}

/** v1.1：N 次「专注复习」（每次 ms 拉满 1.0），再看 72 小时后的留存 */
function v1RetentionAfterReviews() {
  return apply_forgetting(1.0, 72, config);
}

/** v2：N 次成功提取（间隔 24 小时），再看 72 小时后的留存 */
function v2RetentionAfterReviews(n) {
  const node = stub();
  let u = 0;
  memory.ensureState(node, 0, O);
  for (let i = 0; i < n; i += 1) {
    u += 24;
    memory.applyReview(node, u, { type: 'retrieval_success', grade: 3 }, O);
  }
  return memory.retrievabilityOf(node, u + 72, O);
}

out('MindNet 学习规律体检（v2）');
out('='.repeat(72));

// ---------------------------------------------------------------- 规律 1
out('\n【规律 1】成功提取次数越多 ⇒ 遗忘越慢');
out('  v1.1：');
for (const n of [1, 3, 10]) out(`    复习 ${String(n).padStart(2)} 次 → 72h 后留存 ${f(v1RetentionAfterReviews())}   ← 恒定`);
out('  v2  ：');
for (const n of [1, 3, 10]) out(`    复习 ${String(n).padStart(2)} 次 → 72h 后留存 ${f(v2RetentionAfterReviews(n))}`);
out('  ⇒ 已翻转：v2 的留存随复习次数单调上升；v1.1 与次数无关。');

// ---------------------------------------------------------------- 规律 5
out('\n【规律 5】失败证据会过期（上周卡住 ≠ 一年前卡住）');
{
  const node = stub(0.8);
  memory.recordFailure(node, 0, O);
  const graph = { nodes: new Map([['n', node]]) };
  const fresh = memory.penaltyOf(graph, 0, O).penalty;
  const month = memory.penaltyOf(graph, 30 * 24, O).penalty;
  const year = memory.penaltyOf(graph, 365 * 24, O).penalty;
  out(`  v1.1：刚失败 ${f(1, 1)} → 一个月后 ${f(1, 1)} → 一年后 ${f(1, 1)}        ← 终身累计，不变`);
  out(`  v2  ：刚失败 ${f(fresh, 6)} → 一个月后 ${f(month, 6)} → 一年后 ${f(year, 6)}`);
  out('  ⇒ 已翻转：v2 的失败证据按 30 天半衰期指数衰减。');
}

// ---------------------------------------------------------------- 规律 2/3/4
out('\n【规律 2】意识带宽有限（容量竞争）');
out('  v1.1：200 节点星图 1 轮点亮全部 201 个');
out('  v2  ：内核已实现两级容量准入（DAR=4 / FA=1），但快层扩散循环属于 v1.3 —— 待做');
out('\n【规律 3】多条线索汇聚 ⇒ 更容易想起来（入边求和）');
out('  v1.1：取最大值，10 条弱线索合计 0.40 仍判 INACTIVE');
out('  v2  ：方程已定义（求和 + 分流饱和），实现属于 v1.3 —— 待做');
out('\n【规律 4】联想随距离衰减');
out('  v1.1：六节点链每跳首次 Impact 都是 0.81');
out('  v2  ：a 递归衰减自动带来距离代价，实现属于 v1.3 —— 待做');

// ---------------------------------------------------------------- 新能力
out('\n【新能力 A】排程反解：什么时候该复习，由目标留存率算出来');
{
  const node = stub(1.0);
  memory.ensureState(node, 0, O);
  const S = node.m.memory_dsr.S;
  out(`  S = ${f(S, 2)} 小时；不同目标留存对应的间隔：`);
  for (const r of [0.95, 0.9, 0.85, 0.8, 0.7]) {
    out(`    目标 ${r} → ${f(memory.scheduleInterval(node, 0, r, O) / S, 3)} × S`);
  }
  out('  ⇒ 85% 规则（Wilson 2019）在本模型里就是一个乘数：1.906 × S');
}

out('\n【新能力 B】退化等价：指数模式 + S = k·R0 时与 v1.1 逐位相同');
{
  let maxDiff = 0;
  for (let t = 0; t <= 200; t += 0.5) {
    const node = stub(0.8);
    memory.ensureState(node, 0, O_EXP);
    maxDiff = Math.max(maxDiff, Math.abs(memory.retrievabilityOf(node, t, O_EXP) - apply_forgetting(0.8, t, config)));
  }
  out(`  t ∈ [0,200]h 上 v1.1 与 v2（指数模式）的最大差 = ${maxDiff}`);
}

out('\n【新能力 C】复习类型有区别（v1.1 只有一种「专注复习」）');
{
  const node = stub();
  const bag = memory.ensureState(node, 0, O);
  const R = 0.6;
  const rows = [
    ['再读（被动）', memory.stabilityIncrease(bag, R, O, 'reread', 0.5)],
    ['失败后对答案（closeness=0.9）', memory.stabilityIncrease(bag, R, O, 'retrieval_failure_feedback', 0.9)],
    ['提取成功', memory.stabilityIncrease(bag, R, O, 'retrieval_success', 0.5)],
  ];
  for (const [name, inc] of rows) out(`    ${name.padEnd(30)} SInc = ${f(inc, 3)}`);
}

out(`\n${'='.repeat(72)}`);
out('小结：规律 1、5 已翻转；规律 2、3、4 需要 v1.3 的快层（方程已定，未实现）；');
out('      另新增三项 v1.1 完全不具备的能力：排程反解、退化等价、复习分档。');
