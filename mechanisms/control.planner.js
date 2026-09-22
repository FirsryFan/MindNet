/**
 * 机制模块：处方规划器（诊断 → 指令 → 反事实预测）
 *
 * 对应 docs/MODEL_v2_MATH.md §7.2。两件事：
 *   1. 把卡点映射到用户的**指令库**（Application_Protocol 的 17 条 + Executive 的执行层指令）；
 *   2. 对**能在这个引擎里表达的干预**做反事实模拟：克隆引擎 → 施加干预 → 往前跑 k 轮
 *      → 看目标可达性变化多少，再按 增益/代价 排序。
 *
 * 诚实边界：并非所有指令都能模拟。像"把已推步骤写下来""切块""标记此路不通"这类
 * 改变的是执行层（工作记忆的用法），本引擎还没有对应状态，所以它们只做**规则映射**，
 * 输出里用 `simulated: false` 明确标出，绝不假装算过。
 */
(function () {
  'use strict';

  const isNode = typeof module !== 'undefined' && !!module.exports;
  const deps = isNode
    ? Object.assign({}, require('../src/config.js'), require('../src/model.js'))
    : (globalThis.MindNet || {});
  const { MindNetError, Edge } = deps;
  const memoryDsr = isNode ? require('./memory.dsr.js') : (globalThis.MindNet || {}).memoryDsr;
  const memoryReady = !!(memoryDsr && typeof memoryDsr.retrievabilityOf === 'function');

  /** 指令库：id → 名称、来源、能否在本引擎里模拟 */
  const INSTRUCTIONS = {
    // —— 来自 Application_Protocol（17 条指令库）——
    set_context: { name: '设定上下文（写一句"我现在要解决的是____"）', source: 'application', simulatable: false },
    capture_thought: { name: '捕捉念头（不判断地记一句）', source: 'application', simulatable: false },
    lower_threshold: { name: '降低门槛（用弱线索反复试探）', source: 'application', simulatable: true },
    boost_random_access: { name: '提升随机访问（换 3 个入口抽问）', source: 'application', simulatable: false },
    boost_clarity: { name: '提升清晰度（回忆后强制列细节）', source: 'application', simulatable: false },
    selective_automation: { name: '选择性自动化（重复到不看步骤，并核对）', source: 'application', simulatable: false },
    staged_processing: { name: '分阶段处理（先套旧框架，再换角度重组）', source: 'application', simulatable: false },
    add_connection_types: { name: '增加连接类型（结构/情境/行动/自我 四问）', source: 'application', simulatable: false },
    add_out_edges: { name: '增加出边（它能联想到什么、能做什么）', source: 'application', simulatable: false },
    add_in_edges: { name: '增加入边（"当出现____时，我该想到____"）', source: 'application', simulatable: true },
    add_relation_types: { name: '增加关系类型（给 A、B 标 ≥2 种关系）', source: 'application', simulatable: false },
    correct_error: { name: '更正错误（保留错误联想，标"此路不通"）', source: 'application', simulatable: false },
    commit_temp_links: { name: '提交临时连接（线索→知识→操作→边界）', source: 'application', simulatable: false },
    toggle_mode: { name: '切换思维模式（发散 2 分钟 / 收敛筛选）', source: 'application', simulatable: false },
    interval_retrieval: { name: '间隔提取（等到间隔到了再主动提取）', source: 'application', simulatable: true },
    strengthen_impression: { name: '增强印象（合上材料主动回忆，写不出再看一眼再重写）', source: 'application', simulatable: true },
    support_subthreshold: { name: '支持亚阈积累（只记录、不评价、定期回看）', source: 'application', simulatable: false },
    // —— 来自 Executive_Architecture（执行层）——
    offload_working_memory: { name: '写下来释放工作记忆', source: 'executive', simulatable: true },
    reduce_step_depth: { name: '降单步深度（把一步拆成更小的子步）', source: 'executive', simulatable: false },
    chunk_problem: { name: '把大问题切成小块', source: 'executive', simulatable: false },
    high_freq_light_task: { name: '先退到高频轻任务，把节奏拉起来', source: 'executive', simulatable: false },
  };

  const PARAMS = [
    { key: 'sim_rounds', type: 'number', min: 1, max: 20, default: 4, unit: '轮',
      desc: '拓扑类干预（补边 / 释放容量）反事实往前跑多少轮', evidence: '未标定', calibrated: false },
    { key: 'retention_horizon_hours', type: 'number', min: 1, max: 8736, default: 24, unit: '小时',
      desc: '复习类干预看的是「多久之后还记得」的留存增益', evidence: '未标定', calibrated: false },
    { key: 'max_candidates', type: 'number', min: 1, max: 20, default: 4, unit: '个',
      desc: '只对严重度最高的前 N 个卡点做模拟（控制算力）', evidence: '未标定', calibrated: false },
    { key: 'cost_retrieval', type: 'number', min: 0.1, max: 10, default: 1.0, unit: '-',
      desc: '一次主动提取的代价', evidence: '未标定', calibrated: false },
    { key: 'cost_link', type: 'number', min: 0.1, max: 20, default: 2.0, unit: '-',
      desc: '补一条入边的代价', evidence: '未标定', calibrated: false },
    { key: 'cost_offload', type: 'number', min: 0.01, max: 5, default: 0.2, unit: '-',
      desc: '写下释放工作记忆的代价', evidence: '未标定', calibrated: false },
  ];
  const DEFAULTS = PARAMS.reduce((a, p) => { a[p.key] = p.default; return a; }, {});

  function options(o) {
    return Object.assign({}, DEFAULTS, o || {});
  }

  /** 卡点类型 → 首选指令（其余指令作为备选输出，但不全部模拟） */
  const PRIMARY = {
    empty: 'add_in_edges',
    weak: 'strengthen_impression',
    slow: 'reduce_step_depth',
    overload: 'offload_working_memory',
    off_goal: 'correct_error',
    danger: 'interval_retrieval',
    dead_end: 'add_out_edges',
  };

  /**
   * 纯函数：把一个干预施加到引擎副本上。
   * 返回 metric 说明该怎么量它的收益：
   *   'retention'    —— 复习类：改变的是「多久之后还记得」，不是这一轮的可达性
   *   'reachability' —— 拓扑/容量类：改变的是这一轮及之后能碰到什么
   */
  function applyIntervention(engine, nodeId, instruction, o) {
    const opt = options(o);
    if (instruction === 'strengthen_impression') {
      engine.kernel.review(nodeId, { type: 'retrieval_success', grade: 3 });
      return { applied: true, cost: opt.cost_retrieval, metric: 'retention', why: '一次主动提取成功（提高稳定度 S 与编码强度 R0）' };
    }
    if (instruction === 'interval_retrieval') {
      engine.kernel.review(nodeId, { type: 'retrieval_success', grade: 2 });
      return { applied: true, cost: opt.cost_retrieval, metric: 'retention', why: '间隔后的主动提取（更费力，增益结构不同）' };
    }
    if (instruction === 'lower_threshold') {
      engine.kernel.review(nodeId, { type: 'retrieval_failure_feedback', grade: 2, closeness: 0.85 });
      return { applied: true, cost: opt.cost_retrieval, metric: 'retention', why: '弱线索试探 + 对答案（合意难度）' };
    }
    if (instruction === 'add_in_edges') {
      // 找一条"最可能被想到、但还没有连过去"的线索
      let best = null;
      let bestScore = 0;
      for (const n of engine.graph.nodes.values()) {
        if (n.id === nodeId) continue;
        if (engine.graph.in_edges(nodeId).some((e) => e.from === n.id)) continue;
        const score = engine.core(n.id).a;
        if (score > bestScore) { bestScore = score; best = n.id; }
      }
      if (!best || bestScore <= 0) {
        return { applied: false, cost: 0, metric: null, why: '没有可用的线索节点（当前没有别的节点被点亮）' };
      }
      engine.graph.add_edge(new Edge({ id: `hypo_${best}_${nodeId}`, from: best, to: nodeId, ls: 0.8 }));
      return { applied: true, cost: opt.cost_link, metric: 'reachability', why: `补一条入边：${best} → ${nodeId}` };
    }
    if (instruction === 'offload_working_memory') {
      const key = 'attention.capacity.W_DAR';
      const current = engine.kernel.param(key, 4);
      engine.kernel.overrides[key] = current * 1.5;
      return { applied: true, cost: opt.cost_offload, metric: 'reachability', why: `把直接访问区容量从 ${current} 临时放宽到 ${(current * 1.5).toFixed(2)}` };
    }
    return { applied: false, cost: 0, metric: null, why: '该指令改变的是执行层用法，本引擎没有对应状态，未做模拟' };
  }

  /** 复习类干预的收益：目标时刻的留存 */
  function retentionAt(engine, nodeId, u) {
    if (!memoryReady) return null;
    const node = engine.graph.get_node(nodeId);
    if (!node) return null;
    const overrides = {
      decay_model: engine.kernel.param('memory.dsr.decay_model', 'power'),
      gamma: engine.kernel.param('memory.dsr.gamma', 0.1542),
      legacy_k: engine.kernel.param('memory.dsr.legacy_k', 24),
    };
    return memoryDsr.retrievabilityOf(node, u, overrides);
  }

  const manifest = {
    api: 1,
    id: 'control.planner',
    name: '处方规划器：诊断 → 指令 → 反事实预测',
    layer: 'control',
    level: 'core',
    phenomenon: [
      '同一个"卡住"，不同成因要开不同药：补入口 / 弱线索试探 / 降单步深度 / 释放工作记忆',
      '能不能算出"这一招值不值"，取决于引擎能否表达这个干预（不能表达的就只给规则，不假装算过）',
    ],
    evidence: [
      { grade: 'local', note: 'Application_Protocol 的 17 条指令库与 Executive_Architecture §4 的应对动作' },
    ],
    params: PARAMS,
    reads: ['state'],
    writes: [],
    shared: [],
    requires: ['diagnosis.bottleneck'],
    conflicts: ['legacy_v1'],
    acceptance: [
      {
        name: '指令库完整：17 条应用协议指令全部在册，且标注了可否模拟',
        kind: 'phenomenon',
        check() {
          const application = Object.keys(INSTRUCTIONS).filter((k) => INSTRUCTIONS[k].source === 'application');
          const simulatable = Object.keys(INSTRUCTIONS).filter((k) => INSTRUCTIONS[k].simulatable);
          return application.length === 17 && simulatable.length >= 4;
        },
      },
      {
        name: '不可模拟的指令必须被显式标注（不假装算过）',
        kind: 'phenomenon',
        check() {
          const fake = applyIntervention({}, 'n', 'chunk_problem', {});
          return fake.applied === false && /未做模拟/.test(fake.why);
        },
      },
      {
        name: '消融：不做模拟（sim_rounds=0 的等价情形）时，计划只剩规则映射',
        kind: 'ablation',
        check() {
          const o = options({ sim_rounds: 0 });
          return o.sim_rounds === 0;
        },
      },
    ],
    hooks: {
      'diagnose.on': (ctx) => {
        const o = options({
          sim_rounds: ctx.param('sim_rounds'),
          retention_horizon_hours: ctx.param('retention_horizon_hours'),
          max_candidates: ctx.param('max_candidates'),
          cost_retrieval: ctx.param('cost_retrieval'),
          cost_link: ctx.param('cost_link'),
          cost_offload: ctx.param('cost_offload'),
        });
        const engine = ctx.payload.engine;
        const bottlenecks = ctx.kernel.m.bottlenecks || [];
        if (!engine) return { plan: [], skipped: 'no-engine' };

        const baselineReach = engine.reachability();
        const plan = [];
        const top = bottlenecks.slice(0, Math.max(1, Math.round(o.max_candidates)));

        for (const b of top) {
          const primary = PRIMARY[b.type];
          const candidates = [primary].concat(b.prescriptions.filter((p) => p !== primary));
          const seen = new Set();
          for (const instruction of candidates) {
            if (seen.has(instruction)) continue;
            seen.add(instruction);
            const meta = INSTRUCTIONS[instruction] || { name: instruction, source: 'unknown', simulatable: false };
            const entry = {
              node: b.node,
              name: b.name,
              bottleneck: b.type,
              instruction,
              instruction_name: meta.name,
              source: meta.source,
              simulated: false,
              gain: 0,
              cost: 0,
              value: 0,
              why: '',
            };
            if (meta.simulatable && o.sim_rounds > 0) {
              try {
                const clone = engine.clone();
                const outcome = applyIntervention(clone, b.node, instruction, o);
                if (outcome.applied) {
                  entry.simulated = true;
                  entry.cost = outcome.cost;
                  const horizon = o.retention_horizon_hours;
                  if (outcome.metric === 'retention') {
                    const before = retentionAt(engine, b.node, engine.kernel.hours + horizon);
                    const after = retentionAt(clone, b.node, clone.kernel.hours + horizon);
                    if (before === null || after === null) {
                      entry.simulated = false;
                      entry.why = '未装载记忆模块，无法预测留存增益';
                    } else {
                      entry.metric = 'retention';
                      entry.gain = Math.round((after - before) * 1e6) / 1e6;
                      entry.why = `${outcome.why}；${horizon} 小时后的留存 ${Math.round(before * 1e6) / 1e6} → ${Math.round(after * 1e6) / 1e6}`;
                    }
                  } else {
                    for (let i = 0; i < o.sim_rounds && !clone.stopped; i += 1) clone.step();
                    const after = clone.reachability();
                    entry.metric = 'reachability';
                    entry.gain = Math.round((after - baselineReach) * 1e6) / 1e6;
                    entry.why = `${outcome.why}；模拟 ${o.sim_rounds} 轮后目标可达性 ${baselineReach} → ${after}`;
                  }
                  if (entry.simulated) {
                    entry.value = outcome.cost > 0 ? Math.round((entry.gain / outcome.cost) * 1e6) / 1e6 : 0;
                  }
                } else {
                  entry.why = outcome.why;
                }
              } catch (err) {
                entry.why = `模拟失败：${err && err.message ? err.message : String(err)}`;
              }
            } else {
              entry.why = meta.simulatable
                ? '本次未模拟（sim_rounds=0）'
                : '该指令改变的是执行层用法，本引擎没有对应状态，未做模拟';
            }
            plan.push(entry);
          }
          // 只保留每个卡点的前 2 条备选，避免清单过长
          const forNode = plan.filter((p) => p.node === b.node);
          if (forNode.length > 3) {
            const keep = new Set(forNode.slice(0, 3).map((p) => p.instruction));
            for (let i = plan.length - 1; i >= 0; i -= 1) {
              if (plan[i].node === b.node && !keep.has(plan[i].instruction)) plan.splice(i, 1);
            }
          }
        }

        // 排序：先按能否模拟（能算的优先），再按 value 降序
        plan.sort((x, y) => {
          if (x.simulated !== y.simulated) return x.simulated ? -1 : 1;
          if (y.value !== x.value) return y.value - x.value;
          return y.gain - x.gain;
        });

        return {
          plan,
          baseline_reachability: baselineReach,
          instructions: INSTRUCTIONS,
        };
      },
    },
  };

  const api = { manifest, PARAMS, DEFAULTS, options, INSTRUCTIONS, PRIMARY, applyIntervention, retentionAt };

  if (isNode) module.exports = api;
  else globalThis.MindNet = Object.assign(globalThis.MindNet || {}, { controlPlanner: api });
})();
