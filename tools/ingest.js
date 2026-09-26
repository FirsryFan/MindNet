#!/usr/bin/env node
/**
 * 材料转化 CLI：`mindnet.material/1` → 卡片 + 图补丁 + `mindnet.run/1` 请求
 *
 *   node tools/ingest.js --material material.json --check
 *   node tools/ingest.js --material material.json --now-hours 497321.25 --out-dir out/
 *
 * 产出（`--out-dir` 下）：
 *   cards.json          卡片（canonical，含 tts_text 与 tags）
 *   anki/*.tsv          每个 note type 一个文件（Anki 2.1.55+ 的 # 头指令格式）
 *   tts.txt             待合成音频的文本（每行一条）
 *   run_request.json    mindnet.run/1（knowledge 动作 + ★ 的 goal）
 *   graph_patch.json    节点与边（便于人工核对）
 *   summary.txt         一行摘要 + 告警
 *
 * 对应 docs/INGEST.md §6。本工具**不跑模型、不写认知状态** —— 只把材料翻译成标准输入。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const ingest = require('../src/ingest.js');

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--check' || a === '--json' || a === '--quiet') { out[a.slice(2)] = true; continue; }
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

function write(file, text) {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.writeFileSync(file, text, 'utf8');
}

function main(argv) {
  const args = parseArgs(argv || []);
  try {
    if (!args.material || args.material === true) {
      process.stdout.write(
        '用法：node tools/ingest.js --material material.json [--check] [--now-hours <小时>] [--out-dir out/]\n'
        + '      [--deck English::Listening] [--json] [--quiet]\n'
      );
      return 1;
    }
    const env = loadJson(args.material);
    const warnings = (() => {
      try {
        return ingest.validateMaterial(env).warnings;
      } catch (err) {
        process.stderr.write(`✗ 材料信封不合法：${err.message}\n`);
        process.stderr.write('  对照 docs/INGEST.md §2.1 的字段规则与 §5 的提示词自检清单逐条检查。\n');
        return null;
      }
    })();
    if (warnings === null) return 1;

    if (args.check) {
      const patch = ingest.buildGraphPatch(env);
      const carded = ingest.toCards(env);
      const lines = [
        `✓ 信封合法：${env.batch_id} · ${env.items.length} 条`,
        `  将产出：${patch.nodes.length} 节点 / ${patch.edges.length} 边 / ${carded.cards.length} 张卡 / ${carded.tts.length} 条待合成音频`,
      ];
      if (patch.skipped.length) {
        lines.push(`  不进图：${patch.skipped.map((s) => `${s.item}（${s.reason}）`).join('；')}`);
      }
      for (const w of warnings) lines.push(`  ⚠ [${w.kind}] ${w.item}：${w.message}`);
      if (!warnings.length) lines.push('  告警：无');
      lines.push('下一步：node tools/ingest.js --material <同一文件> --now-hours <模型小时> --out-dir out/');
      process.stdout.write(`${lines.join('\n')}\n`);
      return 0;
    }

    const nowHours = args['now-hours'];
    const result = (() => {
      try {
        return ingest.convert(env, {
          now_hours: nowHours === undefined ? undefined : Number(nowHours),
          deck: args.deck === undefined ? undefined : String(args.deck),
        });
      } catch (err) {
        return { error: err };
      }
    })();
    if (result.error) {
      process.stderr.write(`✗ 转化失败：${result.error.message}\n`);
      if (/now_hours/.test(result.error.message)) {
        process.stderr.write('  说明：模型时间基必须显式给（--now-hours <小时>）。'
          + '可以用外壳里显示的现实时间，或上次存档的 hours。\n');
      }
      return 1;
    }

    if (args.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return 0;
    }

    const outDir = args['out-dir'];
    if (!outDir || outDir === true) {
      process.stdout.write(`${result.summary.text}\n`);
      for (const w of result.warnings) process.stdout.write(`  ⚠ [${w.kind}] ${w.item}：${w.message}\n`);
      process.stdout.write('（没有 --out-dir，只做预览；加 --out-dir out/ 才会写文件）\n');
      return 0;
    }

    write(path.join(outDir, 'cards.json'), `${JSON.stringify(result.cards, null, 2)}\n`);
    write(path.join(outDir, 'graph_patch.json'), `${JSON.stringify(result.graph_patch, null, 2)}\n`);
    write(path.join(outDir, 'run_request.json'), `${JSON.stringify(result.run_request, null, 2)}\n`);
    // tts.tsv：文件名与卡片 Audio 字段里的 [sound:...] 一一对应，合成后直接丢进 collection.media
    write(path.join(outDir, 'tts.tsv'), `${result.tts.map((t) => `${t.file}\t${t.text}\t${t.note_type}`).join('\n')}${result.tts.length ? '\n' : ''}`);
    write(path.join(outDir, 'tts.txt'), `${result.tts.map((t) => t.text).join('\n')}${result.tts.length ? '\n' : ''}`);
    write(path.join(outDir, 'anki', 'templates.md'), result.anki_templates);
    for (const [name, text] of Object.entries(result.anki_files)) {
      write(path.join(outDir, 'anki', name), text);
    }
    const summaryLines = [
      result.summary.text,
      '',
      '产出：',
      '  cards.json        卡片（canonical）',
      `  anki/*.tsv        ${Object.keys(result.anki_files).length} 个文件（每 note type 一个，Anki 导入用）`,
      '  anki/templates.md 四个 note type 的字段与正/背面模板（照抄进 Anki）',
      `  tts.tsv           ${result.tts.length} 条待合成音频（文件名 → 文本），与卡片 Audio 字段一一对应`,
      '  tts.txt           同一批文本（纯文本，每行一条）',
      '  run_request.json  mindnet.run/1（用 tools/io_check.js 校验后可交给 io_run.js）',
      '  graph_patch.json  节点与边（人工核对用）',
      '',
      result.warnings.length ? '告警：' : '告警：无',
      ...result.warnings.map((w) => `  ⚠ [${w.kind}] ${w.item}：${w.message}`),
      '',
      '下一步：',
      '  1) 用任意 TTS 按 tts.tsv 合成音频（文件名保持不变），导入 Anki 前放进 collection.media',
      '  2) 按 anki/templates.md 建四个 note type，再导入 anki/*.tsv',
      `  3) node tools/io_check.js --request ${path.join(outDir, 'run_request.json')} --graph <你的图>`,
      `  4) node tools/io_run.js --request ${path.join(outDir, 'run_request.json')} --graph <你的图> --print digest`,
    ];
    write(path.join(outDir, 'summary.txt'), `${summaryLines.join('\n')}\n`);
    process.stdout.write(`${summaryLines.join('\n')}\n`);
    return 0;
  } catch (err) {
    process.stderr.write(`材料转化错误：${err.message}\n`);
    return 1;
  }
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}

module.exports = { main, parseArgs };
