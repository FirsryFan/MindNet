# MindNet I/O 协议 v2（本模块的边界与契约）

> **这一版把范围收窄了**（按你的要求）：
> 照片→结构化、以及"模型产物拿去干什么"（搜题 / 评价 / 计划…）**都不是本模块的事**。
> MindNet 要做的是一件干净的事：
>
> **吃一份协议化的输入 → 跑模型 → 吐一份协议化的输出（含完整运作过程）+ 即时存档。**
>
> 上游（AI 或别的模块）负责把题目/批改结果加工成下面的 `mindnet.run/1`；
> 下游（AI 或别的模块）负责把 `mindnet.result/1` 拿去做任何事。
> 本模块不猜上游、不管下游，只保证：**输入合法、状态可回放、过程讲得清**。
>
> 关联：`docs/MODEL_v2_MATH.md`（数学）、`docs/FEEDBACK.md`（反馈）、
> `docs/PLUGIN_ARCHITECTURE.md`（模块契约）。

---

## §1 数据流

```
上游（AI / 别的模块）
   │  把「我做了什么」加工成 run 请求（§2）
   ▼
┌───────────────────────────────────────────────────────────────┐
│  MindNet（本模块，零 AI、零网络、确定性）                       │
│  ① 校验请求        ② 逐条生效（立即，不等确认）                  │
│  ③ 即时存档        ④ 采集过程轨迹        ⑤ 生成结果信封         │
└───────────────────────────────────────────────────────────────┘
   │  mindnet.result/1（§4：结论 + trace + change_log + 存档指针）
   ▼
下游（AI / 别的模块 / 壳）
```

三条硬约束（照旧）：

1. **零 AI、零网络**：本模块不调模型、不读照片、不搜题。上游给什么就是什么。
2. **确定性可回放**：同一份请求 + 同一 seed ⇒ **逐位相同的输出**（时间基必须显式给，见 §3.3）。
3. **不静默失败**：请求缺字段 / 指向不存在的节点 / 时间戳自相矛盾 → 报错并指出第几条；
   只有"能算的"才落状态。

---

## §2 输入契约：`mindnet.run/1`

```jsonc
{
  "protocol": "mindnet.run/1",
  "run_id": "run-2026-09-25-0007",            // 幂等键：同一个 run_id 只生效一次
  "graph": { /* 可省略：省略则用引擎里当前的图 */ },
  "time": { "model_hours": 497321.25 },        // 本次运行的时间基（§3.3）
  "steps": 0,                                  // 可选：生效后再推进几轮扩散（默认 0）
  "actions": [ /* §2.2，按数组顺序依次生效 */ ],
  "meta": { "source": "photo|text|manual", "note": "…" }   // 可选，只记录、不参与计算
}
```

### 2.1 三条规则

1. **顺序即语义**：`actions` 按顺序生效；每条生效后都写一条 `change_log`。
2. **立即生效**：不做"等人确认"的挂起队列 —— 模型不大，错了靠**存档回退**解决（§6）。
3. **幂等**：`run_id` 已存在 ⇒ 直接返回上次的结果（同一个 `result_id`），不重复生效。

### 2.2 动作白名单（本模块能接受的**全部**输入，共 5 类）

| kind | 含义 | 必填 | 落到模型 |
|---|---|---|---|
| `time` | 现在到了什么时刻 / 过了多久 | `at.model_hours`（或 `elapsed_hours`） | `kernel.setHours` / `advanceHours` → `hours.advance`（同步所有节点的 `ms`） |
| `review` | 我做了一道题/被问到一个点，结果如何 | `node`、`outcome`(`correct`/`wrong`/`blank`)、`at` | `kernel.review(...)`（映射见 §2.3） |
| `exposure` | 我看了/读了但**没测** | `node`、`at` | `kernel.review(node, {type:'reread'})` |
| `knowledge` | 图变了：新知识点 / 新连接 | `node` 或 `edge` | `graph.add_node` / `graph.add_edge` |
| `goal` | 这次要推进的目标变了 | `targets[]`（可带 `starts[]`） | `engine.start_diffusion(starts, targets)` |

**注意**：题目本身的答案/解析**不是本模块的输入**（那是题库的事，由上游保管）。

### 2.3 `review` 的三种结果 → 三条不同的机制路径

| `outcome` | 机制里对应 | 为什么 |
|---|---|---|
| `correct` | `retrieval_success`（`grade` 默认 3） | 成功提取：`S` 按 `SInc` 增长，`R0` 上调，`N+1` |
| `wrong` | **`lapse`**（默认） | 做错了就是**没提取出来**，`S` 该下降、失败证据 `+1` |
| `wrong` + `reviewed_solution: true` | `retrieval_failure_feedback`（`closeness` 默认 0.5） | 做错**之后对过答案**：这是学习事件，`closeness` 越接近 1（差点想起来）增益越大 |
| `blank` | `lapse` | 完全没想起来 = 真遗忘 |

> 为什么把 `wrong` 与 `wrong + reviewed_solution` 分开（**实测数据**，同一节点同一次做错）：
> 走"失败后对答案"路径是 `S 3.6h → 90.8h`（25 倍，因为低留存下的合意难度增益极大），
> 走 `lapse` 路径在正常节点上是下降（`R0=0.8` 的节点：`S 19.2h → 4.2h`）。
> 差别不是参数问题，而是**到底发生了什么**：没做出来 ≠ 没做出来但随后把解法学了一遍。
> 上游知道这个区别，就该在请求里说明；模型不替它猜。

可选项：`grade`（1–4，上游若从"轻松/顺利/困难"观察到就带上）、`closeness`（0–1）、
`reviewed_solution`（布尔）、`problem_id` / `evidence`（**只记录，方便回查**，不参与计算）。

一条 `review` 的完整形状：

```jsonc
{
  "kind": "review",
  "node": "polar",
  "outcome": "wrong",
  "closeness": 0.4,
  "at": { "model_hours": 497321.25, "wall": "2026-09-25T21:12:00+08:00" },
  "evidence": { "source": "dsc_0042.jpg", "region": "第 3 题第 (2) 问",
                "quote": "写到 r = 2cosθ 后停住", "problem_id": "P-1043" },
  "confidence": 0.8
}
```

`evidence` / `confidence` 在本模块里**不拦任何东西**（按你的决定：立即生效），
但它们会原样进 `change_log` 与存档 —— 事后查出问题靠它们，而不是靠事前拦截。

### 2.4 请求校验（不合法就整份拒绝）

- 未知 `kind` / 缺必填字段 → 报 `第 N 条 action 缺少 …`；
- `node` 不在图里 → 报错（`knowledge` 类除外，它本来就是来建节点的）；
- `at` 既没有 `model_hours` 也没有 `wall` 锚点 → 报错（**不许默默用"现在"**）；
- 同一个 `run` 里对同一节点同时出现 `correct` 与 `wrong`（时间相同）→ 报冲突，整份拒绝。

---

## §3 执行语义

### 3.1 一条动作的生效顺序

```
写 change_log(before) → 调模型 → 取模型返回的前后值 → 写 change_log(after) → 追加存档
```

### 3.2 全部动作生效后

1. 可选推进 `steps` 轮扩散（每一轮都进 trace，见 §4.3）；
2. 跑一次控制层报告（诊断 → 处方 → 反事实）；
3. 生成 `mindnet.result/1`。

### 3.3 时间基（三个时间基只允许出现两个）

模型内部有 tick(250ms) / round / hours 三个时间基。请求里只允许 `model_hours`（模型时间基）
与 `wall`（人能核对的现实时间）：

1. 给了 `model_hours` → 直接采用（可回放）。
2. 只给 `wall` → 用上一次已知的 `wall ↔ model_hours` 锚点线性换算，换算过程写进 `assumptions[]`。
3. 两者都没给 → **拒绝**。

---

## §4 输出契约：`mindnet.result/1`

```jsonc
{
  "protocol": "mindnet.result/1",
  "result_id": "res-run-2026-09-25-0007",
  "run_id": "run-2026-09-25-0007",
  "status": "ok",                          // ok | rejected | partial
  "model": {
    "profile": "v2", "seed": 7, "hours": 497321.25, "rounds": 8,
    "mechanisms": ["memory.dsr", "..."],
    "overrides_digest": "…",              // 参数快照指纹
    "state_hash_before": "…",             // kernel.stateHash()
    "state_hash_after": "…"
  },
  "applied": [ /* 每条动作的生效结果 */ ],
  "assumptions": [ /* 时间换算、缺省值、被跳过的项 */ ],
  "trace": { /* §4.3 —— 模型运作过程 */ },
  "result": { /* §4.4 —— 模型判定 */ },
  "warnings": [ /* 内核告警 + 本层告警 */ ],
  "archive": { "path": "…", "entries": 128, "last_entry_id": "…" }
}
```

### 4.1 `applied[]`：每条动作发生了什么

```jsonc
{ "index": 2, "kind": "review", "node": "polar", "outcome": "wrong",
  "mechanism": "retrieval_failure_feedback",
  "delta": { "R_at_review": 0.15, "S_before": 3.6, "S_after": 4.57023, "SInc": 1.2695,
             "R0_before": 0.15, "Sigma_before": 0.15, "Sigma_after": 0.575,
             "D_before": 5.1618, "D_after": 5.7868 },
  "evidence": { "source": "dsc_0042.jpg", "region": "第 3 题第 (2) 问" },
  "confidence": 0.8 }
```

⚠️ 实测细节：`kernel.review()` 返回的是**每个模块的结果数组**（`[{id, out}]`），
本层要按 `id === 'memory.dsr'` 取出 `out` 再展开成上面的 `delta`。

### 4.2 `assumptions[]`

一行一条，形状 `{ "what": "时间换算", "detail": "wall 21:12 → model_hours 497321.25（锚点 20:00↔497320）", "effect": "用于本次全部动作" }`。
**凡是本层替你决定的东西，都必须出现在这里**，否则输出不算"详细明确"。

### 4.3 `trace`：模型运作过程（本模块的核心产出）

#### (a) `trace.slow[]` —— 慢层事件（小时尺度）

每条 `time` / `review` / `exposure` 的模型返回原样收录：`{kind, node?, ms_before→ms_after?,
R_at_review, S_before→S_after, SInc, R0, Σ, D, F, history_len}`。

#### (b) `trace.rounds[]` —— 快层每一轮

由本层在每次 `step()` 之后快照引擎的当轮数据（引擎自己只保留最后一轮）：

| 字段 | 现在就有？ | 含义 |
|---|---|---|
| `round / tick / hours` | ✅ | 轮次与时间基 |
| `cycleTicks / openTicks / availability / rhythm` | ✅ | 节拍长度、这轮多少 tick 在"在线"、节律内部状态 |
| `drive` | ✅ | 每个节点的驱动 `x_v` = 所有入边贡献之和 |
| `drive_edges[]` | 🆕 本层补录 | `{from,to,ls,al,ms,contribution}`：驱动**从哪几条边加出来的**，这是"它为什么亮"的第一手证据 |
| `scores` / `candidates` | ✅ | 竞争得分与候选集 |
| `admitted / focus / dar_used / outcompeted` | ✅ | 容量准入结果、焦点、用掉几个名额、被挤掉的 |
| `ignition[]` | 🆕 本层补录 | `{node, score, ct, t_ign, p, draw, hit}`：点火是**概率**的，必须记下当时抽到的随机数，否则"这轮为什么没亮"不可复现 |
| `states[]` | 🆕 本层补录 | 每节点 `state_before → state_after`（含 `al`） |
| `notes` | ✅ | 模块自己写的可读说明 |

#### (c) `trace.control` —— 诊断 → 处方 → 反事实

直接采用现成的 `control_report()`：逐节点诊断事实 → 分类（类型/严重度/证据/说明/候选指令）
→ 处方（含预测增益、代价、性价比、`metric`）→ `baseline_reachability`。

#### (d) `trace.invariants` / `trace.warnings`

内核告警（模块异常被隔离）、不变量自查、以及 `state_hash`（同输入同 seed ⇒ 同指纹）。

#### (e) `trace.digest`

一行摘要：`rounds=8 · 点火 14 次 · 容量挤出 3 次 · 慢层事件 5 条 · 诊断 4 条 · 处方 3 条`，
用于人眼速读与回归比对（换参数后 diff digest）。

### 4.4 `result`：模型判定

```jsonc
{
  "states": { "polar": "INACTIVE", "…": "…" },        // 协议四字段之一
  "kc": { "gap": 0.2637, "penalty": 0 },
  "target_steps": { "solve_triangle": 2 },
  "targets_all_reached": false,
  "nodes": { /* 逐节点：a, q, R, R0, S, D, F, peak_drive, ever_activated… */ },
  "diagnoses": [ { "node": "polar", "type": "empty", "severity": 0.391,
                   "human": "线索太弱：峰值只有阈值的 2%",
                   "prescriptions": ["add_in_edges", "support_subthreshold"] } ],
  "plan": [ { "node": "polar", "instruction": "add_in_edges", "why": "…",
              "predicted_gain": 0.706, "cost": 2.0, "metric": "reachability" } ],
  "next_check": { "for_node": "polar", "at_model_hours": 497393.5,
                  "target_retention": 0.85, "hours_from_now": 72.25 }
}
```

`next_check` 是**排程结果**（由 `memoryDsr.scheduleInterval` 反解），下游拿它去决定"什么时候再问这个人"。
本模块不决定问什么，只回答"**这条线索什么时候该再碰**"。

---

## §5 存档与回退（"即时存档"）

- **格式**：append-only **JSONL**，一行一条 `{entry_id, at, run_id, kind, before, after, note}`。
- **时机**：每条动作生效后立刻追加（不攒批、不等确认）。
- **内容**：动作原文 + 模型返回的前后值 + `state_hash_before/after`。
- **回退**：`rewind(run_id)` —— 按 `state_hash` 链条回到某个请求之前的状态；
  实现上优先用"重放"（从最近一次全量快照 + 后续条目重跑），保证与在线路径逐位一致。
- **重放**：同一份请求重放 ⇒ 与首次逐位一致（`state_hash_after` 相同）；不一致就是 bug。
- **位置**：默认 `data/archive/runs.jsonl`（`.gitignore` 排除，不进 GitHub）。

---

## §6 与 `S` 的关系（一个数只能有一个写者）

这是设计时必须先定的事，因为它决定"我做错一道题"到底改了模型里的什么。

**现状**：`S`（这条线索还能撑多久）现在有**两条路**都能改：

| 路径 | 规则 | 来源 |
|---|---|---|
| A. 机制（`mechanisms/memory.dsr.js`） | `SInc` 增长 / 遗忘后公式下降；同时管 `R0/Σ/D/F/history` | FSRS + Bjork，56 条验收断言在守 |
| B. 反馈（`src/feedback.js`） | `S' = S·exp(gain·e·u)`，按"预测 vs 实际"的误差修 | 上一轮为"用做题结果校准"而做 |

**结论（本协议采用）**：

- **机制 A 是 `S` 的唯一写者** —— 每次复习该涨多少，是模型的物理，只有一份实现。
- **反馈 B 改成"体检"**：它继续累计"模型预测 vs 你的实际表现"的偏差，
  但**不去覆盖某个节点的 `S`**；产出是两样东西：
  `compareWithGraph(graph)`（机制算的 `S` vs 账本估的 `S`，含偏差倍数与误差下界）与
  `suggestOverrides()`（攒够证据后建议参数，例如 `memory.dsr.legacy_k`）。
  代码上它已经没有"写回 S"的出口了（`applyToGraph` 已移除，测试里有断言守着）。
- 理由有二：
  1. 同一个事件被两个规则记账 ⇒ 数字互相抵消或翻倍，不可复算；
  2. 我们上轮算过：单条线索的 `S` 靠对错最多只能定到 ±70%（100 条）/ ±30%（400 条），
     用这么吵的估计去盖掉物理公式，是拿噪声替换模型。

因此壳里「反馈」面板的"写回图"会改成"写回参数"，而**每条线索的 `S` 变化仍然可见**
（它来自机制 A，并被完整记进 §4.1 的 `delta`）。

---

## §7 失败模式与对策

| # | 失败模式 | 对策 | 落在哪 |
|---|---|---|---|
| F1 | 上游映射错节点（把"极坐标"标成"弧度制"） | `evidence` 原样存档，事后可查可回退；本层不拦（按你的决定） | §2.3 / §5 |
| F2 | 上游编造节点 id | 非 `knowledge` 动作指向不存在的节点 ⇒ 整份拒绝 | §2.4 |
| F3 | 时间戳错 → 曲线算错 | 时间基三规则 + `assumptions[]` 显式记录换算 | §3.3 |
| F4 | 同一份请求重复提交 | `run_id` 幂等 | §2.1 |
| F5 | 动作互相矛盾 | 整份拒绝并指出冲突位置 | §2.4 |
| F6 | 模块异常毁掉整体 | 内核已有错误隔离 → `warnings[]`；本层不许吞 | §4.3(d) |
| F7 | 输出里出现无法追溯的数 | 每个数都能由 `state_hash` + 请求重放复算 | §5 |
| F8 | 回退把状态弄坏 | 回退实现走"重放"，且回退前后都做不变量自查 | §5 |

---

## §8 实施与验收

### 8.1 本批已实现（可跑）

| 文件 | 作用 |
|---|---|
| `src/io/run.js` | 校验 → 逐条生效 → 采集 trace → 生成 `mindnet.result/1`（纯逻辑，无 fs） |
| `src/io/archive.js` | append-only 存档：`append / findRun / rewindPlan / toJSONL / fromJSONL`（BOM 容错） |
| `tools/io_run.js` | 命令行：`--request / --graph / --steps / --archive / --out / --print / --rewind` |
| `example/requests/run_request_example.json` | 一份真实可跑的示例请求（复习+看材料+补边+时间推进） |
| `test/io.test.js` | 13 条断言，逐条对应 §8.2 |

另外为 trace 补录了三处（都是**只增不改**的观测，不动任何机制语义）：
`v2/engine.js` 的逐项驱动明细（入边 / 亚阈 / 模块改写三类，来源可辨）、
每轮 `state_before → state_after`（含 `al`）；
`mechanisms/attention.ignition.js` 的点火明细（`p`、当时抽到的随机数 `draw`、`hit`）。

```powershell
node tools/io_run.js --request example/requests/run_request_example.json `
                     --graph demo_learning --archive data/archive/runs.jsonl --print digest
# rounds=3 · 点火 11 次 · 容量挤出 0 次 · 慢层事件 4 条 · 诊断 0 条 · 处方 12 条
```

### 8.2 验收断言（全部落地在 `test/io.test.js`，13 条）

1. 非法请求（协议错 / 缺 `run_id` / 未知 kind / 不存在节点 / 非法 outcome / 无时间基 / steps 为负）
   ⇒ 报错并指出第几条，且 **`state_hash` 不变**；
2. 矛盾观察（同一节点同刻 `correct` + `wrong`）⇒ 整份拒绝；
3. 只给 `wall` 且无锚点 ⇒ 报错；有锚点 ⇒ 换算写进 `assumptions[]` 且标 `derived`；
4. `review` 四种情形分别落到 `retrieval_success` / `lapse` / `lapse` / `retrieval_failure_feedback`；
5. 复习的 `S_before/S_after/D_after` 与内核单独跑一遍**逐位一致**；
6. `trace.rounds[].drive_edges` 逐项之和 == `drive`（入边贡献 == `al·ms·ls`，亚阈与模块改写单列）；
7. `ignition[].p` 可由 `σ((score−ct)/T)` 复算，`hit` 与最终 `conscious` 一致；
8. 每轮每个节点都有 `state_before → state_after`（含 `al`），起点始终在意识里；
9. `trace.digest` / `invariants` / `slow` 如实反映本次动作数；
10. 同一 `run_id` 重复提交 ⇒ `replay: true`，状态与存档条目都不翻倍；
11. 同请求 + 同 seed 在两套引擎上 ⇒ `state_hash_after` 相同、`trace` 逐位相同；
    换 seed 只影响点火（第 1 轮驱动与 seed 无关）；
12. 存档：run 头 + 每动作一条，`state_hash` 链条首尾相接；JSONL 往返不丢；
    用存档里的动作重放 ⇒ 回到同一个 `state_hash`；`rewindPlan` 指向上一个状态；
13. 示例请求文件端到端跑通，结果里能追到 `evidence.region` / `confidence` 这一级的出处。

**M2（下一批，等你说了再做）**：壳里的界面（把存档与 trace 画出来）、`audit`（处方有效性）、
上游 AI 的转写规程（把这份契约写成给外部模型的提示词与自检清单）。

---

## §9 明确不做

- 不读照片、不调 AI、不搜题、不评价题目、不做计划：这些是**上游与下游**的事（本版范围）。
- 不做数据库/服务端/账号：存档就是 JSONL 文件。
- 不引入新机制：IO 只做翻译、执行、记录、呈现。
- 不在本层做"要不要采纳这条观察"的判断：按你的决定，**立即生效 + 存档可回退**。
