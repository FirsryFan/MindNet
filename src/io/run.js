/**
 * MindNet I/O · 运行层（`mindnet.run/1` → `mindnet.result/1`）
 *
 * 这一层的全部工作：**校验请求 → 逐条生效 → 采集过程 → 生成结果信封**。
 * 它不读照片、不调 AI、不搜题、不评价题目 —— 上游把"我做了什么"加工成 run 请求，
 * 下游把 result 拿去做任何事。这里只保证合法、可回放、过程讲得清。
 *
 * 设计要点（对应 docs/IO_PROTOCOL.md）：
 *   1. 顺序即语义：actions 按数组顺序生效，每条生效后写一条 change_log 与存档；
 *   2. 立即生效：没有"等人确认"的挂起队列（错了靠存档回退，见 archive.js）；
 *   3. 确定性：同一请求 + 同 seed ⇒ 逐位相同的输出（时间基必须显式给，不许默认用"现在"）；
 *   4. `S` 只有一个写者：机制（memory.dsr）。本层不写 S，只把机制返回的前后值记进 trace。
 */
(function () {
  'use strict';

  const isNode = typeof module !== 'undefined' && !!module.exports;
  const deps = isNode
    ? Object.assign({}, require('../config.js'), require('../model.js'), require('./archive.js'))
    : (globalThis.MindNet || {});
  const { MindNetError, Node, Edge } = deps;
  const RunArchive = deps.RunArchive || (deps.ioArchive && deps.ioArchive.RunArchive);

  const RUN_PROTOCOL = 'mindnet.run/1';
  const RESULT_PROTOCOL = 'mindnet.result/1';

  /** 动作白名单：本模块能接受的**全部**输入 */
  const ACTION_KINDS = ['time', 'review', 'exposure', 'knowledge', 'goal'];

  /**
   * outcome → 机制里的复习类型（三条不同的路径，见 IO_PROTOCOL §2.3）
   *
   * `wrong` 默认走 **lapse**（遗忘）：做错了就是没提取出来，S 该下降。
   * 只有上游明确说"做错之后我看了答案/解析"（`reviewed_solution: true`）才走
   * `retrieval_failure_feedback` —— 那是"失败后对答案"的学习路径，增益由 closeness 决定。
   *
   * 为什么要把这两条分开（实测数据）：
   *   同一个节点、同一次"做错"，走 feedback 路径是 `S 3.6h → 90.8h`（25 倍），
   *   走 lapse 路径是下降（正常 R0=0.8 的节点：`S 19.2h → 4.2h`）。
   *   两者的差别不是"参数调得好不好"，而是**到底发生了什么**：
   *   只是没做出来 ≠ 没做出来但随后把解法学了一遍。上游知道这个区别，就该告诉模型。
   */
  const REVIEW_MAP = {
    correct: { type: 'retrieval_success', grade: 3 },
    wrong: { type: 'lapse', grade: 1 },
    blank: { type: 'lapse', grade: 1 },
  };

  /** 做错但"随后对过答案"时改走的学习路径 */
  const REVIEW_MAP_AFTER_FEEDBACK = { type: 'retrieval_failure_feedback', grade: 1, closeness: 0.5 };

  function reviewPlan(action) {
    if (action.outcome === 'wrong' && action.reviewed_solution === true) {
      return Object.assign({}, REVIEW_MAP_AFTER_FEEDBACK);
    }
    return Object.assign({}, REVIEW_MAP[action.outcome]);
  }

  function round6(x) {
    if (typeof x !== 'number' || !Number.isFinite(x)) return x;
    return Math.round(x * 1e6) / 1e6;
  }

  function fail(msg) {
    throw new MindNetError(msg);
  }

  // ------------------------------------------------------------------ 校验

  /**
   * 解析动作的时间基。model_hours 优先；只给 wall 时用锚点线性换算并记进 assumptions；
   * 都没有就报错（不许默默用"现在"——那是"时间戳漂移"类 bug 的唯一防线）。
   * @param {boolean} dry true = 只检查、不写 assumptions（校验阶段用）
   */
  function resolveAt(action, index, state, dry) {
    const at = action.at;
    if (!at || typeof at !== 'object') {
      return fail(`第 ${index + 1} 条 action（${action.kind}）缺少 at（至少要 at.model_hours）`);
    }
    if (at.model_hours !== undefined && at.model_hours !== null) {
      const h = Number(at.model_hours);
      if (!Number.isFinite(h)) fail(`第 ${index + 1} 条 action 的 at.model_hours 不是数字`);
      return { model_hours: h, derived: false, wall: at.wall === undefined ? null : at.wall };
    }
    if (at.wall !== undefined && at.wall !== null) {
      const anchor = state.anchor;
      if (!anchor || anchor.wall_ms === null) {
        return fail(`第 ${index + 1} 条 action 只给了 at.wall，而没有可用的 wall↔model_hours 锚点：`
          + '请直接给 at.model_hours，或先用带 wall 的 time 动作建立锚点');
      }
      const t = Date.parse(at.wall);
      if (!Number.isFinite(t)) fail(`第 ${index + 1} 条 action 的 at.wall 不是可解析的时间`);
      const hours = anchor.model_hours + (t - anchor.wall_ms) / 3600000;
      if (!dry) {
        state.assumptions.push({
          what: '时间换算',
          detail: `wall ${at.wall} → model_hours ${round6(hours)}（锚点 ${anchor.wall} ↔ ${anchor.model_hours}）`,
          effect: `第 ${index + 1} 条 action 的时间基`,
        });
      }
      return { model_hours: hours, derived: true, wall: at.wall };
    }
    return fail(`第 ${index + 1} 条 action（${action.kind}）既没有 at.model_hours 也没有 at.wall：`
      + '不许默默用"现在"，请显式给出时间基');
  }

  function hasTimeBase(action) {
    if (action.kind === 'time' && action.elapsed_hours !== undefined) return true;
    const at = action.at;
    return !!(at && typeof at === 'object'
      && ((at.model_hours !== undefined && at.model_hours !== null)
        || (at.wall !== undefined && at.wall !== null)));
  }

  /**
   * 校验整份请求：不合法就整份拒绝，**绝不半途生效**。
   */
  function validateRequest(request, engine) {
    if (!request || typeof request !== 'object') fail('run 请求必须是对象');
    if (request.protocol !== RUN_PROTOCOL) {
      fail(`run 请求的 protocol 必须是 "${RUN_PROTOCOL}"，实际 ${JSON.stringify(request.protocol)}`);
    }
    if (typeof request.run_id !== 'string' || !request.run_id) fail('run 请求缺少 run_id（幂等键）');
    if (!Array.isArray(request.actions)) fail('run 请求缺少 actions 数组');
    if (request.steps !== undefined) {
      const s = Number(request.steps);
      if (!Number.isFinite(s) || s < 0 || Math.floor(s) !== s) fail('run 请求的 steps 必须是 ≥0 的整数');
    }

    // 校验用一份"影子状态"：确认每条动作的时间基都能解析，又不产生重复的 assumptions。
    // 同时维护一份"影子图"（下面 shadowNodes/shadowEdges）：校验按与执行相同的顺序走，
    // 把本批次**将要新建**的节点/边也算作"已存在" —— 否则「同一份请求里先建节点、
    // 再把它们设为目标」会被误判成"目标不在图里"（材料批量入库的正常形态，实测踩到过）。
    const shadow = { anchor: null, assumptions: [] };
    if (request.time && request.time.model_hours !== undefined) {
      const h = Number(request.time.model_hours);
      if (!Number.isFinite(h)) fail('run 请求的 time.model_hours 必须是数字');
      const wallMs = request.time.wall ? Date.parse(request.time.wall) : null;
      if (request.time.wall && !Number.isFinite(wallMs)) fail(`run 请求的 time.wall 不可解析：${request.time.wall}`);
      shadow.anchor = { model_hours: h, wall_ms: wallMs, wall: request.time.wall || null };
    }

    const shadowNodes = new Set(engine.graph.nodes.keys());
    const shadowEdges = new Set(engine.graph.edges.map((e) => e.id));
    const has = (id) => shadowNodes.has(id);
    const seen = new Map();
    request.actions.forEach((action, index) => {
      if (!action || typeof action !== 'object') fail(`第 ${index + 1} 条 action 不是对象`);
      if (ACTION_KINDS.indexOf(action.kind) < 0) {
        fail(`第 ${index + 1} 条 action 的 kind 必须是 ${ACTION_KINDS.join(' / ')}，实际 ${JSON.stringify(action.kind)}`);
      }
      if (!hasTimeBase(action)) {
        fail(`第 ${index + 1} 条 action（${action.kind}）缺少时间基：至少要 at.model_hours`
          + '（time 动作也可以用 elapsed_hours）');
      }
      if (action.kind === 'review') {
        if (typeof action.node !== 'string' || !action.node) fail(`第 ${index + 1} 条 action（review）缺少 node`);
        if (!has(action.node)) fail(`第 ${index + 1} 条 action（review）指向图里不存在的节点 "${action.node}"`);
        if (!REVIEW_MAP[action.outcome]) {
          fail(`第 ${index + 1} 条 action（review）的 outcome 必须是 ${Object.keys(REVIEW_MAP).join(' / ')}，`
            + `实际 ${JSON.stringify(action.outcome)}`);
        }
        const prev = seen.get(action.node);
        if (prev && prev !== action.outcome) {
          fail(`同一个 run 里节点 "${action.node}" 同时出现了 "${prev}" 与 "${action.outcome}"：`
            + '互相矛盾的观察请拆成两次请求（或先确认到底哪个对）');
        }
        seen.set(action.node, action.outcome);
      } else if (action.kind === 'exposure') {
        if (typeof action.node !== 'string' || !action.node) fail(`第 ${index + 1} 条 action（exposure）缺少 node`);
        if (!has(action.node)) fail(`第 ${index + 1} 条 action（exposure）指向不存在的节点 "${action.node}"`);
      } else if (action.kind === 'knowledge') {
        const hasNode = action.node && typeof action.node === 'object';
        const hasEdge = action.edge && typeof action.edge === 'object';
        if (!hasNode && !hasEdge) fail(`第 ${index + 1} 条 action（knowledge）要么给 node（新知识点）要么给 edge（新连接）`);
        if (hasNode) {
          const id = action.node.id;
          if (id !== undefined && id !== null) {
            if (typeof id !== 'string' || !id) fail(`第 ${index + 1} 条 action（knowledge）的 node.id 必须是非空字符串`);
            if (shadowNodes.has(id)) {
              fail(`第 ${index + 1} 条 action（knowledge）要建的节点 "${id}" 已经存在`
                + '（材料入库应当幂等：不必重复建，直接引用即可）');
            }
            shadowNodes.add(id);
          }
        } else {
          const e = action.edge;
          if (!e.from || !e.to) fail(`第 ${index + 1} 条 action（knowledge）的 edge 缺少 from / to`);
          if (!has(e.from)) fail(`第 ${index + 1} 条 action（knowledge）的边起点 "${e.from}" 不在图里（也不在本批次新建的节点里）`);
          if (!has(e.to)) fail(`第 ${index + 1} 条 action（knowledge）的边终点 "${e.to}" 不在图里（也不在本批次新建的节点里）`);
          if (e.id !== undefined && e.id !== null) {
            if (typeof e.id !== 'string' || !e.id) fail(`第 ${index + 1} 条 action（knowledge）的 edge.id 必须是非空字符串`);
            if (shadowEdges.has(e.id)) fail(`第 ${index + 1} 条 action（knowledge）要建的边 "${e.id}" 已经存在`);
            shadowEdges.add(e.id);
          }
        }
      } else if (action.kind === 'goal') {
        if (!Array.isArray(action.targets) || action.targets.length === 0) {
          fail(`第 ${index + 1} 条 action（goal）必须给非空的 targets 数组`);
        }
        for (const t of action.targets) {
          if (!has(t)) fail(`第 ${index + 1} 条 action（goal）的目标 "${t}" 不在图里`);
        }
        if (action.starts !== undefined) {
          if (!Array.isArray(action.starts)) fail(`第 ${index + 1} 条 action（goal）的 starts 必须是数组`);
          for (const s of action.starts) if (!has(s)) fail(`第 ${index + 1} 条 action（goal）的起点 "${s}" 不在图里`);
        }
      } else if (action.kind === 'time') {
        if (action.elapsed_hours !== undefined) {
          const eh = Number(action.elapsed_hours);
          if (!Number.isFinite(eh) || eh < 0) fail(`第 ${index + 1} 条 action（time）的 elapsed_hours 必须是非负数`);
        } else {
          const t = resolveAt(action, index, shadow, true);
          // 让后面的动作能用这个锚点
          if (t.wall) shadow.anchor = { model_hours: t.model_hours, wall_ms: Date.parse(t.wall), wall: t.wall };
        }
      }
      if (action.kind !== 'time') resolveAt(action, index, shadow, true);
    });

    const state = { anchor: shadow.anchor ? Object.assign({}, shadow.anchor) : null, assumptions: [] };
    return { state, ctx: { state, graph: engine.graph, hasNode: has } };
  }

  // ------------------------------------------------------------------ 生效

  /** kernel.run 返回的是**每个模块的结果数组**，这里取出 memory.dsr 的那一份 */
  function memoryOut(raw) {
    if (Array.isArray(raw)) {
      for (const r of raw) if (r && r.id === 'memory.dsr' && r.out) return r.out;
      return raw.length && raw[0].out ? raw[0].out : null;
    }
    return raw || null;
  }

  function applyOne(engine, kernel, action, index, ctx) {
    switch (action.kind) {
      case 'time': {
        const before = kernel.hours;
        let elapsed;
        let t = null;
        if (action.elapsed_hours !== undefined) {
          elapsed = Number(action.elapsed_hours);
          kernel.advanceHours(elapsed);
        } else {
          t = resolveAt(action, index, ctx.state, false);
          elapsed = t.model_hours - before;
          kernel.setHours(t.model_hours);
        }
        if (t && t.wall) ctx.state.anchor = { model_hours: kernel.hours, wall_ms: Date.parse(t.wall), wall: t.wall };
        // 时间推进把每个节点的 ms 重新同步（慢层的"曲线推进"，不改 S 本身）
        const msView = {};
        for (const node of engine.graph.nodes.values()) msView[node.id] = round6(node.ms);
        return {
          kind: 'time', node: null, mechanism: 'hours.advance',
          hours_before: round6(before), hours_after: round6(kernel.hours),
          elapsed_hours: round6(elapsed), at: t,
          delta: { synced_nodes: engine.graph.size, ms: msView },
        };
      }
      case 'review': {
        const map = reviewPlan(action);
        const at = resolveAt(action, index, ctx.state, false);
        const grade = action.grade === undefined ? map.grade : Number(action.grade);
        const closeness = action.closeness === undefined
          ? map.closeness
          : Number(action.closeness);
        const raw = kernel.review(action.node, {
          type: map.type, grade, closeness, current_real_time: at.model_hours,
        });
        return {
          kind: 'review', node: action.node, outcome: action.outcome, mechanism: map.type,
          delta: memoryOut(raw) || {}, at,
        };
      }
      case 'exposure': {
        const at = resolveAt(action, index, ctx.state, false);
        const raw = kernel.review(action.node, { type: 'reread', current_real_time: at.model_hours });
        return { kind: 'exposure', node: action.node, outcome: 'reread', mechanism: 'reread', delta: memoryOut(raw) || {}, at };
      }
      case 'knowledge': {
        const at = resolveAt(action, index, ctx.state, false);
        if (action.node) {
          const node = Node.from_object(
            Object.assign({}, action.node, { id: action.node.id || `new_${index + 1}` }),
            `第 ${index + 1} 条 action 的新节点`
          );
          engine.graph.add_node(node);
          return { kind: 'knowledge', node: node.id, mechanism: 'graph.add_node', at, delta: { added: 'node' } };
        }
        const e = action.edge;
        const edge = new Edge({
          id: e.id || `e_${index + 1}_${e.from}_${e.to}`,
          from: e.from,
          to: e.to,
          ls: e.ls === undefined ? 0.8 : Number(e.ls),
        });
        engine.graph.add_edge(edge);
        return {
          kind: 'knowledge', node: null, mechanism: 'graph.add_edge', at,
          delta: { added: 'edge', edge: edge.to_object() },
        };
      }
      case 'goal': {
        const at = resolveAt(action, index, ctx.state, false);
        const starts = action.starts || engine.starts;
        engine.start_diffusion(starts, action.targets);
        return {
          kind: 'goal', node: null, mechanism: 'start_diffusion', at,
          delta: { targets: action.targets.slice(), starts: starts.slice(), rounds_reset: true },
        };
      }
      default:
        return fail(`未知动作 ${action.kind}`);
    }
  }

  // ------------------------------------------------------------- 过程采集

  /** 快照一轮（引擎自己只保留最后一轮，所以由本层逐轮抓） */
  function snapshotRound(payload) {
    if (!payload) return null;
    const mapToObj = (m) => {
      const out = {};
      if (!m) return out;
      if (m instanceof Map) {
        for (const [k, v] of m) out[k] = round6(v);
        return out;
      }
      for (const k of Object.keys(m)) out[k] = round6(m[k]);
      return out;
    };
    return {
      round: payload.round,
      tick: payload.tick,
      hours: round6(payload.hours),
      cycle_ticks: payload.cycleTicks,
      open_ticks: payload.openTicks === undefined ? null : payload.openTicks,
      availability: round6(payload.availability),
      rhythm: payload.rhythm === undefined ? null : payload.rhythm,
      drive: mapToObj(payload.drive),
      drive_edges: (payload.drive_edges || []).map((e) => Object.assign({}, e)),
      scores: mapToObj(payload.scores),
      candidates: (payload.candidates || []).slice(0, 50).map((c) => Object.assign({}, c)),
      admitted: payload.admitted ? payload.admitted.slice() : null,
      focus: payload.focus === undefined ? null : payload.focus,
      dar_used: payload.dar_used === undefined ? null : payload.dar_used,
      outcompeted: (payload.outcompeted || []).slice(),
      ignition: (payload.ignition || []).map((i) => Object.assign({}, i)),
      conscious: (payload.conscious || []).slice(),
      subconscious: (payload.subconscious || []).slice(),
      states: (payload.state_changes || []).map((s) => Object.assign({}, s)),
      notes: (payload.notes || []).slice(),
    };
  }

  function digestOf(trace) {
    const rounds = trace.rounds.length;
    let ignited = 0;
    let evicted = 0;
    for (const r of trace.rounds) {
      for (const i of r.ignition) if (i.hit) ignited += 1;
      evicted += r.outcompeted.length;
    }
    const diagnoses = trace.control && trace.control.diagnoses ? trace.control.diagnoses.length : 0;
    const plan = trace.control && trace.control.plan ? trace.control.plan.length : 0;
    return {
      rounds,
      ignited,
      evicted,
      slow_events: trace.slow.length,
      diagnoses,
      plan_items: plan,
      text: `rounds=${rounds} · 点火 ${ignited} 次 · 容量挤出 ${evicted} 次 · 慢层事件 ${trace.slow.length} 条`
        + ` · 诊断 ${diagnoses} 条 · 处方 ${plan} 条`,
    };
  }

  /** 排程建议：这条线索什么时候该再碰（由 memory.dsr 反解，不由本层拍脑袋） */
  function nextCheckFor(engine, memoryDsr, nodeId, nowHours, targetRetention) {
    if (!nodeId || !memoryDsr) return null;
    const node = engine.graph.get_node(nodeId);
    const bag = node && node.m && node.m.memory_dsr;
    if (!bag) return null;
    const target = targetRetention === undefined ? 0.85 : targetRetention;
    const stub = {
      id: node.id, ms: bag.R0, weight: node.weight, last_review_time: bag.lastReview,
      m: { memory_dsr: Object.assign({}, bag) },
    };
    let hours;
    try {
      hours = memoryDsr.scheduleInterval(stub, nowHours, target, { decay_model: 'power' });
    } catch (err) {
      return null;
    }
    if (hours === null || !Number.isFinite(hours)) return null;
    return {
      for_node: nodeId,
      at_model_hours: round6(nowHours + hours),
      hours_from_now: round6(hours),
      target_retention: target,
      note: hours === 0
        ? `目标留存 ${target} 高过这条线索的编码上限 R0=${round6(bag.R0)}：曲线够不到 ⇒ 间隔 0（先提高 R0）`
        : null,
    };
  }

  /** 不变量自查（本层能查的那部分）：状态合法 + 数字有限 */
  function checkInvariants(engine) {
    const problems = [];
    for (const node of engine.graph.nodes.values()) {
      const c = engine.core ? engine.core(node.id) : { a: 0, q: 0 };
      const a = c.a;
      const q = c.q;
      if (!Number.isFinite(a) || a < 0 || a > 1) problems.push(`node ${node.id}: a=${a} 越界`);
      if (!Number.isFinite(q) || q < 0 || q > 1) problems.push(`node ${node.id}: q=${q} 越界`);
      if (!Number.isFinite(node.ms) || node.ms < 0 || node.ms > 1) problems.push(`node ${node.id}: ms=${node.ms} 越界`);
      const bag = node.m && node.m.memory_dsr;
      if (bag) {
        if (!Number.isFinite(bag.S) || bag.S <= 0) problems.push(`node ${node.id}: S=${bag.S} 非法`);
        if (!(bag.D >= 1 && bag.D <= 10)) problems.push(`node ${node.id}: D=${bag.D} 越界`);
        if (!(bag.R0 >= 0 && bag.R0 <= 1)) problems.push(`node ${node.id}: R0=${bag.R0} 越界`);
      }
    }
    return { checked: 'state_legality', ok: problems.length === 0, problems };
  }

  // -------------------------------------------------------------- 主入口

  /**
   * 跑一份请求。
   * @param {object} p { engine, kernel, request, archive, memoryDsr, clock, target_retention, profile, onArchive }
   * @returns {object} mindnet.result/1
   */
  function run(p) {
    const params = p || {};
    const engine = params.engine;
    const kernel = params.kernel || (engine && engine.kernel);
    if (!engine || !kernel) fail('run 需要 { engine, kernel }');
    const request = params.request;
    const archive = params.archive === undefined ? new RunArchive({ clock: params.clock }) : params.archive;
    if (!archive || typeof archive.append !== 'function') fail('run 的 archive 必须是 RunArchive');

    // 幂等：同一个 run_id 直接返回上次的结果，不重复生效。
    // 完整结果只缓存在内存里（存档是"变更日志"，不该被几十 KB 的结果撑爆）；
    // 换进程后重放同一 run_id 只会拿到摘要 —— 这一点写在返回值里，不装成完整结果。
    if (!archive.results) archive.results = {};
    const prior = archive.findRun(request && request.run_id);
    if (prior) {
      const cached = archive.results[request.run_id];
      if (cached) return Object.assign({}, cached, { replay: true, note: `run "${request.run_id}" 已生效过（幂等，未重复执行）` });
      return {
        protocol: RESULT_PROTOCOL,
        result_id: `res-${request.run_id}`,
        run_id: request.run_id,
        status: 'ok',
        replay: true,
        model: { state_hash_after: prior.state_hash_after === undefined ? null : prior.state_hash_after },
        note: `run "${request.run_id}" 在更早的进程里已生效过：只返回摘要（完整结果请读当时保存的结果文件）`,
      };
    }

    const validated = validateRequest(request, engine);
    const ctx = validated.ctx;
    const hasHash = typeof kernel.stateHash === 'function';
    const hashBefore = hasHash ? kernel.stateHash() : null;
    const slow = [];
    const applied = [];

    archive.append({
      kind: 'run', run_id: request.run_id,
      before: { state_hash: hashBefore, hours: round6(kernel.hours) }, after: null,
      state_hash_before: hashBefore,
      note: `请求进入：${request.actions.length} 条 action`,
    });

    request.actions.forEach((action, index) => {
      const before = {
        state_hash: hasHash ? kernel.stateHash() : null,
        hours: round6(kernel.hours),
      };
      const result = applyOne(engine, kernel, action, index, ctx);
      const after = {
        state_hash: hasHash ? kernel.stateHash() : null,
        hours: round6(kernel.hours),
      };
      applied.push({
        index,
        kind: action.kind,
        node: action.node === undefined ? null : action.node,
        outcome: action.outcome === undefined ? null : action.outcome,
        mechanism: result.mechanism === undefined ? null : result.mechanism,
        delta: result.delta === undefined ? null : result.delta,
        evidence: action.evidence === undefined ? null : action.evidence,
        confidence: action.confidence === undefined ? null : action.confidence,
        at: result.at || null,
        state_hash_before: before.state_hash,
        state_hash_after: after.state_hash,
      });
      if (result.delta && Object.keys(result.delta).length) {
        slow.push({ action_index: index, kind: action.kind, node: result.node || null, delta: result.delta });
      }
      archive.append({
        kind: 'action', run_id: request.run_id, action_index: index,
        action, before, after,
        state_hash_before: before.state_hash,
        state_hash_after: after.state_hash,
        note: `${action.kind}${result.node ? ` ${result.node}` : ''}`,
      });
    });

    // 可选推进扩散：逐轮抓快照（引擎只保留最后一轮）
    const trace = { slow, rounds: [], control: null, invariants: null, warnings: [], digest: null };
    const steps = request.steps === undefined ? 0 : Number(request.steps);
    for (let i = 0; i < steps; i += 1) {
      engine.step();
      const snap = snapshotRound(engine._lastRound);
      if (snap) trace.rounds.push(snap);
      if (engine.stopped) break;
    }

    if (typeof engine.control_report === 'function') {
      try {
        trace.control = engine.control_report();
      } catch (err) {
        trace.warnings.push({ kind: 'io.control_report', message: err.message });
      }
    }
    trace.invariants = checkInvariants(engine);
    if (kernel.warnings && kernel.warnings.length) for (const w of kernel.warnings) trace.warnings.push(w);
    trace.digest = digestOf(trace);

    const hashAfter = hasHash ? kernel.stateHash() : null;
    const nodeIds = applied.filter((a) => a.node).map((a) => a.node);
    const lastNode = nodeIds.length ? nodeIds[nodeIds.length - 1] : null;

    const result = {
      protocol: RESULT_PROTOCOL,
      result_id: `res-${request.run_id}`,
      run_id: request.run_id,
      status: 'ok',
      model: {
        profile: params.profile === undefined ? null : params.profile,
        seed: kernel.seed,
        hours: round6(kernel.hours),
        rounds: engine.rounds === undefined ? null : engine.rounds,
        mechanisms: typeof kernel.enabledIds === 'function' ? kernel.enabledIds() : [],
        overrides_digest: digestOverrides(kernel.overrides),
        state_hash_before: hashBefore,
        state_hash_after: hashAfter,
      },
      applied,
      assumptions: ctx.state.assumptions,
      trace,
      result: Object.assign({}, typeof engine.result === 'function' ? engine.result() : {}, {
        nodes: nodeView(engine),
        diagnoses: trace.control ? trace.control.diagnoses : [],
        plan: trace.control ? trace.control.plan : [],
        next_check: nextCheckFor(engine, params.memoryDsr, lastNode, kernel.hours, params.target_retention),
      }),
      warnings: trace.warnings.slice(),
      archive: {
        entries: archive.entries.length,
        last_entry_id: archive.lastEntryId,
        run_entry: archive.findRun(request.run_id) ? archive.findRun(request.run_id).entry_id : null,
      },
    };

    // 存档里只留摘要（变更日志不该被完整结果撑爆）；完整结果缓存到内存供幂等返回
    const head = archive.findRun(request.run_id);
    if (head) {
      head.after = {
        result_id: result.result_id,
        state_hash_after: hashAfter,
        digest: trace.digest.text,
        next_check: result.result.next_check,
      };
      head.state_hash_after = hashAfter;
    }
    archive.results[request.run_id] = result;
    return result;
  }

  function digestOverrides(overrides) {
    const keys = Object.keys(overrides || {}).sort();
    const text = keys.map((k) => `${k}=${overrides[k]}`).join(';');
    let h = 0;
    for (let i = 0; i < text.length; i += 1) h = (h * 31 + text.charCodeAt(i)) % 2147483647;
    return `n${keys.length}-${h.toString(36)}`;
  }

  function nodeView(engine) {
    const out = {};
    for (const node of engine.graph.nodes.values()) {
      const c = engine.core ? engine.core(node.id) : { a: 0, q: 0 };
      const bag = node.m && node.m.memory_dsr;
      out[node.id] = {
        name: node.name,
        state: node.state,
        a: round6(c.a || 0),
        q: round6(c.q || 0),
        ms: round6(node.ms),
        R0: bag ? round6(bag.R0) : null,
        S: bag ? round6(bag.S) : null,
        D: bag ? round6(bag.D) : null,
        Sigma: bag ? round6(bag.Sigma) : null,
        F: bag ? round6(bag.F) : null,
        peak_drive: round6(engine._peakDrive ? engine._peakDrive.get(node.id) || 0 : 0),
        ever_activated: engine._everActivated ? engine._everActivated.has(node.id) : false,
      };
    }
    return out;
  }

  const api = {
    RUN_PROTOCOL, RESULT_PROTOCOL, ACTION_KINDS, REVIEW_MAP, REVIEW_MAP_AFTER_FEEDBACK, reviewPlan,
    validateRequest, run, snapshotRound, digestOf, checkInvariants, nextCheckFor,
  };

  if (isNode) module.exports = api;
  else globalThis.MindNet = Object.assign(globalThis.MindNet || {}, { io: api });
})();
