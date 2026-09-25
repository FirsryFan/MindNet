'use strict';

/**
 * I/O 层测试（`docs/IO_PROTOCOL.md` §8 的十条验收断言，逐条落地）。
 *
 * 这里守的是三件事：
 *   1. 输入契约严格 —— 不合法就整份拒绝，绝不半途生效；
 *   2. 过程可信 —— trace 里的每个数都能由引擎复算；
 *   3. 可回放 —— 同请求同结果、幂等、存档能重放。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Graph, Config, createKernel, FastEngine, memoryDsr } = require('../src/index.js');
const io = require('../src/io/run.js');
const { RunArchive } = require('../src/io/archive.js');
const { makeGraph, close } = require('./helpers.js');

const EXAMPLE = path.join(__dirname, '..', 'example');

/** 造一套引擎（v2 profile） */
function makeEngine(graph, options) {
  const opts = Object.assign({ seed: 7, hours: 0, profile: 'v2' }, options || {});
  const kernel = createKernel(graph, new Config(), opts);
  const engine = new FastEngine(graph, kernel.config, { kernel });
  return { engine, kernel };
}

function demoGraph() {
  const loaded = Graph.load_input(require('../example/demo_learning.json'), 0);
  return loaded;
}

function baseRequest(over) {
  return Object.assign({
    protocol: 'mindnet.run/1',
    run_id: 'run-1',
    time: { model_hours: 10 },
    actions: [],
  }, over || {});
}

// ---------------------------------------------------------------- 输入契约

test('IO · 请求校验：缺字段 / 未知 kind / 不存在节点 / 无时间基 都要报错且不改状态', () => {
  const g = makeGraph([['A', { ms: 0.8 }], ['B', { ms: 0.6 }]], [['A', 'B', 0.9]]);
  const { engine, kernel } = makeEngine(g);
  const hash = kernel.stateHash();

  const bad = [
    [baseRequest({ protocol: 'nope' }), /protocol/],
    [baseRequest({ run_id: '' }), /run_id/],
    [baseRequest({ actions: 'x' }), /actions/],
    [baseRequest({ actions: [{ kind: 'teleport', at: { model_hours: 1 } }] }), /kind 必须是/],
    [baseRequest({ actions: [{ kind: 'review', node: 'Z', outcome: 'correct', at: { model_hours: 1 } }] }), /不存在的节点/],
    [baseRequest({ actions: [{ kind: 'review', node: 'A', outcome: 'maybe', at: { model_hours: 1 } }] }), /outcome/],
    [baseRequest({ actions: [{ kind: 'review', node: 'A' }] }), /缺少时间基|缺少 at/],
    [baseRequest({ steps: -1 }), /steps/],
  ];
  for (const [req, re] of bad) {
    assert.throws(() => io.run({ engine, kernel, request: req, archive: new RunArchive() }), re,
      `这类请求必须被拒绝：${JSON.stringify(req.actions)}`);
  }
  assert.equal(kernel.stateHash(), hash, '被拒绝的请求不许改动状态');
});

test('IO · 矛盾观察：同一节点同时 correct 与 wrong ⇒ 整份拒绝', () => {
  const g = makeGraph([['A', { ms: 0.8 }]], []);
  const { engine, kernel } = makeEngine(g);
  assert.throws(() => io.run({
    engine, kernel, archive: new RunArchive(),
    request: baseRequest({
      actions: [
        { kind: 'review', node: 'A', outcome: 'correct', at: { model_hours: 1 } },
        { kind: 'review', node: 'A', outcome: 'wrong', at: { model_hours: 1 } },
      ],
    }),
  }), /互相矛盾/);
});

test('IO · 时间基：只给 wall 且没有锚点 ⇒ 报错；有锚点 ⇒ 换算并写进 assumptions', () => {
  const g = makeGraph([['A', { ms: 0.8 }]], []);
  const { engine, kernel } = makeEngine(g);
  assert.throws(() => io.run({
    engine, kernel, archive: new RunArchive(),
    request: baseRequest({
      actions: [{ kind: 'exposure', node: 'A', at: { wall: '2026-09-25T22:00:00+08:00' } }],
    }),
  }), /锚点/);

  const res = io.run({
    engine, kernel, archive: new RunArchive(),
    request: {
      protocol: 'mindnet.run/1', run_id: 'run-anchor',
      time: { model_hours: 10, wall: '2026-09-25T21:00:00+08:00' },
      actions: [
        { kind: 'exposure', node: 'A', at: { wall: '2026-09-25T23:00:00+08:00' } },
      ],
    },
  });
  assert.equal(res.status, 'ok');
  assert.equal(res.assumptions.length, 1, '换算必须写进 assumptions');
  close(res.applied[0].at.model_hours, 12, 1e-6);
  assert.equal(res.applied[0].at.derived, true);
});

// ------------------------------------------------------------- review 三条路

test('IO · review 三种结果分别走三条机制路径（correct / wrong / blank / wrong+看了答案）', () => {
  function runOne(action) {
    const loaded = demoGraph();
    const { engine, kernel } = makeEngine(loaded.graph);
    engine.start_diffusion(loaded.initial_nodes, loaded.target_nodes);
    const res = io.run({
      engine, kernel, archive: new RunArchive(),
      request: baseRequest({ run_id: `r-${action.outcome}-${action.reviewed_solution === true}`, actions: [action] }),
    });
    return res.applied[0];
  }
  const at = { model_hours: 10 };
  const correct = runOne({ kind: 'review', node: 'unit_circle', outcome: 'correct', at });
  assert.equal(correct.mechanism, 'retrieval_success');
  assert.ok(correct.delta.S_after > correct.delta.S_before, '答对必须让 S 上升');

  const blank = runOne({ kind: 'review', node: 'unit_circle', outcome: 'blank', at });
  assert.equal(blank.mechanism, 'lapse');
  assert.ok(blank.delta.kind === 'lapse');

  const wrong = runOne({ kind: 'review', node: 'unit_circle', outcome: 'wrong', at });
  assert.equal(wrong.mechanism, 'lapse', '没做出来但没看答案 ⇒ 走遗忘路径');

  const wrongStudied = runOne({ kind: 'review', node: 'unit_circle', outcome: 'wrong', reviewed_solution: true, closeness: 0.4, at });
  assert.equal(wrongStudied.mechanism, 'retrieval_failure_feedback', '做错后对过答案 ⇒ 走"失败后对答案"路径');
  assert.ok(wrongStudied.delta.SInc > 1);
});

test('IO · 复习的 S 前后值与内核返回逐位一致（trace 不许自己编数）', () => {
  const loaded = demoGraph();
  const { engine, kernel } = makeEngine(loaded.graph);
  engine.start_diffusion(loaded.initial_nodes, loaded.target_nodes);
  const res = io.run({
    engine, kernel, archive: new RunArchive(),
    request: baseRequest({ actions: [{ kind: 'review', node: 'polar', outcome: 'blank', at: { model_hours: 10 } }] }),
  });
  const raw = kernel.review === undefined ? null : res.applied[0].delta;
  // 用同一条内核单独跑一遍做对照
  const g2 = demoGraph();
  const two = makeEngine(g2.graph);
  two.engine.start_diffusion(g2.initial_nodes, g2.target_nodes);
  const direct = two.kernel.review('polar', { type: 'lapse', grade: 1, current_real_time: 10 });
  const out = Array.isArray(direct) ? direct.find((r) => r.id === 'memory.dsr').out : direct;
  close(raw.S_before, out.S_before, 1e-9);
  close(raw.S_after, out.S_after, 1e-9);
  close(raw.D_after, out.D_after, 1e-9);
});

// ------------------------------------------------------------------ trace

test('IO · trace.rounds：逐边贡献之和 == 驱动；点火概率可复算；状态迁移齐全', () => {
  const loaded = demoGraph();
  const { engine, kernel } = makeEngine(loaded.graph);
  engine.start_diffusion(['trig_func'], ['solve_triangle']);
  const res = io.run({
    engine, kernel, archive: new RunArchive(),
    request: baseRequest({ steps: 3, actions: [] }),
  });
  assert.equal(res.trace.rounds.length, 3, 'steps=3 应当抓到 3 轮');

  for (const r of res.trace.rounds) {
    // 逐项贡献之和 == 驱动（入边贡献 + 亚阈累积 q，两项都在明细里）
    const sum = {};
    for (const e of r.drive_edges) sum[e.to] = (sum[e.to] || 0) + e.contribution;
    for (const id of Object.keys(r.drive)) {
      const s = sum[id] || 0;
      assert.ok(Math.abs(r.drive[id] - s) < 1e-5,
        `第 ${r.round} 轮 ${id}：逐项之和 ${s} 与驱动 ${r.drive[id]} 不一致`);
    }
    assert.ok(r.drive_edges.some((e) => e.kind === 'edge'), '应当有入边贡献明细');
    for (const e of r.drive_edges) {
      if (e.kind === 'edge') {
        assert.ok(Math.abs(e.contribution - e.al * e.ms * e.ls) < 1e-5,
          `入边贡献必须等于 al·ms·ls：${e.contribution} vs ${e.al}·${e.ms}·${e.ls}`);
      }
    }
    // 点火明细：p 能由 score/ct/T 复算，hit 与 conscious 一致
    for (const ig of r.ignition) {
      const expected = ig.t_ign > 0 ? 1 / (1 + Math.exp(-(ig.score - ig.ct) / ig.t_ign)) : (ig.score >= ig.ct ? 1 : 0);
      assert.ok(Math.abs(ig.p - expected) < 1e-5, `点火概率复算不一致：${ig.p} vs ${expected}`);
      assert.equal(ig.hit, r.conscious.indexOf(ig.node) >= 0, `${ig.node} 的 hit 与 conscious 不一致`);
    }
    // 状态迁移：每个节点都有一条
    assert.equal(r.states.length, loaded.graph.size, '每个节点都要有 state_before → state_after');
    for (const s of r.states) {
      assert.ok(['CONSCIOUS', 'SUBCONSCIOUS', 'INACTIVE'].indexOf(s.state_after) >= 0);
      assert.ok(Number.isFinite(s.al));
    }
  }
  // 焦点始终在意识里（起点每轮被按住）
  for (const r of res.trace.rounds) {
    assert.ok(r.conscious.indexOf('trig_func') >= 0, '起点必须在意识里');
  }
});

test('IO · trace.slow / digest / invariants：慢层事件与摘要如实反映本次做了什么', () => {
  const loaded = demoGraph();
  const { engine, kernel } = makeEngine(loaded.graph);
  engine.start_diffusion(loaded.initial_nodes, loaded.target_nodes);
  const res = io.run({
    engine, kernel, archive: new RunArchive(), memoryDsr,
    request: baseRequest({
      steps: 2,
      actions: [
        { kind: 'time', at: { model_hours: 10 } },
        { kind: 'review', node: 'polar', outcome: 'blank', at: { model_hours: 10 } },
        { kind: 'knowledge', edge: { from: 'trig_func', to: 'polar', ls: 0.7 }, at: { model_hours: 10 } },
      ],
    }),
  });
  assert.equal(res.trace.slow.length, 3, '三条动作都要有慢层记录');
  assert.match(res.trace.digest.text, /rounds=2/);
  assert.equal(res.trace.digest.rounds, 2);
  assert.equal(res.trace.invariants.ok, true, `不变量自查应当通过：${res.trace.invariants.problems.join('; ')}`);
  assert.deepEqual(res.trace.invariants.problems, []);
  assert.equal(res.trace.control !== null, true, '控制层报告应当被采集');
  assert.equal(res.result.next_check.for_node, 'polar', '排程建议应当针对最后动过的节点');
  assert.ok(res.result.next_check.hours_from_now >= 0);
});

// ------------------------------------------------------------- 幂等 / 确定性

test('IO · 幂等：同一 run_id 跑两次不重复生效，第二次标记 replay', () => {
  const archive = new RunArchive();
  const g1 = makeGraph([['A', { ms: 0.8 }], ['B', { ms: 0.6 }]], [['A', 'B', 0.9]]);
  const one = makeEngine(g1);
  const req = baseRequest({ actions: [{ kind: 'review', node: 'A', outcome: 'correct', at: { model_hours: 5 } }] });
  const first = io.run({ engine: one.engine, kernel: one.kernel, request: req, archive });
  const hashAfterFirst = one.kernel.stateHash();
  const second = io.run({ engine: one.engine, kernel: one.kernel, request: req, archive });
  assert.equal(second.replay, true);
  assert.equal(second.model.state_hash_after, first.model.state_hash_after);
  assert.equal(one.kernel.stateHash(), hashAfterFirst, '重复提交不许再改状态');
  assert.equal(archive.entries.filter((e) => e.kind === 'action').length, 1, '存档里只应有一条动作');
});

test('IO · 确定性：同一请求 + 同 seed 在两套引擎上跑出相同 state_hash 与相同 trace', () => {
  const req = baseRequest({
    run_id: 'run-det', steps: 3,
    actions: [
      { kind: 'review', node: 'polar', outcome: 'blank', at: { model_hours: 10 } },
      { kind: 'knowledge', edge: { from: 'vector', to: 'polar', ls: 0.6 }, at: { model_hours: 10 } },
    ],
  });
  function once() {
    const loaded = demoGraph();
    const { engine, kernel } = makeEngine(loaded.graph);
    engine.start_diffusion(loaded.initial_nodes, loaded.target_nodes);
    return io.run({ engine, kernel, archive: new RunArchive(), request: req });
  }
  const a = once();
  const b = once();
  assert.equal(a.model.state_hash_after, b.model.state_hash_after);
  assert.deepEqual(a.trace.rounds, b.trace.rounds, '逐轮 trace 必须逐位一致');
  assert.deepEqual(a.applied, b.applied);
  assert.deepEqual(a.result.next_check, b.result.next_check);
});

test('IO · 换 seed：只有点火明细会变，驱动/状态判定按 seed 也一致（同 seed 才要求全等）', () => {
  const req = baseRequest({ run_id: 'run-seed', steps: 2, actions: [] });
  function once(seed) {
    const loaded = demoGraph();
    const { engine, kernel } = makeEngine(loaded.graph, { seed });
    engine.start_diffusion(loaded.initial_nodes, loaded.target_nodes);
    return io.run({ engine, kernel, archive: new RunArchive(), memoryDsr, request: req });
  }
  const a = once(7);
  const b = once(7);
  const c = once(99);
  assert.deepEqual(a.trace.rounds, b.trace.rounds, '同 seed 必须逐位一致');
  // 第 1 轮的驱动只由（确定性的）初始激活决定，换 seed 不该变；
  // 之后几轮会被"上一轮点火成功与否"影响，所以只断言第 1 轮
  assert.deepEqual(a.trace.rounds[0].drive, c.trace.rounds[0].drive, '第 1 轮驱动与 seed 无关');
  assert.deepEqual(a.trace.rounds[0].drive_edges, c.trace.rounds[0].drive_edges);
});

// ------------------------------------------------------------------ 存档

test('IO · 存档：每条动作一条记录 + 重放回同样的 state_hash；rewindPlan 指回上一个状态', () => {
  const archive = new RunArchive();
  const g = makeGraph([['A', { ms: 0.8 }], ['B', { ms: 0.6 }]], [['A', 'B', 0.9]]);
  const { engine, kernel } = makeEngine(g);
  const hash0 = kernel.stateHash();
  const res = io.run({
    engine, kernel, archive,
    request: baseRequest({
      actions: [
        { kind: 'review', node: 'A', outcome: 'correct', at: { model_hours: 5 } },
        { kind: 'review', node: 'B', outcome: 'blank', at: { model_hours: 6 } },
      ],
    }),
  });
  // run 头 + 2 条动作
  assert.equal(archive.entries.length, 3);
  assert.equal(archive.entries[0].kind, 'run');
  assert.equal(archive.entries[1].action_index, 0);
  assert.equal(archive.entries[1].state_hash_before, hash0);
  assert.equal(archive.entries[2].state_hash_before, archive.entries[1].state_hash_after);
  assert.equal(res.archive.last_entry_id, archive.entries[2].entry_id);

  // JSONL 往返
  const back = RunArchive.fromJSONL(archive.toJSONL());
  assert.deepEqual(back.toJSON(), archive.toJSON());

  // 重放：用存档里的动作重跑一遍，state_hash 必须回到同一个值
  const g2 = makeGraph([['A', { ms: 0.8 }], ['B', { ms: 0.6 }]], [['A', 'B', 0.9]]);
  const two = makeEngine(g2);
  io.run({
    engine: two.engine, kernel: two.kernel, archive: new RunArchive(),
    request: baseRequest({
      run_id: 'run-replay',
      actions: archive.entries.filter((e) => e.kind === 'action').map((e) => e.action),
    }),
  });
  assert.equal(two.kernel.stateHash(), res.model.state_hash_after, '重放必须逐位回到同一状态');

  const plan = archive.rewindPlan('run-1');
  assert.deepEqual(plan.keep, [], '第一条 run 之前没有条目');
  assert.equal(plan.drop.length, 3);
  assert.equal(plan.target_state_hash, null);
});

test('IO · 存档：BOM 容错（Windows 编辑器写出的 JSONL 也能读）', () => {
  const a = new RunArchive();
  a.append({ kind: 'run', run_id: 'r1' });
  const back = RunArchive.fromJSONL(`\uFEFF${a.toJSONL()}`);
  assert.equal(back.entries.length, 1);
  assert.equal(back.entries[0].run_id, 'r1');
});

// ------------------------------------------------------------- 例子与工具

test('IO · 自检工具（tools/io_check.js）：合法请求返回 0 且不动状态，非法请求说人话并给可用 id', () => {
  const { main } = require('../tools/io_check.js');
  const reqFile = path.join(EXAMPLE, 'requests', 'run_request_example.json');
  const out = [];
  const err = [];
  const so = process.stdout.write;
  const se = process.stderr.write;
  process.stdout.write = (s) => { out.push(String(s)); return true; };
  process.stderr.write = (s) => { err.push(String(s)); return true; };
  let code;
  try {
    code = main(['--request', reqFile, '--graph', 'demo_learning']);
  } finally {
    process.stdout.write = so;
    process.stderr.write = se;
  }
  assert.equal(code, 0, err.join(''));
  assert.match(out.join(''), /请求合法/);
  assert.match(out.join(''), /lapse/);
  // example 图没有被自检改动（自检跑在克隆体上）
  const graphAfter = JSON.parse(fs.readFileSync(path.join(EXAMPLE, 'demo_learning.json'), 'utf8'));
  assert.equal(graphAfter.graph.nodes.find((n) => n.id === 'polar').m, undefined);
});

test('IO · example/requests/ 下的每个请求文件都必须是合法请求（文档例子不许过期）', () => {
  const dir = path.join(EXAMPLE, 'requests');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  assert.ok(files.length >= 1, '至少要有一份示例请求');
  for (const file of files) {
    const request = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8').replace(/^\uFEFF/, ''));
    const loaded = demoGraph();
    const { engine, kernel } = makeEngine(loaded.graph);
    engine.start_diffusion(loaded.initial_nodes, loaded.target_nodes);
    const res = io.run({ engine, kernel, archive: new RunArchive(), request, memoryDsr, profile: 'v2' });
    assert.equal(res.status, 'ok', `${file} 应当能跑通`);
    assert.ok(res.applied.length === request.actions.length, `${file} 的每条动作都要有效果记录`);
    assert.equal(res.trace.invariants.ok, true, `${file}: ${res.trace.invariants.problems.join('; ')}`);
  }
});

test('IO · 示例请求的结果里能追到"照片区域"这一级的出处，且机制清单/参数指纹齐全', () => {
  const raw = fs.readFileSync(path.join(EXAMPLE, 'requests', 'run_request_example.json'), 'utf8').replace(/^\uFEFF/, '');
  const request = JSON.parse(raw);
  assert.equal(request.protocol, 'mindnet.run/1');
  const loaded = demoGraph();
  const { engine, kernel } = makeEngine(loaded.graph);
  engine.start_diffusion(loaded.initial_nodes, loaded.target_nodes);
  const res = io.run({ engine, kernel, archive: new RunArchive(), request, memoryDsr, profile: 'v2' });
  assert.equal(res.status, 'ok');
  assert.equal(res.applied.length, 4);
  assert.equal(res.model.mechanisms.indexOf('memory.dsr') >= 0, true);
  assert.match(res.model.overrides_digest, /^n\d+-/);
  assert.equal(res.applied[0].evidence.region, '第 3 题第 (2) 问');
  assert.equal(res.applied[0].confidence, 0.8);
});
