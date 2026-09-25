# MindNet 反馈微调协议（feedback）

> 标定（`docs/CALIBRATION.md`）负责**起点**，反馈负责**之后每天的真实修正**。
> 本文写清楚：更新律是什么、为什么是它、它能把参数修到多准、以及在壳里/命令行里怎么用。

---

## 1 它解决什么问题

标定页只能给你一个**量级正确**的初值（而且其中三项已经改成"用文献默认值就够、不做也行"）。
真正把这个模型往你身上拧的是日常动作：**每做一道题，就是一条证据**。

一条证据长这样：

```json
{ "node": "polar", "tHours": 48, "correct": false, "at": 1758000000000 }
```

- `node`：这是哪条线索（图里的节点 id）；
- `tHours`：距上次复习过了多少小时；
- `correct`：这次想起来了没有；
- `at`：真实时间戳（只用于展示与排序，**不参与任何计算**）。

---

## 2 更新律（`src/feedback.js`）

模型先预测"这次你大概能不能想起来"，再看实际结果，按**预测误差**修正稳定度 `S`：

```
p  = R0 · Ψ(t / S)              ← 模型预测的可提取度（Ψ 与排程用的是同一条曲线）
e  = y − p                      ← y = 1 答对、0 答错；这就是预测误差
u  = 4p(1 − p)                  ← 信息量权重：p ≈ 0.5 时最有信息，p ≈ 0/1 时几乎为零
gain_k = max(α_min, α / (1 + k/K))   ← 递减增益（k = 这条线索已收过几条证据）
S' = S · exp(gain_k · e · u)    ← 按误差方向走，步长由信息量与增益共同决定
D' = clip(D − 0.15 · e · u · 2, 1, 10)  ← 答错且原本有把握 ⇒ 难度上调
```

默认参数：`α = 0.35`、`α_min = 0.05`、`K = 20`、单步位移硬上限 **±40%**、`S ∈ [0.1, 100000]`。

### 为什么必须是"误差"而不是"答对加分"

用"答对加分"的写法（答对 `S × 1.15`、答错 `S ÷ 1.15`）时，每一条证据的期望 log 位移是

```
E[Δ log S] = (2p_correct − 1) · ln 1.15
```

而排程的目标留存率只要高于 50%（例如 85%），`p_correct > 0.5` 就恒成立，于是
**期望位移恒为正 ⇒ `S` 单调上漂、永远收敛不到真值**。旧版 `calibration.refineStability`
正是这个写法（并且它压根没用 `tHours`），已经废弃，现在只是指向本模块的兼容别名。

用 `e = y − p` 时有一个干净的性质：

> **E[e] = 0 ⇔ 模型校准。**

也就是说，"模型恰好说对了你的记忆强度"就是这条更新律的不动点。
`test/feedback.test.js` 里有两条专门的断言守着它：校准态下平均位移趋近 0（无漂移），
以及"真实 S 与初值差近一倍时，几百条证据后必须走回来"（收敛）。

### 为什么增益要递减

固定增益下估计值会永远在真值附近抖动（稳态误差约 ±60%）。让增益按证据条数衰减
（第 20 条时减半），于是"前几条快速靠近、之后越来越稳"；
同时保留地板 `α_min = 0.05`，保证你本人真的变强/变弱时它还跟得上，不会变成化石。

---

## 3 诚实边界：一道题只有 1 bit

这是整个模块最重要的一条结论，**它不是算法的缺陷，是数据的性质**。

一道题的结果只有"对/错"两种，它对 `S` 的信息量可以用 Fisher 信息算出来：

```
I(x) = (∂p/∂log S)² / (p(1−p)),   x = t/S
```

代入 `p = R0·(1 + c·x)^(−γ)`、`γ = 0.1542`、`c = 0.980346`（与排程同源）后，
`I` 在 **t ≈ 3.9·S（那时 p ≈ 0.70）** 取到最大 `I ≈ 0.0359`。于是：

```
n 条证据之后  log S 的标准误 ≥ 1/√(n·I)
```

| 证据条数 | S 的误差下界（最好情况） |
|---|---|
| 25 | ±187% |
| 50 | ±111% |
| 100 | ±70% |
| 200 | ±45% |
| 400 | ±30% |
| 900 | ±19% |

实测（`node tools/feedback.js demo --events 400`，20 个随机种子的 RMS 与下界之比
**0.91 ~ 0.99**）说明：这个更新律**已经把数据榨干了**，换任何别的估计器都不会显著更快。

结论有三条，直接决定了这个模块该怎么用：

1. **反馈调的是量级，不是小数点**：它擅长发现"这条线索比我以为的结实/脆弱几倍"，不擅长定到 ±10%。
2. **所以标定页不需要你去精确测 `S`**（T3 已改为选做，默认直接用 FSRS-4.5 的量级）。
3. **所以必须长期跑**：把每道题的对错都记下来，几十条之后才谈得上"准"。
   界面上会一直显示当前的误差下界（`se_best_pct`），不假装精准。

---

## 4 三种用法

> **先记住分工**：每条线索的 `S` 由**机制**（`mechanisms/memory.dsr.js`）维护 —— 那是模型的物理。
> 本模块**不改任何节点的 S**，它只做体检与参数建议（`docs/IO_PROTOCOL.md` §6 的定案）。

### 4.1 可视化壳（主要入口）

打开 `viz/index.html` → 右侧 **「反馈」** 卡片：

1. 在图上点一条线索（或点节点表里的一行）；
2. 「距上次复习」会自动填成 `现在 − 上次复习`，也可以手改；
3. 点 **「答对了」/「答错了」** —— 立刻看到：
   - 模型考前的预测留存 `p`（这就是它当时的把握）；
   - 账本估计 `S` 的位移百分比、这条证据的权重与增益；
   - **机制算的 `S` vs 体检估的 `S`** 并排（表格两列）+ 偏差倍数；
   - **下一次复习时间**（按机制那个 `S` 与 `calibration.target_retention` 算，默认 0.85）。

记录存在 `localStorage['mindnet.feedback.v1']`，可以「撤销上一条」（账本会从起点回放重算）。
面板底部始终显示：共几条证据、正确率、`S` 的误差下界。
证据够多时，点 **「把体检结论写成参数」** 会把建议（例如 `memory.dsr.legacy_k`）写进
`localStorage['mindnet.overrides']`，刷新后引擎按新参数装配。

> 口径提醒：如果目标留存（例如 0.85）**高于**这条线索的编码上限 `R0`（例如 0.8），
> 排程公式会返回间隔 0 —— 面板会把原因写出来，而不是静默显示 0。

### 4.2 命令行

```powershell
node tools/feedback.js init    .tmp/led.json example/demo_learning.json   # 先取真实起点
node tools/feedback.js add     .tmp/led.json --node polar --hours 48 --wrong
node tools/feedback.js add     .tmp/led.json --node polar --hours 20 --correct
node tools/feedback.js report  .tmp/led.json
node tools/feedback.js compare .tmp/led.json example/demo_learning.json   # 体检：机制 S vs 账本估计
node tools/feedback.js params  .tmp/led.json -o overrides.json            # 只给参数建议
node tools/feedback.js demo    --events 400                               # 看收敛/不漂移
```

`compare` 是日常最常用的那条：它把"模型算的 `S`"和"用你的对错估出来的 `S`"摆在一起，
告诉你模型偏乐观还是偏保守、现在还差多少证据。`params` 给出的 overrides
可以直接喂给 `createKernel(graph, config, { overrides })`。

### 4.3 代码里

```js
const { FeedbackLog } = require('./src/feedback.js');
const log = new FeedbackLog();
log.harvest(graph);                               // 起点 = 图里现有的记忆状态
log.record({ node: 'polar', tHours: 48, correct: false });
log.compareWithGraph(graph);                      // 体检：机制 S vs 账本估计 + 偏差读数
log.suggestOverrides();                           // 唯一的"写"出口：参数建议（不碰 S）
log.report();                                     // 逐节点统计 + 误差下界 + 全局 k 建议
```

---

## 5 与其它部分的接口

| 接口 | 说明 |
|---|---|
| `memory.dsr` 的曲线 | `predictedRetrievability` 直接调用 `memoryDsr.psi` 与它的默认参数（`gamma` 等），**不另造一条曲线**；参数不全时显式报错，绝不静默返回 0 |
| `S` 的归属 | **机制独占**（复习事件里的 `SInc` / 遗忘后公式）。本模块只观测与建议，因此同一事件不会被两条规则记账 |
| 排程 | 排程始终用机制那个 `S`：`memoryDsr.scheduleInterval(node, now, target)` |
| 全局 `k` | `suggestLegacyK()` 取各节点 `S/R0` 的**中位数**（≥3 个节点才算数）；`suggestOverrides()` 把它包成 overrides |
| 存档往返 | `Node.from_object` / `to_object` 会带上机制命名空间 `m`，`Graph.from_object` 也接受 `{id: 节点}` 映射形态，所以 `state()` 导出的存档能原样载回（含起点/目标） |
| 标定 | `calibration.refineStability` 只是本模块的兼容别名（估计用），不写状态 |
| I/O 层 | 上游送来的 `review` 观察由 `src/io/run.js` 走机制路径；本模块的账本可以从 I/O 的 `applied[].delta` 直接喂（那条 delta 就是机制的返回） |
| 反事实规划 | 机制维护的 `S` 就是 `docs/MODEL_v2_MATH.md` §7.2 规划器的输入 |

---

## 6 复现与自检

```powershell
npm test                                   # 122 项（其中反馈 11 项 + 反馈 CLI 6 项 + I/O 13 项）
node tools/feedback.js demo --events 400   # 收敛/无偏的信息论验证
node tools/feedback.js compare <账本> <图>  # 体检：机制 S vs 账本估计
node tools/mechanisms.js --check           # 机制契约不受影响
```

可视化壳与标定页都自带自检：

- `viz/index.html?selfcheck=1` → 页面底部 `<pre id="selfcheck">`，其中 `fb_*` 行是一次真实的
  "记一条错题 → 账本估计下降 → 面板并排显示机制/体检两个值"；
- `viz/calibrate.html?selfcheck=1` → 报告里含 `tier_core/tier_optional`（必做 3 / 选做 3）
  与一次真实的反馈演示（`refine_out`）。

---

## 7 还没做的（诚实清单）

- **节点级 `S` 与全局 `k` 没有做分层贝叶斯**：现在是"逐节点误差更新 + 跨节点取中位数"，
  比单节点瞎修稳，但不如真正的分层模型省数据；
- **没有自动选题**：什么时候该考哪条线索、该考到多少留存，目前由你决定
  （规划器给建议，但不强制）；
- **难度 `D` 的反馈尺度 `d_feedback = 0.15` 未标定**，只有"答错且原本有把握 ⇒ 上调"这个方向是确定的；
- **T3/T4 的人工实验没有真人数据**：§3 的表格是 Fisher 信息的理论下界 + 模拟学生验证，
  真人跑出来的曲线会不会更平，还没有证据。
