# MindNet 记忆记录（待写入 Hindsight 记忆库）

**为什么有这个文件**：本仓库的 Hindsight 记忆库余额不足，读整页与写入记忆都被拒（`402 Insufficient credits. Balance: $-0.03,`）。
本文件是**待写入记忆库的事实清单**：余额恢复后照 §3 的两步补记，任何一次新会话也可以直接读这个文件恢复上下文，不依赖记忆库。
**边界**：这不是设计文档。设计见 `DESIGN_v1.1.md`、`DESIGN_v2_PROPOSAL.md`、`PLUGIN_ARCHITECTURE.md`、`MECHANISM_CATALOG.md`。

---

## 1. 事实清单（截至本次记录）

| 事实 | 证据 |
|---|---|
| MindNet 是一个**独立组件**（引擎 + 可视化壳），不依赖 AI、不依赖网络、零第三方依赖 | `[跑]` `npm test` → 41/41 通过（Node v24.19.0） |
| 位置：**`E:\Document\MindNet`**（22 个文件时搬迁，现 26 个文件 / 208.7 KB） | `[跑]` 目录清单 |
| 曾经在 `E:\FirsryOS\THREADRIPPER\mindnet`，已整体搬迁；组件内**无写死绝对路径**，搬迁后 41 项测试、CLI、无头浏览器自检均在新位置复跑通过 | `[跑]` 搬迁后全量复验 |
| 引擎 `src/` 仍是 **v1.1 行为**（用户交付的 v1.1 定稿），未按 v2 提案改动 | `[读]` `src/*.js` |
| 语言选择：**JavaScript**（一份源码同时给 Node 与浏览器，壳可 `file://` 双击打开）；设计文档 §7 的 Python 方法名 1:1 保留 | `[读]` `README.md` §5 |
| 组件名从「Furnace / 熔思」改为 **MindNet**（用户要求：它只是一个组件） | `[读]` `docs/DESIGN_v1.1.md` 抬头说明 |
| 新增只读探针 `probe/learning_laws.js`：实测 v1.1 答不上五条学习规律 | `[跑]` `npm run probe` |
| 三份设计文档 + 一份提案：`DESIGN_v2_PROPOSAL.md`、`PLUGIN_ARCHITECTURE.md`、`MECHANISM_CATALOG.md` | `[读]` `docs/` |
| 引擎代码未因设计工作改动；文档声明审计 BLOCKER 0 | `[跑]` `audit-claims.mjs` |

### 探针实测的五条缺口（v1.1）

1. 复习次数不改变遗忘速度：复习 1/3/10 次后 S 恒为 24 小时，72 小时后留存都是 0.049787（违反用户 `Application_Protocol` §1「提取历史 K」）
2. 无意识容量：200 节点星图 1 轮点亮全部 201 个节点
3. 入边取 max：10 条弱线索合计 0.40 ≥ CT 0.3，节点仍 INACTIVE
4. 距离无代价：六节点链每跳首次 Impact 都是 0.81
5. 失败证据不老化：刚失败与一年后 Penalty 都是 1

### 方向变更（用户要求）

用户要求：**基于对人脑的模仿 + 对学生学习过程的模仿**完善模型；并且**用户可自定义作用效果**（元认知是其一），方式是"在运行过程中留出参数与机制槽位，**AI 插入对应模块代码就能跑起来**"。据此产出：

- v2 提案：三层架构（快层激活 / 慢层记忆 / 控制层诊断→指令）、九处机制缺口、八条学习规律验收断言、可退化到 v1.1 的迁移方案；
- 插件架构：内核固定 + 机制外挂，**13 个槽位**、模块 manifest、8 条不变量守卫、验收契约（现象断言 + 强制消融断言）、AI 插入五步流程、用户侧自动生成开关与滑块；**v1.1 本身降级为 `legacy_v1` 模块**（兼容性变成配置）；
- 机制目录：8 层 50+ 条候选机制，每条带证据分级与文献链接（含"不建议做"清单）；
- 新增**三级时间基** `tick`(250ms) / `round`(4 tick ≈ 1s) / `hours`，这是"思维频率 / 半秒在思考半秒不在"能被建模的前提。

---

## 2. 记忆库当前状态（2026-09-21 实测）

- 页面 `kp-4da6589568e7468fb128e5c5d0565b84`「MindNet 认知模型引擎（独立组件 + 可视化壳）」**存在但内容为空**（搜索片段为 `Generating content...`）→ 库里**没有过期信息需要更正**，只缺内容。
- 可用：`sync_status`、`list_knowledge_pages`、`search_knowledge_pages`、`diagnose`。
- 被拒：`read_knowledge_page`（GET page）、`capture_initiative` / `ingest_document`（POST memories），均为 `402 Insufficient credits`。
- 配置侧正常：`C:\Users\firsr\.hindsight\coding-agent.json` 存在、token 已配置且匹配、未禁用 → **纯余额问题**。

---

## 3. 代码仓库与实施进度（2026-09-21）

- **GitHub 仓库**：https://github.com/FirsryFan/MindNet （公开）
- **提交历史**（都接在远端 `f5c30ff Initial commit` 之上，未覆盖历史）：
  - `a57405d` 内核 + 插件架构 + v1.2 记忆层
  - `22be258` 统一入口 `createKernel` / `listMechanisms`
  - `fed8db8` v1.3 快层（容量竞争、入边求和、分流方程、概率点火、节律门控、目标偏置）
  - `9c07459` **v2.0 控制层**（元认知自信度、卡点诊断、处方规划器 + 反事实预测）
  - `d7ad57b` **参数标定页 + 可视化壳接入 v2**（六个可亲手做的实验、估计器、壳默认跑 v2 并显示诊断/处方）
- 仓库内容：62 个文件（含 `.gitattributes` 统一 LF、`.gitignore`），零第三方依赖
- 标定（用户可亲自做）：`viz/calibrate.html` —— T1 即刻广度→`W_DAR`；T2 经验取样→`duty/p_off/p_on/τ_vig`；
  T3 学习+延迟回忆→`R0/S/legacy_k`；T4 再读 vs 主动回忆→`kappa_reread_ratio`；T5 自信校准→`b0/δ`；
  T6 成本与目标→`cost_*`/目标留存。进度存 localStorage，一键保存到本机供扩散视图使用；
  后续每道题的对错通过 `refineStability` 继续微调 `S`（协议见 `docs/CALIBRATION.md`）
- 已实现（11 个机制模块、56 条验收断言）：
  - `src/core/` 机制内核（15 个槽位、不变量守卫、共享/命名空间状态、验收执行）
  - `src/v2/engine.js` 快层引擎（每轮管线 + 诊断事实表 + 克隆 + 控制层报告）
  - `mechanisms/`：记忆（R0/S/Σ、三档复习、失败证据老化、排程反解）、激活（分流方程精确积分 + 亚阈累积）、容量（DAR 4 + 焦点 1）、点火（概率 + 可播种随机）、节律（占空比 / 走神马尔可夫 / θ + 警觉衰减 + 负荷自适应节拍）、目标偏置、元认知自信度、卡点诊断、处方规划器、侧抑制（实验性）、v1.1 兼容包
- 已验证：`npm test` **78/78**；`npm run mechanisms -- --check` **11 模块 56 条断言全过**；`npm run math` 7 组全过；`npm run probe:v2` **学习规律 1–5 全部翻转**；`npm run control` 输出诊断 + 处方 + 反事实预测；差分等价：`FastEngine + legacy_v1` 在链/菱形/扇出三张图上逐轮复现 v1.1 的 `state` 与 `al`
- 未实现：可视化壳接 v2；参数标定（v1.3/v2.0 的十余个参数全部 `[未标定]`）；侧抑制默认关闭；睡眠巩固的具体量级

---

## 4. 余额恢复后的补记步骤（两步）

1. `hindsight_capture_initiative(title="MindNet 认知模型引擎（独立组件 + 可视化壳）", summary=<把本文 §1 的事实与方向变更写进去>, relates_to_page_id="kp-4da6589568e7468fb128e5c5d0565b84")`
2. 若要保留更细的设计决策，再 `hindsight_ingest_document(title="MindNet 设计决策记录 v1.1→v2", content=<本文 §1 + 三份设计文档的要点>)`
