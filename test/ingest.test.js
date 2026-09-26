'use strict';

/**
 * 材料转化层测试（`src/ingest.js` + `tools/ingest.js`，对应 docs/INGEST.md）。
 *
 * 这一层是确定性的：同一个信封必须产出同样的节点 id、同样的卡片、同样的请求。
 * 测试守四件事：
 *   1. 校验严格（缺 margin_note / context / contains 指向不存在 ⇒ 整份拒绝）；
 *   2. 幂等（同一页拍两次 ⇒ 同一批节点 id，不重复）；
 *   3. 转化正确（节点类型、边方向、★ 目标、卡片字段、TSV 头）；
 *   4. 与 IO 层真的接得上（生成的 run_request 能过 io_check 并被 io_run 执行）。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ingest = require('../src/ingest.js');
const io = require('../src/io/run.js');
const { RunArchive } = require('../src/io/archive.js');
const { Graph, Config, createKernel } = require('../src/index.js');
const { FastEngine } = require('../src/v2/engine.js');
const { tmpPath, cleanupTmp } = require('./helpers.js');

const SAMPLE = path.join(__dirname, '..', 'example', 'material', 'en_listening_2026-09-25.json');

function sample() {
  return JSON.parse(fs.readFileSync(SAMPLE, 'utf8').replace(/^\uFEFF/, ''));
}

function tiny(over) {
  return Object.assign({
    protocol: 'mindnet.material/1',
    batch_id: 'b1',
    language: 'en',
    source: { kind: 'photo', refs: ['p1.jpg'], material: '测试材料' },
    items: [
      { id: 'i1', mark: 'W', text: 'resilient', margin_note: 'resilient', context: 'She was resilient.', page: 1, line: 3 },
    ],
  }, over || {});
}

// ------------------------------------------------------------------ 校验

test('材料 · 校验：缺 margin_note / context / contains 悬空 / mark 非法 都要整份拒绝', () => {
  const cases = [
    [{ items: [{ id: 'a', mark: 'W', text: 'x', margin_note: 'x', page: 1, line: 1 }] }, /context/],
    [{ items: [{ id: 'a', mark: 'W', text: 'x', context: 'y', page: 1, line: 1 }] }, /margin_note/],
    [{ items: [{ id: 'a', mark: 'X', text: 'x', page: 1, line: 1 }] }, /记号认不出来/],
    [{ items: [{ id: 'a', mark: 'S', text: 'x', contains: ['nope'], page: 1, line: 1 }] }, /contains 指向不存在/],
    [{ items: [{ id: 'a', mark: 'S', text: 'x', page: 1 }] }, /缺少 line 或 lines/],
    [{ items: [{ id: 'a', mark: 'S', text: 'x', page: 1, line: 1 }, { id: 'a', mark: 'S', text: 'y', page: 1, line: 2 }] }, /id .* 与前面的重复/],
  ];
  for (const [over, re] of cases) {
    assert.throws(() => ingest.validateMaterial(tiny(over)), re, `这类信封必须被拒：${JSON.stringify(over.items)}`);
  }
  assert.throws(() => ingest.validateMaterial({ protocol: 'nope' }), /protocol/);
  assert.throws(() => ingest.validateMaterial({ protocol: 'mindnet.material/1', batch_id: 'b', items: [] }), /非空数组/);
});

test('材料 · 校验：不确定/冲突/重复文本产生告警但不拒绝（上游标了就照办）', () => {
  const env = tiny({
    items: [
      { id: 'i1', mark: 'W', text: 'resilient', margin_note: 'resilient', context: 'a', page: 1, line: 1, uncertain: true, region: '第 3 行页边' },
      { id: 'i2', mark: 'W', text: 'Resilient', margin_note: 'resilient', context: 'b', page: 1, line: 2, conflict: true, conflict_detail: '页边写了 resilent' },
    ],
  });
  const { warnings } = ingest.validateMaterial(env);
  const kinds = warnings.map((w) => w.kind).sort();
  assert.deepEqual(kinds, ['conflict', 'duplicate-text', 'uncertain']);
  assert.match(warnings.find((w) => w.kind === 'uncertain').message, /第 3 行页边/);
});

test('材料 · 记号写法：写「词/搭/句/段/问」和写 W/C/S/T/N 等价（节点 id 完全相同）', () => {
  assert.equal(ingest.canonMark('词'), 'W');
  assert.equal(ingest.canonMark('搭'), 'C');
  assert.equal(ingest.canonMark('句'), 'S');
  assert.equal(ingest.canonMark('段'), 'T');
  assert.equal(ingest.canonMark('问'), 'N');
  assert.equal(ingest.canonMark('会'), 'OK');
  assert.equal(ingest.canonMark('1'), 'W');
  assert.equal(ingest.canonMark('搭 '), 'C');
  assert.equal(ingest.canonMark('W'), 'W');
  assert.equal(ingest.canonMark('n'), 'N');
  assert.equal(ingest.canonMark('看不懂的记号'), '看不懂的记号', '认不出来就原样返回，交给校验报错');
  assert.equal(ingest.writtenMark('W'), '词');
  // 幂等的前提：两种写法落到同一个节点 id
  assert.equal(ingest.nodeId('en', '词', 'Resilient'), ingest.nodeId('en', 'W', 'Resilient'));
  assert.equal(ingest.nodeId('en', '句', 'It  took a while.'), ingest.nodeId('en', 'S', 'It took a while.'));
  // 中文记号也能端到端跑
  const env = tiny({
    items: [{ id: 'i1', mark: '词', text: 'resilient', context: 'She was resilient.', margin_note: 'resilient', page: 1, line: 3 }],
  });
  const cards = ingest.toCards(env).cards;
  assert.equal(cards[0].note_type, 'EN::Listen::Word');
  assert.ok(cards[0].tags.indexOf('写::词') >= 0, '卡片上要留下"你写的是哪个记号"');
  assert.equal(ingest.buildGraphPatch(env).nodes[0].id, 'en::w::resilient');
});

test('材料 · 两条省事通道：一行只有一处可以不抄 / 用点子标词 —— 都必须显式说明，否则仍拒绝', () => {
  // ① 一行只有一处要记 ⇒ 可以不抄，但要标 inferred_from_line
  const fromLine = tiny({
    items: [{ id: 'i1', mark: '词', text: 'resilient', context: 'She was resilient.', page: 1, line: 3, inferred_from_line: true }],
  });
  const w1 = ingest.validateMaterial(fromLine).warnings;
  assert.equal(w1.some((w) => w.kind === 'inferred-scope'), true);
  assert.equal(ingest.toCards(fromLine).cards[0].tags.indexOf('scope_from_line') >= 0, true);

  // ② 词下点了个点 ⇒ 可以不抄，但要标 marked_by: 'dot'
  const byDot = tiny({
    items: [{ id: 'i1', mark: '词', text: 'resilient', context: 'She was resilient.', page: 1, line: 3, marked_by: 'dot', dot_position: '第 4 个词下方' }],
  });
  const w2 = ingest.validateMaterial(byDot).warnings;
  assert.equal(w2.some((w) => w.kind === 'dot-mark'), true);
  assert.match(w2.find((w) => w.kind === 'dot-mark').message, /第 4 个词下方/);
  assert.equal(ingest.toCards(byDot).cards[0].tags.indexOf('scope_dot') >= 0, true);

  // ③ 什么都不说 ⇒ 仍然拒绝（不许 AI 偷偷猜）
  const silent = tiny({
    items: [{ id: 'i1', mark: '词', text: 'resilient', context: 'She was resilient.', page: 1, line: 3 }],
  });
  assert.throws(() => ingest.validateMaterial(silent), /margin_note/);
});

// ------------------------------------------------------------------ 幂等

test('材料 · 幂等：同一页拍两次 ⇒ 同样的节点 id，不重复建', () => {
  const a = ingest.buildGraphPatch(sample());
  const b = ingest.buildGraphPatch(sample());
  assert.deepEqual(a.nodes.map((n) => n.id), b.nodes.map((n) => n.id));
  assert.deepEqual(a.edges.map((e) => e.id), b.edges.map((e) => e.id));
  // 词用 slug、句用哈希 ⇒ 都能稳定复现
  assert.equal(ingest.nodeId('en', 'W', 'Resilient'), 'en::w::resilient');
  assert.equal(ingest.nodeId('en', 'W', 'resilient'), 'en::w::resilient');
  assert.equal(ingest.nodeId('en', 'S', 'It  took me a while.'), ingest.nodeId('en', 'S', 'It took me a while.'));
  assert.match(ingest.nodeId('en', 'S', 'anything'), /^en::s::[0-9a-f]{8}$/);
});

// ------------------------------------------------------------ 图补丁与卡

test('材料 · 图补丁：词/搭配=knowledge、句=logic、疑问不进图、主题建 hub', () => {
  const env = sample();
  const patch = ingest.buildGraphPatch(env);
  const byId = new Map(patch.nodes.map((n) => [n.id, n]));
  assert.equal(byId.get('en::w::resilient').type, 'knowledge');
  assert.equal(byId.get('en::c::get-the-hang-of').type, 'knowledge');
  assert.equal(patch.nodes.find((n) => n.id.startsWith('en::s::')).type, 'logic');
  assert.equal(byId.has('en::topic::travel'), true, '主题应当建 hub 节点');
  assert.equal(patch.nodes.some((n) => n.id.indexOf('m5') >= 0), false);
  assert.equal(patch.skipped.some((s) => s.item === 'm5'), true, '疑问要出现在 skipped 里');
  // contains ⇒ 句 → 搭配 的边；produce ⇒ 反向边
  const sId = patch.nodes.find((n) => n.id.startsWith('en::s::')).id;
  assert.equal(patch.edges.some((e) => e.from === sId && e.to === 'en::c::get-the-hang-of'), true);
  assert.equal(patch.edges.some((e) => e.from === 'en::c::get-the-hang-of' && e.to === sId), true, 'produce 要建反向边');
  // 主题 hub 挂到所有条目
  assert.ok(patch.edges.filter((e) => e.from === 'en::topic::travel').length >= 5);
});

test('材料 · 卡片：听力卡带音频引用（不是空白正面）、释义来自 AI 的打待核对、produce 出产出卡', () => {
  const { cards, tts } = ingest.toCards(sample());
  const word = cards.find((c) => c.note_type === 'EN::Listen::Word' && c.fields.Word === 'resilient');
  assert.match(word.fields.Audio, /^\[sound:en__w__resilient\.mp3\]$/, 'Audio 必须是可用的媒体引用');
  assert.ok(word.tags.indexOf('meaning_check') >= 0, 'AI 给的释义要标待核对');
  assert.ok(word.tags.indexOf('priority::star') >= 0);
  const userMeaning = cards.find((c) => c.fields.Word === 'timetable');
  assert.equal(userMeaning.tags.indexOf('meaning_check'), -1, '自己写的释义不用标待核对');
  assert.ok(userMeaning.tags.indexOf('exception') >= 0);
  const sCard = cards.find((c) => c.note_type === 'EN::Listen::Sentence');
  assert.equal(sCard.fields.KeyChunk, 'get the hang of', '句卡要带关键词块');
  assert.equal(cards.filter((c) => c.note_type === 'EN::Listen::Produce').length, 2);
  // tts 与卡片字段一一对应
  const files = tts.map((t) => t.file);
  assert.deepEqual(files.slice().sort(), ['en__c__get-the-hang-of.mp3', 'en__s__' + ingest.hash8('It took me a while to get the hang of it.') + '.mp3', 'en__w__resilient.mp3', 'en__w__timetable.mp3'].sort());
  for (const t of tts) assert.ok(t.text && t.note_type);
});

test('材料 · Anki 文件：每 note type 一个文件、头指令齐全、字段数与 tags 列号对得上', () => {
  const r = ingest.convert(sample(), { now_hours: 497321.25 });
  const names = Object.keys(r.anki_files).sort();
  assert.deepEqual(names, ['EN.Listen.Chunk.tsv', 'EN.Listen.Produce.tsv', 'EN.Listen.Sentence.tsv', 'EN.Listen.Word.tsv']);
  const wordTsv = r.anki_files['EN.Listen.Word.tsv'];
  const lines = wordTsv.trim().split('\n');
  assert.equal(lines[0], '#separator:tab');
  assert.equal(lines[1], '#html:false');
  assert.equal(lines[2], '#notetype:EN::Listen::Word');
  assert.equal(lines[3], '#deck:English::Listening');
  assert.equal(lines[4], `#tags column:${ingest.CARD_FIELDS['EN::Listen::Word'].length + 1}`);
  const fields = ingest.CARD_FIELDS['EN::Listen::Word'];
  const audioIdx = fields.indexOf('Audio');
  for (const row of lines.slice(5)) {
    const cells = row.split('\t');
    assert.equal(cells.length, fields.length + 1, `列数不对：${row}`);
    assert.match(cells[audioIdx], /^\[sound:.+\.mp3\]$/, `Audio 列不能为空（否则正面是空的）：${row}`);
    assert.ok(cells[0].length > 0, 'Word 列不能为空');
  }
  assert.match(wordTsv.split('\n')[5], /\[sound:en__w__resilient\.mp3\]/);
  // 允许其它列为空（例如没给 IPA 的词），那是正常的
  assert.match(wordTsv, /\t\t/, 'timetable 没有 IPA，应当出现空列（这是允许的）');
  // 模板说明里四个 note type 都在，且字段名一致
  for (const nt of Object.keys(ingest.CARD_FIELDS)) assert.match(r.anki_templates, new RegExp(nt));
  assert.match(r.anki_templates, /collection\.media/);
});

// ------------------------------------------------------------------ 请求

test('材料 · 请求：先节点后边、run_id 由 batch_id 决定、★ 条目设为目标、时间基必填', () => {
  const r = ingest.convert(sample(), { now_hours: 497321.25 });
  const req = r.run_request;
  assert.equal(req.protocol, 'mindnet.run/1');
  assert.equal(req.run_id, 'ingest-en-listen-2026-09-25-a');
  const kinds = req.actions.map((a) => a.kind);
  assert.equal(kinds[kinds.length - 1], 'goal');
  const firstEdge = kinds.indexOf('knowledge') + r.graph_patch.nodes.length;
  // 节点动作全部在边动作之前
  const nodeActions = req.actions.filter((a) => a.node);
  assert.equal(nodeActions.length, r.graph_patch.nodes.length);
  assert.equal(req.actions.filter((a) => a.edge).length, r.graph_patch.edges.length);
  assert.equal(kinds.slice(0, nodeActions.length).every((k) => k === 'knowledge'), true);
  assert.equal(firstEdge > nodeActions.length - 1, true);
  assert.deepEqual(req.actions[kinds.length - 1].targets, ['en::w::resilient', 'en::c::get-the-hang-of']);
  // 每条动作都有时间基与出处
  for (const a of req.actions) {
    assert.equal(Number.isFinite(a.at.model_hours), true);
    assert.equal(a.evidence.batch_id, req.run_id.replace(/^ingest-/, ''));
  }
  assert.throws(() => ingest.toRunRequest(sample(), {}), /now_hours/);
});

test('材料 · 端到端：生成的请求能过 IO 层校验、能被执行、且重复提交幂等', () => {
  const r = ingest.convert(sample(), { now_hours: 100 });
  const graph = Graph.from_object({
    nodes: [{ id: 'seed', name: '起点', type: 'knowledge', ms: 0.8 }],
    edges: [],
  }, 0);
  const kernel = createKernel(graph, new Config(), { seed: 7, hours: 0, profile: 'v2' });
  const engine = new FastEngine(graph, kernel.config, { kernel });
  engine.start_diffusion([], []);
  const archive = new RunArchive();
  const res = io.run({ engine, kernel, request: r.run_request, archive });
  assert.equal(res.status, 'ok');
  assert.equal(res.applied.length, r.run_request.actions.length);
  // 节点与边真的进了图
  assert.equal(graph.has_node('en::w::resilient'), true);
  assert.equal(graph.has_node('en::topic::travel'), true);
  assert.equal(graph.out_edges('en::topic::travel').length >= 5, true);
  assert.equal(res.trace.invariants.ok, true, res.trace.invariants.problems.join('; '));
  // 幂等：同一 batch 再跑一次，节点数不变
  const before = graph.size;
  const again = io.run({ engine, kernel, request: r.run_request, archive });
  assert.equal(again.replay, true);
  assert.equal(graph.size, before);
});

test('材料 · CLI：--check 只校验不写文件；--out-dir 产出五样东西；非法信封返回 1', () => {
  const { main } = require('../tools/ingest.js');
  const out = [];
  const err = [];
  const so = process.stdout.write;
  const se = process.stderr.write;
  const capture = (fn) => {
    out.length = 0; err.length = 0;
    process.stdout.write = (s) => { out.push(String(s)); return true; };
    process.stderr.write = (s) => { err.push(String(s)); return true; };
    try { return fn(); } finally { process.stdout.write = so; process.stderr.write = se; }
  };

  const check = capture(() => main(['--material', SAMPLE, '--check']));
  assert.equal(check, 0, err.join(''));
  assert.match(out.join(''), /信封合法/);
  assert.match(out.join(''), /不进图：m5/);

  const dir = tmpPath(`ingest_${process.pid}`);
  const run = capture(() => main(['--material', SAMPLE, '--now-hours', '497321.25', '--out-dir', dir]));
  assert.equal(run, 0, err.join(''));
  for (const f of ['cards.json', 'graph_patch.json', 'run_request.json', 'tts.tsv', 'tts.txt', 'summary.txt',
    path.join('anki', 'templates.md'), path.join('anki', 'EN.Listen.Word.tsv')]) {
    assert.equal(fs.existsSync(path.join(dir, f)), true, `缺少产出 ${f}`);
  }
  const tts = fs.readFileSync(path.join(dir, 'tts.tsv'), 'utf8').trim().split('\n');
  assert.equal(tts.length, 4);
  assert.match(tts[0], /\.mp3\t/);

  const bad = tmpPath(`bad_${process.pid}.json`);
  fs.writeFileSync(bad, JSON.stringify({ protocol: 'mindnet.material/1', batch_id: 'b', items: [{ id: 'x', mark: 'W', text: 'w', page: 1, line: 1 }] }), 'utf8');
  const badCode = capture(() => main(['--material', bad, '--check']));
  assert.equal(badCode, 1);
  assert.match(err.join(''), /margin_note/);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.unlinkSync(bad);
  cleanupTmp();
});
