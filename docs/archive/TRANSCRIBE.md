# 转写规程（照片 → `mindnet.run/1`）

> **这份文档是给"上游 AI"看的**：它负责把照片/试卷/错题本加工成 MindNet 能吃的请求。
> MindNet 自己不看照片、不调 AI —— 它只保证：**你给的请求合法、可回放、过程讲得清**。
> 契约细节见 `docs/IO_PROTOCOL.md`；本文件只讲"怎么把眼前这张照片变成那份 JSON"。
>
> 用法：把 §6 的提示词整段贴给任何有视觉能力的模型，再附上照片，它会产出请求 JSON；
> 用 `node tools/io_check.js --request <文件>` 自检，通过了再 `node tools/io_run.js` 真跑。

---

## §1 上游 AI 的权限（只有这五件事）

| kind | 什么时候用 | 必填 |
|---|---|---|
| `review` | 看到"学生做了这道题/这个点"，且有对错证据 | `node`、`outcome`(`correct`/`wrong`/`blank`)、`at` |
| `exposure` | 看到"学生读了/抄了/整理了"，**没有测试证据** | `node`、`at` |
| `knowledge` | 题目引入了图里没有的知识点，或出现了新的连接 | `node` 或 `edge` |
| `goal` | 学生明确说"我要搞定 X" | `targets[]` |
| `time` | 需要推进到某个时刻 / 记录花了多久 | `at` 或 `elapsed_hours` |

**不许做的事**（做了就是污染模型，`io_check` 会拦住一部分，但主要靠你自觉）：

1. 不许直接写 `S / D / R0` —— 那些是模型的判定，不是你能观察到的东西。
2. 不许发明节点 id：`node` 必须是**图里已有**的 id（图会给你，见 §6 的输入清单）；
   如果是新知识点，先用 `knowledge` 建节点，再用它的 id。
3. 不许把"我觉得他掌握了"写成 `review`。`review` 必须有**可核对的痕迹**：
   题号 / 照片区域 / 学生写的原文。
4. 不许猜时间。看不出"这是什么时候做的"就**问**，或者用 `time` 动作显式给出时刻 ——
   宁可少写一条动作，也不要用"现在"蒙一个。
5. 一张照片可以产出多条动作，但**顺序就是语义**（模型按数组顺序生效）。

---

## §2 判读照片的决策树

```
看到一张照片
├─ 是"学生写的解答/草稿"吗？
│   ├─ 有批改痕迹（对/错/分数）
│   │   ├─ 对 → review(correct)
│   │   └─ 错 → review(wrong)；若同时看到"旁边有订正/抄了解析" → review(wrong, reviewed_solution: true)
│   └─ 没有批改
│       ├─ 是完整解答 → 你无法判断对错 ⇒ 不要写 review，最多写 exposure（他练过这个点）
│       └─ 是空白/只写了开头 → review(blank)，并在 evidence.quote 里写他停在哪
├─ 是"题目本身"（没有学生笔迹）吗？
│   └─ 提取它用到哪些知识点 → 这些点若不在图里 → knowledge(node)；若你看到两条点之间的关系 → knowledge(edge)
├─ 是"错题本/笔记"吗？
│   └─ exposure（他整理过），不要写成 review
└─ 是"时间信息"（日期戳、课表、"今天 21:12"）
    └─ time（把它作为锚点给出来）
```

**三种 outcome 的区别（很关键，写错会让模型学反）**：

| 你看到的 | 写 | 模型会做什么 |
|---|---|---|
| 做对了 | `correct` | `S` 按成功提取增长，编码上限 `R0` 上调 |
| 做错了，**没看到**他后来对答案 | `wrong` | 走遗忘路径：`S` 下降、失败证据 +1 |
| 做错了，**看到**他后来订正/看了解析 | `wrong` + `reviewed_solution: true` | 走"失败后对答案"的学习路径（增益由 `closeness` 决定，差一点想起来增益最大） |
| 完全没写出来 | `blank` | 同遗忘路径 |

> 实测依据：同一节点同一次做错，走学习路径是 `S 3.6h → 90.8h`，走遗忘路径在正常节点上是下降
> （`S 19.2h → 4.2h`）。这不是调参问题，而是"到底发生了什么"的区别 —— 所以只有看得见订正才写 `reviewed_solution`。

---

## §3 出处与置信度（必填，虽然模型不拦）

```jsonc
"evidence": {
  "source": "dsc_0042.jpg",      // 哪个文件
  "region": "第 3 题第 (2) 问",   // 照片的哪一块（人话即可）
  "quote": "学生写到 r = 2cosθ 后停住",   // 你实际看到的原文/笔迹
  "problem_id": "P-1043"         // 如果知道题号就写上
},
"confidence": 0.8                 // 你对这条判断的把握（0–1）
```

- `confidence` 的含义是**你对这条观察的把握**，不是"模型该不该采纳" ——
  按定案，模型**立即生效**（错了靠存档回退），所以这个字段只用于事后审计与统计。
- 看不清就别猜：把 `confidence` 写低、把 `quote` 写清楚，或者干脆不产出这条动作。

---

## §4 常见坑（都是真实会犯的）

| 坑 | 后果 | 正确做法 |
|---|---|---|
| 把"练习册印刷的例题"当成学生做对了 | 凭空给了一条 `correct` | 没有笔迹就不要写 `review` |
| 一张照片里 3 道题只写 1 条 `review` | 模型少学两条 | 一道题一条动作 |
| 用中文名字当 `node` | 报错（节点 id 是图里的 id） | 先查图（§6 输入清单），查不到就 `knowledge` 建 |
| `at` 写 `"now"` / 省略 | 报错 | 给 `model_hours`（由外壳换算）或 `wall` |
| 同一节点同一时刻写 `correct` 又写 `wrong` | 整份请求被拒 | 先确认到底哪个对；拿不准就都不写 |
| 把"他很聪明"写进 JSON | 模型没有这个字段，纯噪声 | 只写可核对的事实 |

---

## §5 三个完整例子

### 例子 A：一道做错的题（有订正）

```jsonc
{
  "protocol": "mindnet.run/1",
  "run_id": "run-2026-09-25-0007",
  "time": { "model_hours": 497321.25, "wall": "2026-09-25T21:40:00+08:00" },
  "actions": [
    {
      "kind": "review", "node": "polar", "outcome": "wrong",
      "reviewed_solution": true, "closeness": 0.4,
      "at": { "model_hours": 497321.25, "wall": "2026-09-25T21:12:00+08:00" },
      "evidence": { "source": "dsc_0042.jpg", "region": "第 3 题第 (2) 问",
                    "quote": "写到 r = 2cosθ 后停住，旁边有红笔订正", "problem_id": "P-1043" },
      "confidence": 0.8
    },
    { "kind": "time", "elapsed_hours": 0.5, "at": { "model_hours": 497321.25 } }
  ]
}
```

### 例子 B：只有题目本身（学生还没做）

```jsonc
{
  "protocol": "mindnet.run/1", "run_id": "run-2026-09-25-0008",
  "time": { "model_hours": 497330 },
  "actions": [
    { "kind": "knowledge", "node": { "id": "polar_area", "name": "极坐标下的面积", "type": "knowledge" },
      "at": { "model_hours": 497330 }, "confidence": 0.7 },
    { "kind": "knowledge", "edge": { "from": "polar", "to": "polar_area", "ls": 0.7 },
      "at": { "model_hours": 497330 }, "confidence": 0.6 }
  ]
}
```

### 例子 C：一节自习课的记录

```jsonc
{
  "protocol": "mindnet.run/1", "run_id": "run-2026-09-25-0009",
  "time": { "model_hours": 497335, "wall": "2026-09-25T22:30:00+08:00" },
  "actions": [
    { "kind": "exposure", "node": "sine_law", "at": { "model_hours": 497333 }, "confidence": 0.9 },
    { "kind": "review", "node": "sine_law", "outcome": "correct",
      "at": { "model_hours": 497335 },
      "evidence": { "source": "dsc_0045.jpg", "region": "默写第 2 行", "quote": "a/sinA = b/sinB 写对了" },
      "confidence": 0.85 },
    { "kind": "time", "elapsed_hours": 1.5, "at": { "model_hours": 497335 } }
  ]
}
```

---

## §6 给上游 AI 的提示词（整段复制）

```text
你是 MindNet 的"转写员"。MindNet 是一个确定性的认知模型引擎，它不看照片、不调 AI，
只接受协议化的请求。你的唯一任务：把用户给的照片/文本，转写成一份合法的 run 请求 JSON。

【你只有五种动作，别的不许写】
- review   ：看到"做了这道题"且有对错证据。
             outcome = correct | wrong | blank
             若同时看到订正/抄了解析，加 "reviewed_solution": true（并可给 closeness 0–1）
- exposure ：看到"读了/抄了/整理了"，但没有测试证据
- knowledge：题目引入了图里没有的知识点（给 node），或出现了新连接（给 edge）
- goal     ：用户明确说"我要搞定 X"
- time     ：需要推进到某时刻，或记录花了多久（at 或 elapsed_hours）

【绝对不许】
1. 写 S / D / R0 / 任何模型内部量；
2. 发明节点 id —— node 必须是下面清单里已有的 id（新知识点先用 knowledge 建）；
3. 把"我觉得他掌握了"写成 review —— review 必须有可核对痕迹；
4. 猜时间：看不出时间就问，或用 time 动作显式给出；不许省略 at，也不许写 "now"；
5. 同一节点同一时刻写两条矛盾的 outcome。

【每条动作必带】
- at：{ "model_hours": <数字> }（若知道现实时间，同时给 "wall"）
- evidence：{ "source": <文件名>, "region": <照片哪一块>, "quote": <你实际看到的原文> }
- confidence：0–1，你对这条判断的把握

【输出格式】只输出 JSON，不要解释文字，不要 markdown 代码围栏：
{
  "protocol": "mindnet.run/1",
  "run_id": "<日期-序号，例如 run-2026-09-25-0007>",
  "time": { "model_hours": <当前模型时刻>, "wall": "<ISO 时间>" },
  "actions": [ ... ]
}

【发输出前逐条自检】
□ protocol 是 "mindnet.run/1"，run_id 非空且本次唯一
□ 每条 action 的 kind 在这五种之内
□ 每条 action 都有 at（或 time 动作有 elapsed_hours）
□ 所有 node 都在图清单里（否则我先建节点）
□ 每一道题都有对应的一条 review/exposure（没有遗漏、没有合并）
□ 没有写任何模型内部量（S/D/R0）
□ outcome 与"有没有看到订正"匹配（看到订正才写 reviewed_solution）
□ JSON 能被 JSON.parse 解析（无注释、无尾逗号）

【图清单】（节点 id → 名称，我会在下面附上）
...

【本次照片】
（用户附上照片）
```

---

## §7 自检工具

```powershell
# 只校验不执行：把错误说成人话，并列出"这份请求会做什么"
node tools/io_check.js --request req.json

# 通过之后再真跑
node tools/io_run.js --request req.json --graph demo_learning --print digest
```

`io_check` 会检查：协议名、`run_id`、动作白名单、每条动作的时间基、节点是否存在、
`outcome` 是否合法、是否有矛盾/重复观察，并打印每条动作"将会落到哪个机制路径"。
**它不修改任何状态** —— 适合让 AI 反复迭代到通过为止。
