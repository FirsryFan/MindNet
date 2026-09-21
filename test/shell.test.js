'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const mindnet = require('../src/index.js');
const { buildOutput } = require('../cli.js');
const { tmpPath, cleanupTmp } = require('./helpers.js');

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
