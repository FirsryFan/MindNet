'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { Graph, Node, Edge, Config, CognitiveModel, MindNetError, STATE } = require('../src/index.js');
const { NOW, makeGraph } = require('./helpers.js');

const EXAMPLE = path.join(__dirname, '..', 'example', 'graph.json');

test('从对象建图：节点 / 边 / 出边入边索引', () => {
  const g = makeGraph([['A', { ms: 0.9 }], ['B', {}]], [['A', 'B', 0.7]]);
  assert.equal(g.size, 2);
  assert.equal(g.edges.length, 1);
  assert.equal(g.get_node('A').ms, 0.9);
  assert.equal(g.get_node('B').ms, 0.8, '缺省 ms = 0.8');
  assert.equal(g.get_node('B').weight, 1.0, '缺省 weight = 1.0');
  assert.equal(g.get_node('B').ct, null, '未写 ct 时保持 null，运行时回落到全局默认');
  assert.equal(g.out_edges('A').length, 1);
  assert.equal(g.in_edges('B').length, 1);
  assert.equal(g.out_edges('B').length, 0);
});

test('to_object 往返：结构不丢', () => {
  const g = makeGraph([['A', {}], ['B', {}]], [['A', 'B', 0.6]]);
  const again = Graph.from_object(g.to_object());
  assert.equal(again.size, 2);
  assert.equal(again.edges.length, 1);
  assert.equal(again.edges[0].ls, 0.6);
});

test('to_object 往返：机制的慢状态 m 不丢（反馈修出来的 S 必须活得下来）', () => {
  const g = makeGraph([['A', { ms: 0.8 }]]);
  g.get_node('A').m = { memory_dsr: { R0: 0.8, S: 33.5, D: 4.2, Sigma: 0.8 } };
  const again = Graph.from_object(g.to_object());
  assert.equal(again.get_node('A').m.memory_dsr.S, 33.5);
  // 深拷贝：改副本不能影响原件（否则克隆/载入会串味）
  again.get_node('A').m.memory_dsr.S = 1;
  assert.equal(g.get_node('A').m.memory_dsr.S, 33.5);
  // 没有机制状态时不要凭空塞一个 m，免得每份导出都多一层
  const plain = makeGraph([['C', {}]]);
  assert.equal(plain.to_object().nodes[0].m, undefined);
});

test('载入 §8.1 信封：graph / initial_nodes / target_nodes', () => {
  const input = {
    graph: {
      nodes: [
        { id: 'node_1', name: '三角函数', type: 'knowledge', weight: 0.9, ms: 0.8, ct: 0.3, st: 0.05, last_review_time: 0 },
        { id: 'node_2', name: '正弦定理', type: 'knowledge', weight: 0.7, ms: 0.6, ct: 0.3, st: 0.05, last_review_time: 0 },
      ],
      edges: [{ id: 'edge_1', from: 'node_1', to: 'node_2', ls: 0.8 }],
    },
    initial_nodes: ['node_1'],
    target_nodes: ['node_2'],
  };
  const loaded = Graph.load_input(input, 1234.5);
  assert.equal(loaded.graph.size, 2);
  assert.deepEqual(loaded.initial_nodes, ['node_1']);
  assert.deepEqual(loaded.target_nodes, ['node_2']);
  assert.equal(loaded.graph.get_node('node_1').last_review_time, 1234.5, 'last_review_time = 0 应修正为当前现实时间');
});

test('从 JSON 文件路径载入', () => {
  const g = Graph.load_from_json(EXAMPLE, NOW);
  assert.equal(g.size, 2);
  assert.equal(g.edges.length, 1);
  assert.equal(g.get_node('node_1').name, '三角函数');
});

test('校验：必填字段、重复 id、边端点不存在', () => {
  assert.throws(() => Node.from_object({ name: 'x', type: 'knowledge' }), MindNetError);
  assert.throws(() => Node.from_object({ id: 'x', type: 'knowledge' }), MindNetError);
  assert.throws(() => Node.from_object({ id: 'x', name: 'x' }), MindNetError);
  assert.throws(
    () => Graph.from_object({ nodes: [{ id: 'x', name: 'x', type: 'knowledge' }, { id: 'x', name: 'y', type: 'knowledge' }], edges: [] }),
    MindNetError
  );
  assert.throws(
    () => Graph.from_object({ nodes: [{ id: 'A', name: 'A', type: 'knowledge' }], edges: [{ id: 'e', from: 'A', to: 'B', ls: 0.5 }] }),
    (err) => {
      assert.ok(err instanceof MindNetError);
      assert.match(err.message, /终点 "B" 不存在/);
      return true;
    }
  );
  assert.throws(
    () => Graph.from_object({ nodes: [{ id: 'A', name: 'A', type: 'knowledge' }], edges: [{ id: 'e', from: 'Z', to: 'A' }] }),
    MindNetError
  );
  // nodes 允许两种形态：数组（输入协议）与 {id: 节点} 映射（引擎存档）。
  // 空映射 = 空图（合法）；真·畸形输入仍必须报错。
  assert.equal(Graph.from_object({ nodes: {} }).size, 0, '空映射是合法的空图');
  assert.equal(
    Graph.from_object({ nodes: { A: { name: 'A', type: 'knowledge' } } }).get_node('A').id,
    'A',
    '映射形态缺少 id 时用键补齐'
  );
  assert.throws(() => Graph.from_object({ nodes: 'x' }), MindNetError);
  assert.throws(() => Graph.from_object({ nodes: 42 }), MindNetError);
  assert.throws(() => Graph.from_object({ nodes: [], edges: 'x' }), MindNetError);
  assert.throws(() => Edge.from_object({ from: 'A', to: 'B' }), MindNetError);
  assert.throws(() => Node.from_object({ id: 'A', name: 'A', type: 'knowledge', weight: 'x' }), MindNetError);
});

test('严格有向：未建反向边时不会反向扩散', () => {
  const g = makeGraph([['A', {}], ['B', { ms: 1.0 }]], [['A', 'B', 0.9]]);
  const m = new CognitiveModel(g, new Config());
  m.start_diffusion(['B'], ['A']); // B 是起点，A 是目标；边的方向是 A → B
  const result = m.run_until_stop();

  assert.equal(result.targets_all_reached, false);
  assert.equal(result.final_states.A, STATE.INACTIVE);
  assert.equal(result.final_states.B, STATE.CONSCIOUS);
});

test('不连通子图不报错', () => {
  const g = makeGraph(
    [['A', {}], ['B', {}], ['C', {}], ['D', {}]],
    [
      ['A', 'B', 0.9],
      ['C', 'D', 0.9],
    ]
  );
  assert.equal(g.size, 4);
  assert.equal(g.edges.length, 2);
});
