/**
 * 机制模块：节律门控（在 / 不在）与负荷自适应节拍
 *
 * 对应 docs/MODEL_v2_MATH.md §5。它回答用户提的那件事：
 *   「一秒钟半秒在思考、半秒不在，导致不能沉浸、激发不出全部潜能」
 *
 * 三种门（择一）：
 *   duty   —— 固定占空比方波（最好懂，默认）
 *   markov —— 两态马尔可夫（专注 ⇄ 走神，表达「不由自主地走神」）
 *   theta  —— θ 节律采样（需要把 tick_ms 调细，否则会混叠）
 * 另外两个调制：
 *   警觉衰减：连续在任务时间越长，「在」的窗口越短
 *   负荷自适应：脑子里装得越满，一个思维周期越长（信息一多就转不动）
 */
(function () {
  'use strict';

  const isNode = typeof module !== 'undefined' && !!module.exports;
  const deps = isNode ? Object.assign({}, require('../src/config.js')) : (globalThis.MindNet || {});
  const { MindNetError } = deps;

  const PARAMS = [
    { key: 'mode', type: 'enum', options: ['duty', 'markov', 'theta'], default: 'duty', unit: '-',
      desc: '门控模式：占空比 / 走神马尔可夫 / θ 节律', evidence: '未标定（三种都是候选机制）', calibrated: false },
    { key: 'T0_seconds', type: 'number', min: 0.05, max: 60, default: 1.0, unit: '秒',
      desc: '基准思维周期长度', evidence: '未标定', calibrated: false },
    { key: 'tick_ms', type: 'number', min: 5, max: 1000, default: 250, unit: '毫秒',
      desc: '一个 tick 的时长（决定节律的时间分辨率）', evidence: '未标定', calibrated: false },
    { key: 'duty', type: 'number', min: 0.05, max: 1, default: 0.5, unit: '-',
      desc: '占空比：一个周期里「在」的比例（0.5 = 半秒在）', evidence: '用户口述的现象', calibrated: false },
    { key: 'p_off', type: 'number', min: 0, max: 1, default: 0.02, unit: '1/tick',
      desc: 'markov 模式：从专注转入走神的概率', evidence: '未标定', calibrated: false },
    { key: 'p_on', type: 'number', min: 0, max: 1, default: 0.08, unit: '1/tick',
      desc: 'markov 模式：从走神转回专注的概率', evidence: '未标定', calibrated: false },
    { key: 'lambda_load', type: 'number', min: 0, max: 5, default: 1.0, unit: '-',
      desc: '负荷对节拍长度的拉伸系数', evidence: '未标定（负荷升高 → θ 频率下移，PMC4500897）', calibrated: false },
    { key: 'tau_vig_minutes', type: 'number', min: 1, max: 600, default: 20, unit: '分钟',
      desc: '警觉衰减时间常数', evidence: '未标定', calibrated: false },
  ];
  const DEFAULTS = PARAMS.reduce((a, p) => { a[p.key] = p.default; return a; }, {});

  function options(o) {
    return Object.assign({}, DEFAULTS, o || {});
  }

  /** 一个周期有多少 tick（负荷自适应：装得越满，周期越长） */
  function cycleTicksFor(load, o) {
    const opt = options(o);
    const ref = 4; // 直接访问区基准容量
    const seconds = opt.T0_seconds * (1 + opt.lambda_load * (load / ref));
    return Math.max(1, Math.round((seconds * 1000) / opt.tick_ms));
  }

  /** 一个周期里有多少个 tick 是「在」的（警觉衰减会压缩窗口） */
  function openCountFor(cycle, vig, o) {
    const opt = options(o);
    if (opt.mode === 'markov') return cycle; // markov 由状态机决定，不走这个函数
    const want = Math.round(opt.duty * Math.max(0, Math.min(1, vig)) * cycle);
    return Math.max(0, Math.min(cycle, want));
  }

  /** 纯函数：给出一个周期的开/关计划（便于测试与解释） */
  function planFor(o, vig) {
    const opt = options(o);
    const cycle = cycleTicksFor(0, opt);
    const open = openCountFor(cycle, vig === undefined ? 1 : vig, opt);
    return Array.from({ length: cycle }, (_, i) => i < open);
  }

  const manifest = {
    api: 1,
    id: 'rhythm.gate',
    name: '节律门控：占空比 / 走神 / 负荷自适应节拍',
    layer: 'rhythm',
    level: 'core',
    phenomenon: [
      '思维不是连续在线的：有「在」和「不在」的时间结构（用户口述：一秒里半秒在）',
      '连续在任务上越久，在的时间越短（警觉衰减）',
      '脑子里装得越满，一个思维周期越长（信息一多就转不动）',
    ],
    evidence: [
      { grade: 'read', url: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC4500897/',
        note: '工作记忆负荷升高时 θ 频率下移（Jensen & Tesche 2002；Axmacher et al. 2010 的综述转述）' },
      { grade: 'read', url: 'https://www.eurekalert.org/news-releases/811445',
        note: '清醒时间约 46.9% 在想与当前活动无关的事（Killingsworth & Gilbert 2010）' },
      { grade: 'local', note: 'Executive_Architecture §2「思维频率」与 §2.3 的三种失配' },
    ],
    params: PARAMS,
    reads: ['state'],
    writes: [],
    shared: [],
    requires: [],
    conflicts: ['legacy_v1'],
    acceptance: [
      {
        name: '占空比：T=1s、tick=250ms、d=0.5 ⇒ 一个周期 4 个 tick 里恰好 2 个「在」',
        kind: 'phenomenon',
        check() {
          const plan = planFor({ T0_seconds: 1, tick_ms: 250, duty: 0.5 }, 1);
          return plan.length === 4 && plan.filter(Boolean).length === 2;
        },
      },
      {
        name: '负荷自适应：装得越满，周期越长（0 → 4 时 1.00 → 2.00 秒）',
        kind: 'phenomenon',
        check() {
          const o = { T0_seconds: 1, tick_ms: 250, lambda_load: 1 };
          const empty = cycleTicksFor(0, o);
          const full = cycleTicksFor(4, o);
          return empty === 4 && full === 8 && full > empty;
        },
      },
      {
        name: '警觉衰减：vig=0.5 时「在」的窗口收缩一半；vig=0 时完全不在',
        kind: 'phenomenon',
        check() {
          const o = { T0_seconds: 1, tick_ms: 250, duty: 0.5 };
          const half = planFor(o, 0.5).filter(Boolean).length;
          const zero = planFor(o, 0).filter(Boolean).length;
          return half === 1 && zero === 0;
        },
      },
      {
        name: '消融：duty=1 时没有任何「不在」的 tick（等价于关掉这个机制）',
        kind: 'ablation',
        check() {
          const plan = planFor({ T0_seconds: 1, tick_ms: 250, duty: 1 }, 1);
          return plan.every(Boolean);
        },
      },
    ],
    hooks: {
      'round.before': (ctx) => {
        const o = options({
          mode: ctx.param('mode'),
          T0_seconds: ctx.param('T0_seconds'),
          tick_ms: ctx.param('tick_ms'),
          duty: ctx.param('duty'),
          p_off: ctx.param('p_off'),
          p_on: ctx.param('p_on'),
          lambda_load: ctx.param('lambda_load'),
          tau_vig_minutes: ctx.param('tau_vig_minutes'),
        });
        const store = ctx.store();
        if (store.on === undefined) store.on = true;
        if (store.onMinutes === undefined) store.onMinutes = 0;

        // θ 模式的混叠提醒（只在第一次说一遍）
        if (o.mode === 'theta' && !store.warned && 6 > 0.5 / (o.tick_ms / 1000)) {
          ctx.log(`θ 模式在 tick_ms=${o.tick_ms} 下会有混叠：可表示的频率上限是 ${(0.5 / (o.tick_ms / 1000)).toFixed(1)} Hz，建议把 tick_ms 调到 ≤ 80ms`);
          store.warned = true;
        }

        const load = ctx.nodes().reduce(
          (sum, n) => sum + (ctx.shared(n.id).a >= n.st_of(ctx.config) ? ctx.shared(n.id).a : 0),
          0
        );
        const cycle = o.mode === 'markov'
          ? Math.max(1, Math.round((o.T0_seconds * 1000) / o.tick_ms))
          : cycleTicksFor(load, o);
        const vig = Math.exp(-store.onMinutes / o.tau_vig_minutes);
        ctx.payload.cycleTicks = cycle;
        ctx.payload.rhythm = { mode: o.mode, cycle, load, vigilance: vig, openPlan: openCountFor(cycle, vig, o) };
        return { cycle, load, vigilance: vig };
      },
      'tick.before': (ctx) => {
        const o = options({ mode: ctx.param('mode'), tick_ms: ctx.param('tick_ms'), p_off: ctx.param('p_off'), p_on: ctx.param('p_on'), tau_vig_minutes: ctx.param('tau_vig_minutes') });
        const store = ctx.store();
        store.onMinutes = (store.onMinutes || 0) + o.tick_ms / 60000;
        if (o.mode === 'markov') {
          const r = ctx.rng();
          store.on = store.on ? !(r < o.p_off) : r < o.p_on;
        }
        return { on: store.on, onMinutes: store.onMinutes };
      },
      'tick.gate': (ctx) => {
        const o = options({
          mode: ctx.param('mode'),
          T0_seconds: ctx.param('T0_seconds'),
          tick_ms: ctx.param('tick_ms'),
          duty: ctx.param('duty'),
          tau_vig_minutes: ctx.param('tau_vig_minutes'),
        });
        const store = ctx.store();
        const vig = Math.exp(-(store.onMinutes || 0) / o.tau_vig_minutes);
        if (o.mode === 'markov') {
          return store.on ? undefined : { block: true, reason: 'mind_wandering' };
        }
        const cycle = Math.max(1, Math.round((o.T0_seconds * 1000) / o.tick_ms));
        const open = openCountFor(cycle, vig, o);
        const phase = ((ctx.tick - 1) % cycle);
        if (phase < open) return undefined;
        return { block: true, reason: vig < 0.5 ? 'vigilance_low' : 'off_phase' };
      },
    },
  };

  const api = { manifest, PARAMS, DEFAULTS, options, cycleTicksFor, openCountFor, planFor };

  if (isNode) module.exports = api;
  else globalThis.MindNet = Object.assign(globalThis.MindNet || {}, { rhythmGate: api });
})();
