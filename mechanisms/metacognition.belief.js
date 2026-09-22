/**
 * 机制模块：元认知自信度（判断自己会不会）
 *
 * 对应 docs/MODEL_v2_MATH.md §6。核心设计是**故意的偏差**：
 *   b_v = σ( w_f·流畅度 + w_r·R0_v + w_e·近因 − b0 )
 * 只看「最近看得顺不顺」（激活的滑动平均）、编码强度 R0、以及"上一次亮是什么时候"，
 * **刻意不看 S（稳定度）与复习历史**。
 *
 * 依据：把 5 次集中学习 + 1 次复习 与 1 次 + 5 次对比，最终回忆率相同，
 *       但前者自信显著更高（Metcalfe & Finn 2008，Metcalfe 2009 综述，本次取到全文）。
 *       自信跟着流畅度走，不跟着真实记忆强度走 —— 这就是"看懂了 ≠ 会做"的来源。
 *
 * 输出（写进内核级 store 的 `metacognition` 键，供其它模块读取）：
 *   危险区（高自信 × 低可提取）、焦虑区（低自信 × 高可提取）、校准度。
 */
(function () {
  'use strict';

  const isNode = typeof module !== 'undefined' && !!module.exports;
  const deps = isNode ? Object.assign({}, require('../src/config.js')) : (globalThis.MindNet || {});
  const { MindNetError } = deps;

  const PARAMS = [
    { key: 'w_fluency', type: 'number', min: 0, max: 4, default: 1.5, unit: '-',
      desc: '流畅度（近期激活）对自信的权重',
      evidence: '未标定；方向来自 Metcalfe 2009 的流畅性错觉。取值需让"集中重复"产生可见的自信差（实测 0.5 时差异被 sigmoid 压到 0.03，几乎看不见）', calibrated: false },
    { key: 'w_encoding', type: 'number', min: 0, max: 4, default: 0.8, unit: '-',
      desc: '编码强度 R0 对自信的权重', evidence: '未标定', calibrated: false },
    { key: 'w_recency', type: 'number', min: 0, max: 4, default: 0.8, unit: '-',
      desc: '「上次亮到现在多久」对自信的权重', evidence: '未标定', calibrated: false },
    { key: 'tau_recency_hours', type: 'number', min: 0.1, max: 240, default: 6, unit: '小时',
      desc: '近因的时间常数', evidence: '未标定', calibrated: false },
    { key: 'b0', type: 'number', min: -4, max: 4, default: 1.5, unit: '-',
      desc: '自信的偏置（越大越自信）', evidence: '未标定', calibrated: false },
    { key: 'delta', type: 'number', min: 0.01, max: 1, default: 0.2, unit: '-',
      desc: '判定「危险区 / 焦虑区」的显著差阈值', evidence: '未标定', calibrated: false },
  ];
  const DEFAULTS = PARAMS.reduce((a, p) => { a[p.key] = p.default; return a; }, {});

  function options(o) {
    return Object.assign({}, DEFAULTS, o || {});
  }

  function sigmoid(x) {
    if (x >= 0) return 1 / (1 + Math.exp(-x));
    const e = Math.exp(x);
    return e / (1 + e);
  }

  /** 纯函数：自信度 */
  function beliefOf(fluency, R0, recencyHours, o) {
    const opt = options(o);
    const recency = Math.exp(-Math.max(0, recencyHours) / opt.tau_recency_hours);
    const z = opt.w_fluency * fluency + opt.w_encoding * (R0 === null ? 0.5 : R0)
      + opt.w_recency * recency - opt.b0;
    return sigmoid(z);
  }

  const manifest = {
    api: 1,
    id: 'metacognition.belief',
    name: '元认知自信度：流畅性驱动的"我会不会"',
    layer: 'metacognition',
    level: 'core',
    phenomenon: [
      '看得顺 ≠ 记得住：集中重复会抬高"感觉会了"，但不提高长期可提取性',
      '危险区：自信高而实际想不起来 —— 学生最可能跳过、最该练的地方',
      '焦虑区：其实会，但不敢用',
    ],
    evidence: [
      { grade: 'read', url: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC2742428/',
        note: 'Metcalfe 2009：JOL 与流畅性、5-1/1-5 错觉、学习区（本次取到全文）' },
    ],
    params: PARAMS,
    reads: ['state', 'ms'],
    writes: ['fluency', 'lastConscious'],
    shared: [],
    requires: [],
    conflicts: ['legacy_v1'],
    acceptance: [
      {
        name: '自信跟流畅度走：流畅度高 → 自信高（同编码强度、同近因）',
        kind: 'phenomenon',
        check() {
          const low = beliefOf(0.1, 0.8, 0);
          const high = beliefOf(0.9, 0.8, 0);
          return high > low;
        },
      },
      {
        name: '自信不看记忆强度：只改 S 不影响自信（S 根本不在公式里）',
        kind: 'phenomenon',
        check() {
          const a = beliefOf(0.5, 0.8, 1);
          const b = beliefOf(0.5, 0.8, 1);
          return a === b;
        },
      },
      {
        name: '近因：刚看过时自信更高，隔久了下降',
        kind: 'phenomenon',
        check() {
          const fresh = beliefOf(0.5, 0.8, 0);
          const stale = beliefOf(0.5, 0.8, 24);
          return fresh > stale;
        },
      },
      {
        name: '消融：去掉流畅度项（w_f=0）后，集中重复不再抬高自信',
        kind: 'ablation',
        check() {
          const off = options({ w_fluency: 0 });
          return beliefOf(0.95, 0.8, 0, off) === beliefOf(0.05, 0.8, 0, off);
        },
      },
    ],
    hooks: {
      'state.after': (ctx) => {
        const beta = 0.4; // 滑动平均步长（写死：它是"最近几轮"的定义，不是可调机制参数）
        for (const node of ctx.nodes()) {
          const bag = ctx.data(node.id);
          const a = ctx.shared(node.id).a;
          const ema = bag.fluency === undefined ? a : bag.fluency * (1 - beta) + a * beta;
          if (node.state === 'CONSCIOUS') bag.lastConscious = ctx.hours;
          ctx.patch(node.id, {
            fluency: ema,
            lastConscious: bag.lastConscious === undefined ? null : bag.lastConscious,
          });
        }
        return { updated: ctx.nodes().length };
      },
      'diagnose.on': (ctx) => {
        const o = options({
          w_fluency: ctx.param('w_fluency'),
          w_encoding: ctx.param('w_encoding'),
          w_recency: ctx.param('w_recency'),
          tau_recency_hours: ctx.param('tau_recency_hours'),
          b0: ctx.param('b0'),
          delta: ctx.param('delta'),
        });
        const facts = ctx.payload.facts || {};
        const rows = [];
        const danger = [];
        const anxiety = [];
        let errorSum = 0;
        let counted = 0;
        for (const node of ctx.nodes()) {
          const f = facts[node.id];
          if (!f || f.is_start) continue;
          const bag = ctx.data(node.id);
          const last = bag.lastConscious === undefined || bag.lastConscious === null
            ? Infinity
            : ctx.hours - bag.lastConscious;
          const b = beliefOf(bag.fluency === undefined ? f.a : bag.fluency, f.R0, last, o);
          const R = f.R;
          const gap = b - R;
          const row = { node: node.id, name: node.name, belief: Math.round(b * 1e6) / 1e6, R, diff: Math.round(gap * 1e6) / 1e6 };
          rows.push(row);
          if (gap > o.delta) danger.push(row);
          if (-gap > o.delta) anxiety.push(row);
          errorSum += Math.abs(gap);
          counted += 1;
        }
        danger.sort((x, y) => y.diff - x.diff);
        anxiety.sort((x, y) => x.diff - y.diff);
        const metacognition = {
          danger,
          anxiety,
          calibration: counted ? Math.round((errorSum / counted) * 1e6) / 1e6 : 0,
          rows,
        };
        // 发布到内核级 store：控制层模块（规划器）要读它
        ctx.kernel.m.metacognition = metacognition;
        return { metacognition };
      },
    },
  };

  const api = { manifest, PARAMS, DEFAULTS, options, beliefOf, sigmoid };

  if (isNode) module.exports = api;
  else globalThis.MindNet = Object.assign(globalThis.MindNet || {}, { metacognitionBelief: api });
})();
