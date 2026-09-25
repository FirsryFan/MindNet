#!/usr/bin/env node
/**
 * MindNet I/O 命令行：把一份 `mindnet.run/1` 请求跑成 `mindnet.result/1`
 *
 * 用法：
 *   node tools/io_run.js --request req.json [--graph demo_learning] [--steps 4]
 *                        [--archive data/archive/runs.jsonl] [--out result.json]
 *                        [--profile v2] [--seed 7] [--target-retention 0.85]
 *                        [--rewind run-xxxx] [--print trace|digest|applied|result|all]
 *
 * 说明：
 *   - 请求里可以带 graph（完整输入信封），也可以用 --graph 指定 example/ 下的示例或一个 JSON 路径；
 *   - 存档是 append-only JSONL：每条动作一行，最后追加一条 run 结果行，便于回放与回退；
 *   - `--rewind <run_id>` 不做状态修改，只打印"该 run 之前的存档条目 / 目标 state_hash"，
 *     真正的回退方式是按保留条目重放（见 docs/IO_PROTOCOL.md §5）。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { Graph, Config, createKernel, FastEngine, memoryDsr } = require('../src/index.js');
const { RunArchive } = require('../src/io/archive.js');
const io = require('../src/io/run.js');

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
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

const EXAMPLE = path.join(__dirname, '..', 'example');
const DEFAULT_ARCHIVE = path.join(__dirname, '..', 'data', 'archive', 'runs.jsonl');

function loadJson(file) {
  // Windows 上手工编辑的 JSON 常带 BOM（记事本/PowerShell 默认就会加），这里容错
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
}

/** 图来源：请求里带的 graph > --graph 指定的示例名或路径 */
function resolveGraphInput(request, args) {
  if (request && request.graph) {
    return request.graph.graph ? request.graph : { graph: request.graph };
  }
  if (!args.graph || args.graph === true) {
    throw new Error('请求里没有 graph，也没有 --graph：请至少给一个');
  }
  const named = path.join(EXAMPLE, `${args.graph}.json`);
  const file = fs.existsSync(named) ? named : args.graph;
  if (!fs.existsSync(file)) throw new Error(`找不到图文件：${args.graph}`);
  const raw = loadJson(file);
  return raw.graph ? raw : { graph: raw };
}

function loadArchive(file) {
  if (!file || !fs.existsSync(file)) return new RunArchive();
  return RunArchive.fromJSONL(fs.readFileSync(file, 'utf8'));
}

function printResult(result, mode) {
  const out = process.stdout;
  if (mode === 'digest') {
    out.write(`${result.trace.digest.text}\n`);
    return;
  }
  if (mode === 'applied') {
    out.write(`${JSON.stringify(result.applied, null, 2)}\n`);
    return;
  }
  if (mode === 'trace') {
    out.write(`${JSON.stringify(result.trace, null, 2)}\n`);
    return;
  }
  if (mode === 'result') {
    out.write(`${JSON.stringify(result.result, null, 2)}\n`);
    return;
  }
  out.write(`${JSON.stringify(result, null, 2)}\n`);
}

function main(argv) {
  const args = parseArgs(argv || []);
  try {
    const archiveFile = args.archive === undefined || args.archive === true ? DEFAULT_ARCHIVE : args.archive;
    const archive = loadArchive(archiveFile);

    if (args.rewind) {
      const plan = archive.rewindPlan(String(args.rewind));
      process.stdout.write(
        `回退计划：run "${plan.run_id}"\n`
        + `  保留 ${plan.keep.length} 条、丢弃 ${plan.drop.length} 条\n`
        + `  目标 state_hash：${plan.target_state_hash === null ? '（回到空状态）' : plan.target_state_hash}\n`
        + '  实际回退 = 把保留的条目从头重放（docs/IO_PROTOCOL.md §5）\n'
      );
      return 0;
    }

    if (!args.request || args.request === true) {
      process.stdout.write(
        '用法：node tools/io_run.js --request req.json [--graph demo_learning] [--steps 4]\n'
        + '       [--archive data/archive/runs.jsonl] [--out result.json] [--profile v2] [--seed 7]\n'
        + '       [--target-retention 0.85] [--rewind run-xxxx] [--print trace|digest|applied|result|all]\n'
      );
      return 1;
    }

    const request = loadJson(args.request);
    const input = resolveGraphInput(request, args);
    const graph = Graph.from_object(input.graph, request.time && request.time.model_hours !== undefined
      ? request.time.model_hours
      : 0);
    const profile = args.profile === undefined ? 'v2' : String(args.profile);
    const seed = args.seed === undefined ? 7 : Number(args.seed);
    const kernel = createKernel(graph, new Config(), { seed, hours: 0, profile });
    const engine = new FastEngine(graph, kernel.config, { kernel });
    // 起点/目标：请求没带就取图信封里的
    engine.start_diffusion(input.initial_nodes || [], input.target_nodes || []);

    const result = io.run({
      engine,
      kernel,
      request,
      archive,
      memoryDsr,
      profile,
      target_retention: args['target-retention'] === undefined ? undefined : Number(args['target-retention']),
    });

    // 追加一条 run 结果行（存档即"即时落盘"）
    archive.append({
      kind: 'result',
      run_id: result.run_id,
      before: { state_hash: result.model.state_hash_before },
      after: { state_hash: result.model.state_hash_after, digest: result.trace.digest.text },
      note: 'run 结果',
    });
    fs.mkdirSync(path.dirname(path.resolve(archiveFile)), { recursive: true });
    fs.writeFileSync(archiveFile, archive.toJSONL(), 'utf8');

    if (args.out && args.out !== true) {
      fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
      fs.writeFileSync(args.out, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
      process.stdout.write(`结果已写入 ${path.resolve(args.out)}\n`);
      process.stdout.write(`存档：${path.resolve(archiveFile)}（${archive.entries.length} 条）\n`);
      process.stdout.write(`${result.trace.digest.text}\n`);
      process.stdout.write(`state_hash ${result.model.state_hash_before} → ${result.model.state_hash_after}\n`);
      return 0;
    }
    printResult(result, args.print === undefined || args.print === true ? 'all' : String(args.print));
    return 0;
  } catch (err) {
    process.stderr.write(`I/O 运行错误：${err.message}\n`);
    return 1;
  }
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}

module.exports = { main, parseArgs, resolveGraphInput, loadArchive };
