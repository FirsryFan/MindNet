#!/usr/bin/env node
/**
 * 机制工具：目录报告 + 校验（对应 docs/PLUGIN_ARCHITECTURE.md §7）
 *
 * 用法：
 *   node tools/mechanisms.js            # 打印机制目录报告（含验收断言执行结果）
 *   node tools/mechanisms.js --check    # 严格校验：schema / 冲突 / 静态扫描 / 验收断言（失败即退出码 1）
 *   node tools/mechanisms.js --json     # 机器可读
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { loadMechanisms, PROFILES } = require('../mechanisms/index.js');
const { MechanismKernel } = require('../src/core/kernel.js');
const { Graph, Config } = require('../src/index.js');

const MECH_DIR = path.join(__dirname, '..', 'mechanisms');
const ALLOWED_REQUIRE = [
  /^\.\.\/src\/config\.js$/,
  /^\.\.\/src\/model\.js$/,
  /^\.\.\/src\/core\//,
  /^\.\/[A-Za-z0-9_.-]+\.js$/,
];
const FORBIDDEN = [
  { re: /Math\.random\s*\(/g, why: '禁止 Math.random（破坏确定性，请用 ctx.rng）' },
  { re: /Date\.now\s*\(/g, why: '禁止 Date.now（请用 ctx.hours / now_hours()）' },
  { re: /\bfetch\s*\(/g, why: '禁止网络访问（内核不变量 I3）' },
  { re: /\brequire\s*\(\s*['"]node:/g, why: '机制不许访问 Node 内置模块' },
];

function staticScan(file) {
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split('\n');
  const problems = [];
  for (const rule of FORBIDDEN) {
    rule.re.lastIndex = 0;
    let m;
    while ((m = rule.re.exec(text)) !== null) {
      const line = text.slice(0, m.index).split('\n').length;
      problems.push({ line, message: `${rule.why}：${lines[line - 1].trim()}` });
    }
  }
  const reqRe = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  let r;
  while ((r = reqRe.exec(text)) !== null) {
    const spec = r[1];
    if (!ALLOWED_REQUIRE.some((re) => re.test(spec))) {
      const line = text.slice(0, r.index).split('\n').length;
      problems.push({ line, message: `不允许的依赖 "${spec}"（白名单：${ALLOWED_REQUIRE.map(String).join(' / ')}）` });
    }
  }
  return problems;
}

function buildKernel(loaded, ids) {
  const graph = Graph.from_object(
    { nodes: [{ id: 'probe_node', name: '探针节点', type: 'knowledge', ms: 0.8 }], edges: [] },
    0
  );
  const kernel = new MechanismKernel(graph, new Config(), { seed: 1, hours: 0 });
  const picked = ids ? loaded.filter((x) => ids.includes(x.manifest.id)) : loaded;
  kernel.load(picked.map((x) => x.manifest));
  return kernel;
}

function buildReport() {
  const loaded = loadMechanisms();
  // 每个 profile 单独建内核跑验收（legacy_v1 与 v2 快层模块互斥）
  const acceptance = [];
  const perProfile = {};
  for (const [name, ids] of Object.entries(PROFILES)) {
    const kernel = buildKernel(loaded, ids);
    const report = kernel.runAcceptance();
    perProfile[name] = { kernel, report, ids };
    acceptance.push(...report);
  }
  const scan = {};
  for (const item of loaded) {
    scan[item.manifest.id] = staticScan(path.join(MECH_DIR, item.file));
  }
  const rows = loaded.map((item) => {
    const m = item.manifest;
    const params = m.params || [];
    return {
      id: m.id,
      file: item.file,
      name: m.name,
      layer: m.layer,
      level: m.level,
      params: params.length,
      calibrated: params.filter((p) => p.calibrated).length,
      hooks: Object.keys(m.hooks),
      reads: m.reads || [],
      writes: m.writes || [],
      phenomenon: m.phenomenon || [],
      evidence: m.evidence || [],
      acceptance: acceptance.filter((a) => a.mechanism === m.id),
      scan: scan[m.id],
    };
  });
  const warnings = [];
  for (const [name, entry] of Object.entries(perProfile)) {
    for (const w of entry.kernel.warnings) warnings.push(Object.assign({ profile: name }, w));
  }
  return {
    kernel: perProfile.v2.kernel,
    profiles: perProfile,
    rows,
    warnings,
    acceptance,
    ok: rows.every((r) => r.scan.length === 0 && r.acceptance.every((a) => a.passed)),
  };
}

function printHuman(report) {
  const out = [];
  out.push('MindNet 机制目录');
  out.push('='.repeat(70));
  for (const r of report.rows) {
    out.push(`\n● ${r.id}  (${r.file})`);
    out.push(`  名称    ：${r.name}`);
    out.push(`  层 / 级 ：${r.layer} / ${r.level}`);
    out.push(`  槽位    ：${r.hooks.join(', ')}`);
    out.push(`  参数    ：${r.params} 个（已标定 ${r.calibrated}，未标定 ${r.params - r.calibrated}）`);
    out.push(`  读 / 写 ：${r.reads.join(', ') || '—'}  /  ${r.writes.join(', ')}`);
    out.push(`  现象    ：${r.phenomenon.map((p) => `\n            - ${p}`).join('')}`);
    out.push(`  证据    ：${r.evidence.map((e) => e.grade).join(', ') || '（未声明）'}`);
    for (const a of r.acceptance) {
      out.push(`  验收    ：${a.passed ? '通过' : '失败'} [${a.kind}] ${a.name}${a.error ? ` ← ${a.error}` : ''}`);
    }
    if (r.scan.length) {
      for (const s of r.scan) out.push(`  静态扫描：第 ${s.line} 行 ${s.message}`);
    }
  }
  if (report.warnings.length) {
    out.push('\n内核告警：');
    for (const w of report.warnings) out.push(`  [${w.kind}] ${w.mechanism}${w.hook ? ` @ ${w.hook}` : ''}：${w.message}`);
  }
  out.push(`\n结论：${report.ok ? '全部通过' : '存在失败项'}`);
  return out.join('\n');
}

function main(argv) {
  const args = argv || [];
  const check = args.includes('--check');
  const json = args.includes('--json');
  let report;
  try {
    report = buildReport();
  } catch (err) {
    process.stderr.write(`机制装载失败：${err.message}\n`);
    return 1;
  }
  if (json) {
    process.stdout.write(`${JSON.stringify({ rows: report.rows, warnings: report.warnings, ok: report.ok }, null, 2)}\n`);
  } else if (check) {
    const lines = [];
    lines.push(`机制校验：${report.rows.length} 个模块`);
    for (const r of report.rows) {
      const failed = r.acceptance.filter((a) => !a.passed);
      lines.push(`  ${r.id}：schema 通过；静态扫描 ${r.scan.length} 项违规；验收 ${r.acceptance.length - failed.length}/${r.acceptance.length} 通过`);
      for (const f of failed) lines.push(`      ✗ [${f.kind}] ${f.name}${f.error ? ` ← ${f.error}` : ''}`);
      for (const s of r.scan) lines.push(`      ✗ 第 ${s.line} 行 ${s.message}`);
    }
    for (const w of report.warnings) lines.push(`  告警 [${w.kind}] ${w.mechanism}：${w.message}`);
    lines.push(report.ok ? '结论：PASS' : '结论：FAIL');
    process.stdout.write(`${lines.join('\n')}\n`);
  } else {
    process.stdout.write(`${printHuman(report)}\n`);
  }
  return report.ok ? 0 : 1;
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}

module.exports = { main, buildReport, staticScan };
