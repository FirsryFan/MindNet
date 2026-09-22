#!/usr/bin/env node
/**
 * MindNet v2.0 控制层报告（诊断 → 处方 → 反事实预测）
 *
 * 用法：
 *   node probe/control_report.js                      # 用 example/demo_learning.json
 *   node probe/control_report.js example/graph.json   # 指定任意 §8.1 输入
 */
'use strict';

const path = require('path');
const { Config, Graph, createKernel } = require('../src/index.js');
const { FastEngine } = require('../src/v2/engine.js');
const planner = require('../mechanisms/control.planner.js');

const out = (s) => process.stdout.write(`${s}\n`);
const fixed = (x, n) => Number(x).toFixed(n === undefined ? 3 : n);

const file = process.argv[2] || path.join(__dirname, '..', 'example', 'demo_learning.json');
const config = new Config();
// 注意：Graph.load_input 收到字符串时按「文件路径」处理，所以这里先自己解析成对象
const input = JSON.parse(require('fs').readFileSync(file, 'utf8'));
const loaded = Graph.load_input(input, 0);

const kernel = createKernel(loaded.graph, config, { seed: 7, hours: 0, profile: 'v2' });
const engine = new FastEngine(loaded.graph, config, { kernel, seed: 7, hours: 0 });
engine.start_diffusion(loaded.initial_nodes, loaded.target_nodes);
// 现实用法：学到一半就问"现在该练什么"，而不是等扩散跑完
const MID_ROUNDS = 3;
for (let i = 0; i < MID_ROUNDS && !engine.stopped; i += 1) engine.step();
const result = engine.result();
const report = engine.control_report();

out('MindNet v2.0 控制层报告');
out('='.repeat(74));
out(`输入        ：${path.relative(process.cwd(), file)}`);
out(`起点 / 目标 ：${loaded.initial_nodes.join(', ')}  →  ${loaded.target_nodes.join(', ')}`);
out(`扩散进度    ：已走 ${engine.rounds} 轮（报告时点：学习中），目标全达成 ${result.targets_all_reached ? '是' : '否'}`);
out(`知识贡献    ：Gap = ${result.kc.gap}   Penalty = ${result.kc.penalty}`);

// ------------------------------------------------------------------ 元认知
out('\n【元认知】自信 vs 实际可提取度');
const meta = report.metacognition;
if (meta) {
  out(`  校准度（平均 |自信 − 可提取度|）= ${fixed(meta.calibration)}`);
  if (meta.danger.length) {
    out('  危险区（自信高、其实想不起来 —— 最该练的地方）：');
    for (const d of meta.danger) out(`    ${d.node.padEnd(16)} 自信 ${fixed(d.belief)}  实际 ${fixed(d.R)}  差 +${fixed(d.diff)}`);
  } else out('  危险区：无');
  if (meta.anxiety.length) {
    out('  焦虑区（其实会，但不敢用）：');
    for (const a of meta.anxiety) out(`    ${a.node.padEnd(16)} 自信 ${fixed(a.belief)}  实际 ${fixed(a.R)}`);
  }
}

// ------------------------------------------------------------------ 诊断
out('\n【卡点诊断】');
if (!report.diagnosis.length) out('  （没有卡点）');
for (const b of report.diagnosis.slice(0, 8)) {
  out(`  ${b.node.padEnd(16)} ${b.label}`);
  out(`      严重度 ${fixed(b.severity)}　证据：${JSON.stringify(b.evidence)}`);
  out(`      说明：${b.note}`);
  out(`      处方：${b.prescriptions.join(' / ')}`);
}

// ------------------------------------------------------------------ 处方
out('\n【今日处方】（能算的都算过：复习类看留存，拓扑/容量类看目标可达性）');
out(`  基线目标可达性 = ${report.baseline_reachability === undefined ? '—' : engine.reachability()}`);
if (!report.plan.length) out('  （没有可执行的处方）');
report.plan.slice(0, 10).forEach((p, i) => {
  const tag = p.simulated ? `预测增益 ${p.gain >= 0 ? '+' : ''}${fixed(p.gain)}（${p.metric === 'retention' ? '留存' : '可达性'}）代价 ${fixed(p.cost, 2)} 性价比 ${fixed(p.value)}` : '未模拟（规则映射）';
  out(`  ${String(i + 1).padStart(2)}. ${p.node.padEnd(16)} ${(planner.INSTRUCTIONS[p.instruction] || {}).name || p.instruction}`);
  out(`      ${tag}`);
  out(`      ${p.why}`);
});

const ruleOnly = Object.keys(planner.INSTRUCTIONS).filter((k) => !planner.INSTRUCTIONS[k].simulatable);
out(`\n  指令库：${Object.keys(planner.INSTRUCTIONS).length} 条（应用协议 17 条 + 执行层 4 条），`);
out(`          其中 ${ruleOnly.length} 条只做规则映射 —— 它们改变的是执行层用法，本引擎还没有对应状态，不假装算过。`);

if (engine.kernel.warnings.length) {
  out('\n【内核告警】');
  for (const w of engine.kernel.warnings) out(`  [${w.kind}] ${w.mechanism}：${w.message}`);
}
