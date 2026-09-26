# MindNet —— 认知模型独立设计文档 v1.1（最终版）

> **本文件说明**
> - 内容为用户交付的 v1.1 定稿原文，**语义未改**，仅按用户要求把组件名从「Furnace / 熔思」改为 **MindNet**（它是一个组件，不是整个产品）。
> - 对应实现就在本组件的同级目录：`src/`（引擎）、`cli.js`（命令行）、`viz/`（可视化壳）；本文件位于 `docs/`。
> - 实现中遇到文档未拍板之处的处理方式，集中记录在同级目录的 `README.md` 的「实现决定」一节。

**版本**：v1.1
**状态**：最终版，可直接开发
**目标**：实现独立运行、不依赖 AI 的认知模型引擎，接收认知图与初始激活节点，运行扩散，输出知识贡献 KC 与目标节点激活情况。

---

## 1. 系统目标与边界

### 1.1 核心目标

构建一个独立运行的认知模型引擎：

- 接收用户输入的认知图结构。
- 接收初始激活节点，可一次多个，也可在扩散过程中追加。
- 运行同步状态扩散。
- 输出：
  - 知识贡献 KC 二元组：发展区缺口 Gap、死角区惩罚 Penalty。
  - 目标节点激活步数。
  - 最终节点状态。
- 不调用 AI。
- 不依赖教学交互、题目推送、g 分计算。

### 1.2 本版本实现

- 有向认知图结构。
- 节点状态：`CONSCIOUS` / `SUBCONSCIOUS` / `INACTIVE`。
- 永久亮着机制。
- 基于影响力乘法的同步扩散。
- 目标节点追踪与停止条件。
- 多起点共享扩散。
- 长期记忆 MS 的现实时间衰减。
- 专注复习更新。
- KC 计算。
- JSON 输入输出协议。

### 1.3 本版本不实现

- 注意力机制：全局注意力池、点注意力、边注意力。
- 扩散内时间机制：Tick、通行成本、思维频率、精力。
- 灵感边动态生成。
- 短期记忆 STM 的复杂衰减计算。仅保留字段。
- 教学交互、题目推送、g 分计算。
- 信号回传增强机制。
- 过程访问复习的复杂回调。仅保留接口位置，本版不实现。

---

## 2. 术语与状态定义

| 术语 | 符号 | 说明 |
|---|---|---|
| 记忆强度 | MS | 长期记忆牢固度，范围 (0, 1] |
| 意识阈值 | CT | 进入显意识的阈值，节点可自定义，缺省用全局默认 |
| 潜意识阈值 | ST | 进入潜意识的阈值，节点可自定义，缺省用全局默认 |
| 链接强度 | LS | 边通路效率，范围 (0, 1] |
| 激活强度 | AL | 节点当前激活程度 |
| 影响力 | Impact | 从源节点传播到目标节点的力量 |
| 节点状态 | state | `CONSCIOUS` / `SUBCONSCIOUS` / `INACTIVE` |
| 访问次数 | visit_count | 累计失败尝试次数，用于死角重要性判断 |
| 知识贡献 | KC | `(Gap, Penalty)` 二元组 |

**激活定义**：

- `state != INACTIVE` 即视为激活。
- 激活包括 `CONSCIOUS` 和 `SUBCONSCIOUS`。
- 目标达成定义为：目标节点 `state != INACTIVE`。

**永久亮着定义**：

- 初始激活节点一旦设为 `CONSCIOUS`，永久保持激活。
- 扩散过程中，边指向已激活节点时，跳过该目标节点，不修改其 `state`、`al`、`visit_count`。
- 已激活节点仍然作为源节点继续向外传播。
- 起点不参与 KC 计算，但参与扩散。

---

## 3. 数据结构与 JSON 协议

### 3.1 节点 Node

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `id` | string | 必填 | 唯一标识 |
| `name` | string | 必填 | 节点名称 |
| `type` | string | 必填 | `knowledge` / `logic` / `technique` |
| `weight` | float | 1.0 | 节点重要性，范围 (0, 1]，用于 KC 加权 |
| `ms` | float | 0.8 | 长期记忆强度，范围 (0, 1] |
| `ct` | float | 全局 `ct_default` | 意识阈值 |
| `st` | float | 全局 `st_default` | 潜意识阈值 |
| `state` | string | 运行时 | `CONSCIOUS` / `SUBCONSCIOUS` / `INACTIVE` |
| `al` | float | 运行时 | 当前激活强度，由状态推导 |
| `visit_count` | int | 0 | 累计失败尝试次数，跨扩散累计 |
| `last_review_time` | float | 当前现实时间 | 上次复习时间，单位小时 |
| `stm` | float | 0.0 | 短期记忆预留字段，本版不参与计算 |

节点 JSON 示例：

```json
{
  "id": "node_1",
  "name": "三角函数",
  "type": "knowledge",
  "weight": 0.9,
  "ms": 0.8,
  "ct": 0.3,
  "st": 0.05,
  "last_review_time": 0
}
```

加载时若 `last_review_time == 0` 或缺失，自动修正为当前现实时间。

### 3.2 边 Edge

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `id` | string | 必填 | 唯一标识 |
| `from` | string | 必填 | 起点节点 id |
| `to` | string | 必填 | 终点节点 id |
| `ls` | float | 0.8 | 链接强度，范围 (0, 1] |

边 JSON 示例：

```json
{
  "id": "edge_1",
  "from": "node_1",
  "to": "node_2",
  "ls": 0.8
}
```

### 3.3 图 Graph

- 严格有向图。
- 扩散只能从 `from` 流向 `to`。
- 禁止反向扩散。
- 无向图需用户手动创建双向边。
- 不连通子图不报错。
- 边端点不存在时，加载阶段报错。

---

## 4. 时间与记忆机制

### 4.1 时间层

- 扩散内时间：无 Tick，无通行时间。
- 扩散用「更新轮次」计量。
- 从扩散开始到目标首次激活所经历的更新轮次数，记为 `target_steps`。
- 扩散外时间：接入现实时间戳，单位小时。

### 4.2 长期记忆 MS 衰减

采用艾宾浩斯简化形式：

$$MS(t) = MS_0 \times e^{-\frac{t}{S}}$$

- `MS_0`：上次更新后的记忆强度。
- `t`：距离上次复习的时间，单位小时。
- `S`：记忆稳定度，单位小时。
- 稳定度计算：

$$S = k \times MS_0$$

- 全局常数 `k = 24.0`。
- 若 `MS_0 <= 0`，则 `MS = 0`。
- 若 `MS_0 > 0`，则按公式计算。

软件打开时，若距离 `last_review_time` 超过 1 小时，统一更新所有节点：

```python
def update_global_memory(graph, current_real_time):
    for node in graph.nodes.values():
        if node.last_review_time is None or node.last_review_time == 0:
            node.last_review_time = current_real_time
            continue

        t = current_real_time - node.last_review_time
        if t > config.forget_update_threshold_hours:
            ms0 = node.ms
            if ms0 <= 0:
                node.ms = 0.0
            else:
                S = config.forgetting_k * ms0
                node.ms = ms0 * math.exp(-t / S)
            node.last_review_time = current_real_time
```

### 4.3 专注复习

```python
def focused_review(node, current_real_time):
    node.ms = 1.0
    node.last_review_time = current_real_time
```

规则：

- `ms = 1.0`。
- `last_review_time = 当前现实时间`。
- 下次衰减从当前时间重新开始。

### 4.4 过程访问复习

本版不实现复杂过程访问回调。
保留接口位置，调用时抛出 `NotImplementedError` 或直接忽略，后续版本再定。

### 4.5 短期记忆 STM

- 仅保留 `stm` 字段。
- 本版不参与任何计算。
- 扩散内遗忘不建模。

---

## 5. 扩散引擎

### 5.1 初始激活

- 用户传入 `initial_nodes` 列表。
- 起点节点状态设为 `CONSCIOUS`。
- 起点节点 `al = 1.0`。
- 起点节点永久亮着。
- 起点节点不参与 KC。
- 起点节点仍作为源节点向外传播。

多任务共享扩散：

- 可同时激活多个起点。
- 扩散过程中可调用 `add_initial_nodes` 追加起点。
- 追加起点在下一轮生效。
- 所有任务共享同一个扩散过程。
- 任务之间无依赖关系。

### 5.2 每轮更新规则

每轮执行以下步骤：

1. **设置 AL**

   根据当前状态：

   - `CONSCIOUS` → `al = 1.0`
   - `SUBCONSCIOUS` → `al = 0.3`
   - `INACTIVE` → `al = 0.0`

2. **计算影响力**

   对每个源节点：

   - 源节点必须 `state != INACTIVE`。
   - 对每条出边：

   $$Impact = MS_{from} \times LS_{edge} \times AL_{from}$$

3. **汇总入边影响力**

   对每个目标节点：

   - 汇总所有入边影响力。
   - 取最大值，记为 `incoming_max`。

4. **更新未激活目标节点**

   对每个目标节点：

   - 如果目标已经是 `CONSCIOUS` 或 `SUBCONSCIOUS`：
     - 跳过。
     - 不修改任何属性。
   - 如果目标仍是 `INACTIVE`：
     - 读取目标节点的 `ct` 与 `st`，缺省用全局默认。
     - 若 `incoming_max >= ct`：
       - `state = CONSCIOUS`
       - 记录首次激活轮次。
       - 记录首次激活时的 `Impact = incoming_max`。
     - 否则若 `incoming_max >= st`：
       - `state = SUBCONSCIOUS`
       - 记录首次激活轮次。
       - 记录首次激活时的 `Impact = incoming_max`。
     - 否则：
       - 保持 `INACTIVE`。
       - 若 `incoming_max > 0` 且该节点不是起点：
         - 标记本次扩散中该节点被尝试激活过。

5. **永久亮着处理**

   - 一旦节点变为 `CONSCIOUS` 或 `SUBCONSCIOUS`，本扩散后续轮次不再修改它。
   - 但它继续作为源节点传播。

6. **目标检查**

   - 若所有目标节点 `state != INACTIVE`：
     - 停止扩散。
     - 记录 `targets_all_reached = true`。
   - 否则继续。

7. **冷却检查**

   - 比较本轮结束状态与上一轮结束状态。
   - 若所有节点状态连续两轮完全无变化：
     - 停止扩散。
     - 标记为思维冷却。

8. **最大轮次检查**

   - 若达到 `max_rounds`，默认 100：
     - 强制停止。

### 5.3 访问次数 visit_count 更新

扩散结束后统一更新：

- 对每个非起点、最终仍 `INACTIVE`、且本次扩散中被标记为“被尝试激活过”的节点：
  - `visit_count += 1`。
- 单次扩散中，每个节点最多加 1。
- `visit_count` 跨多次扩散累计。
- `visit_count` 是死角重要性判断指标。

### 5.4 停止条件汇总

- 所有目标节点激活：立即停止。
- 连续两轮所有节点状态无变化：冷却停止。
- 达到最大轮次 100：强制停止。
- 无目标节点时：冷却或最大轮次停止。

---

## 6. 知识贡献 KC 计算

### 6.1 发展区缺口 Gap

$$Gap = \sum_{i \in \text{非起点且已激活}} w_i \times \max(0, 1.2 \times CT_i - Impact_i)$$

- 只对非起点且 `state != INACTIVE` 的节点计算。
- `w_i` 为节点 `weight`。
- `CT_i` 为节点意识阈值，缺省用全局默认。
- `Impact_i` 取该节点首次激活时的入边最大 Impact。
- 起点不参与 Gap。

### 6.2 死角区惩罚 Penalty

$$Penalty = \sum_{i \in \text{非起点、未激活、visit\_count > 0}} w_i \times \sqrt{VisitCount_i}$$

- 只对非起点、最终 `INACTIVE`、且 `visit_count > 0` 的节点计算。
- 不再使用 `weight > 0.5` 作为重要节点阈值。
- 重要性由 `visit_count` 判断。
- `w_i` 为节点 `weight`。
- `VisitCount_i` 为累计失败尝试次数。

### 6.3 KC 输出

```json
{
  "gap": 0.85,
  "penalty": 0.32
}
```

Gap 与 Penalty 分别保存，不合并。

---

## 7. 接口设计

### 7.1 初始化

```python
graph = Graph.load_from_json("graph.json", current_real_time=now_hours)
config = Config()
model = CognitiveModel(graph, config)
```

### 7.2 全局记忆更新

```python
model.update_global_memory(current_real_time=now_hours)
```

### 7.3 开始扩散

```python
model.start_diffusion(
    initial_nodes=["node_1", "node_2"],
    target_nodes=["node_3", "node_4"]
)
```

### 7.4 追加初始节点

```python
model.add_initial_nodes(["node_5"])
```

- 下一轮生效。
- 若节点已激活，跳过。
- 若节点未激活，设为 `CONSCIOUS`，永久亮着。

### 7.5 单步执行

```python
model.step()
```

### 7.6 运行至停止

```python
result = model.run_until_stop(max_rounds=100)
```

### 7.7 获取 KC

```python
kc = model.get_kc()
```

### 7.8 专注复习

```python
model.update_memory("node_id", review_type="focused", current_real_time=now_hours)
```

### 7.9 导出状态

```python
model.export_state("state.json")
```

---

## 8. 输入输出 JSON 协议

### 8.1 输入 JSON

```json
{
  "graph": {
    "nodes": [
      {
        "id": "node_1",
        "name": "三角函数",
        "type": "knowledge",
        "weight": 0.9,
        "ms": 0.8,
        "ct": 0.3,
        "st": 0.05,
        "last_review_time": 0
      },
      {
        "id": "node_2",
        "name": "正弦定理",
        "type": "knowledge",
        "weight": 0.7,
        "ms": 0.6,
        "ct": 0.3,
        "st": 0.05,
        "last_review_time": 0
      }
    ],
    "edges": [
      {
        "id": "edge_1",
        "from": "node_1",
        "to": "node_2",
        "ls": 0.8
      }
    ]
  },
  "initial_nodes": ["node_1"],
  "target_nodes": ["node_2"]
}
```

### 8.2 输出 JSON

示例：`node_1` 起点，`node_2` 目标，第一轮被激活。

```json
{
  "kc": {
    "gap": 0.0,
    "penalty": 0.0
  },
  "target_steps": {
    "node_2": 1
  },
  "targets_all_reached": true,
  "final_states": {
    "node_1": "CONSCIOUS",
    "node_2": "CONSCIOUS"
  }
}
```

字段说明：

- `target_steps`：目标节点首次达到非 `INACTIVE` 的更新轮次。
- 未激活目标不出现在 `target_steps` 中。
- `targets_all_reached`：所有目标是否都达到非 `INACTIVE`。
- `final_states`：所有节点的最终状态。

---

## 9. 全局配置参数

| 参数 | 默认值 | 说明 |
|---|---|---|
| `ct_default` | 0.3 | 默认意识阈值 |
| `st_default` | 0.05 | 默认潜意识阈值 |
| `state_coeff_conscious` | 1.0 | 显意识 AL |
| `state_coeff_subconscious` | 0.3 | 潜意识 AL |
| `state_coeff_inactive` | 0.0 | 未激活 AL |
| `max_rounds` | 100 | 最大更新轮次 |
| `stable_rounds` | 2 | 连续无变化轮次判定冷却 |
| `forgetting_k` | 24.0 | 稳定度系数 |
| `forget_update_threshold_hours` | 1.0 | 超过此时间才更新 MS |
| `gap_constant` | 1.2 | 发展区缺口常数 |

节点 `ct` / `st` 优先于全局默认。
不再存在“重要节点阈值 0.5”。
KC 公式中的 `w_i` 就是 `Node.weight`。

---

## 10. 边界处理与测试计划

### 10.1 边界处理

- 空图：返回空 KC，`final_states = {}`。
- 孤立节点：若为起点，永久亮着；若为目标，未激活则保持 INACTIVE。
- 无入边节点：不能通过入边激活，除非是起点。
- 边端点不存在：加载时报错。
- 目标节点不存在：加载或运行前报错。
- 目标节点一开始就是起点：`target_steps = 0`，直接视为达成。
- 所有目标均未激活：`targets_all_reached = false`，`target_steps` 为空。
- 多次运行：每次 `start_diffusion` 重置运行时状态，但 `visit_count` 累计保留。

### 10.2 单元测试

- 状态判定：给定 Impact 和 CT/ST，验证状态。
- 永久亮着：起点不会被降级。
- 已激活目标跳过：已激活节点属性不变。
- 专注复习：`ms = 1.0`，`last_review_time` 更新。
- 遗忘曲线：给定 `MS_0`、`t`，验证 `MS`。
- KC：构造小图，手动验证 Gap 与 Penalty。

### 10.3 集成测试

- 3 节点 2 边图，输入起点，运行扩散，检查最终状态与 KC。
- 多起点共享扩散。
- 扩散过程中追加起点。
- 目标未达成时冷却停止。
- 达到最大轮次停止。

### 10.4 边界测试

- 空图。
- 孤立节点。
- 无入边节点。
- 所有节点未激活时的 Penalty。
- 目标节点不存在。
- 边端点不存在。

---

## 11. 未实现 / 后续版本

| 项目 | 状态 |
|---|---|
| 注意力机制 | 暂不实现 |
| Tick 时间机制 | 暂不实现 |
| 通行成本 | 暂不实现 |
| 剪枝 | 暂不实现 |
| 灵感边动态生成 | 暂不实现 |
| STM 复杂衰减 | 暂不实现 |
| 过程访问复习 | 暂不实现 |
| 教学交互 | 暂不实现 |
| 题目推送 | 暂不实现 |
| g 分计算 | 暂不实现 |
| 信号回传增强 | 暂不实现 |

---

**文档结束。**
