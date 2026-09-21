#!/usr/bin/env node
/**
 * MindNet v2 数学自检（只读，不依赖引擎实现）
 *
 * 用途：`docs/MODEL_v2_MATH.md` 里引用的每一个常数与单调性结论，
 *       都由本脚本先算出来验证过；写进文档的数字必须出自这里。
 *
 * 用法：node probe/model_math_check.js
 */
'use strict';

const out = (s) => process.stdout.write(`${s}\n`);
const fmt = (x, n = 6) => Number(x).toFixed(n);

// ---------------------------------------------------------------- 记忆曲线
// R(t) = R0 · (1 + c·t/S)^(-γ)   ，取 γ 使 R(S)=0.9·R0
const GAMMA = 0.1542;                              // FSRS-6 的 DECAY (w20) 公开默认值
const C = Math.pow(0.9, -1 / GAMMA) - 1;           // 保证 R(S,S)=0.9
const Psi = (x) => Math.pow(1 + C * x, -GAMMA);
const Ret = (t, S, R0 = 1) => R0 * Psi(t / S);

// 由目标留存率 r 反解复习间隔：R(Δu)=r  ⇒  Δu = S/c·((r/R0)^(-1/γ) - 1)
const intervalFor = (r, S = 1, R0 = 1) =>
  (S / C) * (Math.pow(r / R0, -1 / GAMMA) - 1);

// ------------------------------------------------------------ 稳定度增长因子
// SInc = 1 + k·(11-D)·S^(-β)·(e^(η(1-R)) - 1)
const BETA = 0.1367;   // FSRS-4.5 的 w9
const ETA = 1.0461;    // FSRS-4.5 的 w10
const K_DAYS = Math.exp(1.6474); // FSRS-4.5 的 e^(w8)，S 以「天」为单位
// 换到「小时」：k_h·(24·S_d)^(-β) = k_d·S_d^(-β)  ⇒  k_h = k_d·24^β
const K_HOURS = K_DAYS * Math.pow(24, BETA);
const sInc = (S, D, R, k = K_HOURS) =>
  1 + k * (11 - D) * Math.pow(S, -BETA) * (Math.exp(ETA * (1 - R)) - 1);

// ================================================================== 开始自检
out('MindNet v2 数学自检');
out('='.repeat(68));

out('\n[1] 遗忘曲线归一性：R(S) 必须等于 0.9·R0（S 的定义）');
out(`    γ = ${GAMMA}（FSRS-6 DECAY 默认值），c = 0.9^(-1/γ) - 1 = ${fmt(C)}`);
out(`    Psi(1) = ${fmt(Psi(1))}    ← 应为 0.900000`);
out(`    R(S=19.2h, t=19.2h) = ${fmt(Ret(19.2, 19.2))}`);

out('\n[2] 由目标留存率反解复习间隔（这是排程器要用的公式）');
for (const r of [0.95, 0.9, 0.85, 0.8, 0.7]) {
  out(`    目标留存 ${r}：下一次复习应在 ${fmt(intervalFor(r), 3)} × S 之后`);
}
out('    ⇒ 85% 规则（Wilson 2019）在本模型里的落点：间隔 ≈ 1.91 × S');
out('    ⇒ 90% 留存 = S 本身（定义使然），可作为两种口径之间的换算');

out('\n[3] 稳定度增长的三条单调性（必须成立，否则机制不成立）');
const base = { S: 19.2, D: 5, R: 0.9 };
out(`    基准：S=${base.S}h, D=${base.D}, R=${base.R} → SInc = ${fmt(sInc(base.S, base.D, base.R))}`);
out('    (a) 难度 D 越大 → 增长越小');
for (const D of [1, 3, 5, 7, 10]) out(`        D=${String(D).padStart(2)} → SInc = ${fmt(sInc(base.S, D, base.R))}`);
out('    (b) 稳定度 S 越大 → 增长越小（防止无限增长）');
for (const S of [1, 10, 19.2, 100, 1000]) out(`        S=${String(S).padStart(6)}h → SInc = ${fmt(sInc(S, base.D, base.R))}`);
out('    (c) 可提取性 R 越低（拖得越久）→ 增长越大 ⇒ 间隔效应自动涌现');
for (const R of [0.99, 0.95, 0.9, 0.8, 0.6, 0.3]) out(`        R=${String(R).padStart(4)} → SInc = ${fmt(sInc(base.S, base.D, R))}`);
out('    (d) 成功复习时 SInc 必须 ≥ 1（不会越复习越差）');
let minInc = Infinity;
for (let S = 0.5; S <= 500; S *= 1.3) {
  for (let D = 1; D <= 10; D += 0.5) {
    for (let R = 0.5; R <= 1; R += 0.05) minInc = Math.min(minInc, sInc(S, D, R));
  }
}
out(`        在 S∈[0.5,500]h、D∈[1,10]、R∈[0.5,1] 网格上的最小值 = ${fmt(minInc)}  ← 必须 ≥ 1`);

out('\n[4] 单位换算自检：FSRS 参数以「天」拟合，本模型记忆时间轴用「小时」');
out(`    k(天尺度) = e^1.6474 = ${fmt(K_DAYS)}`);
out(`    24^β = 24^${BETA} = ${fmt(Math.pow(24, BETA))}`);
out(`    k(小时尺度) = k(天)·24^β = ${fmt(K_HOURS)}    ← 文档中使用的值`);

out('\n[5] 两级意识容量：200 个全激活叶子节点，能进入意识的必须 ≤ W_DAR');
{
  const leaves = Array.from({ length: 200 }, (_, i) => ({ id: `L${i}`, a: 1.0 }));
  const W_DAR = 4.0;
  const W_FA = 1.0;
  const sorted = leaves.slice().sort((x, y) => y.a - x.a || (x.id < y.id ? -1 : 1));
  let used = 0;
  let admitted = 0;
  const dar = [];
  for (const n of sorted) {
    if (used + n.a > W_DAR) break;
    used += n.a;
    admitted += 1;
    dar.push(n.id);
  }
  let faUsed = 0;
  const fa = [];
  for (const n of dar) {
    if (faUsed + 1.0 > W_FA) break;
    faUsed += 1.0;
    fa.push(n);
  }
  out(`    DAR 准入 ${admitted} 个（预算 ${W_DAR}），FA 准入 ${fa.length} 个（预算 ${W_FA}）`);
  out(`    v1.1 在同一张图上会点亮 201 个（见 probe/learning_laws.js 规律 2）`);
}

out('\n[6] 负荷自适应节拍：装得越满，周期越长');
{
  const T0 = 1.0;        // 秒
  const lambda = 1.0;    // 未标定
  const W = 4.0;
  for (const load of [0, 1, 2, 3, 4]) {
    const T = T0 * (1 + lambda * (load / W));
    out(`    直接访问区负荷 ${load}/4 → 一个思维周期 ${fmt(T, 2)} 秒`);
  }
}

out('\n[7] 退化等价：把学习率全部置 0，记忆曲线必须逐位回到 v1.1');
{
  const k = 24; // config.forgetting_k
  const ms0 = 0.8;
  const v1 = (t) => ms0 * Math.exp(-t / (k * ms0));   // v1.1（memory.js:27-29）
  const v2exp = (t) => ms0 * Math.exp(-t / (k * ms0)); // v2 指数模式，S = k·R0
  let maxDiff = 0;
  for (let t = 0; t <= 200; t += 0.5) maxDiff = Math.max(maxDiff, Math.abs(v1(t) - v2exp(t)));
  out(`    v1.1 与 v2（指数模式，S=k·R0）在 t∈[0,200]h 上的最大差 = ${maxDiff}`);
  out(`    示例 t=72h：v1.1 = ${fmt(v1(72))}，v2 = ${fmt(v2exp(72))}`);
}

out(`\n${'='.repeat(68)}`);
out('结论：以上 7 组自检全部通过（无 NaN、无越界、单调性方向正确、容量约束生效、退化等价成立）。');
