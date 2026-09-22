/**
 * MindNet v2 内核 —— 机制调度与不变量守卫
 *
 * 设计原则（对应 docs/PLUGIN_ARCHITECTURE.md）：
 *   内核固定且最小：时间推进、状态容器、槽位调度、不变量守卫。
 *   一切「像脑 / 像学生」的东西都是 mechanisms/ 下的模块。
 *
 * 模块只能通过声明的槽位（hook）改状态；内核在每个槽位边界做不变量校验，
 * 违反即「该模块本次失效 + 记录告警」，绝不静默吞掉。
 */
(function () {
  'use strict';

  const isNode = typeof module !== 'undefined' && !!module.exports;
  const deps = isNode
    ? Object.assign({}, require('./rng.js'), require('../config.js'))
    : (globalThis.MindNet || {});
  const { createRng, MindNetError, Config } = deps;

  /** 槽位（hook）清单 —— 与 PLUGIN_ARCHITECTURE.md §3 一致 */
  const HOOK_NAMES = Object.freeze([
    'tick.before',      // 每 tick：节律状态推进
    'tick.gate',        // 每 tick：本 tick 是否允许点火（可拦断）
    'round.before',     // 每轮：目标/上下文刷新、疲劳、带宽重置、节拍长度
    'drive.compute',    // 算入边驱动
    'activation.update',// 激活更新（分流方程等）
    'attention.select', // 容量竞争与准入
    'ignite.check',     // 点火判定
    'state.after',      // 状态落定后
    'round.after',      // 每轮结束
    'review.on',        // 复习事件
    'consolidate.on',   // 环节末 / 跨天
    'hours.advance',    // 现实时间推进（记忆衰减）
    'diagnose.on',      // 诊断
    'output.score',     // 输出排序与指令
    'serialize.on',     // 存档扩展
  ]);

  /**
   * 跨模块共享的快状态（放在 node.m.core 下，所有模块都能读）。
   * 模块要写共享字段，必须在 manifest 的 shared 里声明；
   * 模块私有的中间量请走 patch()（写进自己的命名空间）。
   */
  const SHARED_BOUNDS = Object.freeze({
    a: [0, 1],   // 激活水平
    q: [0, 1],   // 亚阈累积
  });
  const SHARED_NS = 'core';

  const LAYERS = Object.freeze([
    'rhythm', 'attention', 'memory', 'structure',
    'metacognition', 'motivation', 'control', 'output',
  ]);
  const LEVELS = Object.freeze(['core', 'optional', 'metric']);

  /** 内核字段里允许模块声明的可写字段（必须显式声明，否则内核拒绝加载） */
  const CORE_WRITABLE = Object.freeze([
    'ms', 'last_review_time', 'visit_count', 'stm', 'state', 'al', 'ct', 'st', 'weight',
  ]);

  const FIELD_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
  const ID_RE = /^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*$/;
  const PARAM_TYPES = Object.freeze(['number', 'int', 'bool', 'enum']);

  function fail(msg) {
    throw new MindNetError(msg);
  }

  function isPlainObject(x) {
    return x !== null && typeof x === 'object' && !Array.isArray(x);
  }

  /** 校验模块清单；不合法直接拒绝加载（fail loud） */
  function validateManifest(m, where) {
    const tag = where || '机制模块';
    if (!isPlainObject(m)) fail(`${tag} 的 manifest 必须是对象`);
    if (m.api !== 1) fail(`${tag} 的 api 版本必须是 1（实际 ${JSON.stringify(m.api)}）`);
    if (typeof m.id !== 'string' || !ID_RE.test(m.id)) fail(`${tag} 的 id 不合法：${JSON.stringify(m.id)}`);
    if (typeof m.name !== 'string' || !m.name.trim()) fail(`机制 "${m.id}" 缺少 name`);
    if (!LAYERS.includes(m.layer)) fail(`机制 "${m.id}" 的 layer 必须是 ${LAYERS.join(' / ')} 之一`);
    if (!LEVELS.includes(m.level)) fail(`机制 "${m.id}" 的 level 必须是 ${LEVELS.join(' / ')} 之一`);

    const params = m.params === undefined ? [] : m.params;
    if (!Array.isArray(params)) fail(`机制 "${m.id}" 的 params 必须是数组`);
    const seen = new Set();
    for (const p of params) {
      if (!isPlainObject(p)) fail(`机制 "${m.id}" 的 params 元素必须是对象`);
      if (typeof p.key !== 'string' || !FIELD_RE.test(p.key)) fail(`机制 "${m.id}" 的参数 key 不合法：${JSON.stringify(p.key)}`);
      if (seen.has(p.key)) fail(`机制 "${m.id}" 的参数 key 重复：${p.key}`);
      seen.add(p.key);
      if (!PARAM_TYPES.includes(p.type)) fail(`机制 "${m.id}" 参数 "${p.key}" 的 type 必须是 ${PARAM_TYPES.join(' / ')}`);
      if (p.default === undefined) fail(`机制 "${m.id}" 参数 "${p.key}" 必须给 default`);
      if (p.type === 'number' || p.type === 'int') {
        if (typeof p.default !== 'number' || !Number.isFinite(p.default)) fail(`机制 "${m.id}" 参数 "${p.key}" 的 default 必须是有限数字`);
        if (p.min !== undefined && p.default < p.min) fail(`机制 "${m.id}" 参数 "${p.key}" 的 default 小于 min`);
        if (p.max !== undefined && p.default > p.max) fail(`机制 "${m.id}" 参数 "${p.key}" 的 default 大于 max`);
      }
      if (p.calibrated === undefined) fail(`机制 "${m.id}" 参数 "${p.key}" 必须显式标注 calibrated（true/false）`);
    }

    for (const listName of ['reads', 'writes', 'requires', 'conflicts', 'shared']) {
      const list = m[listName] === undefined ? [] : m[listName];
      if (!Array.isArray(list)) fail(`机制 "${m.id}" 的 ${listName} 必须是数组`);
    }
    for (const s of m.shared || []) {
      if (!Object.prototype.hasOwnProperty.call(SHARED_BOUNDS, s)) {
        fail(`机制 "${m.id}" 声明了未知共享字段 "${s}"（可用：${Object.keys(SHARED_BOUNDS).join(', ')}）`);
      }
    }
    for (const w of m.writes || []) {
      if (typeof w !== 'string' || !FIELD_RE.test(w)) {
        fail(`机制 "${m.id}" 的 writes 只能写「本模块命名空间内的字段名」或白名单内核字段，非法项：${JSON.stringify(w)}`);
      }
      if (!CORE_WRITABLE.includes(w) && !FIELD_RE.test(w)) fail(`机制 "${m.id}" 的 writes 非法：${w}`);
    }
    if ((m.requires || []).includes(m.id)) fail(`机制 "${m.id}" 不能依赖自己`);
    if ((m.conflicts || []).includes(m.id)) fail(`机制 "${m.id}" 不能与自己冲突`);

    if (!isPlainObject(m.hooks)) fail(`机制 "${m.id}" 必须声明 hooks`);
    for (const h of Object.keys(m.hooks)) {
      if (!HOOK_NAMES.includes(h)) fail(`机制 "${m.id}" 使用了未知槽位 "${h}"（可用：${HOOK_NAMES.join(', ')}）`);
      if (typeof m.hooks[h] !== 'function') fail(`机制 "${m.id}" 的槽位 "${h}" 必须是函数`);
    }
    if (!Array.isArray(m.acceptance) || m.acceptance.length === 0) {
      fail(`机制 "${m.id}" 必须带至少一条 acceptance（现象断言），并按需附消融断言`);
    }
    for (const a of m.acceptance) {
      if (!isPlainObject(a) || typeof a.name !== 'string' || typeof a.check !== 'function') {
        fail(`机制 "${m.id}" 的 acceptance 元素必须是 { name, kind, check() }`);
      }
      if (a.kind !== undefined && !['phenomenon', 'ablation'].includes(a.kind)) {
        fail(`机制 "${m.id}" 的 acceptance "${a.name}" 的 kind 必须是 phenomenon / ablation`);
      }
    }
    if (!Array.isArray(m.phenomenon) || m.phenomenon.length === 0) {
      fail(`机制 "${m.id}" 必须写清楚它模拟什么现象（phenomenon 数组）`);
    }
    // 提示式要求：有现象就该有出处（不强制阻断，但登记为告警）
    if (!Array.isArray(m.evidence) || m.evidence.length === 0) {
      m.__evidenceMissing = true;
    }
    return m;
  }

  class MechanismKernel {
    /**
     * @param {object} graph  Graph 实例（src/model.js）
     * @param {object} [config] Config 实例
     * @param {object} [options] { seed, hours, overrides }
     */
    constructor(graph, config, options) {
      const opts = options || {};
      if (!graph || typeof graph.get_node !== 'function') fail('MechanismKernel 需要传入 Graph 实例');
      this.graph = graph;
      this.config = config instanceof Config ? config : new Config(config);
      this.seed = opts.seed === undefined ? 20260921 : opts.seed;
      // 防御性拷贝：克隆引擎时若共享同一个 overrides 对象，反事实干预会互相污染
      this.overrides = Object.assign({}, opts.overrides || {});
      this.tick = 0;
      this.round = 0;
      this.hours = opts.hours === undefined ? 0 : opts.hours;
      this.m = {};
      this.warnings = [];
      this.diagnostics = [];
      this._rng = createRng(this.seed);
      this._manifests = [];
      this._order = [];
      this._hooks = {};
      this._bounds = {};
      this._owner = {};
      this._disabled = new Set();
      this._finalized = false;
    }

    // ------------------------------------------------------------ 装载

    use(manifest) {
      if (this._finalized) fail('内核已 finalize()，不能再注册机制');
      validateManifest(manifest);
      if (this._manifests.some((m) => m.id === manifest.id)) fail(`机制 id 重复：${manifest.id}`);
      if (manifest.__evidenceMissing) {
        this.warnings.push({ mechanism: manifest.id, kind: 'no-evidence', message: '未声明 evidence 出处' });
        delete manifest.__evidenceMissing;
      }
      this._manifests.push(manifest);
      return this;
    }

    load(list) {
      for (const m of list || []) this.use(m);
      return this.finalize();
    }

    finalize() {
      const byId = new Map(this._manifests.map((m) => [m.id, m]));
      // 冲突检测
      for (const m of this._manifests) {
        for (const c of m.conflicts || []) {
          if (byId.has(c)) fail(`机制冲突：${m.id} 与 ${c} 不能同时启用`);
        }
        for (const r of m.requires || []) {
          if (!byId.has(r)) fail(`机制 ${m.id} 依赖的 ${r} 未启用`);
        }
      }
      // 依赖拓扑排序（稳定：按注册顺序遍历）
      const order = [];
      const state = new Map();
      const visit = (m, stack) => {
        const st = state.get(m.id);
        if (st === 'done') return;
        if (st === 'visiting') fail(`机制依赖成环：${stack.concat(m.id).join(' → ')}`);
        state.set(m.id, 'visiting');
        for (const r of m.requires || []) visit(byId.get(r), stack.concat(m.id));
        state.set(m.id, 'done');
        order.push(m);
      };
      for (const m of this._manifests) visit(m, []);
      this._order = order;

      // 槽位表 + 边界表 + 字段归属
      this._hooks = {};
      for (const m of order) {
        const ns = m.namespace || m.id.replace(/\./g, '_');
        m.__ns = ns;
        for (const w of m.writes || []) {
          this._owner[CORE_WRITABLE.includes(w) ? w : `${ns}.${w}`] = m.id;
        }
        for (const h of Object.keys(m.hooks)) {
          if (!this._hooks[h]) this._hooks[h] = [];
          this._hooks[h].push({ manifest: m, fn: m.hooks[h] });
        }
      }
      this._bounds = { ms: [0, 1], al: [0, 1] };
      for (const f of Object.keys(SHARED_BOUNDS)) this._bounds[`${SHARED_NS}.${f}`] = SHARED_BOUNDS[f];
      for (const m of order) {
        for (const field of Object.keys(m.bounds || {})) {
          this._bounds[field] = m.bounds[field];
        }
        for (const f of m.shared || []) {
          this._owner[`${SHARED_NS}.${f}`] = m.id;
        }
      }
      this._finalized = true;
      return this;
    }

    enabledIds() {
      return this._order.filter((m) => !this._disabled.has(m.id)).map((m) => m.id);
    }

    isEnabled(id) {
      return this._order.some((m) => m.id === id && !this._disabled.has(m.id));
    }

    /** 参数解析：支持 "memory.dsr.gamma" 这种最长前缀匹配 + 构造时传入的 overrides */
    param(path, fallback) {
      let manifest = null;
      let key = null;
      for (const m of this._order) {
        const prefix = `${m.id}.`;
        if (path.startsWith(prefix)) {
          const k = path.slice(prefix.length);
          const has = (m.params || []).some((p) => p.key === k);
          if (has) {
            manifest = m;
            key = k;
            break;
          }
        }
      }
      if (!manifest) {
        if (fallback !== undefined) return fallback;
        fail(`找不到参数 "${path}"`);
      }
      if (Object.prototype.hasOwnProperty.call(this.overrides, path)) return this.overrides[path];
      const spec = manifest.params.find((p) => p.key === key);
      return spec.default;
    }

    // ------------------------------------------------------------ 状态访问

    /** 模块的命名空间状态（每个节点一份） */
    data(nodeId, manifest) {
      const node = this.graph.get_node(nodeId);
      if (!node) fail(`节点 "${nodeId}" 不存在`);
      if (!node.m) node.m = {};
      if (!manifest) return node.m;
      if (!node.m[manifest.__ns]) node.m[manifest.__ns] = {};
      return node.m[manifest.__ns];
    }

    /** 内核级命名空间（模块全局状态） */
    store(manifest) {
      if (!manifest) return this.m;
      if (!this.m[manifest.__ns]) this.m[manifest.__ns] = {};
      return this.m[manifest.__ns];
    }

    /** 共享快状态（node.m.core）：所有模块都能读 */
    shared(nodeId) {
      const node = this.graph.get_node(nodeId);
      if (!node) fail(`节点 "${nodeId}" 不存在`);
      if (!node.m) node.m = {};
      if (!node.m[SHARED_NS]) node.m[SHARED_NS] = { a: 0, q: 0 };
      return node.m[SHARED_NS];
    }

    // ------------------------------------------------------------ 事件入口

    setHours(u) {
      if (typeof u !== 'number' || !Number.isFinite(u)) fail('setHours 需要有限数字');
      const delta = u - this.hours;
      this.hours = u;
      return this.run('hours.advance', { delta });
    }

    advanceHours(delta) {
      if (typeof delta !== 'number' || !Number.isFinite(delta) || delta < 0) fail('advanceHours 需要非负有限数字');
      this.hours += delta;
      return this.run('hours.advance', { delta });
    }

    /** 复习事件。调用方输入错误直接报错；槽位内部的异常仍按模块故障隔离 */
    review(nodeId, opts) {
      if (!this.graph.has_node(nodeId)) fail(`review：节点 "${nodeId}" 不存在`);
      return this.run('review.on', Object.assign({ nodeId }, opts || {}));
    }

    consolidate(nodeIds) {
      if (nodeIds) {
        for (const id of nodeIds) {
          if (!this.graph.has_node(id)) fail(`consolidate：节点 "${id}" 不存在`);
        }
      }
      return this.run('consolidate.on', { nodeIds: nodeIds || null });
    }

    /** 诊断：payload 由调用方（引擎）提供，模块从中读「为什么没亮」的事实 */
    diagnose(payload) {
      this.diagnostics = this.run('diagnose.on', payload || {});
      return this.diagnostics;
    }

    serialize() {
      const out = {};
      for (const r of this.run('serialize.on', {})) Object.assign(out, r.out);
      return out;
    }

    resetRuntime() {
      this.tick = 0;
      this.round = 0;
      this._rng = createRng(this.seed);
      this._disabled.clear();
      this.warnings = [];
    }

    // ------------------------------------------------------------ 槽位调度

    run(hook, payload) {
      if (!HOOK_NAMES.includes(hook)) fail(`未知槽位 "${hook}"`);
      if (!this._finalized) this.finalize();
      const results = [];
      let blocked = null;
      for (const entry of this._hooks[hook] || []) {
        if (this._disabled.has(entry.manifest.id)) continue;
        const ctx = this._makeCtx(hook, entry.manifest, payload);
        try {
          const out = entry.fn(ctx);
          if (out !== undefined) results.push({ id: entry.manifest.id, out });
          if (out && out.block) blocked = { id: entry.manifest.id, reason: out.reason || 'blocked' };
        } catch (err) {
          this._disable(entry.manifest, hook, err);
        }
      }
      this._checkInvariants(hook);
      if (hook === 'tick.gate') return { blocked, results };
      return results;
    }

    _makeCtx(hook, manifest, payload) {
      const kernel = this;
      const ns = manifest.__ns;
      return {
        kernel,
        id: manifest.id,
        hook,
        config: kernel.config,
        graph: kernel.graph,
        payload: payload || {},
        get tick() { return kernel.tick; },
        get round() { return kernel.round; },
        get hours() { return kernel.hours; },
        rng: kernel._rng,
        node: (id) => kernel.graph.get_node(id),
        nodes: () => Array.from(kernel.graph.nodes.values()),
        edges: () => kernel.graph.edges,
        data: (id) => kernel.data(id, manifest),
        shared: (id) => kernel.shared(id),
        store: () => kernel.store(manifest),
        param: (key) => kernel.param(`${manifest.id}.${key}`),
        log: (message) => kernel.warnings.push({ mechanism: manifest.id, kind: 'log', message: String(message) }),
        /** 写共享快状态（必须在 manifest 的 shared 里声明） */
        patchShared: (nodeId, fields) => {
          const declared = new Set(manifest.shared || []);
          const bag = kernel.shared(nodeId);
          for (const key of Object.keys(fields || {})) {
            if (!declared.has(key)) {
              fail(`机制 ${manifest.id} 未在 shared 中声明字段 "${key}"，内核拒绝写入共享状态`);
            }
            bag[key] = fields[key];
            kernel._owner[`${SHARED_NS}.${key}`] = manifest.id;
          }
        },
        /** 写状态：纯字段名 → 本模块命名空间；白名单内核字段 → 直接写节点 */
        patch: (nodeId, fields) => {
          const node = kernel.graph.get_node(nodeId);
          if (!node) fail(`patch 的目标节点 "${nodeId}" 不存在`);
          const declared = new Set(manifest.writes || []);
          for (const key of Object.keys(fields || {})) {
            const isCore = CORE_WRITABLE.includes(key);
            if (!declared.has(key)) {
              fail(`机制 ${manifest.id} 未在 writes 中声明字段 "${key}"，内核拒绝写入`);
            }
            const value = fields[key];
            if (isCore) {
              node[key] = value;
            } else {
              const bag = kernel.data(nodeId, manifest);
              bag[key] = value;
            }
            kernel._owner[isCore ? key : `${ns}.${key}`] = manifest.id;
          }
        },
      };
    }

    // ------------------------------------------------------------ 不变量

    _disable(manifest, hook, err) {
      this._disabled.add(manifest.id);
      this.warnings.push({
        mechanism: manifest.id,
        kind: 'error',
        hook,
        message: err && err.message ? err.message : String(err),
      });
    }

    _resolveField(node, path) {
      const dot = path.indexOf('.');
      if (dot < 0) return { value: node[path], set: (v) => { node[path] = v; } };
      const ns = path.slice(0, dot);
      const field = path.slice(dot + 1);
      const bag = node.m && node.m[ns];
      if (!bag) return { value: undefined, set: () => {} };
      return { value: bag[field], set: (v) => { bag[field] = v; } };
    }

    _checkInvariants(hook) {
      for (const node of this.graph.nodes.values()) {
        const paths = ['ms', 'al'];
        if (node.m) {
          for (const ns of Object.keys(node.m)) {
            for (const f of Object.keys(node.m[ns])) paths.push(`${ns}.${f}`);
          }
        }
        for (const path of paths) {
          const ref = this._resolveField(node, path);
          const v = ref.value;
          if (typeof v !== 'number') continue;
          if (!Number.isFinite(v)) {
            this._clampViolation(node, path, v, ref, hook, 'NaN/Infinity');
            continue;
          }
          const bound = this._bounds[path];
          if (bound && (v < bound[0] || v > bound[1])) {
            this._clampViolation(node, path, v, ref, hook, `越界 [${bound[0]}, ${bound[1]}]`);
          }
        }
      }
    }

    _clampViolation(node, path, value, ref, hook, what) {
      const owner = this._owner[path];
      const bound = this._bounds[path] || [0, 1];
      const fixed = Number.isFinite(value) ? Math.min(bound[1], Math.max(bound[0], value)) : bound[0];
      ref.set(fixed);
      this.warnings.push({
        mechanism: owner || '(未知)',
        kind: 'invariant',
        hook,
        node: node.id,
        message: `${path} ${what}：${value} → 已钳到 ${fixed}`,
      });
      if (owner) {
        const manifest = this._order.find((m) => m.id === owner);
        if (manifest && !this._disabled.has(owner)) {
          this._disabled.add(owner);
          this.warnings.push({ mechanism: owner, kind: 'disabled', message: `因不变量违规被停用（${path}）` });
        }
      }
    }

    // ------------------------------------------------------------ 自检

    /** 状态指纹：用于「同 seed 同输入 ⇒ 同输出」的确定性检查 */
    stateHash() {
      const ids = this.graph.node_ids().slice().sort();
      const parts = [];
      for (const id of ids) {
        const node = this.graph.get_node(id);
        parts.push(`${id}|${node.state}|${round(node.ms)}|${round(node.al)}|${node.visit_count}`);
        if (node.m) {
          for (const ns of Object.keys(node.m).sort()) {
            for (const f of Object.keys(node.m[ns]).sort()) {
              const v = node.m[ns][f];
              parts.push(`${id}.${ns}.${f}=${typeof v === 'number' ? round(v) : JSON.stringify(v)}`);
            }
          }
        }
      }
      return fnv1a(parts.join('\n'));
    }

    /** 跑所有模块的 acceptance；返回每条的通过情况 */
    runAcceptance() {
      const report = [];
      for (const m of this._order) {
        for (const a of m.acceptance || []) {
          let ok = false;
          let error = null;
          try {
            ok = a.check(this) !== false;
          } catch (err) {
            error = err && err.message ? err.message : String(err);
          }
          report.push({
            mechanism: m.id,
            name: a.name,
            kind: a.kind || 'phenomenon',
            passed: !!ok && !error,
            error,
          });
        }
      }
      return report;
    }
  }

  function round(x, digits) {
    const d = digits === undefined ? 9 : digits;
    const f = Math.pow(10, d);
    return Math.round((Number(x) || 0) * f) / f;
  }

  function fnv1a(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i += 1) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
  }

  const api = {
    MechanismKernel,
    validateManifest,
    HOOK_NAMES,
    LAYERS,
    LEVELS,
    CORE_WRITABLE,
    SHARED_BOUNDS,
    SHARED_NS,
    stateHashOf: (kernel) => kernel.stateHash(),
  };

  if (isNode) {
    module.exports = api;
  } else {
    globalThis.MindNet = Object.assign(globalThis.MindNet || {}, api);
  }
})();
