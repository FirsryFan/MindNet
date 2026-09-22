/**
 * 机制模块：卡点诊断（把"没想起来"分成五类）
 *
 * 对应 docs/MODEL_v2_MATH.md §7.1，分类口径直接沿用用户的 Executive_Architecture：
 *   §4.2 检索失败三型：空（没候选）/ 慢（等太久）/ 容量太大（候选过多）
 *   §4.3 初筛错：没想清楚就下结论
 * 再加两类本模型特有的：
 *   overload —— 会，但被容量挤出去（**不是知识缺口**）
 *   danger   —— 元认知危险区（自信高、实际想不起来）
 *
 * 每类给不同的处方：这正是 v1.1 做不到的事（它把所有失败都算进 visit_count）。
 */
(function () {
  'use strict';

  const isNode = typeof module !== 'undefined' && !!module.exports;
  const deps = isNode ? Object.assign({}, require('../src/config.js')) : (globalThis.MindNet || {});
  const { MindNetError } = deps;

  const PARAMS = [
    { key: 'closeness_weak', type: 'number', min: 0, max: 1, default: 0.6, unit: '-',
      desc: '「差点想起来」的下界：驱动达到意识阈值的这个比例才算弱，否则算空',
      evidence: '未标定', calibrated: false },
    { key: 'slow_rounds', type: 'number', min: 1, max: 50, default: 3, unit: '轮',
      desc: '目标激活超过这么多轮才算「慢」', evidence: '未标定', calibrated: false },
    { key: 'severity_weight', type: 'number', min: 0, max: 5, default: 1.0, unit: '-',
      desc: '严重度里节点重要性的权重', evidence: '未标定', calibrated: false },
  ];
  const DEFAULTS = PARAMS.reduce((a, p) => { a[p.key] = p.default; return a; }, {});

  function options(o) {
    return Object.assign({}, DEFAULTS, o || {});
  }

  /** 处方表：卡点 → 指令 id（指令库见 control.planner） */
  const PRESCRIPTION = {
    empty: ['add_in_edges', 'add_connection_types', 'lower_threshold', 'support_subthreshold'],
    weak: ['lower_threshold', 'strengthen_impression', 'interval_retrieval'],
    slow: ['reduce_step_depth', 'high_freq_light_task', 'commit_temp_links'],
    overload: ['offload_working_memory', 'chunk_problem', 'capture_thought'],
    off_goal: ['correct_error', 'commit_temp_links', 'boost_clarity'],
    danger: ['interval_retrieval', 'boost_random_access', 'strengthen_impression'],
    dead_end: ['add_out_edges', 'add_relation_types'],
  };

  const TYPE_LABEL = {
    empty: '空（没有候选 / 缺入口）',
    weak: '弱（差点想起来）',
    slow: '慢（频率不够）',
    overload: '超载（会，但被容量挤出去）',
    off_goal: '初筛错 / 跑偏（亮了但与目标无关）',
    danger: '危险区（自信高、实际想不起来）',
    dead_end: '死路（没有出边，想到了也走不下去）',
  };

  /** 纯函数：分类（测试与演示都用它，保证与槽位实现同一口径） */
  function classify(fact, o) {
    const opt = options(o);
    if (!fact || fact.is_start) return null;
    if (fact.outcompeted && fact.score >= fact.ct) {
      return { type: 'overload', subtype: null, closeness: null, note: '进了候选但被容量挤出，不是知识缺口', also: [] };
    }
    if (fact.in_degree === 0) {
      return { type: 'empty', subtype: 'no_entry', closeness: 0, note: '没有任何入边，线索再多也传不进来', also: [] };
    }
    const also = [];
    if (fact.is_target && fact.first_activation_round !== null && fact.first_activation_round > opt.slow_rounds) {
      also.push('slow');
    }
    // 未进入意识的所有情形统一处理：
    //   没点亮过（线索传不进来）/ 只到潜意识 / 曾点亮但已回落（概率点火 + 容量竞争的常态）
    if (fact.state !== 'CONSCIOUS') {
      const strength = Math.max(fact.score || 0, fact.peak_drive || 0);
      const closeness = fact.ct > 0 ? strength / fact.ct : 0;
      if (closeness >= opt.closeness_weak) {
        return {
          type: 'weak', subtype: null, closeness, also,
          note: `已到阈值的 ${(closeness * 100).toFixed(0)}%${fact.ever_activated ? '（曾点亮、已回落）' : ''}，但没过线`,
        };
      }
      return {
        type: 'empty', subtype: 'too_faint', closeness, also,
        note: `线索太弱：峰值只有阈值的 ${(closeness * 100).toFixed(0)}%${fact.ever_activated ? '（曾点亮）' : ''}`,
      };
    }
    if (also.indexOf('slow') >= 0) {
      return { type: 'slow', subtype: null, closeness: null, note: `第 ${fact.first_activation_round} 轮才亮`, also: [] };
    }
    if (!fact.is_target && fact.reaches_goal === false) {
      return { type: 'off_goal', subtype: null, closeness: null, note: '亮了，但走不到任何目标（跑偏分支）', also: [] };
    }
    if (fact.out_degree === 0 && !fact.is_target) {
      return { type: 'dead_end', subtype: null, closeness: null, note: '没有出边', also: [] };
    }
    return null;
  }

  const manifest = {
    api: 1,
    id: 'diagnosis.bottleneck',
    name: '卡点诊断：空 / 弱 / 慢 / 超载 / 初筛错 / 危险区',
    layer: 'control',
    level: 'core',
    phenomenon: [
      '卡住的原因不止一种：没入口、差点想起、频率不够、被挤出去、跑偏 —— 处方完全不同',
      '把「会但被挤出去」误判成「不会」，会让学生白练已经会的东西',
    ],
    evidence: [
      { grade: 'local', note: 'Executive_Architecture §4.2（空/慢/容量太大）与 §4.3（初筛错）' },
      { grade: 'local', note: 'Application_Protocol 的 17 条指令库（处方来源）' },
    ],
    params: PARAMS,
    reads: ['state'],
    writes: [],
    shared: [],
    requires: [],
    conflicts: ['legacy_v1'],
    acceptance: [
      {
        name: '分类：四类构造事实各归各位',
        kind: 'phenomenon',
        check() {
          const base = { is_start: false, ct: 0.3, st: 0.05, score: 0, peak_drive: 0, in_degree: 1, out_degree: 1, ever_activated: false, is_target: false, activated_at_round: null, outcompeted: false, state: 'INACTIVE' };
          const overload = classify(Object.assign({}, base, { outcompeted: true, score: 0.4 }));
          const empty = classify(Object.assign({}, base, { in_degree: 0 }));
          const weak = classify(Object.assign({}, base, { peak_drive: 0.25 }));
          const emptyLow = classify(Object.assign({}, base, { peak_drive: 0.05 }));
          return overload.type === 'overload' && empty.type === 'empty' && weak.type === 'weak' && emptyLow.type === 'empty';
        },
      },
      {
        name: '超载 ≠ 知识缺口：它拿到的处方不包含"补前驱/加边"',
        kind: 'phenomenon',
        check() {
          const p = PRESCRIPTION.overload;
          return p.indexOf('add_in_edges') < 0 && p.indexOf('offload_working_memory') >= 0;
        },
      },
      {
        name: '消融：把弱判定阈值设成 1.0 时，"差点想起来"不再被单独识别',
        kind: 'ablation',
        check() {
          const base = { is_start: false, ct: 0.3, st: 0.05, score: 0, peak_drive: 0.25, in_degree: 1, out_degree: 1, ever_activated: false, is_target: false, activated_at_round: null, outcompeted: false, state: 'INACTIVE' };
          const normal = classify(base, {});
          const strict = classify(base, { closeness_weak: 1.0 });
          return normal.type === 'weak' && strict.type === 'empty';
        },
      },
    ],
    hooks: {
      'diagnose.on': (ctx) => {
        const o = options({
          closeness_weak: ctx.param('closeness_weak'),
          slow_rounds: ctx.param('slow_rounds'),
          severity_weight: ctx.param('severity_weight'),
        });
        const facts = ctx.payload.facts || {};
        const targets = ctx.payload.targets || [];

        // 到目标的可达性（有向）：用来判断"跑偏"。
        // 注意：没有目标时"跑偏"没有意义 —— 这时 reaches_goal 记为 null 而不是 false。
        const reach = reachableToTargets(ctx.graph, targets);
        const hasTargets = targets.length > 0;

        const bottlenecks = [];
        for (const node of ctx.nodes()) {
          const fact = facts[node.id];
          if (!fact) continue;
          const enriched = Object.assign({}, fact, {
            reaches_goal: hasTargets ? reach.get(node.id) === true : null,
          });
          const verdict = classify(enriched, o);
          if (!verdict) continue;
          const deficit = verdict.type === 'overload'
            ? 0.5
            : Math.max(0.05, 1 - (verdict.closeness === null ? 0.5 : verdict.closeness));
          bottlenecks.push({
            node: node.id,
            name: node.name,
            type: verdict.type,
            subtype: verdict.subtype || null,
            also: verdict.also || [],
            label: TYPE_LABEL[verdict.type] + (verdict.subtype === 'too_faint' ? '（线索太弱）' : verdict.subtype === 'no_entry' ? '（没有入口）' : ''),
            closeness: verdict.closeness,
            note: verdict.note,
            severity: Math.round(node.weight * deficit * o.severity_weight * 1e6) / 1e6,
            prescriptions: PRESCRIPTION[verdict.type].slice(),
            evidence: {
              state: fact.state,
              peak_drive: fact.peak_drive,
              ct: fact.ct,
              st: fact.st,
              in_degree: fact.in_degree,
              out_degree: fact.out_degree,
              outcompeted: fact.outcompeted,
              weight: node.weight,
            },
          });
        }

        // 元认知危险区并进诊断（由 metacognition.belief 发布到内核 store）
        const meta = ctx.kernel.m.metacognition;
        if (meta && Array.isArray(meta.danger)) {
          for (const row of meta.danger) {
            const node = ctx.node(row.node);
            if (!node) continue;
            if (bottlenecks.some((b) => b.node === row.node && b.type === 'danger')) continue;
            bottlenecks.push({
              node: row.node,
              name: row.name,
              type: 'danger',
              label: TYPE_LABEL.danger,
              closeness: null,
              note: `自信 ${row.belief} 而实际可提取度只有 ${row.R}`,
              severity: Math.round(node.weight * Math.max(0.05, row.diff) * o.severity_weight * 1e6) / 1e6,
              prescriptions: PRESCRIPTION.danger.slice(),
              evidence: { belief: row.belief, R: row.R, diff: row.diff },
            });
          }
        }

        bottlenecks.sort((a, b) => b.severity - a.severity);
        // 发布到内核级 store：控制层（处方规划器）要读它
        ctx.kernel.m.bottlenecks = bottlenecks;
        return { bottlenecks };
      },
    },
  };

  /** 反向可达：哪些节点能沿出边走到某个目标 */
  function reachableToTargets(graph, targets) {
    const ok = new Map();
    const queue = [];
    for (const t of targets) {
      if (!graph.has_node(t)) continue;
      ok.set(t, true);
      queue.push(t);
    }
    for (let head = 0; head < queue.length; head += 1) {
      const cur = queue[head];
      for (const e of graph.in_edges(cur)) {
        if (ok.get(e.from)) continue;
        ok.set(e.from, true);
        queue.push(e.from);
      }
    }
    return ok;
  }

  const api = { manifest, PARAMS, DEFAULTS, options, classify, PRESCRIPTION, TYPE_LABEL, reachableToTargets };

  if (isNode) module.exports = api;
  else globalThis.MindNet = Object.assign(globalThis.MindNet || {}, { diagnosisBottleneck: api });
})();
