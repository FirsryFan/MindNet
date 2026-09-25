'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const mindnet = require('../src/index.js');
const { buildOutput } = require('../cli.js');
const { close, tmpPath, cleanupTmp } = require('./helpers.js');

const VIZ = path.join(__dirname, '..', 'viz');
const EXAMPLE = path.join(__dirname, '..', 'example');

test('可视化壳：index.html 引用的本地资源都存在，脚本顺序满足依赖', () => {
  const html = fs.readFileSync(path.join(VIZ, 'index.html'), 'utf8');
  const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
    .map((m) => m[1])
    .filter((s) => !/^(https?:)?\/\//.test(s));
  assert.ok(refs.length >= 6, `index.html 应引用引擎与样式，实际 ${refs.length} 个`);
  for (const ref of refs) {
    assert.ok(fs.existsSync(path.join(VIZ, ref)), `index.html 引用的文件不存在：${ref}`);
  }
  const order = [
    '../src/config.js',
    '../src/model.js',
    '../src/memory.js',
    '../src/diffusion.js',
    'sample_graph.js',
    'app.js',
  ];
  const positions = order.map((s) => html.indexOf(`"${s}"`));
  positions.forEach((p, i) => assert.ok(p >= 0, `index.html 缺少脚本 ${order[i]}`));
  for (let i = 1; i < positions.length; i += 1) {
    assert.ok(positions[i] > positions[i - 1], `脚本顺序错误：${order[i]} 必须在 ${order[i - 1]} 之后`);
  }
});

test('可视化壳：app.js 引用的引擎 API 全部存在（静态扫描 + 运行时核对）', () => {
  const app = fs.readFileSync(path.join(VIZ, 'app.js'), 'utf8');
  const used = new Set([...app.matchAll(/\bM\.([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]));
  assert.ok(used.size >= 5, 'app.js 应该使用了多个引擎 API');
  const available = new Set([
    ...Object.keys(mindnet),
    ...Object.getOwnPropertyNames(mindnet.CognitiveModel.prototype),
  ]);
  const missing = [...used].filter((u) => !available.has(u));
  assert.deepEqual(missing, [], `app.js 引用了引擎中不存在的名字：${missing.join(', ')}`);

  const graph = mindnet.Graph.from_object(
    { nodes: [{ id: 'A', name: 'A', type: 'knowledge' }], edges: [] },
    1000
  );
  const model = new mindnet.CognitiveModel(graph, new mindnet.Config());
  for (const name of [
    'start_diffusion',
    'step',
    'run_until_stop',
    'get_kc',
    'kc_breakdown',
    'target_steps',
    'export_state',
    'update_memory',
    'update_global_memory',
    'add_initial_nodes',
  ]) {
    assert.equal(typeof model[name], 'function', `CognitiveModel 缺少 ${name}()`);
  }
  assert.equal(model.running, false);
  assert.equal(model.stopped, false);
  assert.deepEqual(model.starts, []);
  assert.deepEqual(model.targets, []);
});

test('可视化壳：内置示例由 example/*.json 生成，且能被引擎载入', () => {
  const generated = require('../viz/sample_graph.js');
  const files = fs.readdirSync(EXAMPLE).filter((f) => f.endsWith('.json'));
  for (const file of files) {
    const key = path.basename(file, '.json');
    assert.ok(generated[key], `sample_graph.js 缺少示例 ${key}（请重跑 node viz/build_samples.js）`);
    const input = generated[key];
    const loaded = mindnet.Graph.load_input(input, 1000);
    assert.ok(loaded.graph.size > 0);
  }
});

test('可视化壳：反馈面板引用的 DOM 元素都在 index.html 里，且依赖顺序正确', () => {
  const html = fs.readFileSync(path.join(VIZ, 'index.html'), 'utf8');
  const panel = fs.readFileSync(path.join(VIZ, 'feedback_panel.js'), 'utf8');
  // 面板里 $('fb-xxx') 用到的每个 id 都必须在 HTML 里存在（写错就是运行时 null）
  const ids = new Set([...panel.matchAll(/\$\('([a-z0-9-]+)'\)/g)].map((m) => m[1]));
  assert.ok(ids.size >= 10, `面板应当引用多个元素，实际 ${ids.size}`);
  const missing = [...ids].filter((id) => !html.includes(`id="${id}"`));
  assert.deepEqual(missing, [], `index.html 缺少反馈面板元素：${missing.join(', ')}`);
  // feedback.js 必须早于 feedback_panel.js；app.js 最后
  const pos = (s) => html.indexOf(`"${s}"`);
  assert.ok(pos('../src/feedback.js') >= 0, 'index.html 必须加载 src/feedback.js');
  assert.ok(pos('../mechanisms/memory.dsr.js') < pos('../src/feedback.js'), 'feedback.js 依赖 memory.dsr');
  assert.ok(pos('../src/feedback.js') < pos('feedback_panel.js'), 'feedback_panel.js 需要先有 feedback.js');
  assert.ok(pos('feedback_panel.js') < pos('app.js'), 'app.js 启动时要能拿到面板');
});

test('可视化壳：反馈面板的账本逻辑与引擎一致（记录 → S 变化 → 写回图）', () => {
  const { FeedbackLog } = require('../src/feedback.js');
  const graph = mindnet.Graph.from_object(
    { nodes: [{ id: 'A', name: 'A', type: 'knowledge', ms: 0.8 }], edges: [] },
    1000
  );
  mindnet.memoryDsr.ensureState(graph.get_node('A'), 0);
  const log = new FeedbackLog();
  log.harvest(graph);
  const before = graph.get_node('A').m.memory_dsr.S;
  log.record({ node: 'A', tHours: 48, correct: false });
  const after = log.nodes.A.S;
  assert.ok(after < before, `答错必须下调 S：${before} → ${after}`);
  assert.equal(log.applyToGraph(graph), 1);
  close(graph.get_node('A').m.memory_dsr.S, after, 1e-9);
  // 面板自检里那两个数字（fb_s_before / fb_s_after）就是这两个值
  assert.ok(log.record({ node: 'A', tHours: 48, correct: true }).S > after, '答对必须上调 S');
});

test('CLI：文档示例输出与 §8.2 完全一致', () => {
  const out = buildOutput([path.join(EXAMPLE, 'graph.json'), '--json', '--no-memory']);
  assert.equal(out.exitCode, 0, out.text);
  assert.deepEqual(JSON.parse(out.text), {
    kc: { gap: 0, penalty: 0 },
    target_steps: { node_2: 1 },
    targets_all_reached: true,
    final_states: { node_1: 'CONSCIOUS', node_2: 'CONSCIOUS' },
  });
});

test('CLI：演示图跑出 Gap / Penalty / 死角，并支持 --now 与 --max-rounds', () => {
  const demo = path.join(EXAMPLE, 'demo_learning.json');

  const out = buildOutput([demo, '--json', '--no-memory']);
  assert.equal(out.exitCode, 0, out.text);
  const result = JSON.parse(out.text);
  assert.deepEqual(result.kc, { gap: 0.096, penalty: 0.4 });
  assert.equal(result.target_steps.solve_triangle, 2);
  assert.equal(result.targets_all_reached, false);
  assert.equal(result.final_states.polar, 'INACTIVE');

  const limited = buildOutput([demo, '--json', '--no-memory', '--max-rounds', '1', '--now', '1000']);
  assert.equal(limited.exitCode, 0, limited.text);
  const limitedResult = JSON.parse(limited.text);
  assert.equal(limitedResult.final_states.solve_triangle, 'INACTIVE');
  assert.equal(limitedResult.target_steps.solve_triangle, undefined);

  const human = buildOutput([demo, '--no-memory']);
  assert.equal(human.exitCode, 0);
  assert.match(human.text, /知识贡献 KC/);
  assert.match(human.text, /思维冷却/);
});

test('CLI：人类可读摘要含记忆更新，错误路径有明确提示', () => {
  const out = buildOutput([path.join(EXAMPLE, 'graph.json')]);
  assert.equal(out.exitCode, 0);
  assert.match(out.text, /记忆更新/);
  assert.match(out.text, /输出协议/);

  const missing = buildOutput([path.join(EXAMPLE, 'no_such_file.json')]);
  assert.equal(missing.exitCode, 1);
  assert.match(missing.text, /找不到输入文件/);

  const badArgs = buildOutput([]);
  assert.equal(badArgs.exitCode, 1);
  assert.match(badArgs.text, /用法/);
});

test('CLI：边端点错误的输入给出 MindNet 错误而不是堆栈', () => {
  const bad = tmpPath(`bad_${process.pid}.json`);
  fs.writeFileSync(
    bad,
    JSON.stringify({
      graph: {
        nodes: [{ id: 'A', name: 'A', type: 'knowledge' }],
        edges: [{ id: 'e', from: 'A', to: 'B', ls: 0.5 }],
      },
      initial_nodes: ['A'],
      target_nodes: [],
    }),
    'utf8'
  );
  const out = buildOutput([bad, '--json']);
  assert.equal(out.exitCode, 1);
  assert.match(out.text, /MindNet 错误/);
  fs.unlinkSync(bad);
  cleanupTmp();
});
