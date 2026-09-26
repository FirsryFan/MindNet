#!/usr/bin/env node
/**
 * 一致性样例（conformance vectors）生成器 —— 给 Dart 移植用的对拍基准
 *
 *   node tools/conformance.js --write    # 重新生成 conformance/mindnet_vectors.json
 *   node tools/conformance.js --check    # 校验磁盘上的文件与当前实现一致（CI/测试用）
 *
 * 设计原则：
 *   1. **样例由实现生成，不手写** —— 手写的期望值会随实现漂移，等于没有基准；
 *   2. 分两层：tierA = 纯记忆数学（无状态机、无随机）；tierB = 快层一轮（去掉随机源）；
 *   3. 容差写在文件里（tolerances），由 MindNet 侧给出建议，Dart 侧照做；
 *   4. `--check` 保证样例不过期：改了实现却没重生成，测试会红。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { Graph, Config, createKernel } = require('../src/index.js');
const { FastEngine } = require('../src/v2/engine.js');
const memoryDsr = require('../mechanisms/memory.dsr.js');

const OUT = path.join(__dirname, '..', 'conformance', 'mindnet_vectors.json');

function round6(x) {
  if (typeof x !== 'number' || !Number.isFinite(x)) return x;
  return Math.round(x * 1e6) / 1e6;
}

/** 造一个记忆状态桩（tierA 用；字段名与 mechanisms/memory.dsr.js 的 state bag 一致） */
function bag(over) {
  return Object.assign({
    R0: 0.8, S: 19.2, Sigma: 0.8, D: 5.1618, N: 0, F: 0,
    lastFail: null, lastReview: 0, history: [], initializedAt: 0,
  }, over || {});
}

function node(over) {
  return Object.assign({
    id: 'n', ms: 0.8, weight: 1, last_review_time: 0, m: { memory_dsr: bag() },
  }, over || {});
}

// ------------------------------------------------------------------ tierA

function tierA() {
  const out = [];
  const o = memoryDsr.options({});

  out.push({
    id: 'A01-constants',
    api: 'memoryDsr.curveC / defaults',
    input: { gamma: o.gamma, decay_model: o.decay_model },
    expected: { c: round6(memoryDsr.curveC(o.gamma)), kappa: o.kappa, beta: o.beta, eta: o.eta },
  });

  for (const z of [0, 0.1, 0.5, 1, 2, 3.88, 5, 10, 45.1]) {
    out.push({
      id: `A02-psi-power-z${z}`,
      api: 'memoryDsr.psi(z, {decay_model:"power"})',
      input: { z, gamma: o.gamma },
      expected: { psi: round6(memoryDsr.psi(z, o)) },
    });
  }
  for (const z of [0, 0.5, 1, 2]) {
    out.push({
      id: `A03-psi-exponential-z${z}`,
      api: 'memoryDsr.psi(z, {decay_model:"exponential"})',
      input: { z, decay_model: 'exponential' },
      expected: { psi: round6(memoryDsr.psi(z, memoryDsr.options({ decay_model: 'exponential' }))) },
    });
  }

  for (const t of [0, 1, 5, 10, 48, 200]) {
    const n = node();
    out.push({
      id: `A04-retrievability-t${t}`,
      api: 'memoryDsr.retrievabilityOf(node, t)',
      input: { state: bag(), t },
      expected: { R: round6(memoryDsr.retrievabilityOf(n, t, o)), ms: round6(n.ms) },
    });
  }

  for (const target of [0.95, 0.9, 0.85, 0.8, 0.7, 0.5]) {
    const n = node({ m: { memory_dsr: bag({ R0: 1 }) } });
    out.push({
      id: `A05-schedule-target${target}`,
      api: 'memoryDsr.scheduleInterval(node, 0, target)',
      input: { state: bag({ R0: 1 }), now: 0, target },
      expected: { hours: round6(memoryDsr.scheduleInterval(n, 0, target, o)) },
    });
  }

  const reviewCases = [
    ['retrieval_success', { type: 'retrieval_success', grade: 3 }],
    ['reread', { type: 'reread' }],
    ['failure_feedback-c0.4', { type: 'retrieval_failure_feedback', closeness: 0.4 }],
    ['failure_feedback-c0.9', { type: 'retrieval_failure_feedback', closeness: 0.9 }],
    ['lapse', { type: 'lapse', grade: 1 }],
  ];
  for (const [label, ev] of reviewCases) {
    for (const t of [5, 30]) {
      const n = node();
      const before = bag();
      const delta = memoryDsr.applyReview(n, t, ev, o);
      out.push({
        id: `A06-applyReview-${label}-t${t}`,
        api: 'memoryDsr.applyReview(node, t, event)',
        input: { state: before, t, event: ev },
        expected: {
          S_after: round6(delta.S_after), R0_after: round6(delta.R0_before === undefined ? null : n.m.memory_dsr.R0),
          Sigma_after: round6(delta.Sigma_after), D_after: round6(delta.D_after),
          R_after: round6(delta.R_after), SInc: delta.SInc === undefined ? null : round6(delta.SInc),
          kind: delta.kind,
        },
      });
    }
  }

  for (const grade of [1, 2, 3, 4]) {
    const n = node();
    const delta = memoryDsr.applyReview(n, 20, { type: 'retrieval_success', grade }, o);
    out.push({
      id: `A07-grade${grade}-difficulty`,
      api: 'memoryDsr.applyReview(node, 20, {type:"retrieval_success", grade})',
      input: { state: bag(), t: 20, event: { type: 'retrieval_success', grade } },
      expected: { S_after: round6(delta.S_after), D_after: round6(delta.D_after), Sigma_after: round6(delta.Sigma_after) },
    });
  }

  // 储蓄效应：Σ 越大，同样的复习增益越大
  const sigmas = [0, 0.5, 0.9];
  for (const sigma of sigmas) {
    const n = node({ m: { memory_dsr: bag({ Sigma: sigma }) } });
    const delta = memoryDsr.applyReview(n, 20, { type: 'retrieval_success', grade: 3 }, o);
    out.push({
      id: `A08-savings-sigma${sigma}`,
      api: 'memoryDsr.applyReview（Σ 越大增益越大）',
      input: { state: bag({ Sigma: sigma }), t: 20, event: { type: 'retrieval_success', grade: 3 } },
      expected: { S_after: round6(delta.S_after), SInc: round6(delta.SInc) },
    });
  }

  return out;
}

// ------------------------------------------------------------------ tierB

/** 快层一轮：去掉随机源（T_ign=0、不装 rhythm.gate），只留可逐位复现的部分 */
function tierB() {
  const mechanisms = ['dynamics.shunting', 'attention.capacity', 'attention.ignition', 'context.goal'];
  const graphSpec = {
    nodes: [
      { id: 'A', name: '前置', type: 'knowledge', ms: 0.8, weight: 1 },
      { id: 'B', name: '中间', type: 'knowledge', ms: 0.7, weight: 1 },
      { id: 'C', name: '目标', type: 'knowledge', ms: 0.6, weight: 1 },
    ],
    edges: [
      { id: 'e1', from: 'A', to: 'B', ls: 0.9 },
      { id: 'e2', from: 'B', to: 'C', ls: 0.8 },
      { id: 'e3', from: 'A', to: 'C', ls: 0.3 },
    ],
  };
  const overrides = { 'attention.ignition.T_ign': 0 };
  const graph = Graph.from_object(graphSpec, 0);
  const kernel = createKernel(graph, new Config(), {
    seed: 7, hours: 0, mechanisms, overrides,
  });
  const engine = new FastEngine(graph, kernel.config, { kernel });
  engine.start_diffusion(['A'], ['C']);

  const rounds = [];
  for (let i = 0; i < 5; i += 1) {
    engine.step();
    const p = engine._lastRound || {};
    const mapToObj = (m) => {
      const out = {};
      if (!m) return out;
      for (const [k, v] of m) out[k] = round6(v);
      return out;
    };
    rounds.push({
      round: p.round,
      cycle_ticks: p.cycleTicks,
      availability: round6(p.availability),
      drive: mapToObj(p.drive),
      // 驱动的**逐项来源**：kind='edge' 是入边贡献（= al·ms·ls），
      // kind='subthreshold' 是亚阈累积，kind='module' 是模块改写（context.goal 的偏置）。
      // 注意：目标节点自身**不吃**目标偏置（否则目标自己点亮自己），所以 C 没有 module 项。
      drive_edges: (p.drive_edges || []).map((e) => Object.assign({}, e)),
      scores: mapToObj(p.scores),
      admitted: (p.admitted || []).slice(),
      focus: p.focus === undefined ? null : p.focus,
      dar_used: p.dar_used === undefined ? null : p.dar_used,
      outcompeted: (p.outcompeted || []).slice(),
      conscious: (p.conscious || []).slice(),
      subconscious: (p.subconscious || []).slice(),
      states: (p.state_changes || []).map((s) => ({ id: s.id, state_after: s.state_after, al: s.al })),
      a: (() => { const o = {}; for (const n of graph.nodes.values()) o[n.id] = round6(engine.core(n.id).a); return o; })(),
      q: (() => { const o = {}; for (const n of graph.nodes.values()) o[n.id] = round6(engine.core(n.id).q); return o; })(),
    });
  }

  return [{
    id: 'B01-fast-layer-chain-5-rounds',
    api: 'FastEngine（mechanisms=[shunting,capacity,ignition,goal], T_ign=0）',
    input: {
      graph: graphSpec,
      initial_nodes: ['A'],
      target_nodes: ['C'],
      seed: 7,
      hours: 0,
      mechanisms,
      overrides,
      module_defaults: {
        'dynamics.shunting': require('../mechanisms/dynamics.shunting.js').DEFAULTS,
        'attention.capacity': require('../mechanisms/attention.capacity.js').DEFAULTS,
        'attention.ignition': require('../mechanisms/attention.ignition.js').DEFAULTS,
        'context.goal': require('../mechanisms/context.goal.js').DEFAULTS,
      },
    },
    expected: { rounds },
  }];
}

// ------------------------------------------------------------------ 组装

function build() {
  let commit = null;
  try {
    commit = execSync('git rev-parse HEAD', { cwd: path.join(__dirname, '..') }).toString().trim();
  } catch (err) {
    commit = null;   // 不在 git 仓库里也能生成
  }
  return {
    protocol: 'mindnet.conformance/1',
    generated_from: {
      repo: 'https://github.com/FirsryFan/MindNet',
      commit,
      package_version: require('../package.json').version,
      generator: 'tools/conformance.js',
    },
    how_to_use: [
      'Dart 侧逐条读 tierA/tierB，用 input 调自己的实现，与 expected 逐字段比对。',
      '整数/布尔/字符串/集合成员：必须完全相等。',
      '浮点：先按 tolerances 判"是否一致"，再判"round6 后是否相同"。',
      'tierB 的 rounds[i] 必须按顺序比；drive/scores/a/q 是每轮结束后的值。',
    ],
    tolerances: {
      rel: 1e-12,
      abs: 1e-15,
      rounded_decimals: 6,
      note: '加和顺序必须与输入 edges 数组顺序一致，否则 drive 会有 ~1e-16 级别差异；'
        + 'pow/exp 在不同语言 libm 下可能差 1 ulp，所以先比容差、再比 round6。',
      must_be_exact: ['admitted', 'focus', 'outcompeted', 'conscious', 'subconscious', 'states[].state_after', 'kind'],
    },
    tierA: tierA(),
    tierB: tierB(),
  };
}

function serialize(obj) {
  return `${JSON.stringify(obj, null, 2)}\n`;
}

function main(argv) {
  const args = argv || [];
  const payload = build();
  const text = serialize(payload);
  if (args.includes('--check')) {
    if (!fs.existsSync(OUT)) {
      process.stderr.write(`样例文件不存在：${OUT}（请运行 node tools/conformance.js --write）\n`);
      return 1;
    }
    const onDisk = fs.readFileSync(OUT, 'utf8');
    if (onDisk === text) {
      process.stdout.write(`样例一致：${payload.tierA.length} 条 tierA + ${payload.tierB.length} 条 tierB\n`);
      return 0;
    }
    // 只有 generated_from.commit 变了（仓库又提交了一次）不算过期 ——
    // 这条检查守的是**数值**，不是仓库历史。其余任何差异都必须重生成。
    const strip = (obj) => {
      const copy = JSON.parse(JSON.stringify(obj));
      if (copy && copy.generated_from) copy.generated_from.commit = null;
      return serialize(copy);
    };
    let onDiskObj = null;
    try {
      onDiskObj = JSON.parse(onDisk);
    } catch (err) {
      process.stderr.write(`样例文件不是合法 JSON：${err.message}（请重跑 --write）\n`);
      return 1;
    }
    if (strip(onDiskObj) === strip(payload)) {
      const oldSha = (onDiskObj.generated_from || {}).commit || '—';
      process.stdout.write(`样例数值一致（只是 commit 变了：${String(oldSha).slice(0, 7)} → ${String(payload.generated_from.commit).slice(0, 7)}）\n`
        + '提示：改动实现时顺手跑一次 node tools/conformance.js --write，让文件里的 commit 跟上\n');
      return 0;
    }
    process.stderr.write('样例已过期：conformance/mindnet_vectors.json 的**数值**与当前实现不一致\n'
      + '（如果这是有意改动实现，请重跑 node tools/conformance.js --write 并提交）\n');
    return 1;
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, text, 'utf8');
  process.stdout.write(`已写入 ${OUT}\n  tierA ${payload.tierA.length} 条 · tierB ${payload.tierB.length} 条 · commit ${payload.generated_from.commit}\n`);
  return 0;
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}

module.exports = { main, build, tierA, tierB, OUT };
