# 从照片到学习材料：提取与转化流水线

> **三步**：`记号（docs/MARKS.md）` → `材料信封（AI 产出）` → `卡片 + MindNet 请求（确定性代码产出）`。
> 中间那个信封是唯一需要 AI 的东西；两头都是确定的。
>
> 与 `docs/TRANSCRIBE.md` 的分工：TRANSCRIBE 管「**我做错了什么**」（复习事件，改认知状态）；
> 本文管「**我要积累什么**」（新材料，进知识图 + 生成卡片）。两者最后都汇到 `mindnet.run/1`。

---

## §1 流水线

```
纸上记号 ──拍照──► AI 判读 ──► 材料信封 mindnet.material/1
                                     │
                     ┌───────────────┼────────────────┐
                     ▼               ▼                ▼
              知识图补丁        呈现卡（Anki 式）   mindnet.run/1 请求
           （节点 + 边）      cards.json + *.tsv    （knowledge 动作）
                     │               │                │
                     └───────► 一起进 MindNet ◄───────┘
                                     │
                          复习事件（你自己做题/听写）
                                     │
                        review 动作 → 机制改 S → 卡片下次什么时候出现
```

**为什么中间要有一层信封，而不是让 AI 直接吐卡片**：
AI 的产出必须**可核对、可重放、可修正**。信封里每条都带出处（哪一页哪一行）与把握，
所以三条硬性质成立：

1. **幂等**：条目 id 由内容确定（`en::w::resilient`），同一页拍两次不会重复建节点；
2. **可追溯**：卡片上能回查"这是从哪一页哪一行来的"；
3. **可退化**：AI 不确定就标 `uncertain`，不猜 —— 猜错的内容会污染后面的所有复习。

---

## §2 材料信封 `mindnet.material/1`

```jsonc
{
  "protocol": "mindnet.material/1",
  "batch_id": "en-listen-2026-09-25-a",          // 幂等键：同一批只入一次
  "source": {
    "kind": "photo", "refs": ["dsc_0101.jpg"],
    "material": "BBC 6 Minute English · 第 3 段",  // 材料出处（人话即可）
    "captured_at": "2026-09-25T21:40:00+08:00"
  },
  "topic": "travel",                              // 页面顶部的 #主题（可空）
  "language": "en",                               // 用于卡片模板与 TTS
  "items": [
    { "id": "m1", "mark": "词", "text": "resilient",     // 写「词」或 "W" 都一样
      "margin_note": "resilient",                 // 页边你抄的那一份（可能拼错，仅消歧）
      "meaning": "有韧性的，能扛的", "meaning_source": "ai",
      "ipa": "/rɪˈzɪliənt/",
      "context": "…she was remarkably resilient in the face of setbacks…",
      "page": 1, "line": 12, "modified": ["star"], "produce": false },

    { "id": "m2", "mark": "搭", "text": "get the hang of",
      "meaning": "上手、摸到门道", "meaning_source": "ai",
      "context": "It took me a while to get the hang of it.",
      "page": 1, "line": 15, "modified": ["star", "produce"] },

    { "id": "m3", "mark": "句", "text": "It took me a while to get the hang of it.",
      "page": 1, "lines": [15, 16], "contains": ["m2"], "produce": true },

    { "id": "m4", "mark": "段", "text": "（整段文字，逐字给出）…",
      "page": 1, "lines": [18, 24],
      "questions": ["作者一开始为什么适应不了？", "后来靠什么转变？"] },

    { "id": "m5", "mark": "问", "text": "没听清 introduced 后面那个词，听起来像 'a-plows'",
      "page": 1, "line": 20 }
  ]
}
```

### 2.1 字段规则（AI 必须遵守）

| 字段 | 必填 | 规则 |
|---|---|---|
| `mark` | ✅ | 你写的那一个字：`词 / 搭 / 句 / 段 / 问 / 会`（也接受等价的 `W C S T N` 或 `1 2 3 4 5`） |
| `text` | ✅ | **印刷正文为准**。`词`/`搭` 若页边与正文不一致 ⇒ 用正文校正，并标 `corrected: true` |
| `margin_note` | `词`/`搭`/`问` 必填 | 页边你写的那一份原样抄录（含拼写错误），用于核对 |
| `inferred_from_line` | 二选一 | `true` = 这一行只有一处要记，所以你没抄 —— 走这条就**不必**给 `margin_note` |
| `marked_by` + `dot_position` | 二选一 | `"dot"` = 你是在那个词下面点的点；`dot_position` 用人话说明位置 |
| `context` | `词`/`搭` 必填 | 它在正文里的那一句（切到句号为止）—— 这就是例句的来源 |
| `page` / `line(s)` | ✅ | 行号从本页第 1 行起数；跨行给 `lines: [起, 止]` |
| `contains` | `句`/`段` 可选 | 指向**本批次内**的 `词`/`搭` id（表示"这句里有这些词"） |
| `meaning` | 可选 | 中文释义；`meaning_source` 只能是 `ai`（卡片上会标"待核对"）或 `user`（你自己写的） |
| `uncertain` | 可选 | `true` = 有东西看不清；同时给 `region`（人话描述位置） |
| `conflict` | 可选 | `true` + `conflict_detail`：页边与正文冲突且无法判断 |
| `duplicate_of` | 可选 | 同一批次内重复的条目指向先出现的那条 |

（`margin_note` / `inferred_from_line` / `marked_by` **三者至少有一个** ——
要么你抄了，要么你说明了为什么没抄。都没有的话 AI 必须拒绝提取，不许猜。）

### 2.2 AI 不许做的事

1. **不许改你的意思**：你没标的东西不提取（哪怕它觉得那个词更重要）；
2. **不许补全没听清的内容**（`问` 类只记录你的疑问，不去替你猜答案）；
3. **不许编 `line`**：数不清行号就标 `uncertain`；
4. **不许把释义当事实**：`meaning` 一律 `meaning_source: "ai"`，卡片上会标"待核对"；
5. **不许在没抄、也没说明的情况下猜你标的是哪个词**（走 §3.2 的省事通道必须写明）；
6. **不许合并**不同条目（重复的用 `duplicate_of` 显式表达）。

---

## §3 确定性转化（`src/ingest.js`）

### 3.1 知识图补丁

| 信封里的东西 | 变成 | 节点类型 | 说明 |
|---|---|---|---|
| `W` 词 | 节点 | `knowledge` | |
| `C` 搭配 | 节点 | `knowledge` | |
| `S` 句 / 句型 | 节点 | `logic` | 句型属于"程序性/结构性"知识 |
| `T` 语段 | 节点 | `knowledge` | |
| `N` 疑问 | **不建节点** | — | 进疑问清单，等你/AI 答复后再决定 |
| `topic` | hub 节点 | `knowledge` | `#travel` → `en::topic::travel` |
| `contains` | 边 `S/T → W/C` | | 语义："听到这句，要能听出这个词" |
| `produce: true` | 边 `W/C/S → 上一级` | | 反向："想到这个搭配，要能说出整句" |
| 主题 hub | 边 `hub → 每条` | | 用于按主题批量调度 |

节点 id 是**内容确定**的：`en::w::resilient`、`en::c::get-the-hang-of`、
`en::s::<规范化文本的 8 位哈希>`、`en::topic::travel`。所以重拍同一页不会建重复节点。

### 3.2 卡片（Anki 式）

四张卡型（字段名固定；第一次用要在 Anki 里手动建这四个 note type，之后拖文件即可）：

| note type | 字段 | 正面 | 背面 |
|---|---|---|---|
| `EN::Listen::Word` | `Word, Meaning, IPA, Audio, Example, Source` | **音频**（听音辨义） | 拼写 + 释义 + 例句 + 出处 |
| `EN::Listen::Chunk` | `Chunk, Meaning, Audio, Example, Source` | 音频 | 短语 + 释义 + 例句 + 出处 |
| `EN::Listen::Sentence` | `Audio, Text, Meaning, KeyChunk, Source` | 音频 | 原句 + 中文 + 关键词块 + 出处 |
| `EN::Listen::Produce` | `Prompt, Target, Audio, Source` | 中文意思 / 提示 | 目标英文（产出型） |

两条设计要点：

- **听力卡必须是"听音 → 想意思"**，不是"看词 → 想意思" —— 否则练的是阅读。
  所以每张卡都带 `Audio` 字段，而且它是**直接可用的媒体引用**：`[sound:en__w__resilient.mp3]`
  （文件名由节点 id 确定）。同时导出一份 **TTS 清单**（文件名 → 文本，工具生成的 `tabular` 文件），
  合成时**保持文件名不变**、丢进 Anki 的媒体目录，卡片就能发声。
  还没合成音频时，模板会退化到 `IPA`（词/搭配）或提示文本 —— 不会出现空白正面。
- **`Produce` 卡只在 `→` 时生成**：听得懂 ≠ 说得出，产出型练习单独一类。

导出里还有一份 **Anki 建卡说明**（工具生成）：四个 note type 的字段顺序与正/背面模板
（含上面那个"没音频就退化"的分支），在 Anki 里建一次即可。

### 3.3 `mindnet.run/1` 请求

`knowledge` 动作按**依赖顺序**排（先建节点，再建边 —— 边要求两端已存在），
`run_id = ingest-<batch_id>`（幂等），时间基由调用方给（`--now-hours`）。
`★` 条目会额外生成一个 `goal` 动作（把高优先级条目设为目标 —— 目标偏置会优先照亮它们）。

复习侧（你做完听写/自测之后）用 `docs/TRANSCRIBE.md` 的 `review` 动作，
听力场景的对应关系：

| 你的实际情况 | 写什么 |
|---|---|
| 听音就能想起意思/拼写 | `review(outcome="correct")` |
| 听清了音但没懂意思 | `review(outcome="wrong", closeness=0.3)` |
| 听出了一部分（半个词、几个音节） | `review(outcome="wrong", closeness=0.7, reviewed_solution=true)` |
| 完全没听出来 | `review(outcome="blank")` |
| 只重听了一遍原句（没测） | `exposure` |

> `closeness` 在听力场景里特别有用：MindNet 的"失败后对答案"路径**按 closeness 加权**，
> "差一点听出来"给的增益最大 —— 这正是合意难度（desirable difficulty）在听觉通道上的样子。

---

## §4 不在本批范围的事

本批只做三件：**记号 → AI 提取 → 格式转化**。
"卡片什么时候再出现、由谁排"（Anki 与模型的排程关系）**不在本批**，以后单独定 ——
现在只要知道一条：那两个来源**不能同时开**，会互相打架。
同理，"题目评价 / 搜题 / 计划"也都不在这里（见 `docs/IO_PROTOCOL.md` §9）。

---

## §5 给 AI 的提示词（材料模式，整段复制）

```text
你是 MindNet 的"材料提取员"。用户会在纸上用固定记号标出要积累的内容，然后拍照给你。
你的唯一任务：把这张照片转写成一份 mindnet.material/1 的信封 JSON。不要做别的。

【记号表】
- 页边竖线 = 范围；竖线顶端的**一个字**是类型（写字母也行，等价）：
  词 / W = 单词（页边会照抄）      搭 / C = 搭配短语（页边会照抄）
  句 / S = 句子（不抄，正文即内容）  段 / T = 语段（不抄，覆盖多行）
  问 / N = 疑问（页边写了问题）     会 / ✓ = 我已经会了（不要建条目）
- 类型字后面的符号：★ 重要 / → 要能说出来 / ? 拿不准 / ! 特例
- 页面顶部可能有 #主题 与日期

【硬规则】
1. 拼写以**印刷正文**为准；页边抄写只用于消歧与核对。两者不一致时用正文，
   并记下 margin_note 与 corrected: true。实在判不了就 conflict: true。
2. 词/搭/问 必须有 margin_note（页边原样，含拼写错误）；词/搭 必须有 context（正文里的那一句）。
   **两条省事通道**（用户没抄时）：
   - 这一行只有一处要记 ⇒ 给 inferred_from_line: true，说明你是按"整行唯一一处"取的；
   - 用户在那个词下面点了点 ⇒ 给 marked_by: "dot" 与 dot_position（人话描述位置）。
   两者都没有、页边也没抄 ⇒ **不要提取这一条**（不要猜是哪个词）。
3. 行号从本页第 1 行开始数；数不清就标 uncertain: true 并描述位置，不要猜。
4. 句子/语段里的词/搭 用 contains 指出来（只能指向本批次内的 id）。
5. 你没把握的一律标 uncertain: true；宁可少提取，不可猜。
6. 释义可以给，但必须标 meaning_source: "ai"，并且不确定就留空。
7. 不要提取用户没标记的内容；不要合并不同条目（重复的用 duplicate_of）。

【输出格式】只输出 JSON，不要解释文字，不要 markdown 围栏：
{
  "protocol": "mindnet.material/1",
  "batch_id": "<来源-日期-序号>",
  "source": { "kind": "photo", "refs": ["<文件名>"], "material": "<材料出处>", "captured_at": "<ISO>" },
  "topic": "<#主题，可空>", "language": "en",
  "items": [ ... ]
}

【发输出前自检】
□ protocol 是 "mindnet.material/1"，batch_id 非空
□ 每条 item 都有 mark / text / page / line(s)
□ 词/搭/问 有 margin_note，或者写明了 inferred_from_line / marked_by
□ 词/搭 有 context
□ contains 只指向本批次内已存在的 id
□ 没把握的都标了 uncertain，没有编造的行号或内容
□ 没有提取用户没标记的内容
□ JSON 能被 JSON.parse 解析（无注释、无尾逗号）

【本次照片】
（用户附上照片）
```

---

## §6 自检与命令

```powershell
# 1. AI 产出信封后，先校验（不写任何东西、不跑模型）
node tools/ingest.js --material material.json --check

# 2. 真正的转化（一次产出全部：卡片 / Anki 文件 / 模板 / tts / 图补丁 / 请求）
node tools/ingest.js --material material.json --now-hours 497321.25 --out-dir out/
#    out/cards.json · out/anki/*.tsv · out/anki/templates.md
#    out/tts.tsv · out/tts.txt · out/run_request.json · out/graph_patch.json · out/summary.txt

# 3. 校验请求本身是否合法（只校验不执行）
node tools/io_check.js --request out/run_request.json --graph demo_learning

# 4. 真跑（把新材料并入认知模型）
node tools/io_run.js --request out/run_request.json --graph <你的图> --print digest
```

**幂等**：`run_id = ingest-<batch_id>`，节点 id 由内容确定 ⇒ 同一页拍两次不会重复建节点，
重复提交请求也只会返回上次结果（`replay: true`）。
**同批次引用**：请求里先建节点、再建边、最后把 `★` 条目设为目标 —— 这三步是同一份请求，
IO 层按顺序校验与执行（这条能力是为材料入库加的）。

---

## §7 抽象：三步法的通用形态

把英语听力换成任何场景，只有两处会变（记号表、卡片模板），流水线不动：

| 步骤 | 输入 | 谁做 | 输出 | 通用要求 |
|---|---|---|---|---|
| ① 记号 | 纸上选择 | **人**（30 秒/页） | 页边锚点 | 形状独特、单笔画、不依赖颜色/方向；短的抄、长的圈 |
| ② 提取 | 照片 | **AI** | 材料信封 | 只感知不判断；带出处与把握；不确定标不确定；幂等 id |
| ③ 转化 | 信封 | **确定性代码** | 图补丁 + 卡片 + 请求 | 纯函数、可对拍（`conformance`）、可重放（`run_id`） |

三条不变量（跨场景都成立）：

1. **印刷/原始材料是权威，人的手写只用于消歧** —— 把手写当权威，OCR 的错会变成模型的错；
2. **一个量只有一个主人** —— 排程（这里）、`S`（`docs/IO_PROTOCOL.md` §6）都是同一原则；
3. **AI 的每个字段都必须能追回"哪一页哪一行"** —— 追不回去的字段不准进模型。
