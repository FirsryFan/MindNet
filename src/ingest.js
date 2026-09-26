/**
 * MindNet 材料转化层：`mindnet.material/1` → 知识图补丁 + 卡片 + `mindnet.run/1` 请求
 *
 * 这一层是**确定性纯函数**：同一个信封进去，同样的图/卡/请求出来。
 * 它不读照片、不调 AI、不猜内容 —— 那些都在上游（docs/MARKS.md 的记号 + docs/INGEST.md §5 的提示词）。
 *
 * 三条设计原则（docs/INGEST.md §7）：
 *   1. 原始/印刷材料是权威，手写只用于消歧（`corrected` / `conflict` 由上游标好，本层只照办）；
 *   2. 一个量只有一个主人：本层不排程、不写 S，只产出"材料"与"请求"；
 *   3. 幂等：节点 id 由内容确定，run_id 由 batch_id 确定 ⇒ 同一页拍两次不会重复建节点。
 */
(function () {
  'use strict';

  const isNode = typeof module !== 'undefined' && !!module.exports;
  const deps = isNode ? require('./config.js') : (globalThis.MindNet || {});
  const { MindNetError } = deps;

  const MATERIAL_PROTOCOL = 'mindnet.material/1';
  const RUN_PROTOCOL = 'mindnet.run/1';

  /** 记号表（换记号只改这里；对应 docs/MARKS.md §2） */
  const MARKS = Object.freeze({
    W: { name: 'word', node_type: 'knowledge', card: 'EN::Listen::Word', copy_to_margin: true },
    C: { name: 'chunk', node_type: 'knowledge', card: 'EN::Listen::Chunk', copy_to_margin: true },
    S: { name: 'sentence', node_type: 'logic', card: 'EN::Listen::Sentence', copy_to_margin: false },
    T: { name: 'passage', node_type: 'knowledge', card: null, copy_to_margin: false },
    N: { name: 'note', node_type: null, card: null, copy_to_margin: true },
    OK: { name: 'known', node_type: null, card: null, copy_to_margin: false },
  });

  const MODIFIERS = ['star', 'produce', 'needs_review', 'exception'];

  /**
   * 边权默认值：**全部未标定**（docs/INGEST.md 明确写了）。
   * 放在一处便于以后用数据替换 —— 现在只是"量级合理"。
   */
  const LS_DEFAULTS = Object.freeze({
    sentence_to_chunk: 0.6,   // 听到整句 → 该能听出这个词块
    chunk_to_sentence: 0.6,   // 想到词块 → 该能说出整句（produce）
    topic_to_item: 0.4,       // 主题 hub → 条目
  });

  const CARD_FIELDS = Object.freeze({
    'EN::Listen::Word': ['Word', 'Meaning', 'IPA', 'Audio', 'Example', 'Source'],
    'EN::Listen::Chunk': ['Chunk', 'Meaning', 'Audio', 'Example', 'Source'],
    'EN::Listen::Sentence': ['Audio', 'Text', 'Meaning', 'KeyChunk', 'Source'],
    'EN::Listen::Produce': ['Prompt', 'Target', 'Audio', 'Source'],
  });

  function fail(msg) {
    throw new MindNetError(msg);
  }

  function round6(x) {
    if (typeof x !== 'number' || !Number.isFinite(x)) return x;
    return Math.round(x * 1e6) / 1e6;
  }

  // ------------------------------------------------------------ 文本规范化

  /** 规范化：用于 id 与哈希（不改动展示用的原文） */
  function normalize(text) {
    return String(text === undefined || text === null ? '' : text)
      .normalize('NFC')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }

  /** 稳定 slug：只留字母数字，用连字符连接；非拉丁字符退化为空（用哈希兜底） */
  function slug(text) {
    const s = normalize(text)
      .replace(/[’']/g, '')
      .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
      .replace(/^-+|-+$/g, '');
    return s.slice(0, 48);
  }

  /** 32 位 FNV-1a：稳定、无依赖、跨语言易复刻（Dart 那边照抄 5 行） */
  function hash8(text) {
    let h = 0x811c9dc5;
    const s = normalize(text);
    for (let i = 0; i < s.length; i += 1) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
  }

  /** 节点 id：内容确定 ⇒ 同一页拍两次不会重复建节点 */
  function nodeId(language, mark, text) {
    const lang = (language || 'en').toLowerCase();
    const kind = (mark || 'x').toLowerCase();
    const key = mark === 'S' || mark === 'T' ? hash8(text) : slug(text);
    return `${lang}::${kind}::${key || hash8(text)}`;
  }

  function topicId(language, topic) {
    return `${(language || 'en').toLowerCase()}::topic::${slug(topic)}`;
  }

  // ------------------------------------------------------------------ 校验

  /**
   * 校验材料信封。不合法就整份拒绝（与 IO 层同一原则：绝不半途生效）。
   * @returns {{items: Array, warnings: Array}}
   */
  function validateMaterial(env) {
    if (!env || typeof env !== 'object') fail('材料信封必须是对象');
    if (env.protocol !== MATERIAL_PROTOCOL) {
      fail(`材料信封的 protocol 必须是 "${MATERIAL_PROTOCOL}"，实际 ${JSON.stringify(env.protocol)}`);
    }
    if (typeof env.batch_id !== 'string' || !env.batch_id) fail('材料信封缺少 batch_id（幂等键）');
    if (!Array.isArray(env.items) || env.items.length === 0) fail('材料信封的 items 必须是非空数组');

    const warnings = [];
    const seen = new Map();          // id → item
    const byText = new Map();        // 规范化文本 → id（查重）
    env.items.forEach((raw, i) => {
      const at = `第 ${i + 1} 条 item`;
      if (!raw || typeof raw !== 'object') fail(`${at} 不是对象`);
      if (typeof raw.id !== 'string' || !raw.id) fail(`${at} 缺少 id`);
      if (seen.has(raw.id)) fail(`${at} 的 id "${raw.id}" 与前面的重复`);
      if (!MARKS[raw.mark]) {
        fail(`${at} 的 mark 必须是 ${Object.keys(MARKS).join(' / ')}，实际 ${JSON.stringify(raw.mark)}`);
      }
      if (typeof raw.text !== 'string' || !raw.text.trim()) fail(`${at} 缺少 text`);
      if (!Number.isFinite(Number(raw.page))) fail(`${at} 缺少 page`);
      const hasLine = Number.isFinite(Number(raw.line))
        || (Array.isArray(raw.lines) && raw.lines.length === 2
          && raw.lines.every((x) => Number.isFinite(Number(x))));
      if (!hasLine) fail(`${at} 缺少 line 或 lines`);

      const mark = MARKS[raw.mark];
      if (mark.copy_to_margin && raw.mark !== 'OK' && !hasText(raw.margin_note)) {
        fail(`${at}（${raw.mark}）缺少 margin_note：页边照抄的那一份必须给出来（docs/MARKS.md §3.1）`);
      }
      if ((raw.mark === 'W' || raw.mark === 'C') && !hasText(raw.context)) {
        fail(`${at}（${raw.mark}）缺少 context：正文里的那一句是例句来源`);
      }
      if (raw.modified !== undefined) {
        if (!Array.isArray(raw.modified)) fail(`${at} 的 modified 必须是数组`);
        for (const m of raw.modified) {
          if (MODIFIERS.indexOf(m) < 0) fail(`${at} 的修饰符 "${m}" 不在 ${MODIFIERS.join(' / ')} 里`);
        }
      }
      const norm = normalize(raw.text);
      if (byText.has(norm) && !raw.duplicate_of) {
        warnings.push({ item: raw.id, kind: 'duplicate-text', message: `与 "${byText.get(norm)}" 文本相同（未标 duplicate_of）` });
      } else if (!byText.has(norm)) {
        byText.set(norm, raw.id);
      }
      if (raw.uncertain) warnings.push({ item: raw.id, kind: 'uncertain', message: `上游标了不确定：${raw.region || '（未给位置）'}` });
      if (raw.conflict) warnings.push({ item: raw.id, kind: 'conflict', message: `页边与正文冲突：${raw.conflict_detail || '（未给细节）'}` });
      seen.set(raw.id, raw);
    });

    // contains 只能指向本批次内的 id
    env.items.forEach((raw) => {
      if (raw.contains === undefined) return;
      if (!Array.isArray(raw.contains)) fail(`item "${raw.id}" 的 contains 必须是数组`);
      for (const ref of raw.contains) {
        if (!seen.has(ref)) fail(`item "${raw.id}" 的 contains 指向不存在的 id "${ref}"`);
      }
    });

    return { items: env.items, warnings };
  }

  function hasText(x) {
    return typeof x === 'string' && x.trim() !== '';
  }

  function modifiersOf(item) {
    const out = new Set(Array.isArray(item.modified) ? item.modified : []);
    if (item.priority === 'star') out.add('star');
    if (item.produce === true) out.add('produce');
    return out;
  }

  // -------------------------------------------------------- 知识图补丁

  /**
   * 材料 → 图补丁（节点 + 边）。顺序：先节点后边（边要求两端存在）。
   * @returns {{nodes: Array, edges: Array, skipped: Array}}
   */
  function buildGraphPatch(env) {
    validateMaterial(env);
    const lang = env.language || 'en';
    const nodes = [];
    const edges = [];
    const skipped = [];
    const idOf = new Map();     // 信封 id → 节点 id

    for (const item of env.items) {
      const meta = MARKS[item.mark];
      if (!meta.node_type) {
        skipped.push({ item: item.id, mark: item.mark, reason: item.mark === 'N' ? '疑问不进图（先答复，再决定是否建节点）' : '标记为已知' });
        continue;
      }
      if (item.duplicate_of) {
        idOf.set(item.id, idOf.get(item.duplicate_of) || null);
        skipped.push({ item: item.id, mark: item.mark, reason: `与 ${item.duplicate_of} 重复` });
        continue;
      }
      const id = nodeId(lang, item.mark, item.text);
      idOf.set(item.id, id);
      nodes.push({
        id,
        name: item.text.slice(0, 80),
        type: meta.node_type,
        // 这些不是模型状态，只是"材料元数据"，随节点名/权重一起带过去
        meta: {
          mark: item.mark,
          meaning: item.meaning === undefined ? null : item.meaning,
          meaning_source: item.meaning_source === undefined ? null : item.meaning_source,
          ipa: item.ipa === undefined ? null : item.ipa,
          context: item.context === undefined ? null : item.context,
          source: env.source ? env.source.material || null : null,
          page: Number(item.page),
          line: Number(item.line) || (item.lines ? Number(item.lines[0]) : null),
          tts_text: item.text,
          modifiers: Array.from(modifiersOf(item)),
          uncertain: !!item.uncertain,
        },
      });
    }

    // contains：听到整句要能听出这个词块
    for (const item of env.items) {
      if (!Array.isArray(item.contains)) continue;
      const from = idOf.get(item.id);
      if (!from) continue;
      for (const ref of item.contains) {
        const to = idOf.get(ref);
        if (!to || to === from) continue;
        edges.push({ id: `e_${from}__${to}`, from, to, ls: LS_DEFAULTS.sentence_to_chunk, why: 'contains' });
      }
    }

    // produce：想到它要能说出整句（反向边）
    for (const item of env.items) {
      const mods = modifiersOf(item);
      if (!mods.has('produce') || item.mark === 'S' || item.mark === 'T') continue;
      const from = idOf.get(item.id);
      if (!from) continue;
      // 找到包含它的句子/语段
      for (const parent of env.items) {
        if (!Array.isArray(parent.contains) || parent.contains.indexOf(item.id) < 0) continue;
        const to = idOf.get(parent.id);
        if (!to) continue;
        edges.push({ id: `e_${from}__${to}`, from, to, ls: LS_DEFAULTS.chunk_to_sentence, why: 'produce' });
      }
    }

    // 主题 hub
    if (hasText(env.topic)) {
      const hub = topicId(lang, env.topic);
      nodes.push({
        id: hub,
        name: `#${env.topic}`,
        type: 'knowledge',
        meta: { mark: 'TOPIC', source: env.source ? env.source.material || null : null, tts_text: null, modifiers: [], uncertain: false },
      });
      for (const node of nodes) {
        if (node.id === hub) continue;
        edges.push({ id: `e_${hub}__${node.id}`, from: hub, to: node.id, ls: LS_DEFAULTS.topic_to_item, why: 'topic' });
      }
    }

    return { nodes, edges, skipped };
  }

  // ------------------------------------------------------------------ 卡片

  /**
   * 材料 → 卡片（Anki 式）。
   * 关键：听力卡是"听音 → 想意思"，所以每张卡都带 Audio / tts_text；
   * 没有音频文件时正面退化为 IPA（仍在听觉通道上）。
   *
   * `Audio` 字段直接写成 Anki 的媒体引用 `[sound:<文件名>]`，
   * 文件名由节点 id 确定（`en__w__resilient.mp3`），因此 `tts.tsv` 里给出的文件名
   * 与卡片字段**天然对齐**：合成完丢进 collection.media 即可，不需要再手工填。
   */
  function toCards(env) {
    validateMaterial(env);
    const cards = [];
    const tts = [];                      // {file, text, note_type}
    const seenTts = new Set();
    const source = env.source ? (env.source.material || null) : null;
    const byId = new Map(env.items.map((i) => [i.id, i]));
    const lang = env.language || 'en';

    const audioFile = (mark, text) => `${nodeId(lang, mark, text).replace(/::/g, '__')}.mp3`;
    const audioRef = (mark, text) => `[sound:${audioFile(mark, text)}]`;
    const pushTts = (file, text, noteType) => {
      if (seenTts.has(file)) return;
      seenTts.add(file);
      tts.push({ file, text, note_type: noteType });
    };

    for (const item of env.items) {
      const meta = MARKS[item.mark];
      if (!meta.card) continue;
      const mods = modifiersOf(item);
      const flags = [];
      if (mods.has('star')) flags.push('priority::star');
      if (mods.has('exception')) flags.push('exception');
      if (mods.has('needs_review')) flags.push('needs_review');
      if (item.uncertain) flags.push('uncertain');
      if (item.meaning_source === 'ai') flags.push('meaning_check');
      const tags = [`mark::${item.mark}`, ...flags, ...(env.topic ? [`topic::${slug(env.topic)}`] : [])];
      const audio = audioRef(item.mark, item.text);

      if (item.mark === 'W' || item.mark === 'C') {
        const field = item.mark === 'W' ? 'Word' : 'Chunk';
        cards.push({
          note_type: meta.card,
          fields: {
            [field]: item.text,
            Meaning: item.meaning || '',
            IPA: item.ipa || '',
            Audio: audio,
            Example: item.context || '',
            Source: sourceLine(source, item),
          },
          tags,
          tts_text: item.text,
        });
        pushTts(audioFile(item.mark, item.text), item.text, meta.card);
        if (mods.has('produce')) {
          cards.push({
            note_type: 'EN::Listen::Produce',
            fields: {
              Prompt: item.meaning ? `${item.meaning}（用英语说）` : `用英语说：${item.text}`,
              Target: item.text,
              Audio: audio,
              Source: sourceLine(source, item),
            },
            tags: [...tags, 'produce'],
            tts_text: item.text,
          });
        }
      } else if (item.mark === 'S') {
        const keyChunk = (item.contains || []).map((ref) => (byId.get(ref) || {}).text).filter(Boolean).join(' / ');
        cards.push({
          note_type: meta.card,
          fields: {
            Audio: audio,
            Text: item.text,
            Meaning: item.meaning || '',
            KeyChunk: keyChunk,
            Source: sourceLine(source, item),
          },
          tags,
          tts_text: item.text,
        });
        pushTts(audioFile(item.mark, item.text), item.text, meta.card);
        if (mods.has('produce')) {
          cards.push({
            note_type: 'EN::Listen::Produce',
            fields: {
              Prompt: item.meaning ? `${item.meaning}（用英语说整句）` : `用英语说出这句：${item.text}`,
              Target: item.text,
              Audio: audio,
              Source: sourceLine(source, item),
            },
            tags: [...tags, 'produce'],
            tts_text: item.text,
          });
        }
      }
      // T（语段）不出卡：整段不适合塞进一张卡；它作为节点存在，参与理解与连接
    }

    return { cards, tts };
  }

  function sourceLine(source, item) {
    const where = item.lines ? `第 ${item.lines[0]}–${item.lines[1]} 行` : `第 ${item.line} 行`;
    return [source, `p${item.page} ${where}`].filter(Boolean).join(' · ');
  }

  /** Anki 导入文件（2.1.55+ 的 `#` 头指令格式）；**一个 note type 一个文件** */
  function toAnkiFiles(cards, options) {
    const opts = options || {};
    const deck = opts.deck || 'English::Listening';
    const groups = new Map();
    for (const card of cards) {
      if (!groups.has(card.note_type)) groups.set(card.note_type, []);
      groups.get(card.note_type).push(card);
    }
    const files = {};
    for (const [noteType, list] of groups) {
      const fields = CARD_FIELDS[noteType];
      if (!fields) fail(`未知卡片类型 ${noteType}（CARD_FIELDS 里没有）`);
      const lines = [
        '#separator:tab',
        '#html:false',
        `#notetype:${noteType}`,
        `#deck:${deck}`,
        `#tags column:${fields.length + 1}`,
      ];
      for (const card of list) {
        const row = fields.map((f) => clean(String(card.fields[f] === undefined ? '' : card.fields[f])));
        row.push(card.tags.join(' '));
        lines.push(row.join('\t'));
      }
      files[`${noteType.replace(/::/g, '.')}.tsv`] = `${lines.join('\n')}\n`;
    }
    return files;
  }

  /** TSV 里不能出现的字符（制表符/换行）与会被 Anki 当 HTML 的尖括号 */
  function clean(s) {
    return s.replace(/[\t\r\n]+/g, ' ').replace(/[<>]/g, (c) => (c === '<' ? '‹' : '›')).trim();
  }

  /**
   * Anki 卡片模板（正面/背面）：**一次性粘进 Anki 建四个 note type**。
   * 正面都带 `{{#Audio}}...{{/Audio}}{{^Audio}}...{{/Audio}}` 退化分支：
   * 音频还没合成时不会出现空白正面（听不到就退到 IPA / 文本提示）。
   */
  const ANKI_TEMPLATES = Object.freeze({
    'EN::Listen::Word': {
      fields: ['Word', 'Meaning', 'IPA', 'Audio', 'Example', 'Source'],
      front: '{{#Audio}}{{Audio}}{{/Audio}}{{^Audio}}{{IPA}}{{/Audio}}',
      back: '{{FrontSide}}<hr id=answer><b>{{Word}}</b> {{IPA}}<br>{{Meaning}}<br><i>{{Example}}</i><br><small>{{Source}}</small>',
    },
    'EN::Listen::Chunk': {
      fields: ['Chunk', 'Meaning', 'Audio', 'Example', 'Source'],
      front: '{{Audio}}',
      back: '{{FrontSide}}<hr id=answer><b>{{Chunk}}</b><br>{{Meaning}}<br><i>{{Example}}</i><br><small>{{Source}}</small>',
    },
    'EN::Listen::Sentence': {
      fields: ['Audio', 'Text', 'Meaning', 'KeyChunk', 'Source'],
      front: '{{Audio}}',
      back: '{{FrontSide}}<hr id=answer>{{Text}}<br>{{Meaning}}<br><b>{{KeyChunk}}</b><br><small>{{Source}}</small>',
    },
    'EN::Listen::Produce': {
      fields: ['Prompt', 'Target', 'Audio', 'Source'],
      front: '{{Prompt}}',
      back: '{{FrontSide}}<hr id=answer><b>{{Target}}</b><br>{{Audio}}<br><small>{{Source}}</small>',
    },
  });

  /** 生成一份可照抄的模板说明（Anki 建 note type 时用） */
  function toAnkiTemplates(options) {
    const o = options || {};
    const deck = o.deck || 'English::Listening';
    const lines = [
      '# Anki 建卡说明（照抄即可）',
      '',
      `牌组：${deck}`,
      '',
      '每个 note type 建一次，字段名必须**完全一致**（大小写敏感）。',
      '导入时用同一个 note type，字段按顺序对应。',
      '',
      '> `Audio` 字段里已经是 `[sound:xxx.mp3]` 形式的媒体引用：',
      '> 把 `tts.tsv` 交给任意 TTS 批量合成、文件名保持不变，丢进',
      '> `collection.media` 就能发声；还没合成时正面会退化（见下面的模板）。',
      '',
    ];
    for (const [noteType, t] of Object.entries(ANKI_TEMPLATES)) {
      lines.push(`## ${noteType}`);
      lines.push('');
      lines.push(`字段（${t.fields.length} 个，按顺序）：${t.fields.map((f) => `\`${f}\``).join(' · ')}`);
      lines.push('');
      lines.push('正面模板：');
      lines.push('```html');
      lines.push(t.front);
      lines.push('```');
      lines.push('');
      lines.push('背面模板：');
      lines.push('```html');
      lines.push(t.back);
      lines.push('```');
      lines.push('');
    }
    lines.push('## 建议的牌组选项');
    lines.push('');
    lines.push('- 新卡/复习上限：先按你的时间预算设，`★` 条目在 MindNet 侧会被设为目标（优先照亮）');
    lines.push('- **排程只留一个主人**：见 `docs/INGEST.md` §4（推荐 A：MindNet 决定什么时候碰，Anki 只当播放器）');
    lines.push('- 若选 B（Anki 排程），用 `--due-from-schedule` 生成到期列，之后别再参考 MindNet 的排程提示');
    lines.push('');
    return `${lines.join('\n')}`;
  }

  // ------------------------------------------------------------------ 请求

  /**
   * 材料 → `mindnet.run/1` 请求（knowledge 动作，先节点后边；★ 条目额外设为目标）。
   * @param {object} env 材料信封
   * @param {object} opts { now_hours, starts?, run_id?, include_topic_goal? }
   */
  function toRunRequest(env, opts) {
    const o = opts || {};
    validateMaterial(env);
    const now = o.now_hours;
    if (!Number.isFinite(Number(now))) {
      fail('toRunRequest 需要 now_hours（模型时间基；不许默默用"现在"，见 docs/IO_PROTOCOL.md §3.3）');
    }
    const patch = buildGraphPatch(env);
    const actions = [];
    const at = { model_hours: round6(Number(now)) };

    for (const node of patch.nodes) {
      actions.push({
        kind: 'knowledge',
        node: { id: node.id, name: node.name, type: node.type },
        at: Object.assign({}, at),
        confidence: node.meta && node.meta.uncertain ? 0.5 : 0.9,
        evidence: {
          source: env.source && env.source.refs ? env.source.refs[0] : null,
          region: `第 ${node.meta ? node.meta.page : '?'} 页`,
          quote: node.meta && node.meta.margin_note ? node.meta.margin_note : null,
          batch_id: env.batch_id,
        },
      });
    }
    for (const edge of patch.edges) {
      actions.push({
        kind: 'knowledge',
        edge: { id: edge.id, from: edge.from, to: edge.to, ls: edge.ls },
        at: Object.assign({}, at),
        confidence: 0.8,
        evidence: { source: env.source && env.source.refs ? env.source.refs[0] : null, region: `边：${edge.why}`, batch_id: env.batch_id },
      });
    }

    // ★ 条目设为目标：目标偏置会优先照亮它们（目标自身不吃偏置，见 context.goal）
    const starred = patch.nodes
      .filter((n) => n.meta && Array.isArray(n.meta.modifiers) && n.meta.modifiers.indexOf('star') >= 0)
      .map((n) => n.id);
    if (starred.length && o.include_topic_goal !== false) {
      actions.push({
        kind: 'goal',
        targets: starred,
        starts: o.starts && o.starts.length ? o.starts.slice() : undefined,
        at: Object.assign({}, at),
        evidence: { region: '★ 高优先级条目', batch_id: env.batch_id },
      });
    }

    return {
      protocol: RUN_PROTOCOL,
      run_id: o.run_id || `ingest-${env.batch_id}`,
      time: { model_hours: round6(Number(now)), wall: env.source ? env.source.captured_at || null : null },
      actions,
      meta: { source: 'ingest', note: `材料批次 ${env.batch_id}：${patch.nodes.length} 节点 / ${patch.edges.length} 边` },
    };
  }

  // ------------------------------------------------------------------ 总入口

  /**
   * 一次产出全部四样。
   * @returns {{cards, anki_files, tts, run_request, graph_patch, warnings, summary}}
   */
  function convert(env, opts) {
    const o = opts || {};
    const validated = validateMaterial(env);
    const patch = buildGraphPatch(env);
    const carded = toCards(env);
    const runRequest = toRunRequest(env, o);
    const summary = {
      batch_id: env.batch_id,
      items: env.items.length,
      nodes: patch.nodes.length,
      edges: patch.edges.length,
      cards: carded.cards.length,
      tts_lines: carded.tts.length,
      actions: runRequest.actions.length,
      skipped: patch.skipped.length,
      warnings: validated.warnings.length,
      text: `批次 ${env.batch_id}：${env.items.length} 条 → ${patch.nodes.length} 节点 / ${patch.edges.length} 边 / `
        + `${carded.cards.length} 张卡 · ${runRequest.actions.length} 条动作 · ${validated.warnings.length} 条告警`,
    };
    return {
      cards: { cards: carded.cards, tts: carded.tts },
      anki_files: toAnkiFiles(carded.cards, o),
      anki_templates: toAnkiTemplates(o),
      tts: carded.tts,
      run_request: runRequest,
      graph_patch: patch,
      warnings: validated.warnings,
      summary,
    };
  }

  const api = {
    MATERIAL_PROTOCOL, RUN_PROTOCOL, MARKS, MODIFIERS, LS_DEFAULTS, CARD_FIELDS, ANKI_TEMPLATES,
    normalize, slug, hash8, nodeId, topicId,
    validateMaterial, buildGraphPatch, toCards, toAnkiFiles, toAnkiTemplates, toRunRequest, convert,
  };

  if (isNode) module.exports = api;
  else globalThis.MindNet = Object.assign(globalThis.MindNet || {}, { ingest: api });
})();
