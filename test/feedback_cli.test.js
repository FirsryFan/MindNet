'use strict';

/**
 * 反馈 CLI 的测试（tools/feedback.js）。
 * 重点：命令行里的每一步都必须和 src/feedback.js 的账本语义一致，
 * 而且 apply 写出来的图必须真的能被引擎载入、并按新 S 排程。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { main } = require('../tools/feedback.js');
const { FeedbackLog } = require('../src/feedback.js');
const memoryDsr = require('../mechanisms/memory.dsr.js');
const mindnet = require('../src/index.js');
const { tmpPath, cleanupTmp } = require('./helpers.js');

const EXAMPLE = path.join(__dirname, '..', 'example', 'demo_learning.json');

/** 跑一次 CLI，捕获 stdout/stderr */
function run(argv) {
  const out = [];
  const err = [];
  const so = process.stdout.write;
  const se = process.stderr.write;
  process.stdout.write = (s) => { out.push(String(s)); return true; };
  process.stderr.write = (s) => { err.push(String(s)); return true; };
  let code;
  try {
    code = main(argv);
  } finally {
    process.stdout.write = so;
    process.stderr.write = se;
  }
  return { code, text: out.join(''), err: err.join('') };
}

test('反馈 CLI · init：从图里取真实起点（R0/S 来自图，而不是默认值）', () => {
  const ledger = tmpPath(`fb_init_${process.pid}.json`);
  const r = run(['init', ledger, EXAMPLE]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.text, /已从 demo_learning\.json 收录 10 个节点/);
  const log = FeedbackLog.loadFromFile(ledger);
  assert.equal(Object.keys(log.nodes).length, 10);
  // 图里 polar 的 ms = 0.15 ⇒ 起点 S 应当是 24 × 0.15，而不是默认 19.2
  assert.equal(log.nodes.polar.R0, 0.15);
  assert.ok(Math.abs(log.nodes.polar.S - 24 * 0.15) < 1e-3);
  fs.unlinkSync(ledger);
  cleanupTmp();
});

test('反馈 CLI · add：答错下调、答对上调，且账本可被 report 读回', () => {
  const ledger = tmpPath(`fb_add_${process.pid}.json`);
  assert.equal(run(['init', ledger, EXAMPLE]).code, 0);
  const before = FeedbackLog.loadFromFile(ledger).nodes.unit_circle.S;

  const wrong = run(['add', ledger, '--node', 'unit_circle', '--hours', '48', '--wrong']);
  assert.equal(wrong.code, 0, wrong.err);
  assert.match(wrong.text, /答错/);
  const s1 = FeedbackLog.loadFromFile(ledger).nodes.unit_circle.S;
  assert.ok(s1 < before, `答错必须下调：${before} → ${s1}`);

  assert.equal(run(['add', ledger, '--node', 'unit_circle', '--hours', '12', '--correct']).code, 0);
  const s2 = FeedbackLog.loadFromFile(ledger).nodes.unit_circle.S;
  assert.ok(s2 > s1, `答对必须上调：${s1} → ${s2}`);

  const rep = run(['report', ledger]);
  assert.equal(rep.code, 0);
  assert.match(rep.text, /共 2 条证据/);
  assert.match(rep.text, /unit_circle/);
  // --json 的输出必须能被 JSON.parse
  const js = run(['report', ledger, '--json']);
  assert.equal(js.code, 0);
  assert.equal(JSON.parse(js.text).events, 2);
  fs.unlinkSync(ledger);
  cleanupTmp();
});

test('反馈 CLI · add：缺参数时给出用法提示而不是崩栈', () => {
  const ledger = tmpPath(`fb_bad_${process.pid}.json`);
  const noNode = run(['add', ledger, '--hours', '10', '--correct']);
  assert.equal(noNode.code, 1);
  assert.match(noNode.err, /--node/);
  const noVerdict = run(['add', ledger, '--node', 'A', '--hours', '10']);
  assert.equal(noVerdict.code, 1);
  assert.match(noVerdict.err, /--correct 或 --wrong/);
  const noHours = run(['add', ledger, '--node', 'A', '--correct']);
  assert.equal(noHours.code, 1);
  assert.match(noHours.err, /--hours/);
  // 不认识的命令 → 打印用法并返回 1
  const bad = run(['nope']);
  assert.equal(bad.code, 1);
  assert.match(bad.text, /用法/);
  cleanupTmp();
});

test('反馈 CLI · params / compare：只给参数建议，不改图里的 S；体检能报出偏差', () => {
  const ledger = tmpPath(`fb_params_${process.pid}.json`);
  const outFile = tmpPath(`fb_overrides_${process.pid}.json`);
  assert.equal(run(['init', ledger, EXAMPLE]).code, 0);
  // 给三个节点各喂 4 条"答对"，让 k 建议有样本
  for (const node of ['polar', 'coordinate', 'vector']) {
    for (let i = 0; i < 4; i += 1) {
      assert.equal(run(['add', ledger, '--node', node, '--hours', '3', '--correct']).code, 0);
    }
  }
  const r = run(['params', ledger, '-o', outFile]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.text, /本模块不改任何节点的 S/);
  const overrides = JSON.parse(fs.readFileSync(outFile, 'utf8').replace(/^\uFEFF/, ''));
  assert.equal(typeof overrides['memory.dsr.legacy_k'], 'number', `应当给出 legacy_k 建议：${JSON.stringify(overrides)}`);

  // compare：账本估计 vs 图里机制算出的 S
  const cmp = run(['compare', ledger, EXAMPLE, '--json']);
  assert.equal(cmp.code, 0, cmp.err);
  const parsed = JSON.parse(cmp.text);
  assert.equal(parsed.rows.length, 3);
  for (const row of parsed.rows) {
    assert.ok(row.graph_S > 0 && row.ledger_S > 0);
    assert.equal(typeof row.ratio, 'number');
  }
  const human = run(['compare', ledger, EXAMPLE]);
  assert.match(human.text, /体检：/);
  // example 图文件本身没被动过（退休的 apply 会往里写 m 字段）
  const graphAfter = JSON.parse(fs.readFileSync(EXAMPLE, 'utf8'));
  assert.equal(graphAfter.graph.nodes.find((n) => n.id === 'polar').m, undefined,
    'example 图里不该被写入记忆状态');
  fs.unlinkSync(ledger);
  fs.unlinkSync(outFile);
  cleanupTmp();
});

test('反馈 CLI · suggest：样本不足沿用默认，够了就给中位数 k', () => {
  const ledger = tmpPath(`fb_sug_${process.pid}.json`);
  const log = new FeedbackLog();
  for (const [id, S, R0] of [['a', 40, 0.8], ['b', 36, 0.6], ['c', 54, 0.9]]) {
    log.nodes[id] = { R0, S, D: 5, count: 4, correct: 3, lastAt: null, origin: { R0, S, D: 5 } };
  }
  log.saveToFile(ledger);
  const r = run(['suggest', ledger]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.text, /60/);                       // S/R0 = 50 / 60 / 60 ⇒ 中位数 60
  const thin = tmpPath(`fb_thin_${process.pid}.json`);
  new FeedbackLog().saveToFile(thin);
  assert.match(run(['suggest', thin]).text, /默认 24/);
  fs.unlinkSync(ledger);
  fs.unlinkSync(thin);
  cleanupTmp();
});

test('反馈 CLI · demo：模拟学生在 400 条证据后进入信息下界附近', () => {
  const r = run(['demo', '--events', '400']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.text, /真实 S = 40 小时/);
  assert.match(r.text, /理论下界/);
  const m = /估计 S = ([\d.]+) 小时（误差 (-?\d+)%）/.exec(r.text);
  assert.ok(m, `demo 输出应当含估计值：${r.text}`);
  assert.ok(Math.abs(Number(m[2])) < 40, `误差 ${m[2]}% 应当在 40% 以内（1 倍标准误 ≈ 26%）`);
});
