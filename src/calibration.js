/**
 * MindNet 参数标定：估计器（纯函数，零依赖，Node 与浏览器共用）
 *
 * 设计原则（对应 docs/CALIBRATION.md）：
 *   1. 每个估计器只吃"学生能真的做出来的数据"，输出一个参数值；
 *   2. 能闭式解的绝不迭代（例如 S 由一次延迟回忆直接反解）；
 *   3. 每个结果都带"粗糙度"，不假装精准；
 *   4. 所有公式与 docs/MODEL_v2_MATH.md 的方程**同源**，不另造模型。
 *
 * 标定不追求一次到位：拿到粗略值 → 跑起来 → 用后续每道题的对错继续修正
 * （`refineStability` 就是那条反馈通道）。
 */
(function () {
  'use strict';

  const isNode = typeof module !== 'undefined' && !!module.exports;
  const deps = isNode
    ? Object.assign({}, require('./config.js'), require('../mechanisms/memory.dsr.js'))
    : (globalThis.MindNet || {});
  const { MindNetError } = deps;
  const memoryDsr = deps.memoryDsr || (isNode ? require('../mechanisms/memory.dsr.js') : null);

  const GAMMA = 0.1542;
  const C = Math.pow(0.9, -1 / GAMMA) - 1; // ≈ 0.980346

  function clamp(x, lo, hi) {
    const v = Number(x);
    if (!Number.isFinite(v)) return lo;
    return v < lo ? lo : v > hi ? hi : v;
  }

  function round(x, n) {
    const f = Math.pow(10, n === undefined ? 6 : n);
    return Math.round((Number(x) || 0) * f) / f;
  }

  /** 至少需要多少个样本才算能用；不够就原样返回默认值并标注 */
  function enough(list, min) {
    return Array.isArray(list) && list.length >= min;
  }

  // ---------------------------------------------------------------- T3 记忆

  /**
   * 由一次「延迟回忆」反解稳定度 S（闭式）。
   *   R(t) = R0·(1 + c·t/S)^(−γ)   ⇒   S = t·c / ((Rt/R0)^(−1/γ) − 1)
   * @param {object} p { R0, Rt, tHours }
   */
  function estimateStability(p) {
    const R0 = clamp(p.R0, 0.01, 1);
    const Rt = clamp(p.Rt, 0.001, R0);
    const t = Number(p.tHours);
    if (!(t > 0)) throw new MindNetError('estimateStability 需要正的延迟时间（小时）');
    const ratio = Rt / R0;
    const denom = Math.pow(ratio, -1 / GAMMA) - 1;
    if (!(denom > 1e-9)) return { S: 1e9, note: '延迟测试几乎没忘，S 只能给一个很大的下界' };
    const S = (t * C) / denom;
    return { S: round(S, 3), note: `延迟 ${t} 小时、留存比 ${round(ratio, 3)} ⇒ S ≈ ${round(S, 2)} 小时` };
  }

  /**
   * 反馈闭环：拿到"某道题在 t 小时后答对/答错"这一条新证据后，微调 S。
   * 答对 ⇒ 至少能撑到这个延迟（S 上调）；答错 ⇒ 没撑到（S 下调）。
   * 用固定步长的几何平均，避免单条数据把 S 甩飞。
   */
  function refineStability(S, p) {
    const s = Math.max(0.1, Number(S) || 24);
    const t = Math.max(0.01, Number(p.tHours) || 1);
    const target = p.correct ? s * 1.15 : s * 0.85;
    const w = 0.25; // 单条证据的权重
    return round(Math.exp(Math.log(s) * (1 - w) + Math.log(target) * w), 3);
  }

  // ------------------------------------------------------- T4 复习类型的增益

  /**
   * 复习类型的增益比：两组初始条件相同、在同一延迟复习，则
   *   (SInc_A − 1) / (SInc_B − 1) = κ_A / κ_B
   * 所以只要分别测出两组的 S，就能得到比例。
   * @param {object} p { S_before, S_reread, S_retrieval }
   */
  function estimateReviewTypeRatio(p) {
    const s0 = Math.max(0.1, Number(p.S_before) || 24);
    const incA = Math.max(1.0001, (Number(p.S_reread) || s0) / s0);
    const incB = Math.max(1.0001, (Number(p.S_retrieval) || s0) / s0);
    const ratio = (incA - 1) / (incB - 1);
    return {
      kappa_reread_ratio: round(clamp(ratio, 0.02, 1), 3),
      note: `再读增益 ${round(incA - 1, 2)} vs 主动回忆增益 ${round(incB - 1, 2)} ⇒ 再读系数 ≈ ${round(clamp(ratio, 0.02, 1), 3)}`,
    };
  }

  // ---------------------------------------------------------------- T1 容量

  /**
   * 意识容量：给每个广度 N 的正确率，取正确率落到 50% 处的 N（线性插值）。
   * 语义上就是"同时能拿住几个"。
   */
  function estimateCapacity(spanResults, fallback) {
    const rows = (spanResults || [])
      .filter((r) => r && Number.isFinite(r.n) && Number.isFinite(r.accuracy))
      .sort((a, b) => a.n - b.n);
    if (!enough(rows, 2)) return { W_DAR: fallback === undefined ? 4 : fallback, note: '样本不足，沿用默认 4' };
    let crossing = null;
    for (let i = 1; i < rows.length; i += 1) {
      const a = rows[i - 1];
      const b = rows[i];
      if (a.accuracy >= 0.5 && b.accuracy < 0.5) {
        const span = b.accuracy - a.accuracy;
        const frac = span === 0 ? 0.5 : (0.5 - a.accuracy) / span;
        crossing = a.n + frac * (b.n - a.n);
        break;
      }
    }
    if (crossing === null) {
      const last = rows[rows.length - 1];
      crossing = last.accuracy >= 0.5 ? last.n + 1 : rows[0].n;
    }
    return {
      W_DAR: round(clamp(crossing, 1.5, 8), 2),
      note: `正确率降到 50% 大约在 ${round(crossing, 1)} 个项目 ⇒ 直接访问区预算 ≈ ${round(clamp(crossing, 1.5, 8), 2)}`,
    };
  }

  // ------------------------------------------------------- T2 节律与走神

  /**
   * 经验取样法（Killingsworth & Gilbert 的做法）估节律参数：
   *   samples: [{ tMinutes, focused: true/false }]
   *   - 走神占比 → 稳态 p1/(p1+p2)
   *   - 平均连续专注时长 → 1/p1（tick 换算后）
   *   - 前 1/3 与后 1/3 的专注率之比 → 警觉衰减 τ
   */
  function estimateRhythm(samples, opts) {
    const o = Object.assign({ tickMs: 250, sampleMinutes: 0.5, fallbackDuty: 0.5 }, opts || {});
    const rows = (samples || []).filter((s) => s && typeof s.focused === 'boolean');
    if (!enough(rows, 6)) {
      return { duty: o.fallbackDuty, p_off: 0.02, p_on: 0.08, tau_vig_minutes: 20, note: '样本不足，沿用默认值' };
    }
    const offFraction = rows.filter((s) => !s.focused).length / rows.length;
    // 连续专注段长度（单位：采样点）→ 转成 tick
    const runs = [];
    let run = 0;
    for (const s of rows) {
      if (s.focused) run += 1;
      else if (run > 0) { runs.push(run); run = 0; }
    }
    if (run > 0) runs.push(run);
    const meanRunSamples = runs.length ? runs.reduce((a, b) => a + b, 0) / runs.length : rows.length;
    const meanRunTicks = Math.max(1, meanRunSamples * (o.sampleMinutes * 60000) / o.tickMs);
    const pOff = clamp(1 / meanRunTicks, 0.0005, 0.2);
    // 稳态：p1/(p1+p2) = offFraction，p1 = pOff ⇒ p2 = p1·(1−off)/off
    const off = clamp(offFraction, 0.02, 0.95);
    const pOn = clamp(pOff * (1 - off) / off, 0.001, 0.5);

    // 警觉衰减：把样本按时间分三段，比较首尾的专注率
    const third = Math.max(1, Math.floor(rows.length / 3));
    const head = rows.slice(0, third);
    const tail = rows.slice(-third);
    const rate = (xs) => xs.filter((s) => s.focused).length / xs.length;
    const r1 = rate(head);
    const r2 = rate(tail);
    const totalMinutes = (rows[rows.length - 1].tMinutes || rows.length * o.sampleMinutes);
    let tau = 20;
    if (r1 > 0.05 && r2 < r1) {
      // exp(−Δt/τ) ≈ r2/r1 ⇒ τ = −Δt / ln(r2/r1)
      tau = clamp(-(totalMinutes * 2 / 3) / Math.log(Math.max(0.05, r2) / r1), 3, 240);
    }
    return {
      duty: round(clamp(1 - off, 0.05, 1), 3),
      p_off: round(pOff, 4),
      p_on: round(pOn, 4),
      tau_vig_minutes: round(tau, 1),
      note: `走神占比 ${round(off, 2)}（连续专注平均 ${round(meanRunSamples, 1)} 个采样点）⇒ duty ≈ ${round(1 - off, 2)}，`
        + `转入走神 ${round(pOff, 4)}/tick、转回 ${round(pOn, 4)}/tick，警觉时间常数 ≈ ${round(tau, 1)} 分钟`,
    };
  }

  // ---------------------------------------------------------------- T5 元认知

  /**
   * 自信偏置 b0：让模型预测的平均自信 ≈ 实际回忆率。
   * 用一维二分（区间固定，20 次迭代足够），不引入任何新参数。
   * @param {object} p { items: [{ belief, recalled, fluency, R0 }], beliefOf }
   */
  function fitBeliefBias(p) {
    const items = (p.items || []).filter((x) => x && Number.isFinite(x.belief) && typeof x.recalled === 'boolean');
    if (!enough(items, 6)) return { b0: 1.5, delta: 0.2, note: '样本不足，沿用默认值' };
    const beliefOf = p.beliefOf;
    const observed = items.filter((x) => x.recalled).length / items.length;
    const fluencyOf = (x) => clamp(x.fluency === undefined ? x.belief : x.fluency, 0, 1);
    const R0Of = (x) => clamp(x.R0 === undefined ? 0.8 : x.R0, 0.01, 1);
    const predictedMean = (b0) => items.reduce(
      (s, x) => s + beliefOf(fluencyOf(x), R0Of(x), 0, { b0, w_fluency: 1.5, w_encoding: 0.8, w_recency: 0.8, tau_recency_hours: 6 }),
      0
    ) / items.length;
    let lo = -6;
    let hi = 6;
    for (let i = 0; i < 24; i += 1) {
      const mid = (lo + hi) / 2;
      if (predictedMean(mid) > observed) lo = mid;
      else hi = mid;
    }
    const b0 = (lo + hi) / 2;
    const diffs = items.map((x) => x.belief - (x.recalled ? 1 : 0));
    const abs = diffs.map(Math.abs).sort((a, b) => a - b);
    const delta = clamp(abs[Math.floor(abs.length * 0.75)] || 0.2, 0.05, 0.6);
    const bias = diffs.reduce((a, b) => a + b, 0) / diffs.length;
    return {
      b0: round(b0, 3),
      delta: round(delta, 3),
      calibration: round(abs.reduce((a, b) => a + b, 0) / abs.length, 3),
      bias: round(bias, 3),
      note: `实际回忆率 ${round(observed, 2)}；平均自信 ${round(items.reduce((s, x) => s + x.belief, 0) / items.length, 2)}`
        + `（偏置 ${round(bias, 2)}）⇒ b0 ≈ ${round(b0, 2)}，危险区阈值 δ ≈ ${round(delta, 2)}`,
    };
  }

  // ---------------------------------------------------------------- T6 问卷

  /** 成本比：把自评（1–5）归一化到"回忆一次 = 1" */
  function estimateCosts(report) {
    const r = report || {};
    const base = clamp(r.retrieval === undefined ? 3 : r.retrieval, 1, 5);
    return {
      cost_retrieval: 1,
      cost_link: round(clamp((r.link === undefined ? 4 : r.link) / base, 0.2, 10), 3),
      cost_offload: round(clamp((r.offload === undefined ? 1 : r.offload) / base, 0.05, 5), 3),
      note: `以「主动回忆一次」为 1：补一条连接 ≈ ${round(clamp((r.link === undefined ? 4 : r.link) / base, 0.2, 10), 2)}，`
        + `写下来 ≈ ${round(clamp((r.offload === undefined ? 1 : r.offload) / base, 0.05, 5), 2)}`,
    };
  }

  // ------------------------------------------------------------ 汇总与说明

  /** 把估计结果组装成内核能直接吃的 overrides */
  function buildOverrides(est) {
    const e = est || {};
    const out = {};
    const put = (key, value) => {
      if (value !== undefined && value !== null && Number.isFinite(value)) out[key] = value;
    };
    put('memory.dsr.legacy_k', e.legacy_k);
    if (e.kappa_reread_ratio !== undefined) put('memory.dsr.kappa_reread_ratio', e.kappa_reread_ratio);
    put('attention.capacity.W_DAR', e.W_DAR);
    put('rhythm.gate.duty', e.duty);
    put('rhythm.gate.p_off', e.p_off);
    put('rhythm.gate.p_on', e.p_on);
    put('rhythm.gate.tau_vig_minutes', e.tau_vig_minutes);
    put('attention.ignition.T_ign', e.T_ign);
    put('metacognition.belief.b0', e.b0);
    put('metacognition.belief.delta', e.delta);
    put('control.planner.cost_link', e.cost_link);
    put('control.planner.cost_offload', e.cost_offload);
    put('calibration.target_retention', e.target_retention);
    return out;
  }

  /**
   * 用标定结果算"这对你意味着什么"（人话版），
   * 全部走模型自己的公式，不做第二套解释。
   */
  function describeEffects(est) {
    const e = est || {};
    const lines = [];
    if (Number.isFinite(e.S_hours)) {
      const target = Number.isFinite(e.target_retention) ? e.target_retention : 0.85;
      const R0 = Number.isFinite(e.R0) && e.R0 > 0 ? e.R0 : 0.8;
      const legacyK = Number.isFinite(e.legacy_k) ? e.legacy_k : 24;
      let interval = null;
      if (memoryDsr && typeof memoryDsr.scheduleInterval === 'function') {
        // 造一个只带记忆状态的桩节点，直接走模型自己的排程公式
        const stub = {
          id: 'stub', ms: R0, weight: 1, state: 'INACTIVE', al: 0, visit_count: 0, stm: 0,
          last_review_time: 0,
          m: {
            memory_dsr: {
              R0, S: e.S_hours, Sigma: R0, D: 5, N: 0, F: 0, lastFail: null, lastReview: 0,
              history: [], initializedAt: 0,
            },
          },
        };
        interval = memoryDsr.scheduleInterval(stub, 0, target, {
          decay_model: 'power', gamma: GAMMA, legacy_k: legacyK,
        });
      }
      if (interval !== null && Number.isFinite(interval)) {
        lines.push(`按你测出的 S ≈ ${round(e.S_hours, 1)} 小时：目标留存 ${target} ⇒ 大约 ${round(interval, 1)} 小时后复习（≈ ${round(interval / 24, 1)} 天）`);
      }
    }
    if (Number.isFinite(e.duty)) {
      lines.push(`专注占比 ${round(e.duty * 100, 0)}% ⇒ 同样坐 1 小时，真正"在"的时间约 ${round(e.duty * 60, 0)} 分钟`);
    }
    if (Number.isFinite(e.W_DAR)) {
      lines.push(`同时能拿住约 ${round(e.W_DAR, 1)} 个项目 ⇒ 一次别指望装下更多；超出的会被"挤出去"（不是不会）`);
    }
    if (Number.isFinite(e.kappa_reread_ratio)) {
      lines.push(`再读的增益只有主动回忆的 ${round(e.kappa_reread_ratio * 100, 0)}% ⇒ 别用"再看一遍"当复习`);
    }
    if (Number.isFinite(e.bias)) {
      lines.push(e.bias > 0.1
        ? `你的自信平均高估 ${round(e.bias, 2)} ⇒ 听"感觉会了"要打折`
        : e.bias < -0.1 ? `你的自信平均低估 ${round(-e.bias, 2)} ⇒ 你比你以为的更会` : '你的自信和实际基本吻合');
    }
    return lines;
  }

  const api = {
    GAMMA,
    CURVE_C: C,
    estimateStability,
    refineStability,
    estimateReviewTypeRatio,
    estimateCapacity,
    estimateRhythm,
    fitBeliefBias,
    estimateCosts,
    buildOverrides,
    describeEffects,
    clamp,
    round,
  };

  if (isNode) module.exports = api;
  else {
    globalThis.MindNet = Object.assign(globalThis.MindNet || {}, { calibration: api });
  }
})();
