# MindNet —— 认知模型引擎（独立组件）

按 `docs/DESIGN_v1.1.md` 实现的**独立、不依赖 AI、不依赖网络**的认知模型引擎，外加一层可视化壳。
它只做一件事：**给一张认知图 + 起点，跑同步状态扩散，输出知识贡献 KC（Gap / Penalty）与目标激活情况。**

---

## 1. 三种用法

### 用法 A：可视化壳（推荐先看这个）

双击打开 `viz/index.html` 即可（浏览器直接以 `file://` 打开，不需要装任何东西、不需要服务器、不联网）。
壳里默认载入 10 个节点的示例图，可以：

| 操作 | 说明 |
|---|---|
| 点节点 → 右侧「设为起点 / 设为目标」 | 标记角色（标记后在「开始扩散 / 重置」时生效） |
| 「开始扩散」 | 起点的角色写进引擎，起点永久亮着 |
| 「单步」 | 走一轮，刚被激活的节点会闪一下 |
| 「跑到底」 | 一直走到停止（目标全达成 / 思维冷却 / 最大轮次） |
| 「自动播放 + 速度」 | 连续单步，看扩散一层层铺开 |
| 「追加起点」 | 扩散途中追加起点（下一轮生效） |
| 拖动节点 | 自己摆布局 |
| 现实时间 / 专注复习 / 设为 N 小时前 / 更新全局记忆 | 演示 §4 的遗忘曲线：ms 怎么随时间衰减、复习怎么把 ms 拉回 1.0 |
| 「发展区 / 死角区」清单 | KC 的逐节点来源（发展区缺口来自谁、死角惩罚来自谁） |
| 输入 JSON → 「载入文本框」 | 换成你自己的图（格式见 §4） |
| 「导出当前状态」 | 生成完整状态 JSON，可下载 |

> 自动化自检：用 `viz/index.html?selfcheck=1` 打开，脚本会把整条交互链路跑一遍，并把结果写进页面底部的 `<pre id="selfcheck">`。

### 用法 B：命令行

```powershell
cd mindnet
node cli.js example/graph.json                      # 设计文档 §8.1 的两节点示例
node cli.js example/demo_learning.json              # 10 节点演示图（会跑出 Gap 与死角 Penalty）
node cli.js example/demo_learning.json --json       # 只输出 JSON（机器可读）
node cli.js example/graph.json --max-rounds 3 --now 1000 --out state.json
```

选项：`--max-rounds <N>`、`--now <小时>`、`--out <文件>`、`--json`、`--no-memory`、`--help`。

### 用法 C：当库用

```js
const { Graph, Config, CognitiveModel, now_hours } = require('./src/index.js');

const now = now_hours();
const loader = Graph.load_input(JSON.parse(fs.readFileSync('graph.json', 'utf8')), now);
const model = new CognitiveModel(loader.graph, new Config());

model.update_global_memory(now);                       // 打开软件时更新长期记忆（§4.2）
model.start_diffusion(loader.initial_nodes, loader.target_nodes);
const result = model.run_until_stop();                 // §8.2 的四个字段
console.log(result.kc, result.target_steps, result.final_states);
```

浏览器里同一份源码挂在全局 `MindNet` 命名空间下（`MindNet.CognitiveModel` 等），无需打包工具。

---

## 2. 目录结构

```
mindnet/
├─ docs/                    设计文档（五份）
│  ├─ DESIGN_v1.1.md        v1.1 定稿（旧语义基线）
│  ├─ MODEL_v2_MATH.md      **v2 数学模型完整规范**：状态空间、全部方程、参数表、可证伪预测、假设登记
│  ├─ DESIGN_v2_PROPOSAL.md v2 提案：脑/学生模仿、九处机制缺口、三层架构、验收标准
│  ├─ PLUGIN_ARCHITECTURE.md 机制插件化：槽位、模块 manifest、不变量守卫、AI 插入流程
│  └─ MECHANISM_CATALOG.md  机制目录：8 层 50+ 条候选机制（带文献依据 / 数学形式 / 优先级）
├─ src/                     内核、v1.1 引擎与 v2 快层引擎（无第三方依赖）
│  ├─ core/rng.js           可播种 PRNG（确定性不变量 I1）
│  ├─ core/kernel.js        机制内核：15 个槽位调度、不变量守卫、共享/命名空间状态、验收执行
│  ├─ v2/engine.js          **v1.3 快层引擎**：每轮管线（节律→驱动→激活→容量→点火→落状态）
│  ├─ config.js             §9 全局参数 + 错误类型 + now_hours()
│  ├─ model.js              §3 Node / Edge / Graph（加载与校验）
│  ├─ memory.js             v1.1 的遗忘曲线 / 全局记忆更新 / 专注复习
│  ├─ diffusion.js          v1.1 扩散引擎 + KC + 输出协议
│  └─ index.js              Node 侧统一入口（createKernel / listMechanisms / memoryDsr）
├─ mechanisms/              机制模块（一个文件一个机制；可增删）
│  ├─ index.js              注册表：扫描 + 校验清单 + 配置档（v2 / memory / legacy / extras）
│  ├─ memory.dsr.js         **v1.2 记忆层**：R0/S/Σ、三档复习、失败证据老化、排程反解
│  ├─ dynamics.shunting.js  **v1.3 激活**：分流方程（精确积分）+ 亚阈累积
│  ├─ attention.capacity.js **v1.3 容量**：两级准入（DAR 4 + 焦点 1）
│  ├─ attention.ignition.js **v1.3 点火**：概率点火（温度 + 可播种随机）
│  ├─ rhythm.gate.js        **v1.3 节律**：占空比 / 走神马尔可夫 / θ，警觉衰减、负荷自适应节拍
│  ├─ context.goal.js       **v1.3 上下文**：目标偏置（抬高通向目标的候选）
│  ├─ attention.inhibition.js 侧抑制（实验性，默认不进 v2 档）
│  └─ legacy_v1.js          v1.1 兼容包（用于差分等价测试）
├─ tools/mechanisms.js      机制目录报告 + 严格校验（`npm run mechanisms`）
├─ probe/                   只读诊断脚本
│  ├─ learning_laws.js      v1.1 体检：答不上哪五条学习规律（`npm run probe`）
│  ├─ learning_laws_v2.js   v2 对照：五条规律逐条翻转（`npm run probe:v2`）
│  └─ model_math_check.js   v2 数学自检：常数、单调性、容量、退化等价（`npm run math`）
├─ cli.js                   命令行外壳
├─ viz/                     可视化壳（HTML + CSS + 原生 JS，无框架）
│  ├─ index.html            双击即用
│  ├─ app.js  styles.css    界面逻辑与样式
│  ├─ sample_graph.js       由 example/*.json 生成（勿手改）
│  └─ build_samples.js      重新生成上面那个文件
├─ example/
│  ├─ graph.json            设计文档 §8.1 的两节点示例
│  └─ demo_learning.json    10 节点演示图（含一个死角节点）
├─ test/                    node:test 测试（无需安装任何东西）
└─ package.json
```

> **当前进度**：内核 + 插件架构 + **v1.2 记忆层** + **v1.3 快层**已实现。
> v1.1 的旧语义**原样保留**在 `src/`（`CognitiveModel`），旧测试全部继续通过；
> v2 走 `src/v2/engine.js` + `mechanisms/`，通过配置档（profile）切换，二者可在同一张图上做对照实验。
> 剩下的 **v2.0 控制层**（元认知自信度与危险区、卡点分类 → 指令映射、反事实规划）尚未实现，方程见 `docs/MODEL_v2_MATH.md` §6–§7。

**v2 怎么用（三行）**

```js
const { Graph, Config, createKernel, memoryDsr } = require('./src/index.js');
const { FastEngine } = require('./src/v2/engine.js');
const graph = Graph.load_from_json('example/demo_learning.json', 0);
const engine = new FastEngine(graph, new Config(), { kernel: createKernel(graph, new Config(), { seed: 7, hours: 0 }) });
engine.start_diffusion(['trig_func'], ['solve_triangle']);
engine.run_until_stop(30);              // → 与 v1.1 相同的 §8.2 四字段
memoryDsr.scheduleInterval(graph.get_node('solve_triangle'), 0, 0.85);  // → 下次复习间隔
```

---

## 3. 引擎接口（对应设计文档 §7）

| 设计文档 | 本实现 | 说明 |
|---|---|---|
| `Graph.load_from_json(path, current_real_time)` | `Graph.load_from_json(input, current_real_time)` | `input` 可为文件路径（Node）、图对象或 §8.1 信封 |
| `Graph.load_input(...)` | `Graph.load_input(input, now)` | 直接返回 `{ graph, initial_nodes, target_nodes }` |
| `Config()` | `new Config(overrides)` | 参数见 §9；写错键名会报错 |
| `CognitiveModel(graph, config)` | 同 | |
| `model.update_global_memory(current_real_time)` | 同 | 超过 1 小时才衰减，返回本次衰减明细 |
| `model.start_diffusion(initial_nodes, target_nodes)` | 同 | 重置运行时状态；`visit_count` 累计保留 |
| `model.add_initial_nodes(ids)` | 同 | 下一轮生效；返回 `{queued, skipped}` |
| `model.step()` | 同 | 返回本轮 `{round, activated, stopped, stop_reason}` |
| `model.run_until_stop(max_rounds)` | 同 | 返回 §8.2 四个字段 |
| `model.get_kc()` | 同 | `{gap, penalty}` |
| `model.update_memory(id, review_type, current_real_time)` | `model.update_memory(id, {review_type, current_real_time})` | `focused` 已实现；`process` 抛 `NotImplementedError`（§4.4） |
| `model.export_state(path)` | 同 | 返回状态对象；给路径则写文件（Node） |
| — | `model.kc_breakdown()` | **附加只读视图**：KC 的逐节点明细，只给壳用，不改变 KC 算法（有测试保证求和一致） |

只读属性：`rounds`、`stop_reason`（`all_targets_reached` / `cooling` / `max_rounds`）、`running`、`stopped`、`targets_all_reached`、`starts`、`targets`、`attempted_this_diffusion`。

---

## 4. 输入 / 输出 JSON

输入（设计文档 §8.1，`example/graph.json` 就是这个）：

```json
{
  "graph": {
    "nodes": [
      { "id": "node_1", "name": "三角函数", "type": "knowledge",
        "weight": 0.9, "ms": 0.8, "ct": 0.3, "st": 0.05, "last_review_time": 0 },
      { "id": "node_2", "name": "正弦定理", "type": "knowledge",
        "weight": 0.7, "ms": 0.6, "ct": 0.3, "st": 0.05, "last_review_time": 0 }
    ],
    "edges": [
      { "id": "edge_1", "from": "node_1", "to": "node_2", "ls": 0.8 }
    ]
  },
  "initial_nodes": ["node_1"],
  "target_nodes": ["node_2"]
}
```

输出（设计文档 §8.2）——`node cli.js example/graph.json --json` 的实际输出：

```json
{
  "kc": { "gap": 0, "penalty": 0 },
  "target_steps": { "node_2": 1 },
  "targets_all_reached": true,
  "final_states": { "node_1": "CONSCIOUS", "node_2": "CONSCIOUS" }
}
```

演示图 `example/demo_learning.json` 的实际输出：`gap = 0.096`、`penalty = 0.4`、5 轮后思维冷却、
`solve_triangle` 第 2 轮激活、`polar`（极坐标）始终未激活并累计 `visit_count = 1`。

---

## 5. 实现决定（设计文档未拍板之处的处理）

这些是文档没有明确规定、但实现必须选一种做法的地方。全部在此列明，便于你核对或推翻：

1. **语言与形态：JavaScript**，一份源码同时给 Node 和浏览器用。
   理由：你要的是「独立组件 + 外面套一个可视化壳」，用同一门语言可以做到**引擎和壳共用一份代码**，壳还能双击直接打开（Python 做不到浏览器界面，除非再引入一整套运行时；Dart 更偏编译型 App 工程）。
   设计文档 §7 的 Python 签名在本实现里 **1:1 对应**（连方法名都保持 `start_diffusion` 这种下划线写法，方便你对着文档核对），换语言不影响模型语义。
2. **冷却判定**：用 `stable_rounds`（默认 2）统计「连续无变化轮次」，比较的是「本轮结束状态」与「上一轮结束状态」；基线取**起点已点亮之后**的状态。
3. **没有目标节点时**：目标检查不触发（文档 §5.4 要求此时靠冷却/最大轮次停止），`targets_all_reached` 记为 `false`；避免出现「空集全达成」却又「冷却停止」的自相矛盾。
4. **追加起点**：在下一轮**开始时**置为 `CONSCIOUS` 并参与该轮传播；已激活或已是起点的节点记为 `skipped`；扩散**已停止**时追加会报错（需要重新 `start_diffusion`）。
5. **`al` 与 `state` 保持严格一致**：文档 §5.2 的步骤顺序会让「本轮刚激活的节点」的 `al` 到下一轮才更新，这样在「第 1 轮就达成目标」时节点会显示 `al = 0`。实现在每轮状态更新后按状态重算 `al`（§3.1 说「al 由状态推导」），**只影响报告值，不影响影响力计算**。
6. **显式报错而不是静默忽略**：未知节点 id（起点/目标/追加）、边端点不存在、节点 id 重复、必填字段缺失、字段类型不对、配置键名写错 —— 都抛 `MindNetError` 并带中文说明。
7. **不校验数值范围**：文档给了 `weight`、`ms` ∈ (0, 1]，但没有规定越界怎么处理，本实现不做强制校验（照原值计算）。
8. **输出精度**：JSON 输出里 KC 与 Impact 保留 6 位小数，避免 `0.21000000000000002` 这类浮点噪声；内部计算不舍入。
9. **`export_state()` 的内容**：§8.2 的四个字段原样在前，另外附加 `rounds`、`stop_reason`、`nodes`（每个节点的完整字段）、`config`，供壳和排查使用。
10. **`Graph.from_object(obj, current_real_time)`**：加载即修正 `last_review_time == 0 / 缺失` 的节点（§3.1），缺省用当前现实时间。

---

## 6. 验证情况（跑了什么、没跑什么）

**已实际执行并通过**（Node v24.19.0，Windows）：

| 命令 | 结果 |
|---|---|
| `npm test` | **68 / 68 通过**（41 项 v1.1 旧语义 + 27 项新增：内核契约、v1.2 记忆层、v1.3 快层与差分等价） |
| `npm run mechanisms -- --check` | **8 个模块**：schema 通过、静态扫描 0 项违规、验收断言 **46 条全部通过** |
| `npm run probe` | v1.1 体检：五条学习规律全部答不上（这是 v2 的立项依据） |
| `npm run probe:v2` | v2 对照：**规律 1–5 全部翻转**（含容量 201→进入意识 2 / 在脑子里 10，距离衰减 0.81 恒定 → 0.983→0.194） |
| `npm run math` | 数学自检 7 组全过（含 `t∈[0,200]h` 上 v1.1 与 v2 指数模式**最大差 = 0**） |
| **差分等价**（`test/v2_fast.test.js`） | `FastEngine + legacy_v1` 在链 / 菱形 / 扇出三张图上逐轮复现 v1.1 的 `state` 与 `al`，目标步数一致 |
| `node cli.js example/graph.json --json` | 输出与文档 §8.2 逐字段一致 |
| `node cli.js example/demo_learning.json` | `gap = 0.096`、`penalty = 0.4`、5 轮冷却停止、`polar` 死角 `visit = 1` |
| Edge 无头浏览器打开 `viz/index.html` | 10 个 SVG 节点 / 11 条边 / 表格全部渲染，消息「已载入：10 个节点 / 11 条边」，无脚本报错 |
| Edge 无头浏览器打开 `viz/index.html?selfcheck=1` | `SELFCHECK_OK`：角色设置 → 开始 → 单步 → 追加起点（`coordinate` 下一轮生效）→ 跑到底 → 专注复习 → 设为 10 小时前 → 全局记忆更新（`polar: 0.15 → 0.0093`）→ 导出 4432 字节状态；`transforms_ok=true`、`class_mismatch=0` |

测试文件：`test/memory.test.js`（v1.1 遗忘曲线、复习、配置）、`test/diffusion.test.js`（v1.1 状态判定、永久亮着、多起点、追加、冷却、最大轮次、目标）、`test/kc.test.js`（v1.1 Gap / Penalty）、`test/graph.test.js`（加载与校验、严格有向）、`test/shell.test.js`（壳结构与 CLI）、`test/kernel.test.js`（**插件内核**：清单校验、依赖排序、错误隔离、不变量守卫、确定性、参数解析）、`test/v2_memory.test.js`（**v1.2 记忆层**：规律 1/5 翻转、提取练习效应、储蓄效应、排程反解、退化等价、难度调整）、`test/v2_fast.test.js`（**v1.3 快层**：规律 2/3/4 翻转、概率点火可复现、节律门控、负荷自适应节拍、**与 v1.1 的差分等价**、协议与确定性）。

**尚未验证**（说明原因，避免被当成已确认的结论）：

- 只测了 **Microsoft Edge 无头模式**；Firefox / Safari / 手机浏览器没测。
- **鼠标拖拽节点、按钮点击的实际手感、配色与排版**没有人工看过（本会话没有截图能力）；壳的逻辑路径已被 `?selfcheck=1` 覆盖，但视觉效果需要你自己打开确认。
- `file://` 下「下载 state.json」按钮没有实际点过（导出内容本身有证据：自检里 `json_output_len` 有值）。
- 没有做性能测试（当前规模是几十个节点；模型是每轮全图遍历，节点上万时可能需要优化）。
- v2 的**参数标定**：`[文献]` 值来自 FSRS 公开默认参数（在别人的数据上拟合），`[未标定]` 值未经你的数据检验；标定状态在 `npm run mechanisms` 的目录报告里逐条列出。
- **一个已知的标定敏感点**：`c_R0 = 0.05`（每次成功提取对编码上限 `R0` 的提升）未标定。按这个初值，`R0` 要从 0.8 升到 0.85 需要约 5 次成功提取；在那之前「以 85% 留存为目标排程」会返回间隔 `0`（因为曲线够不到目标）。这是模型的诚实结果，但初值需要按你的数据调。
- 可视化壳**还没有接 v2**（仍用 v1.1 扩散与 `viz/app.js` 自己的记忆面板）；v2 的展示属于后续批次。
- v1.3 的**快层参数**（α、λ、η_q、λ_q、T_ign、T0、duty、p_off/p_on、λ_load、τ_vig、β_goal、κ_reach）**全部未标定**：默认值是量级合理的取值，能让机制跑起来并复现定性规律，但**不能当作对你个人有效的准确参数**。
- **侧抑制默认关闭**（`extras` 档）：未归一化的求和会让 200 个同构节点之间产生 18.1 的抑制量、把所有候选一次压死（实测），所以实现里改成饱和形式 `sat(x)=x/(1+x)` 并且默认 `γ=0`，等有数据再开。
- **`target_steps` 在 v2 里信息量下降**：目标偏置会让目标节点从第 1 轮起就半亮，因此看传播距离要用峰值驱动或节点进入意识的轮次，不能只看 `target_steps`。
- 与 v1.1 的**差分等价只覆盖状态演化**（`state` / `al` / 目标步数，链/菱形/扇出三张图）：v2 的冷却判据、KC 的 Penalty 口径与 v1.1 不同（v2 用时间衰减的失败证据），**没有声称逐位等价**。

---

## 7. 改数据与重新生成

- 改示例图：直接编辑 `example/*.json`，然后 `node viz/build_samples.js`（或 `npm run samples`）重新生成 `viz/sample_graph.js`。
- 壳里也可以直接粘贴任意 §8.1 格式的 JSON → 点「载入文本框」，不需要改文件。
- 运行测试：`npm test`（只用 Node 内置能力，不需要 `npm install`）。
- 整个目录是**自包含**的：全库搜索 `FirsryOS\`、`THREADRIPPER\`、`E:\Document`（范围：全部 `.js/.json/.md/.html/.css`）没有命中任何写死的绝对路径；本会话把整个目录从工作区搬到 `E:\Document\MindNet` 后，41 项测试、CLI、无头浏览器自检都在新位置复跑通过。
- 测试的临时文件写在组件自己的 `.tmp/` 里，**不写系统 TEMP**（不在 C 盘留任何东西）；`npm test` 跑完复查过：`.tmp` 不存在、系统 TEMP 里 `mindnet|edge_profile` 残留 0 项。
