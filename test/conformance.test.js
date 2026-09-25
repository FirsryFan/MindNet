'use strict';

/**
 * 一致性样例（conformance vectors）的测试。
 *
 * 守两件事：
 *   1. **样例不过期**：`tools/conformance.js --check` 必须与当前实现逐字符一致；
 *   2. **样例有语义**：抽查几条关系（85% 目标 = 1.906×S、储蓄效应、档位单调、closeness 单调），
 *      防止生成器悄悄吐出一堆自洽但没意义的数字。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { main, OUT } = require('../tools/conformance.js');
const { close } = require('./helpers.js');

const vectors = require('../conformance/mindnet_vectors.json');

function byId(id) {
  const v = vectors.tierA.find((x) => x.id === id);
  assert.ok(v, `样例里缺 ${id}`);
  return v.expected;
}

test('样例 · 文件与当前实现一致（--check 通过，样例不会过期）', () => {
  const out = [];
  const so = process.stdout.write;
  const se = process.stderr.write;
  process.stdout.write = (s) => { out.push(String(s)); return true; };
  process.stderr.write = (s) => { out.push(String(s)); return true; };
  let code;
  try {
    code = main(['--check']);
  } finally {
    process.stdout.write = so;
    process.stderr.write = se;
  }
  assert.equal(code, 0, `--check 失败：${out.join('')}\n（若是有意改动实现，请重跑 node tools/conformance.js --write）`);
});

test('样例 · 结构完整：每条都有 id / api / input / expected，且能被打包（npm pack 之前也能读）', () => {
  assert.equal(vectors.protocol, 'mindnet.conformance/1');
  assert.ok(vectors.generated_from.commit, '必须记录生成时的 commit，Dart 侧要钉快照');
  assert.ok(vectors.tolerances && vectors.tolerances.rel > 0, '必须给出容差');
  assert.ok(vectors.tierA.length >= 40, `tierA 样例太少：${vectors.tierA.length}`);
  assert.ok(vectors.tierB.length >= 1, 'tierB 至少要有一条快层样例');
  for (const v of [...vectors.tierA, ...vectors.tierB]) {
    assert.ok(v.id && v.api && v.input && v.expected, `样例字段不全：${JSON.stringify(v).slice(0, 80)}`);
  }
  assert.ok(path.isAbsolute(OUT));
});

test('样例 · 语义抽查：与文档口径一致（85% = 1.906×S、储蓄效应、档位与 closeness 单调）', () => {
  // ① 排程反解：R0=1 时 85% 目标的间隔 = 1.906 × S（S = 19.2）
  close(byId('A05-schedule-target0.85').hours / 19.2, 1.906, 2e-3);
  close(byId('A05-schedule-target0.9').hours / 19.2, 1.0, 1e-3);
  // 目标越松，间隔越远
  const targets = [0.95, 0.9, 0.85, 0.8, 0.7, 0.5].map((t) => byId(`A05-schedule-target${t}`).hours);
  for (let i = 1; i < targets.length; i += 1) assert.ok(targets[i] > targets[i - 1], '目标留存越低，间隔应当越远');

  // ② 曲线单调：t 越大 R 越小
  const rs = [0, 1, 5, 10, 48, 200].map((t) => byId(`A04-retrievability-t${t}`).R);
  for (let i = 1; i < rs.length; i += 1) assert.ok(rs[i] < rs[i - 1], 'R 必须随 t 下降');

  // ③ 储蓄效应：Σ 越大，同一次复习的增益越大
  const savings = [0, 0.5, 0.9].map((s) => byId(`A08-savings-sigma${s}`).S_after);
  assert.ok(savings[0] < savings[1] && savings[1] < savings[2], `Σ 应当放大增益：${savings.join(' < ')}`);

  // ④ 表现档位：grade 影响的是**难度 D**（S 的即时增益由复习类型、R、D、Σ 共同决定，
  //    所以同一次复习里换档位不会立刻改变 S —— 这是模型的既有语义，不是 bug）
  const ds = [1, 2, 3, 4].map((g) => byId(`A07-grade${g}-difficulty`).D_after);
  assert.ok(ds[0] > ds[1] && ds[1] > ds[2] && ds[2] > ds[3], `档位越高难度越低：${ds.join(' > ')}`);

  // ⑤ closeness 越大，"失败后对答案"的增益越大
  close(byId('A06-applyReview-retrieval_success-t5').kind, 'review', 0);
  const c04 = vectors.tierA.find((v) => v.id === 'A06-applyReview-failure_feedback-c0.4-t5').expected;
  const c09 = vectors.tierA.find((v) => v.id === 'A06-applyReview-failure_feedback-c0.9-t5').expected;
  assert.ok(c09.S_after > c04.S_after, `closeness 越大增益越大：${c04.S_after} vs ${c09.S_after}`);

  // ⑥ 遗忘路径：R0=0.8、S=19.2 的节点忘一次，S 必须下降
  const lapse = byId('A06-applyReview-lapse-t30');
  assert.equal(lapse.kind, 'lapse');
  assert.ok(lapse.S_after < 19.2, `遗忘后 S 必须下降：${lapse.S_after}`);
  // 失败证据与 Σ 只增不减
  assert.ok(lapse.Sigma_after >= 0.8);
});

test('样例 · tierB 快层：驱动/准入/状态自洽（不依赖 JS 实现也能核对）', () => {
  const b = vectors.tierB[0];
  assert.equal(b.expected.rounds.length, 5);
  const first = b.expected.rounds[0];
  // 第 1 轮：只有起点 A 有激活 ⇒ A→B 的入边贡献 = al(A)·ms(A)·ls = 1 · 0.8 · 0.9 = 0.72
  const edgeTo = (round, to) => round.drive_edges.filter((e) => e.kind === 'edge' && e.to === to);
  close(edgeTo(first, 'B')[0].contribution, 0.8 * 0.9, 1e-6);
  close(edgeTo(first, 'C')[0].contribution, 0.8 * 0.3, 1e-6);
  for (const e of first.drive_edges) {
    if (e.kind === 'edge') close(e.contribution, e.al * e.ms * e.ls, 1e-6);
  }
  // 驱动 = 逐项之和（入边 + 亚阈 + 模块改写）；模块改写来自 context.goal 的目标偏置
  for (const r of b.expected.rounds) {
    const sum = {};
    for (const e of r.drive_edges) sum[e.to] = (sum[e.to] || 0) + e.contribution;
    for (const id of Object.keys(r.drive)) {
      close(r.drive[id], sum[id] || 0, 1e-5);
    }
  }
  // 目标自身不吃偏置：C 在第一轮只有入边贡献
  assert.equal(first.drive_edges.filter((e) => e.to === 'C' && e.kind === 'module').length, 0,
    '目标节点不该被自己的目标偏置点亮');
  // 每轮每个节点都要有状态
  for (const r of b.expected.rounds) {
    assert.equal(r.states.length, 3, '三个节点都应有状态');
    for (const s of r.states) assert.ok(['CONSCIOUS', 'SUBCONSCIOUS', 'INACTIVE'].indexOf(s.state_after) >= 0);
  }
  // 起点必须始终在意识里（焦点被按住）
  for (const r of b.expected.rounds) assert.ok(r.conscious.indexOf('A') >= 0, '起点必须在意识里');
  // 容量约束：进入意识的不许超过 W_DAR（默认 4.0）
  for (const r of b.expected.rounds) assert.ok(r.conscious.length <= 4, `意识数超容量：${r.conscious.length}`);
});

test('样例 · 生成器可被工具调用（--write 后 --check 必须通过）', () => {
  // 这是一条"幂等"断言：写一次、校验一次，保证生成器本身是确定性的
  const script = path.join(__dirname, '..', 'tools', 'conformance.js');
  execFileSync(process.execPath, [script, '--write'], { stdio: 'pipe' });
  const out = execFileSync(process.execPath, [script, '--check'], { stdio: 'pipe' }).toString();
  assert.match(out, /样例一致/);
});
