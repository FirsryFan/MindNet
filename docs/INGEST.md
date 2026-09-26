# 提取与格式转化

> 三步：**记号（`docs/MARKS.md`）→ AI 提取 → 格式转化**。
> 中间那步是唯一需要 AI 的；两头都是确定的。
>
> 产出三样：**标准清单**（本步的正产品）、**进模型的节点与边**、**可直接跑的请求**。
> 卡片怎么出、什么时候复习，都不在本步。

---

## §1 数据流

```
纸上记号 ──拍照──► AI 判读 ──► 清单（mindnet.material/1）
                                    │
                    ┌───────────────┼───────────────┐
                    ▼               ▼               ▼
              标准清单         节点与边         run 请求
           （规范后的条目）  （进知识图）    （mindnet.run/1）
```

**为什么中间要有一层清单**：AI 的产出必须**可核对、可重放、可修正**。
清单里每条都带出处（第几页第几行）与把握，于是：

1. **幂等**：条目 id 由内容确定（`en::w::resilient`），同一页拍两次不会重复建节点；
2. **可追溯**：每个结论都能回查"从哪一页哪一行来的"；
3. **可退化**：AI 不确定就标 `uncertain`，不猜 —— 猜错会污染后面所有复习。

---

## §2 清单格式 `mindnet.material/1`

```jsonc
{
  "protocol": "mindnet.material/1",
  "batch_id": "en-listen-2026-09-25-a",     // 幂等键
  "source": { "kind": "photo", "refs": ["dsc_0101.jpg"],
              "material": "BBC 6 Minute English · 第 3 段", "captured_at": "…" },
  "topic": "travel",                         // 页面顶部 #主题（可空）
  "language": "en",
  "marks": {                                 // 可选：你自定义的记号在这里说明
    "法": { "role": "method", "means": "听力方法/套路" }
  },
  "items": [
    { "id": "m1", "mark": "词", "text": "resilient",
      "margin_note": "resilient",            // 页边你抄的那份（可能拼错，仅消歧）
      "meaning": "有韧性的", "meaning_source": "ai", "ipa": "/rɪˈzɪliənt/",
      "context": "…she was remarkably resilient…", "page": 1, "line": 12,
      "modified": ["star"] },

    { "id": "m2", "mark": "词", "text": "get the hang of",     // 搭配也写「词」
      "margin_note": "get the hang of", "context": "It took me a while to get the hang of it.",
      "page": 1, "line": 15, "modified": ["star", "produce"] },

    { "id": "m3", "mark": "句", "text": "It took me a while to get the hang of it.",
      "page": 1, "lines": [15, 16], "contains": ["m2"] },

    { "id": "m4", "mark": "段", "text": "（整段文字，逐字给出）…", "page": 1, "lines": [18, 24] },

    { "id": "m5", "mark": "问", "text": "没听清 introduced 后面那个词",
      "marked_by": "dot", "dot_position": "第 20 行 introduced 后", "page": 1, "line": 20 },

    { "id": "m6", "mark": "法", "text": "先抓连接词，再补细节", "page": 1, "line": 22 }
  ]
}
```

### 2.1 字段规则

| 字段 | 必填 | 规则 |
|---|---|---|
| `mark` | ✅ | 你写的那个记号（默认 `词/句/段/问/会`；**自己发明的也收**） |
| `text` | ✅ | **以正文为准**。页边与正文不一致时用正文，并标 `corrected: true` |
| `margin_note` | 见下 | 页边你写的那一份原样抄录（含拼写错误） |
| `inferred_from_line` | 见下 | `true` = 这一行只有一处要记，所以没抄 |
| `marked_by` + `dot_position` | 见下 | `"dot"` = 你是在那个词下面点的点 |
| `context` | 词类必填 | 它在正文里的那一句 —— 例句来源 |
| `page` / `line(s)` | ✅ | 行号从本页第 1 行起数；跨行给 `lines: [起, 止]` |
| `contains` | `句`/`段` 可选 | 指向本批次内的 id（"这句里有这些词"） |
| `meaning` | 可选 | 释义；`meaning_source` 只能是 `ai`（会被标"待核对"）或 `user` |
| `marks`（顶层） | 可选 | 自定义记号 → `{role, means}`；`role` 见 `docs/MARKS.md` §4 |
| `role`（条目级） | 可选 | 直接指定这条的角色（优先级最高） |
| `uncertain` / `conflict` | 可选 | 看不清 / 页边与正文冲突；只是**记录**，不阻止入库 |
| `duplicate_of` | 可选 | 重复条目的显式表达 |

`margin_note` / `inferred_from_line` / `marked_by` **至少有一个** ——
要么你抄了，要么说明为什么没抄。

### 2.2 AI 不许做的事

1. **不许改你的意思**：你没标的，不提取；
2. **不许补全没听清的内容**（`问` 只记录你的疑问，不替你猜答案）；
3. **不许编 `line`**：数不清就标 `uncertain`；
4. **不许把释义当事实**：AI 给的释义一律 `meaning_source: "ai"`；
5. **不许在没抄、也没说明的情况下猜你标的是哪个词**；
6. **不许丢掉不认识的记号** —— 收下，交给 `role` 决定去向。

---

## §3 转化产物

跑一次 `node tools/ingest.js --material x.json --now-hours <模型小时> --out-dir out/`：

| 文件（`--out-dir` 下生成） | 是什么 |
|---|---|
| `items.json` [新] | **标准清单**：规范后的条目（记号、角色、出处、含义、是否进图、节点 id） |
| `graph_patch.json` [新] | 进知识图的节点与边 |
| `run_request.json` [新] | `mindnet.run/1`：先建节点、再建边、把 `★` 条目设为目标 |
| `cards.json` / `tts.tsv` / `tts.txt` / `anki/` [新] | **可选的呈现层**（本步之外，想要卡片就拿走） |

**角色 → 图**：`item` → `knowledge`；`passage` → `logic`；`method` → `technique`；
`question` / `known` / `note` / `other` **不进图**，只留在标准清单里（附原因）。

**节点 id**：`en::w::resilient`（词与搭配共用 `w`）、`en::s::<hash>`（句）、
`en::method::<slug>`（方法）。内容确定 ⇒ 同一页拍两次不会重复建。

---

## §4 给 AI 的提示词（整段复制）

```text
你是 MindNet 的"材料提取员"。用户会在纸上用记号标出要积累的内容，然后拍照给你。
你的唯一任务：把照片转写成一份 mindnet.material/1 清单 JSON。不要做别的。

【记号】
- 页边竖线 = 范围；竖线顶端的一个字是类型：
  词 = 单词或搭配（页边会照抄）  句 = 句子（不抄，正文即内容）
  段 = 语段（不抄）              问 = 疑问（页边写了问题）
  会 = 我已经会了（不要建条目）
- 类型字后面的符号：★ 重要 / → 要能说出来 / ? 拿不准 / ! 特例
- 用户可能自己发明记号（比如「法」「坑」「☆」）。**不认识的记号不要丢**：
  照样收进 items，并在清单顶部的 marks 块里写 {"<记号>": {"role": "<你判断的角色>",
  "means": "<你推测的意思>"}}，role 从 item/passage/method/question/note/other 里选。
- 页面顶部可能有 #主题 与日期。

【硬规则】
1. 拼写以**印刷正文**为准；页边抄写只用于消歧。不一致时用正文，记下 margin_note 并标
   corrected: true；实在判不了就 conflict: true。
2. 词/问 必须有 margin_note；**两种情况可以不抄**：
   这一行只有一处要记 ⇒ 标 inferred_from_line: true；
   用户在那个词下面点了点 ⇒ 标 marked_by: "dot" 加 dot_position（人话描述位置）。
   两者都没有、页边也没抄 ⇒ 不要提取这一条。
3. 词类必须有 context（正文里的那一句）。
4. 行号从本页第 1 行起数；数不清就标 uncertain: true 并描述位置。
5. 句/段里的词用 contains 指出来（只能指向本批次内的 id）。
6. 没把握的一律标 uncertain: true；宁可少提取，不可猜。
7. 释义可以给，但必须标 meaning_source: "ai"。
8. 不要提取用户没标记的内容；不要合并条目（重复的用 duplicate_of）。

【输出】只输出 JSON，不要解释文字，不要 markdown 围栏：
{ "protocol": "mindnet.material/1", "batch_id": "<来源-日期-序号>",
  "source": { "kind": "photo", "refs": ["<文件名>"], "material": "<出处>", "captured_at": "<ISO>" },
  "topic": "<#主题，可空>", "language": "en",
  "marks": { }, "items": [ ] }

【发输出前自检】
□ protocol 与 batch_id 都在，items 非空
□ 每条都有 mark / text / page / line(s)
□ 词/问 有 margin_note，或写明了 inferred_from_line / marked_by
□ 词类有 context；contains 只指向本批次内已存在的 id
□ 不认识的记号没有丢，且写进了 marks
□ 没把握的都标了 uncertain；没有编造的行号或内容
□ JSON 能被 JSON.parse 解析

【本次照片】
（用户附上照片）
```

---

## §5 命令

```powershell
# 1. 先校验（不写文件、不跑模型）
node tools/ingest.js --material material.json --check

# 2. 转化
node tools/ingest.js --material material.json --now-hours 497321.25 --out-dir out/

# 3. 校验请求 → 4. 真跑（把材料并进认知模型）
node tools/io_check.js --request out/run_request.json --graph <你的图>
node tools/io_run.js  --request out/run_request.json --graph <你的图> --print digest
```

---

## §6 概括

三步法，换场景只动两处（记号表、呈现层），流水线不动：

| 步骤 | 谁做 | 产物 | 要求 |
|---|---|---|---|
| ① 记号 | **人**（30 秒/页） | 页边锚点 | 形状独特、单笔画、不依赖颜色/方向；短的抄、长的圈 |
| ② 提取 | **AI** | 清单 | 只感知不判断；带出处与把握；不确定标不确定；**不认识的记号不丢** |
| ③ 转化 | **确定性代码** | 标准清单 + 图补丁 + 请求 | 纯函数、幂等、可重放 |

三条不变量：**原始材料是权威（手写只用于消歧）**；
**AI 的每个字段都能追回"哪一页哪一行"**；
**不认识的输入不会被丢掉，只会被标成"待归类"**。
