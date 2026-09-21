#!/usr/bin/env node
/**
 * MindNet CLI —— 独立组件的最小外壳（命令行）
 *
 * 用法：
 *   node cli.js example/graph.json
 *   node cli.js example/demo_learning.json --max-rounds 50 --out state.json
 *   node cli.js example/graph.json --json            # 只输出 JSON（机器可读）
 *   node cli.js example/graph.json --now 493000.5    # 指定当前现实时间（小时）
 *   node cli.js example/graph.json --no-memory       # 跳过打开软件时的全局记忆更新
 */
'use strict';

const fs = require('fs');
const path = require('path');
const mindnet = require('./src/index.js');
const { Config, CognitiveModel, Graph, MindNetError, now_hours } = mindnet;

const USAGE = `MindNet —— 认知模型引擎 v1.1

用法：
  node cli.js <输入.json> [选项]

选项：
  --max-rounds <N>   最大更新轮次（缺省用配置里的 100）
  --now <小时>       当前现实时间（小时，从 Unix 纪元算；缺省取现在）
  --out <文件>       把完整状态写到文件
  --json             只打印 JSON（不打印中文摘要）
  --no-memory        跳过「打开软件时的全局记忆更新」
  --help             显示本说明

输入 JSON 形如设计文档 §8.1：
  { "graph": { "nodes": [...], "edges": [...] },
    "initial_nodes": ["node_1"], "target_nodes": ["node_2"] }`;

function parseArgs(argv) {
  const opts = {
    input: null,
    max_rounds: null,
    now: null,
    out: null,
    json: false,
    memory: true,
    help: false,
  };
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--no-memory') opts.memory = false;
    else if (a === '--max-rounds') opts.max_rounds = Number(argv[(i += 1)]);
    else if (a === '--now') opts.now = Number(argv[(i += 1)]);
    else if (a === '--out') opts.out = argv[(i += 1)];
    else rest.push(a);
  }
  opts.input = rest[0] || null;
  return opts;
}

function buildOutput(argv) {
  const opts = parseArgs(argv);
  if (opts.help || !opts.input) {
    return { exitCode: opts.help ? 0 : 1, text: USAGE, result: null };
  }
  const file = path.resolve(process.cwd(), opts.input);
  if (!fs.existsSync(file)) {
    return { exitCode: 1, text: `找不到输入文件：${file}`, result: null };
  }
  if (opts.max_rounds !== null && !Number.isFinite(opts.max_rounds)) {
    return { exitCode: 1, text: '--max-rounds 需要一个数字', result: null };
  }
  if (opts.now !== null && !Number.isFinite(opts.now)) {
    return { exitCode: 1, text: '--now 需要一个数字（小时）', result: null };
  }

  const now = opts.now === null ? now_hours() : opts.now;
  try {
    const input = JSON.parse(fs.readFileSync(file, 'utf8'));
    const loaded = Graph.load_input(input, now);
    const config = new Config();
    const model = new CognitiveModel(loaded.graph, config);

    const memory = opts.memory ? model.update_global_memory(now) : null;
    model.start_diffusion(loaded.initial_nodes, loaded.target_nodes);
    const result = model.run_until_stop(
      opts.max_rounds === null ? config.max_rounds : opts.max_rounds
    );
    const state = model.export_state(opts.out ? path.resolve(process.cwd(), opts.out) : undefined);

    const lines = [];
    if (!opts.json) {
      lines.push('MindNet 扩散结果');
      lines.push('────────────────────────────────────────');
      lines.push(`起点        ：${loaded.initial_nodes.join(', ') || '（无）'}`);
      lines.push(`目标        ：${loaded.target_nodes.join(', ') || '（无）'}`);
      lines.push(`更新轮次    ：${model.rounds}（停止原因：${describeStop(model.stop_reason)}）`);
      lines.push(`目标全达成  ：${result.targets_all_reached ? '是' : '否'}`);
      lines.push(`目标步数    ：${formatSteps(result.target_steps)}`);
      lines.push(`知识贡献 KC ：Gap = ${result.kc.gap}   Penalty = ${result.kc.penalty}`);
      if (memory) {
        lines.push(
          `记忆更新    ：衰减 ${memory.updated.length} 个节点，补时间 ${memory.filled_missing.length} 个（now = ${now}）`
        );
      }
      if (opts.out) lines.push(`状态已写入  ：${path.resolve(process.cwd(), opts.out)}`);
      lines.push('');
      lines.push('节点最终状态：');
      for (const node of loaded.graph.nodes.values()) {
        lines.push(
          `  ${pad(node.id, 16)} ${pad(node.state, 13)} ms=${node.ms.toFixed(4)}  al=${node.al}  visit=${node.visit_count}  ${node.name}`
        );
      }
      lines.push('');
      lines.push('输出协议（§8.2）：');
    }
    lines.push(JSON.stringify(result, null, 2));
    return { exitCode: 0, text: lines.join('\n'), result, state, model };
  } catch (err) {
    const prefix = err instanceof MindNetError ? 'MindNet 错误' : '运行出错';
    return { exitCode: 1, text: `${prefix}：${err.message}`, result: null, error: err };
  }
}

function describeStop(reason) {
  if (reason === 'all_targets_reached') return '所有目标已激活';
  if (reason === 'cooling') return '思维冷却（连续两轮无变化）';
  if (reason === 'max_rounds') return '达到最大轮次';
  return String(reason);
}

function formatSteps(steps) {
  const keys = Object.keys(steps);
  if (keys.length === 0) return '（无）';
  return keys.map((k) => `${k} = 第 ${steps[k]} 轮`).join('，');
}

function pad(text, width) {
  let len = 0;
  for (const ch of String(text)) len += ch.charCodeAt(0) > 255 ? 2 : 1;
  const padding = ' '.repeat(Math.max(0, width - len));
  return `${text}${padding}`;
}

function main(argv) {
  const out = buildOutput(argv);
  const stream = out.exitCode === 0 ? process.stdout : process.stderr;
  stream.write(`${out.text}\n`);
  return out.exitCode;
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}

module.exports = { main, buildOutput, parseArgs, USAGE };
