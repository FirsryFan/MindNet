# MindNet 机制插件架构（Mechanism Plugin Architecture）

**状态**：设计（待你确认后实现）
**解决的问题**：你要的"用户能自定义作用效果（比如元认知），方式是过程中留出参数与运行机制的槽位，**AI 插入对应模块代码就能跑起来**"。
**配套**：`docs/MECHANISM_CATALOG.md`（有哪些机制可插）、`docs/DESIGN_v2_PROPOSAL.md`（模型本身怎么改）

---

## 1. 一条总原则

> **内核固定且最小，机制全部外挂；模块只能通过声明的槽位改状态，不能绕过不变量。**

内核只负责四件事：时间推进、状态容器、槽位调度、不变量守卫。
所有"像脑/像学生"的东西（注意力、走神、巩固、元认知……）都是模块。**连 v1.1 本身也降级成一个模块**（见 §9），所以"新模型 / 旧模型"不再是两套代码，而是两份模块配置。

---

## 2. 三种时间基（这是"思维频率"能被建模的前提）

v1.1 只有"轮次"。你要的"一秒钟半秒在思考、半秒不在"需要更细的时间片，所以内核提供三级时间：

| 时间基 | 默认 | 用途 | 谁在用 |
|---|---|---|---|
| `tick` | 250 ms | 节律、注意采样、走神开关、警觉衰减 | 节律层模块 |
| `round` | 4 tick（≈1 秒） | 扩散更新（v1.1 的"轮次"就是它） | 扩散/注意模块 |
| `hours` | 现实小时 | 记忆衰减、间隔排程、巩固 | 记忆/排程模块 |

`ticks_per_round` 是配置项（默认 4）：**调它就能把"思维频率"从 1 秒压到 4 秒**，这是 Executive_Architecture §2「思维频率」在引擎里的落点。

---

## 3. 槽位（Hook Points）

模块就是挂在槽位上的函数。槽位按执行顺序排列，每个槽位声明**能读什么、能写什么、能不能拦断**：

| # | 槽位 | 时机 | 典型用途 | 可拦断 |
|---|---|---|---|---|
| 1 | `tick.before` | 每 tick 开始 | 相位推进、走神马尔可夫状态、警觉值 | 否 |
| 2 | `tick.gate` | 每 tick 点火前 | 本 tick 是否允许点火（走神中 → 否） | **是** |
| 3 | `round.before` | 每轮开始 | 目标/上下文刷新、疲劳累积、带宽重置 | 否 |
| 4 | `drive.compute` | 算入边驱动时 | 求和/取最大、情境调制、抑制、fan 修正 | 否（可改值） |
| 5 | `attention.select` | 驱动算完后 | 带宽竞争、显著性排序、硬聚焦 | 否（可改排序） |
| 6 | `ignite.check` | 点火判定 | 阈值/概率点火/温度 | 否 |
| 7 | `state.after` | 状态落定后 | 元认知采样、情感标记、失败分类 | 否 |
| 8 | `round.after` | 每轮结束 | 冷却判定、日志、跨轮统计 | 否 |
| 9 | `review.on` | 复习事件 | 三档复习、S/D 更新、错误回写 | 否 |
| 10 | `consolidate.on` | 环节末/跨天 | 重放巩固、突触下调、间隔排程 | 否 |
| 11 | `diagnose.on` | 诊断阶段 | 卡点分类、危险区、内化深度 | 否 |
| 12 | `output.score` | 输出阶段 | 排序、指令建议、反事实预测 | 否 |
| 13 | `serialize.on` | 存档 | 模块自己的状态字段读写 | 否 |

槽位函数签名统一：

```js
function hook(ctx) {
  // ctx: 只读访问器 + 受校验的写入口
  const drive = ctx.get('drive');                     // 读
  ctx.patch(nodeId, { 'm.attention.load': 0.7 });     // 写（只能写自己声明过的字段）
  return { block: false };                            // tick.gate 可返回 { block: true, reason: 'mind_wandering' }
}
```

`ctx` 提供：`nodes / edges / round / tick / hours / goal / rng(seed) / config / log()`。
**`ctx.now` 而不是 `Date.now()`**——内核要保证确定性（同一 seed 逐位可复现）。

---

## 4. 模块清单（Manifest）：一个文件就能插进来

```js
// mechanisms/attention.mind_wandering.js
module.exports = {
  api: 1,                                  // 模块 API 版本；内核不兼容时加载期直接拒绝
  id: 'attention.mind_wandering',
  name: '走神（任务无关思维）',
  layer: 'rhythm',                         // rhythm|attention|memory|structure|metacognition|motivation|control|output
  level: 'optional',                       // core=默认开 | optional=可选 | metric=只产出指标

  // 它模拟什么现象（必须写，且带证据等级）
  phenomenon: [
    '人清醒时间约 46.9% 在想与当前活动无关的事（Killingsworth & Gilbert 2010, Science）',
  ],
  evidence: [
    { grade: 'read', url: 'https://www.eurekalert.org/news-releases/811445' },
  ],

  // 参数：内核据此自动生成 UI 控件；每个参数必须标"是否已标定"
  params: [
    { key: 'p_enter_off', type: 'number', min: 0, max: 1, default: 0.02, unit: '1/tick',
      desc: '每个 tick 从专注转入走神的概率', evidence: '未标定', calibrated: false },
    { key: 'p_exit_off',  type: 'number', min: 0, max: 1, default: 0.08, unit: '1/tick',
      desc: '每个 tick 从走神转回专注的概率', evidence: '未标定', calibrated: false },
    { key: 'off_penalty', type: 'number', min: 0, max: 1, default: 1.0, unit: '-',
      desc: '走神时点火被拦截的强度（1=完全拦截）', evidence: '未标定', calibrated: false },
  ],

  reads: ['a', 'goal'],                                  // 声明式：内核据此做静态校验
  writes: ['m.attention.availability'],                   // 只能写命名空间字段

  requires: [], conflicts: ['attention.hard_focus'],      // 冲突的模块不能同时启用
  hooks: {
    'tick.before': (ctx) => { /* 马尔可夫转移 → m.attention.availability */ },
    'tick.gate':   (ctx) => ({ block: ctx.get('m.attention.availability') < 0.5, reason: 'mind_wandering' }),
    'diagnose.on': (ctx) => { /* 输出：哪些节点因为走神而错过点火 */ },
  },

  // 验收断言：不通过就不许加载（见 §7）
  acceptance: [
    { name: '走神占比落在 0.2~0.5', check: (sim) => sim.offFraction > 0.2 && sim.offFraction < 0.5 },
    { name: '走神确实改变结果（消融检查）', check: (sim, simOff) => sim.targetSteps !== simOff.targetSteps },
  ],
};
```

**插入方式**：把这个文件放进 `mechanisms/`（[新] 计划创建的目录），在 `mechanisms/index.js`（[新] 计划创建）里加一行（Node 侧自动扫描；浏览器侧由 `viz/build_mechanisms.js`（[新] 计划创建）生成清单，跟现在 `sample_graph.js` 的做法一致）。**没有第二步**。

---

## 5. 用户侧：开关 + 滑块，不需要懂代码

可视化壳读 manifest 的 `params` 自动生成控件：

```
机制                     [开关]   参数（自动生成）
──────────────────────────────────────────────────────────
走神（任务无关思维）      [ ✓ ]   转入走神 0.02 /tick  [====|----]
                                 转回专注 0.08 /tick  [==|------]
                                 拦截强度 1.0         [==========]
                                 依据：Killingsworth & Gilbert 2010 ↗
注意力带宽（软预算）      [ ✓ ]   带宽 W = 4.0        [====|----]
元认知自信度              [ ✓ ]   流畅权重 0.8        [=======|---]
```

每个参数旁边点开就是**证据出处**和"是否已标定"。用户看到的是"效果 + 依据 + 旋钮"，不是代码。

---

## 6. 内核不变量（模块不许绕过）

内核在每个槽位边界自动校验；违反即**该模块本轮失效并在输出里报告**（不静默吞掉）：

| # | 不变量 | 检查方式 |
|---|---|---|
| I1 | 确定性：同 seed + 同输入 ⇒ 同输出 | 跑两次比对状态哈希；`Math.random` 禁用（静态扫描） |
| I2 | 状态合法：`al∈[0,1]`、概率∈[0,1]、无 NaN/Inf | 每轮边界校验 |
| I3 | 纯度：模块不得访问 fs / 网络 / `Date.now` | 加载期静态扫描 `require(`/`fetch(`，白名单外直接拒绝 |
| I4 | 预算守恒：意识集占用 ≤ 带宽 | 内核自己算，不信模块自证 |
| I5 | 时间单调：tick / round / hours 只增不减 | 每轮边界校验 |
| I6 | 字段所有权：core 字段只能 core 写 | 加载期用 `writes` 声明交叉校验 |
| I7 | 性能：单槽位单轮 ≤ 1 ms / 1000 节点 | 计时，超时告警（不阻断） |
| I8 | 不静默：模块抛错必须出现在输出里 | 错误收集器注入 `result.warnings` |

**失败策略**：加载期问题 → 拒绝加载（`npm run mechanisms -- --check` 报错并给出修法）；运行期问题 → 熔断该模块 + 告警，扩散继续跑（不能因为一个实验性模块让整个引擎崩）。

---

## 7. 验收契约（防止"机制越加越不可证伪"）

每个模块**必须**带 `acceptance`，至少包含两类断言：

1. **现象断言**：开了它，某个可测统计落在文献量级内（如走神占比 0.2~0.5）。
2. **消融断言（必须）**：关掉它，**至少一个决定会变**（target_steps / 排序 / 诊断结论 / KC）。改不了任何决定的模块只能标 `level: 'metric'`，不许进动力学。

`npm run mechanisms -- --check` 会：
- 校验 manifest schema、依赖拓扑、冲突、API 版本；
- 静态扫描禁用 API；
- **跑一遍 acceptance**（含消融）；
- 打印机制目录报告（谁启用、参数、证据、验收状态）。

这是把上一轮那条纪律（"一个机制最多一个参数，且必须能改变一个决定"）**机械化**——不靠自觉。

---

## 8. AI 插入模块的标准流程

| 步 | 谁 | 做什么 | 产物 |
|---|---|---|---|
| 1 | 你 | 一句人话："加一个『半秒在思考半秒不在』的机制" | — |
| 2 | AI | 按模板产出模块文件（含现象、参数、槽位、验收断言） | `mechanisms/rhythm_duty_cycle.js`（[新] 计划创建） |
| 3 | AI | 跑 `npm run mechanisms -- --check` | 校验报告 |
| 4 | 引擎 | 跑 acceptance；**不通过就不加载** | 通过/失败 + 失败原因 |
| 5 | 你 | 在可视化壳里看到新机制，拨开关、拖滑块 | 效果立即可见 |

第 4 步是关键：**AI 写的机制必须自己证明"它确实改变了某个决定"才能上线**，这样"插入代码就能跑"不会变成"插入代码就有一堆假机制"。

---

## 9. v1.1 也是一个模块（兼容性因此变成配置）

把 v1.1 的规则原样实现成一个模块包 `mechanisms/legacy_v1.js`（[新] 计划创建）：

- `drive.compute`：入边取 **max**（v1.1 行为）
- `ignite.check`：硬阈值、无带宽限制
- `state.after`：永久亮着（一旦激活不再变）
- `review.on`：`ms = 1.0`、`S = k·ms`
- `tick.gate`：不挂（没有 tick 层）

于是：

| 配置 | 结果 |
|---|---|
| `enabled: ['legacy_v1']` | **逐位复现 v1.1**（现有 41 项测试跑在这个配置上） |
| `enabled: ['memory.stability', 'attention.bandwidth', ...]` | v2 行为 |
| `enabled: ['legacy_v1', 'metacognition.belief']` | 旧扩散 + 新元认知（**渐进升级**：你可以一次只换一块） |

这解决了上一轮承诺的"可退化性"：不再是"两套代码要同步维护"，而是**一份内核 + 可替换的模块**。你甚至可以同一张图跑两个配置做对照实验（消融研究变成了命令行参数）。

---

## 10. 目录结构（实现后）

```
mindnet/
├─ src/core/               内核：时间推进、状态容器、槽位调度、不变量守卫（不允许模块改这里）
│  ├─ kernel.js  state.js  hooks.js  invariants.js  registry.js
├─ mechanisms/             机制模块（一个文件一个机制；可增删）
│  ├─ index.js             注册表（Node 侧自动扫描）
│  ├─ legacy_v1.js         v1.1 规则包（兼容基线）
│  ├─ memory.stability.js  S/D/R 三变量记忆
│  ├─ attention.bandwidth.js
│  ├─ rhythm.duty_cycle.js 「半秒在/半秒不在」
│  ├─ metacognition.belief.js
│  └─ ...
├─ tools/mechanisms.js     校验 + 目录报告（npm run mechanisms）
├─ probe/                  学习规律探针（已有）
└─ viz/                    可视化壳（按 manifest 自动生成开关与滑块）
```

---

## 11. 需要你拍板的 4 件事

1. **槽位够不够**：13 个槽位是照"节律 / 注意 / 记忆 / 结构 / 元认知 / 动机 / 控制 / 输出"八层设计的。你有没有想插但落不进这 13 个槽位的机制？
2. **可拦断的槽位只有 `tick.gate`**：拦断会改变"谁能进意识"，影响很大。要不要再开放 `attention.select`（抢占式注意力，比如"突然被某个显著线索抓走"）？
3. **模块是否允许改协议输出**：现在只允许往 `output` 里**加**字段，不允许改 §8.2 四个字段。你要不要允许模块替换整个诊断口径？
4. **验收断言的严格度**：现象断言需要文献区间（例如走神占比 0.2~0.5）。有些机制暂时给不出区间（只能给"方向性"断言，如"间隔组 > 集中组"）——这种算通过吗？
