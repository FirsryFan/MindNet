#!/usr/bin/env node
/**
 * 请求自检：只校验、不执行（对应 docs/INGEST.md §3.2 与 docs/PROMPT.md）
 *
 * 用途：上游 AI 产出的 `mindnet.run/1` 先过这一关 —— 报错说人话，
 * 并预告"这份请求将会落到哪些机制路径"。**它不改任何状态**，所以可以反复迭代到通过。
 *
 * 用法：
 *   node tools/io_check.js --request req.json [--graph demo_learning] [--quiet]
 *   node tools/io_check.js --request req.json --json
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { Graph, Config, createKernel, FastEngine } = require('../src/index.js');
const io = require('../src/io/run.js');

const EXAMPLE = path.join(__dirname, '..', 'example');

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json' || a === '--quiet') { out[a.slice(2)] = true; continue; }
    if (/^--?[A-Za-z][A-Za-z0-9-]*$/.test(a)) {
      const key = a.replace(/^--?/, '');
      const val = argv[i + 1];
      if (val === undefined || /^--?[A-Za-z]/.test(val)) { out[key] = true; continue; }
      out[key] = val;
      i += 1;
      continue;
    }
    out._.push(a);
  }
  return out;
}

function loadJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
}

function buildEngine(request, graphArg) {
  let input;
  if (request && request.graph) {
    input = request.graph.graph ? request.graph : { graph: request.graph };
  } else if (graphArg && graphArg !== true) {
    const named = path.join(EXAMPLE, `${graphArg}.json`);
    const file = fs.existsSync(named) ? named : graphArg;
    if (!fs.existsSync(file)) throw new Error(`找不到图文件：${graphArg}`);
    const raw = loadJson(file);
    input = raw.graph ? raw : { graph: raw };
  } else {
    throw new Error('请求里没有 graph，也没有 --graph：无法校验节点 id');
  }
  const graph = Graph.from_object(input.graph, 0);
  const kernel = createKernel(graph, new Config(), { seed: 7, hours: 0, profile: 'v2' });
  const engine = new FastEngine(graph, kernel.config, { kernel });
  engine.start_diffusion(input.initial_nodes || [], input.target_nodes || []);
  return { engine, kernel, nodeIds: Array.from(graph.nodes.keys()) };
}

/** 预告每条动作会落到哪条机制路径（人话） */
function preview(action) {
  if (action.kind === 'review') {
    const map = io.reviewPlan(action);
    return `review(${action.node}) → ${map.type}（S 由机制改）`;
  }
  if (action.kind === 'exposure') return `exposure(${action.node}) → reread（只算再读增益）`;
  if (action.kind === 'knowledge') {
    return action.node ? `新增节点 ${action.node.id || '(自动 id)'}` : `新增边 ${action.edge.from} → ${action.edge.to}`;
  }
  if (action.kind === 'goal') return `重开扩散：起点 ${(action.starts || ['(沿用)']).join(',')} → 目标 ${action.targets.join(',')}`;
  if (action.kind === 'time') {
    return action.elapsed_hours !== undefined
      ? `时间前进 ${action.elapsed_hours} 小时（同步所有节点的可提取度）`
      : `时间设为 ${action.at && action.at.model_hours}`;
  }
  return action.kind;
}

function main(argv) {
  const args = parseArgs(argv || []);
  try {
    if (!args.request || args.request === true) {
      process.stdout.write('用法：node tools/io_check.js --request req.json [--graph demo_learning] [--json] [--quiet]\n');
      return 1;
    }
    const request = loadJson(args.request);
    const built = buildEngine(request, args.graph);
    let result = null;
    let error = null;
    try {
      // 真的跑一遍校验路径，但用**克隆**的引擎 —— 校验通过也不动原始状态
      const probe = built.engine.clone();
      io.run({ engine: probe, kernel: probe.kernel, request, archive: undefined });
      result = 'ok';
    } catch (err) {
      error = err;
    }

    if (args.json) {
      process.stdout.write(`${JSON.stringify({
        ok: !error,
        error: error ? error.message : null,
        run_id: request.run_id === undefined ? null : request.run_id,
        actions: Array.isArray(request.actions) ? request.actions.length : 0,
        preview: Array.isArray(request.actions) ? request.actions.map(preview) : [],
      }, null, 2)}\n`);
      return error ? 1 : 0;
    }

    const lines = [];
    if (error) {
      lines.push(`✗ 请求不合法：${error.message}`);
      lines.push('');
      lines.push(`图里可用的节点 id（${built.nodeIds.length} 个）：`);
      lines.push(`  ${built.nodeIds.join(', ')}`);
      lines.push('');
      lines.push('对照 docs/INGEST.md §3.2「AI 不许做的事」与 docs/PROMPT.md 的自检清单逐条检查，改完再跑一次本命令。');
      process.stdout.write(`${lines.join('\n')}\n`);
      return 1;
    }

    lines.push(`✓ 请求合法：${request.run_id} · ${request.actions.length} 条动作`);
    if (!args.quiet) {
      request.actions.forEach((a, i) => lines.push(`  ${i + 1}. [${a.kind}] ${preview(a)}`));
      const withEvidence = request.actions.filter((a) => a.evidence).length;
      lines.push(`  出处：${withEvidence}/${request.actions.length} 条带 evidence`
        + `（建议全带 —— 出问题时才查得回去）`);
      lines.push('下一步：node tools/io_run.js --request <同一文件> --graph <图> --print digest');
    }
    process.stdout.write(`${lines.join('\n')}\n`);
    return 0;
  } catch (err) {
    process.stderr.write(`自检错误：${err.message}\n`);
    return 1;
  }
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}

module.exports = { main, parseArgs, preview, buildEngine };
