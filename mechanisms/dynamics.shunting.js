/**
 * 机制模块：激活动力学（分流方程 + 亚阈累积）
 *
 * 对应 docs/MODEL_v2_MATH.md §4.2 / §4.3，方程直接沿用用户 Cognitive_Architecture §3.6：
 *   a ← clip( a + α·x·(1−a) − λ·a , 0, 1 )        （兴奋被 (1−a) 饱和，衰减线性）
 *   q ← clip( (1−λ_q)·q + η_q·a·1[a ≥ θ] , 0, q_max )   （未达意识但不丢弃）
 */
(function () {
  'use strict';

  const isNode = typeof module !== 'undefined' && !!module.exports;
  const deps = isNode ? Object.assign({}, require('../src/config.js')) : (globalThis.MindNet || {});
  const { MindNetError } = deps;

  const PARAMS = [
    { key: 'alpha_a', type: 'number', min: 0.001, max: 5, default: 0.5, unit: '-',
      desc: '驱动对激活的增益', evidence: '未标定（分流方程形式取自 Cognitive_Architecture §3.6）', calibrated: false },
    { key: 'lambda_a', type: 'number', min: 0, max: 1, default: 0.2, unit: '1/轮',
      desc: '每轮激活衰减（没有它就没有走神与淡出）', evidence: '未标定', calibrated: false },
    { key: 'eta_q', type: 'number', min: 0, max: 2, default: 0.5, unit: '1/轮',
      desc: '亚阈累积速率', evidence: '未标定（Application_Protocol §17「亚阈积累」）', calibrated: false },
    { key: 'lambda_q', type: 'number', min: 0, max: 1, default: 0.3, unit: '1/轮',
      desc: '亚阈累积的衰减', evidence: '未标定', calibrated: false },
  ];
  const DEFAULTS = PARAMS.reduce((a, p) => { a[p.key] = p.default; return a; }, {});

  function options(o) {
    return Object.assign({}, DEFAULTS, o || {});
  }

  /**
   * 纯函数：一次激活更新。
   *
   * 连续方程（Cognitive_Architecture §3.6）：da/dt = α·x·(1−a) − λ·a
   * 离散实现用**精确积分**而不是显式欧拉步：
   *     k = α·x + λ ,  a* = α·x/k ,  a₁ = a* + (a − a*)·e^(−k·availability)
   * 两个要点：
   *   1. 显式步长在强驱动下会越界振荡（实测 x=100 时在 1 与 0.8 之间来回跳）；
   *      精确积分对任意 x 都单调收敛，且不需要额外参数。
   *   2. `availability` 是这一轮「在」的时间比例：只有一半时间是清醒的，
   *      等价于方程只积分了一半时间 —— 这正是节律门控影响动力学的通道。
   */
  function updateActivation(a, q, drive, theta, o, availability) {
    const opt = options(o);
    const av = availability === undefined ? 1 : Math.max(0, Math.min(1, availability));
    const x = Math.max(0, drive);
    const k = opt.alpha_a * x + opt.lambda_a;
    const aStar = k > 0 ? (opt.alpha_a * x) / k : 0;
    const a1 = Math.min(1, Math.max(0, k > 0 ? aStar + (a - aStar) * Math.exp(-k * av) : a));
    const add = a1 >= theta ? opt.eta_q * a1 : 0;
    const q1 = Math.min(1, Math.max(0, (1 - opt.lambda_q) * q + add));
    return { a: a1, q: q1, aStar, k };
  }

  /**
   * 纯函数：亚阈累积（在状态落定**之后**跑，才能区分「进了意识」与「没进」）。
   *   - 已进入意识：没有「待补」，累加器清零
   *   - 未进意识但超过联想阈值：继续积累（不丢弃）
   *   - 低于联想阈值：缓慢消退
   * 早期版本在激活更新时就累加（不看是否进了意识），结果每个活跃节点都会把
   * 累加器灌到上界 1，驱动被累加器淹没 —— 这是实现时实测出来的错误。
   */
  function updateSubthreshold(q, a, theta, conscious, o) {
    const opt = options(o);
    if (conscious) return 0;
    if (a >= theta) return Math.min(1, Math.max(0, (1 - opt.lambda_q) * q + opt.eta_q * a));
    return Math.min(1, Math.max(0, (1 - opt.lambda_q) * q));
  }

  const manifest = {
    api: 1,
    id: 'dynamics.shunting',
    name: '激活动力学：分流方程 + 亚阈累积',
    layer: 'attention',
    level: 'core',
    phenomenon: [
      '激活会饱和：线索再强，一个节点的激活也趋近上界而不是无限增长',
      '激活会衰减：没有持续输入时念头会淡出（这正是「走神 / 想不起来」的前提）',
      '亚阈激活不丢弃：想不起来的东西仍在后台累积，下一轮更容易被拉起来',
    ],
    evidence: [
      { grade: 'local', note: 'Cognitive_Architecture.md §3.6 的分流方程；§3.4 的多层阈值与亚阈激活' },
      { grade: 'local', note: 'Application_Protocol.md §17「亚阈积累：只记录、不评价、定期回看」' },
    ],
    params: PARAMS,
    reads: ['state'],
    writes: [],
    shared: ['a', 'q'],
    requires: [],
    conflicts: [],
    acceptance: [
      {
        name: '饱和：驱动极大时激活单调收敛到上界，不振荡、不越界',
        kind: 'phenomenon',
        check() {
          let a = 0; let q = 0; let prev = -1; let monotone = true;
          for (let i = 0; i < 50; i += 1) {
            const r = updateActivation(a, q, 100, 0.05);
            if (r.a < prev - 1e-12) monotone = false;
            prev = r.a;
            a = r.a; q = r.q;
          }
          return monotone && a <= 1 && a > 0.99;
        },
      },
      {
        name: '衰减：无输入时激活单调下降',
        kind: 'phenomenon',
        check() {
          let a = 1;
          let prev = a;
          for (let i = 0; i < 5; i += 1) {
            a = updateActivation(a, 0, 0, 0.05).a;
            if (a >= prev) return false;
            prev = a;
          }
          return a < 0.5;
        },
      },
      {
        name: '亚阈累积：没进意识的才积累，进了意识的清零',
        kind: 'phenomenon',
        check() {
          const notConscious = updateSubthreshold(0, 0.9, 0.5, false);
          const conscious = updateSubthreshold(0.5, 0.9, 0.5, true);
          const belowTheta = updateSubthreshold(0.4, 0.1, 0.5, false);
          return notConscious > 0 && conscious === 0 && belowTheta < 0.4;
        },
      },
      {
        name: '节律通道：availability=0 时激活不再更新（不在状态就不推进）',
        kind: 'phenomenon',
        check() {
          const awake = updateActivation(0, 0, 0.8, 0.05, {}, 1);
          const dark = updateActivation(0, 0, 0.8, 0.05, {}, 0);
          return awake.a > 0.2 && dark.a === 0;
        },
      },
      {
        name: '消融：α→0 且 λ=0 时激活基本不变（静态场）',
        kind: 'ablation',
        check() {
          const r = updateActivation(0.4, 0, 5, 0.05, { alpha_a: 0.001, lambda_a: 0 });
          return Math.abs(r.a - 0.4) < 0.01;
        },
      },
    ],
    hooks: {
      'activation.update': (ctx) => {
        const o = options({
          alpha_a: ctx.param('alpha_a'),
          lambda_a: ctx.param('lambda_a'),
          eta_q: ctx.param('eta_q'),
          lambda_q: ctx.param('lambda_q'),
        });
        const availability = ctx.payload.availability === undefined ? 1 : ctx.payload.availability;
        const next = new Map();
        for (const node of ctx.nodes()) {
          const c = ctx.shared(node.id);
          const drive = ctx.payload.drive ? ctx.payload.drive.get(node.id) || 0 : 0;
          const r = updateActivation(c.a, c.q, drive, node.st_of(ctx.config), o, availability);
          next.set(node.id, r.a);
          ctx.patchShared(node.id, { a: r.a });
        }
        ctx.payload.next = next;
        return { updated: next.size, availability };
      },
      // 亚阈累积：在状态落定之后（能区分「进了意识」与「没进」）
      'state.after': (ctx) => {
        const o = options({
          eta_q: ctx.param('eta_q'),
          lambda_q: ctx.param('lambda_q'),
        });
        let pending = 0;
        for (const node of ctx.nodes()) {
          const c = ctx.shared(node.id);
          const q = updateSubthreshold(c.q, c.a, node.st_of(ctx.config), node.state === 'CONSCIOUS', o);
          if (q > 0) pending += 1;
          ctx.patchShared(node.id, { q });
        }
        return { pending };
      },
    },
  };

  const api = { manifest, PARAMS, DEFAULTS, options, updateActivation, updateSubthreshold };

  if (isNode) module.exports = api;
  else globalThis.MindNet = Object.assign(globalThis.MindNet || {}, { dynamicsShunting: api });
})();
