/**
 * MindNet —— 认知模型引擎 v1.1
 * 数据结构：Node / Edge / Graph（对应设计文档 §3）
 *
 * 严格有向图：扩散只能 from → to，禁止反向（反向需用户显式建反向边）。
 */
(function () {
  'use strict';

  const isNode = typeof module !== 'undefined' && !!module.exports;
  const deps = isNode
    ? Object.assign({}, require('./config.js'))
    : (globalThis.MindNet || {});
  const { Config, MindNetError, now_hours } = deps;

  /** 节点状态（文档 §2） */
  const STATE = Object.freeze({
    CONSCIOUS: 'CONSCIOUS',
    SUBCONSCIOUS: 'SUBCONSCIOUS',
    INACTIVE: 'INACTIVE',
  });

  const NODE_TYPES_HINT = ['knowledge', 'logic', 'technique'];

  function requireString(obj, key, where) {
    const v = obj[key];
    if (typeof v !== 'string' || v.trim() === '') {
      throw new MindNetError(`${where} 缺少必填字段 "${key}"（需为非空字符串）`);
    }
    return v;
  }

  function optionalNumber(obj, key, fallback, where) {
    const v = obj[key];
    if (v === undefined || v === null) return fallback;
    if (typeof v !== 'number' || Number.isNaN(v)) {
      throw new MindNetError(`${where} 的字段 "${key}" 必须是数字，实际为 ${JSON.stringify(v)}`);
    }
    return v;
  }

  /** 节点：一个记忆/知识单元 */
  class Node {
    constructor(fields) {
      const f = fields || {};
      this.id = f.id;
      this.name = f.name;
      this.type = f.type;
      this.weight = f.weight === undefined ? 1.0 : f.weight;
      this.ms = f.ms === undefined ? 0.8 : f.ms;
      this.ct = f.ct === undefined ? null : f.ct;
      this.st = f.st === undefined ? null : f.st;
      this.state = f.state === undefined ? STATE.INACTIVE : f.state;
      this.al = f.al === undefined ? 0.0 : f.al;
      this.visit_count = f.visit_count === undefined ? 0 : f.visit_count;
      this.last_review_time = f.last_review_time === undefined ? null : f.last_review_time;
      this.stm = f.stm === undefined ? 0.0 : f.stm;
    }

    static from_object(obj, where) {
      const tag = where || '节点';
      if (obj === null || typeof obj !== 'object') {
        throw new MindNetError(`${tag} 必须是对象，实际为 ${JSON.stringify(obj)}`);
      }
      const id = requireString(obj, 'id', tag);
      const name = requireString(obj, 'name', `${tag} "${id}"`);
      const type = requireString(obj, 'type', `${tag} "${id}"`);
      const ctx = `${tag} "${id}"`;
      const explicit = {};
      for (const key of ['weight', 'ms', 'visit_count', 'stm']) {
        if (obj[key] !== undefined && obj[key] !== null) {
          explicit[key] = optionalNumber(obj, key, undefined, ctx);
        }
      }
      const node = new Node({
        id,
        name,
        type,
        weight: explicit.weight,
        ms: explicit.ms,
        ct: obj.ct === undefined || obj.ct === null ? null : optionalNumber(obj, 'ct', null, ctx),
        st: obj.st === undefined || obj.st === null ? null : optionalNumber(obj, 'st', null, ctx),
        visit_count: explicit.visit_count,
        last_review_time:
          obj.last_review_time === undefined || obj.last_review_time === null
            ? null
            : optionalNumber(obj, 'last_review_time', null, ctx),
        stm: explicit.stm,
      });
      return node;
    }

    /** 意识阈值：节点自定义优先，缺省用全局默认 */
    ct_of(config) {
      return this.ct === null || this.ct === undefined ? config.ct_default : this.ct;
    }

    /** 潜意识阈值：节点自定义优先，缺省用全局默认 */
    st_of(config) {
      return this.st === null || this.st === undefined ? config.st_default : this.st;
    }

    /** 重置运行时状态；visit_count / ms / last_review_time 属于长期数据，不重置 */
    reset_runtime() {
      this.state = STATE.INACTIVE;
      this.al = 0.0;
    }

    is_active() {
      return this.state !== STATE.INACTIVE;
    }

    to_object(config) {
      return {
        id: this.id,
        name: this.name,
        type: this.type,
        weight: this.weight,
        ms: this.ms,
        ct: this.ct,
        st: this.st,
        state: this.state,
        al: this.al,
        visit_count: this.visit_count,
        last_review_time: this.last_review_time,
        stm: this.stm,
        effective_ct: config ? this.ct_of(config) : undefined,
        effective_st: config ? this.st_of(config) : undefined,
      };
    }
  }

  /** 边：有向连接，ls 为链接强度 */
  class Edge {
    constructor(fields) {
      const f = fields || {};
      this.id = f.id;
      this.from = f.from;
      this.to = f.to;
      this.ls = f.ls === undefined ? 0.8 : f.ls;
    }

    static from_object(obj, where) {
      const tag = where || '边';
      if (obj === null || typeof obj !== 'object') {
        throw new MindNetError(`${tag} 必须是对象，实际为 ${JSON.stringify(obj)}`);
      }
      const id = requireString(obj, 'id', tag);
      const from = requireString(obj, 'from', `${tag} "${id}"`);
      const to = requireString(obj, 'to', `${tag} "${id}"`);
      return new Edge({
        id,
        from,
        to,
        ls: optionalNumber(obj, 'ls', undefined, `${tag} "${id}"`),
      });
    }

    to_object() {
      return { id: this.id, from: this.from, to: this.to, ls: this.ls };
    }
  }

  /**
   * 认知图。加载阶段校验：
   *   - 节点 id 不能重复
   *   - 边端点必须存在（§3.3 / §10.1）
   *   - last_review_time 为 0 或缺失 → 修正为 current_real_time（§3.1）
   * 不连通子图不报错。
   */
  class Graph {
    constructor(nodes, edges, current_real_time) {
      this.nodes = new Map();
      this.edges = [];
      this._out = new Map();
      this._in = new Map();
      if (nodes) for (const n of nodes) this.add_node(n);
      if (edges) for (const e of edges) this.add_edge(e);
      if (current_real_time !== undefined) this.fix_last_review_time(current_real_time);
    }

    /** 节点数组 → Graph（元素可以是普通对象或 Node 实例）；加载时修正 last_review_time */
    static from_object(obj, current_real_time) {
      if (obj === null || typeof obj !== 'object') {
        throw new MindNetError('图数据必须是对象，形如 {"nodes": [...], "edges": [...]}');
      }
      const nodes = obj.nodes;
      const edges = obj.edges === undefined ? [] : obj.edges;
      if (!Array.isArray(nodes)) {
        throw new MindNetError('图数据缺少 "nodes" 数组');
      }
      if (!Array.isArray(edges)) {
        throw new MindNetError('图数据的 "edges" 必须是数组');
      }
      const g = new Graph();
      for (let i = 0; i < nodes.length; i += 1) {
        const raw = nodes[i];
        g.add_node(raw instanceof Node ? raw : Node.from_object(raw, `第 ${i + 1} 个节点`));
      }
      for (let i = 0; i < edges.length; i += 1) {
        const raw = edges[i];
        g.add_edge(raw instanceof Edge ? raw : Edge.from_object(raw, `第 ${i + 1} 条边`));
      }
      const now = current_real_time === undefined || current_real_time === null
        ? now_hours()
        : current_real_time;
      g.fix_last_review_time(now);
      return g;
    }

    /**
     * 载入 JSON。input 可以是：
     *   - 文件路径字符串（仅 Node 环境）
     *   - {"nodes": [...], "edges": [...]}
     *   - 输入信封 {"graph": {...}, "initial_nodes": [...], "target_nodes": [...]}（§8.1）
     * 第二参数 current_real_time（小时）用于修正 last_review_time，缺省取当前现实时间。
     */
    static load_from_json(input, current_real_time) {
      const now = current_real_time === undefined || current_real_time === null
        ? now_hours()
        : current_real_time;
      let obj = input;
      if (typeof input === 'string') {
        if (typeof require !== 'function') {
          throw new MindNetError('浏览器环境不支持按路径载入文件，请改用 Graph.from_object(对象)');
        }
        const fs = require('fs');
        obj = JSON.parse(fs.readFileSync(input, 'utf8'));
      }
      const graphPart = obj && obj.graph ? obj.graph : obj;
      return Graph.from_object(graphPart, now);
    }

    /** 载入输入信封，返回 { graph, initial_nodes, target_nodes } */
    static load_input(input, current_real_time) {
      const now = current_real_time === undefined || current_real_time === null
        ? now_hours()
        : current_real_time;
      let obj = input;
      if (typeof input === 'string') {
        if (typeof require !== 'function') {
          throw new MindNetError('浏览器环境不支持按路径载入文件，请传入对象');
        }
        obj = JSON.parse(require('fs').readFileSync(input, 'utf8'));
      }
      const graph = Graph.load_from_json(obj, now);
      return {
        graph,
        initial_nodes: Array.isArray(obj && obj.initial_nodes) ? obj.initial_nodes.slice() : [],
        target_nodes: Array.isArray(obj && obj.target_nodes) ? obj.target_nodes.slice() : [],
      };
    }

    /** last_review_time 为 0 或缺失 → 修正为当前现实时间（§3.1） */
    fix_last_review_time(current_real_time) {
      for (const node of this.nodes.values()) {
        if (node.last_review_time === null || node.last_review_time === undefined || node.last_review_time === 0) {
          node.last_review_time = current_real_time;
        }
      }
      return this;
    }

    add_node(node) {
      if (this.nodes.has(node.id)) {
        throw new MindNetError(`节点 id 重复："${node.id}"`);
      }
      this.nodes.set(node.id, node);
      this._out.set(node.id, []);
      this._in.set(node.id, []);
      return node;
    }

    add_edge(edge) {
      if (!this.nodes.has(edge.from)) {
        throw new MindNetError(`边 "${edge.id}" 的起点 "${edge.from}" 不存在于图中`);
      }
      if (!this.nodes.has(edge.to)) {
        throw new MindNetError(`边 "${edge.id}" 的终点 "${edge.to}" 不存在于图中`);
      }
      this.edges.push(edge);
      this._out.get(edge.from).push(edge);
      this._in.get(edge.to).push(edge);
      return edge;
    }

    has_node(id) {
      return this.nodes.has(id);
    }

    get_node(id) {
      return this.nodes.get(id);
    }

    out_edges(id) {
      return this._out.get(id) || [];
    }

    in_edges(id) {
      return this._in.get(id) || [];
    }

    node_ids() {
      return Array.from(this.nodes.keys());
    }

    get size() {
      return this.nodes.size;
    }

    to_object() {
      return {
        nodes: Array.from(this.nodes.values()).map((n) => n.to_object()),
        edges: this.edges.map((e) => e.to_object()),
      };
    }
  }

  const api = { STATE, NODE_TYPES_HINT, Node, Edge, Graph };

  if (isNode) {
    module.exports = api;
  } else {
    globalThis.MindNet = Object.assign(globalThis.MindNet || {}, api);
  }
})();
