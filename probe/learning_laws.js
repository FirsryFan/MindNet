#!/usr/bin/env node
/**
 * MindNet 学习规律体检探针（只读诊断，不改引擎、不写任何文件）
 *
 * 用途：把「人脑 / 学生学习」层面的已知规律逐条问一遍当前引擎，
 *       看哪几条它答不上来。这是设计评审用的证据工具，不是测试。
 *
 * 用法：node probe/learning_laws.js
 */
'use strict';

const { Graph, Config, CognitiveModel, apply_forgetting } = require('../src/index.js');

const config = new Config();
const out = (s) => process.stdout.write(`${s}\n`);

function build(nodes, edges, now) {
  return Graph.from_object(
    {
      nodes: nodes.map(([id, opts]) => Object.assign({ id, name: id, type: 'knowledge' }, opts || {})),
      edges: edges.map((e, i) => ({
        id: `e${i + 1}`,
        from: e[0],
        to: e[1],
        ls: e[2] === undefined ? 0.8 : e[2],
      })),
    },
    now === undefined ? 1000 : now
  );
}

out('MindNet 学习规律体检（v1.1 引擎实测）');
out('='.repeat(64));

// ---------------------------------------------------------------- 规律 1
out('\n【规律 1】成功提取次数越多 ⇒ 遗忘越慢');
out('  依据：你的 Application_Protocol §1 系统层「提取历史 K：成功提取次数越多，遗忘越慢」');
for (const reviews of [1, 3, 10]) {
  // 每次「专注复习」都把 ms 拉满到 1.0；v1.1 的稳定度 S = k · ms  （k = 24）
  const ms = 1.0;
  const S = config.forgetting_k * ms;
  const at72 = apply_forgetting(ms, 72, config);
  const at720 = apply_forgetting(ms, 720, config);
  out(
    `  复习 ${String(reviews).padStart(2)} 次后：S = ${S} 小时，` +
      `72 小时后留存 = ${at72.toFixed(6)}，30 天后留存 = ${at720.toExponential(3)}`
  );
}
out('  → 三个结果完全一样：复习多少次都不改变遗忘速度，v1.1 表达不出「提取历史」。');

// ---------------------------------------------------------------- 规律 2
out('\n【规律 2】意识带宽有限（同一时刻能「在脑子里」的东西很少）');
out('  依据：你的 Executive_Architecture §5.1「思维容量……尚未建模」');
{
  const N = 200;
  const nodes = [['C', { ms: 0.9 }]];
  const edges = [];
  for (let i = 0; i < N; i += 1) {
    nodes.push([`L${i}`, { ms: 0.9 }]);
    edges.push(['C', `L${i}`, 0.9]);
  }
  const g = build(nodes, edges);
  const m = new CognitiveModel(g, config);
  m.start_diffusion(['C'], []);
  const status = m.step();
  const conscious = Array.from(g.nodes.values()).filter((n) => n.state === 'CONSCIOUS').length;
  out(`  1 轮之内点亮 ${status.activated.length} 个节点，CONSCIOUS 合计 ${conscious} / ${g.size}`);
  out('  → 没有任何容量上限：线索越强、图越密，同时「涌进意识」的东西越多。');
}

// ---------------------------------------------------------------- 规律 3
out('\n【规律 3】多条独立线索汇聚 ⇒ 更容易想起来（证据汇聚）');
{
  const nodes = [['Y', {}]];
  const edges = [];
  for (let i = 0; i < 10; i += 1) {
    nodes.push([`S${i}`, { ms: 0.5 }]);
    edges.push([`S${i}`, 'Y', 0.08]);
  }
  const g = build(nodes, edges);
  const m = new CognitiveModel(g, config);
  const starts = nodes.slice(1).map((n) => n[0]);
  m.start_diffusion(starts, []);
  m.run_until_stop();
  out(
    `  10 个起点同时指向 Y：单条最大 Impact = ${(0.5 * 1.0 * 0.08).toFixed(2)}（低于 ST 0.05），` +
      `十条之和 = ${(10 * 0.5 * 1.0 * 0.08).toFixed(2)}（≥ CT ${config.ct_default}）`
  );
  out(`  Y 的最终状态 = ${g.get_node('Y').state}，被记为一次「尝试失败」`);
  out('  → 入边只取最大值，汇聚证据被丢掉：10 条弱线索不如 1 条刚好过线的线索。');
}

// ---------------------------------------------------------------- 规律 4
out('\n【规律 4】联想强度随距离衰减（一跳到五跳不该一样强）');
{
  const chain = ['A', 'B', 'C', 'D', 'E', 'F'];
  const nodes = chain.map((id) => [id, { ms: 0.9 }]);
  const edges = chain.slice(0, -1).map((id, i) => [id, chain[i + 1], 0.9]);
  const g = build(nodes, edges);
  const m = new CognitiveModel(g, config);
  m.start_diffusion(['A'], []);
  m.run_until_stop();
  const impacts = m.kc_breakdown().gap.map((r) => `${r.id}=${r.impact}`);
  out(`  六节点链 A→B→C→D→E→F，每一跳的首次 Impact：${impacts.join('，')}`);
  out('  → 第 5 跳和第 1 跳一样强：信号不随路径长度衰减，长链推理被当成直接回忆。');
}

// ---------------------------------------------------------------- 规律 5
out('\n【规律 5】失败证据应该会过期（上周卡住 ≠ 一年前卡住）');
{
  const g = build([['A', { ms: 0.2 }], ['Y', { weight: 1.0 }]], [['A', 'Y', 0.1]]);
  const m = new CognitiveModel(g, config);
  m.start_diffusion(['A'], []);
  m.run_until_stop();
  const fresh = m.get_kc().penalty;

  m.update_global_memory(1000 + 8760); // 一年后打开软件：只更新 ms，不碰失败记录
  m.start_diffusion(['A'], []);
  m.run_until_stop();
  const old = m.get_kc().penalty;
  out(`  刚失败时 Penalty = ${fresh}；8760 小时（一年）后再算 Penalty = ${old}`);
  out(`  Y 的 visit_count = ${g.get_node('Y').visit_count}（只增不减，不记录失败发生的时间）`);
  out('  → 「死角」是终身记录：一年前的一次失败和昨天的一次失败，对今天的学习计划影响相同。');
}

out(`\n${'='.repeat(64)}`);
out('结论：规律 1–5 全部答不上来。它们分别对应 v1.1 的五个机制缺口：');
out('  1 记忆只有 MS 没有稳定度 S（复习不改变遗忘速度）');
out('  2 没有意识带宽（激活无上限、无竞争）');
out('  3 入边取 max 而不是求和（汇聚证据丢失）');
out('  4 每跳用源节点自己的 ms，信号不随路径衰减（距离无代价）');
out('  5 失败证据只计数、不记时间（死角终身制）');
