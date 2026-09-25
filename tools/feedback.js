#!/usr/bin/env node
/**
 * 反馈工具：把「做过的每道题」变成对稳定度 S 的修正（对应 docs/FEEDBACK.md）
 *
 * 用法：
 *   node tools/feedback.js init    <账本.json> [图.json]      # 从图里取每条线索的真实起点（推荐先做这一步）
 *   node tools/feedback.js add     <账本.json> --node <节点> --hours <小时> --correct|--wrong [--at <ms>] [--r0 <0-1>]
 *   node tools/feedback.js report  <账本.json>
 *   node tools/feedback.js compare <账本.json> <图.json>      # 体检：账本估计 vs 机制算出的 S
 *   node tools/feedback.js suggest <账本.json>
 *   node tools/feedback.js params  <账本.json> [-o overrides.json]   # 只调参数，不改 S
 *   node tools/feedback.js demo    [--events 400]             # 用模拟学生验证"收敛/不漂移"
 *
 * 分工（见 docs/IO_PROTOCOL.md §6）：S 由机制（memory.dsr）改，本工具只做体检与参数建议。
 *
 * 说明：
 *   - 账本 = 每条线索的 S 起点（origin）+ 之后的全部证据，所以随时可回放重算；
 *   - add 会自动建账本、自动按模型自己的曲线算 p（预测留存）；
 *   - apply 把修正写回图 JSON：引擎下次载入这个图就直接用新的 S 排程。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { FeedbackLog, updateStability, predictedRetrievability, gainAt, seLogSBest } = require('../src/feedback.js');
const memoryDsr = require('../mechanisms/memory.dsr.js');
const { Graph } = require('../src/index.js');
const { createRng } = require('../src/core/rng.js');

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--correct' || a === '--wrong') { out[a.slice(2)] = true; continue; }
    if (a === '--json') { out.json = true; continue; }
    // 取值型开关：--node X / --hours 48 / -o out.json（单横线也认，别把它当成文件名）
    if (/^--?[A-Za-z][A-Za-z0-9-]*$/.test(a)) {
      const key = a.replace(/^--?/, '');
      const val = argv[i + 1];
      if (val === undefined || /^--?[A-Za-z]/.test(val)) throw new Error(`参数 ${a} 缺少取值`);
      out[key] = val;
      i += 1;
      continue;
    }
    out._.push(a);
  }
  return out;
}

function loadLedger(file) {
  return FeedbackLog.loadFromFile(file);
}

function saveLedger(log, file) {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  log.saveToFile(file);
}

function needNode(args) {
  if (!args.node) throw new Error('add 需要 --node <节点 id>');
  return String(args.node);
}

function cmdInit(args) {
  const file = args._[1];
  const graphFile = args._[2];
  if (!file) throw new Error('init 需要账本文件路径（可选第二个参数：图.json）');
  const log = loadLedger(file);
  let added = 0;
  if (graphFile) {
    const raw = JSON.parse(fs.readFileSync(graphFile, 'utf8'));
    const input = raw.graph ? raw : { graph: raw };
    const g = Graph.from_object(input.graph, input.current_real_time === undefined ? 0 : input.current_real_time);
    // 先让 memory.dsr 建好状态，账本起点才是图里真实的 R0/S（而不是默认 24·0.8）
    for (const n of g.nodes.values()) memoryDsr.ensureState(n, 0);
    const tmp = new FeedbackLog();
    tmp.harvest(g);
    for (const [id, ledger] of Object.entries(tmp.nodes)) {
      if (!log.nodes[id]) { log.nodes[id] = ledger; added += 1; }
    }
    saveLedger(log, file);
    process.stdout.write(`已从 ${path.basename(graphFile)} 收录 ${added} 个节点（共 ${Object.keys(log.nodes).length} 个），写入 ${path.resolve(file)}\n`);
    return 0;
  }
  // 没有图：至少给一个空账本，方便后面 add
  saveLedger(log, file);
  process.stdout.write(`已创建空账本 ${path.resolve(file)}（建议：node tools/feedback.js init <账本> <图.json> 从图里取真实起点）\n`);
  return 0;
}

function cmdAdd(args) {
  const file = args._[1];
  if (!file) throw new Error('add 需要账本文件路径');
  const node = needNode(args);
  const hours = Number(args.hours);
  if (!Number.isFinite(hours) || hours < 0) throw new Error('add 需要 --hours <非负小时数>');
  const correct = args.correct === true;
  if (!correct && args.wrong !== true) throw new Error('add 需要 --correct 或 --wrong');
  const log = loadLedger(file);
  if (!log.nodes[node]) {
    // 新线索但账本里没有它：起点用模型默认初值（legacy_k·R0），可用 --r0 指定这条线索的编码强度
    const R0 = Number.isFinite(Number(args.r0)) && Number(args.r0) > 0 ? Math.min(1, Number(args.r0)) : 0.8;
    log.nodes[node] = {
      R0, S: 24 * R0, D: 5.1618, count: 0, correct: 0, lastAt: null,
      origin: { R0, S: 24 * R0, D: 5.1618 },
    };
  }
  const rec = log.record({
    node, tHours: hours, correct,
    at: args.at === undefined ? null : Number(args.at),
  });
  saveLedger(log, file);
  const L = log.nodes[node];
  const sePct = (Math.exp(seLogSBest(L.count)) - 1) * 100;
  const lines = [
    `${node}：考前预测 p = ${(rec.R_at_test * 100).toFixed(1)}% ⇒ ${correct ? '答对' : '答错'}`,
    `  S ${(rec.S / rec.delta_ratio).toFixed(2)} → ${rec.S.toFixed(2)} 小时（${rec.delta_ratio >= 1 ? '+' : ''}${((rec.delta_ratio - 1) * 100).toFixed(1)}%）`,
    `  本次增益 ${rec.gain.toFixed(3)}（会随证据条数递减）、信息量权重 ${rec.weight.toFixed(3)}`,
    `  累计 ${L.count} 条证据（对 ${L.correct}），S 的误差下界约 ${sePct > 200 ? '还测不准（需要几十条以上）' : `±${sePct.toFixed(0)}%`}`,
    `账本：${path.resolve(file)}`,
  ];
  process.stdout.write(`${lines.join('\n')}\n`);
  return 0;
}

function cmdReport(args) {
  const file = args._[1];
  if (!file) throw new Error('report 需要账本文件路径');
  const log = loadLedger(file);
  const rep = log.report();
  if (args.json) {
    process.stdout.write(`${JSON.stringify(rep, null, 2)}\n`);
    return 0;
  }
  if (!rep.events) {
    process.stdout.write('账本里还没有证据。\n');
    return 0;
  }
  const lines = [`共 ${rep.events} 条证据，正确率 ${(rep.accuracy * 100).toFixed(1)}%（S 的误差下界 ±${rep.se_best_pct}%）`];
  lines.push('节点                 条数  正确率   S 起点 → 现在       倍数');
  for (const r of rep.rows) {
    const before = r.S_before === null ? '—' : Number(r.S_before).toFixed(2);
    lines.push(
      `${String(r.node).padEnd(20)} ${String(r.count).padStart(4)}  `
      + `${r.accuracy === null ? '  — ' : `${(r.accuracy * 100).toFixed(0).padStart(4)}%`}  `
      + `${before.padStart(8)} → ${Number(r.S_after).toFixed(2).padEnd(9)} ${r.ratio === null ? '' : `${r.ratio.toFixed(2)}×`}`
    );
  }
  lines.push(`\n${rep.suggestion.note}`);
  lines.push(`提示：${rep.note}`);
  process.stdout.write(`${lines.join('\n')}\n`);
  return 0;
}

function cmdSuggest(args) {
  const file = args._[1];
  if (!file) throw new Error('suggest 需要账本文件路径');
  const log = loadLedger(file);
  const s = log.suggestLegacyK();
  if (args.json) {
    process.stdout.write(`${JSON.stringify(s, null, 2)}\n`);
    return 0;
  }
  process.stdout.write(`${s.note}\n用在 overrides 里就是：{"memory.dsr.legacy_k": ${s.legacy_k}}\n`);
  return 0;
}

function cmdApply(args) {
  const file = args._[1];
  if (!file) throw new Error('params 需要账本文件路径');
  const log = loadLedger(file);
  const overrides = log.suggestOverrides();
  const k = log.suggestLegacyK();
  const out = args.o || args.output;
  if (args.json) {
    process.stdout.write(`${JSON.stringify({ overrides, suggestion: k }, null, 2)}\n`);
    return 0;
  }
  if (out) {
    fs.writeFileSync(out, `${JSON.stringify(overrides, null, 2)}\n`, 'utf8');
    process.stdout.write(`已写入参数覆盖：${path.resolve(out)}\n`);
  }
  process.stdout.write(`${k.note}\n`);
  process.stdout.write(`${Object.keys(overrides).length ? `建议覆盖：${JSON.stringify(overrides)}` : '样本还不够，暂不建议覆盖任何参数'}\n`);
  process.stdout.write('说明：本模块不改任何节点的 S（那是机制的活），只调参数。\n');
  return 0;
}

/** 体检：账本估计 vs 图里机制算出的 S（本模块在新分工下的主要产出） */
function cmdCompare(args) {
  const file = args._[1];
  const graphFile = args._[2];
  if (!file || !graphFile) throw new Error('compare 需要 <账本.json> 与 <图.json> 两个路径');
  const log = loadLedger(file);
  const raw = JSON.parse(fs.readFileSync(graphFile, 'utf8').replace(/^\uFEFF/, ''));
  const input = raw.graph ? raw : { graph: raw };
  const g = Graph.from_object(input.graph, input.current_real_time === undefined ? 0 : input.current_real_time);
  for (const n of g.nodes.values()) memoryDsr.ensureState(n, 0);
  const cmp = log.compareWithGraph(g);
  if (args.json) {
    process.stdout.write(`${JSON.stringify(cmp, null, 2)}\n`);
    return 0;
  }
  const lines = [`体检：${cmp.samples} 个有效节点`, cmp.bias_note];
  if (cmp.rows.length) {
    lines.push('节点                 证据    机制 S      账本估 S   比值   误差下界');
    for (const r of cmp.rows) {
      lines.push(
        `${String(r.node).padEnd(20)} ${String(r.count).padStart(4)}  `
        + `${String(r.graph_S).padStart(9)}  ${String(r.ledger_S).padStart(10)}  `
        + `${(r.ratio === null ? '—' : `${r.ratio.toFixed(2)}×`).padStart(6)}  ±${r.se_best_pct}%`
      );
    }
  }
  process.stdout.write(`${lines.join('\n')}\n`);
  return 0;
}

/** 用模拟学生验证收敛与无偏（不用手点 400 道题也能看到反馈律的性质） */
function cmdDemo(args) {
  const events = Number(args.events || 400);
  const R0 = 0.9;
  const S_TRUE = 40;
  const TARGET = 0.7;
  const rng = createRng(20260925);
  const log = new FeedbackLog();
  log.nodes.n = {
    R0, S: 24 * R0, D: 5.1618, count: 0, correct: 0, lastAt: null,
    origin: { R0, S: 24 * R0, D: 5.1618 },
  };
  const stub = (S) => ({
    id: 'n', ms: R0, weight: 1, last_review_time: 0,
    m: { memory_dsr: { R0, S, Sigma: R0, D: 5.1618, N: 0, F: 0, lastFail: null, lastReview: 0, history: [], initializedAt: 0 } },
  });
  const trace = [];
  for (let i = 0; i < events; i += 1) {
    const t = memoryDsr.scheduleInterval(stub(log.nodes.n.S), 0, TARGET, { decay_model: 'power' });
    const pTrue = predictedRetrievability(S_TRUE, R0, t);
    log.record({ node: 'n', tHours: t, correct: rng() < pTrue });
    if ((i + 1) % Math.max(1, Math.round(events / 8)) === 0) trace.push(`  第 ${i + 1} 条：S = ${log.nodes.n.S.toFixed(1)} 小时`);
  }
  const bound = seLogSBest(events);
  const lines = [
    `模拟：真实 S = ${S_TRUE} 小时、R0 = ${R0}，起点用默认 ${24 * R0} 小时，按目标留存 ${TARGET} 排程`,
    ...trace,
    `结果：估计 S = ${log.nodes.n.S.toFixed(1)} 小时（误差 ${(((log.nodes.n.S - S_TRUE) / S_TRUE) * 100).toFixed(0)}%），`,
    `      实测正确率 ${((log.nodes.n.correct / log.nodes.n.count) * 100).toFixed(0)}%`,
    `理论下界：${events} 条证据后 log S 的标准误 ≥ ${bound.toFixed(3)}（即 ±${(((Math.exp(bound) - 1) * 100)).toFixed(0)}%）`,
    '结论：反馈是慢变量 —— 它调的是量级，不是小数点。这条下界与算法无关，是"对/错只有 1 bit"决定的。',
  ];
  process.stdout.write(`${lines.join('\n')}\n`);
  return 0;
}

function main(argv) {
  const args = parseArgs(argv || []);
  const cmd = args._[0];
  try {
    if (cmd === 'init') return cmdInit(args);
    if (cmd === 'add') return cmdAdd(args);
    if (cmd === 'report') return cmdReport(args);
    if (cmd === 'suggest') return cmdSuggest(args);
    if (cmd === 'params') return cmdApply(args);
    if (cmd === 'compare') return cmdCompare(args);
    if (cmd === 'demo') return cmdDemo(args);
    process.stdout.write(
      '用法：\n'
      + '  node tools/feedback.js init    <账本.json> [图.json]\n'
      + '  node tools/feedback.js add     <账本.json> --node <节点> --hours <小时> --correct|--wrong [--at <ms>] [--r0 <0-1>]\n'
      + '  node tools/feedback.js report  <账本.json> [--json]\n'
      + '  node tools/feedback.js compare <账本.json> <图.json>     # 体检：账本估计 vs 机制算出的 S\n'
      + '  node tools/feedback.js suggest <账本.json>\n'
      + '  node tools/feedback.js params  <账本.json> [-o overrides.json]   # 只调参数，不改 S\n'
      + '  node tools/feedback.js demo    [--events 400]\n'
    );
    return cmd ? 1 : 0;
  } catch (err) {
    process.stderr.write(`反馈工具错误：${err.message}\n`);
    return 1;
  }
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}

module.exports = { main, cmdInit, cmdAdd, cmdReport, cmdSuggest, cmdApply, cmdCompare, cmdDemo, parseArgs };
