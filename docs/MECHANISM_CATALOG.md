# MindNet 机制目录（Mechanism Catalog）

**状态**：调研 + 头脑风暴稿（供你挑选，不是实现清单）
**配套**：`docs/PLUGIN_ARCHITECTURE.md`（怎么把下面任何一条做成插件）、`docs/DESIGN_v2_PROPOSAL.md`（模型主干怎么改）
**用法**：每条机制都写了「现象依据 / 数学形式 / 参数 / 挂哪个槽位 / 优先级」。你挑中的，按插件架构 §8 的流程让 AI 写成模块即可。

## 证据等级（每一行都标了）

| 标记 | 含义 |
|---|---|
| `读-网` | 本次会话**取到全文并读到**（附链接） |
| `搜-网` | 只在**搜索结果摘要**层面看到，未读全文（附链接，引用时保守） |
| `读-本地` | 你自己的 `theory/` 三份文档里已经写过（本次会话读过） |
| `忆` | 我的既有知识，**本次未核实**，需你或我后续查证 |

> 说明（**已更新**）：本轮实际取到**全文**的是五份——Killingsworth & Gilbert 2010（走神 46.9%，EurekAlert 全文）、Wilson et al. 2019 的 85% 规则（EurekAlert 全文；PubMed 只到记录页 PMID 31690723）、Metcalfe 2009 元认知与学习控制（PMC 全文）、**Martini et al. 2015 工作记忆维持综述（PMC 全文）**、**FSRS 算法完整公式（awesome-fsrs wiki 原始 Markdown）**，外加 **WUR 上交错练习 RCT 的摘要全文**。其余为摘要级，标 `搜-网`。

### 资料可达性（本机网络实测，供后续会话省时间）

| 站点 | 状态 | 备注 |
|---|---|---|
| `pmc.ncbi.nlm.nih.gov` | ✅ 通 | **首选**：开放获取全文都在这里，PDF 也可下 |
| `eurekalert.org` | ✅ 通 | 期刊新闻稿全文（含关键数字） |
| `raw.githubusercontent.com/wiki/...` | ✅ 通 | GitHub wiki 的原始 Markdown（公式完整）；注意 `.../main/...` 那条路径本轮失败过 |
| `research.wur.nl` 等机构仓储 | ✅ 通 | 论文摘要与元数据 |
| `nature.com` | ❌ 不通 | 被重定向到 `idp.nature.com`（机构登录） |
| `link.springer.com` | ❌ 不通 | 被重定向到 `idp.springer.com` |
| `sciencedirect.com` | ❌ 不通 | HTTP 403 |
| `pubmed.ncbi.nlm.nih.gov` | ⚠️ 空壳 | 返回 HTTP 203 但正文为空；**同一篇走 PMC 就能读** |
| `biorxiv.org` | ❌ 暂时不通 | Cloudflare 429（本会话请求过多），非永久封锁 |
| `aera.net` / `repository.upenn.edu` | ❌ 不通 | 跨域重定向 / 连接失败 |

**绕行经验**：被墙的期刊论文，先用搜索找 `PMC` 或机构仓储或预印本版本；本机对 **PMC + 新闻稿 + GitHub wiki** 这三类稳定可达。

---

## A. 节律层（tick 级）—— 你说的"思维频率"就在这里

| # | 机制 | 现象 / 依据 | 数学形式 | 参数 | 槽位 | 优先级 |
|---|---|---|---|---|---|---|
| A1 | **走神两态开关** | 人清醒时间约 **46.9%** 在想与当前活动无关的事 `读-网` [Killingsworth & Gilbert 2010](https://www.eurekalert.org/news-releases/811445) | 二态马尔可夫：`P(专注→走神)=p₁`、`P(走神→专注)=p₂`；走神时拦截点火。稳态走神占比 `p₁/(p₁+p₂)` | `p₁=0.02`、`p₂=0.08`（稳态 20%，可调到 0.47 对齐文献） | `tick.before` / `tick.gate` | **P0** |
| A2 | **θ 节律注意采样** | 信息在工作记忆中靠跨频率耦合维持：**γ 负责维持与读出，α 负责抑制无关信息，β 负责选择与长程同步**，θ 提供节拍 `读-网` [Martini et al. 2015, Front Syst Neurosci, PMC4500897](https://pmc.ncbi.nlm.nih.gov/articles/PMC4500897/) | `availability(t)=0.5+0.5·cos(2πft+φ)`，仅相位窗口内允许点火 | `f≈6 Hz`、`duty≈0.5` | `tick.before` / `tick.gate` | P1 |
| A3 | **占空比门控**（你举的例子） | 你的原话："一秒钟半秒在思考半秒不在，导致不能沉浸、激发不出全部潜能" | 方波：周期 `T`，占空比 `d`；"在"的 tick 才推进扩散 | `T=1 s`、`d=0.5` | `tick.before` / `tick.gate` | **P0** |
| A4 | **警觉衰减** | 连续任务中警觉随时间下降（多种解释并存）`搜-网` [Vigilance decline, Atten Percept Psychophys](https://link.springer.com/article/10.3758/s13414-021-02353-7) | `availability *= exp(−Δt/τ_vig)`，休息/换任务部分恢复 | `τ_vig`（未标定） | `tick.before` | P1 |
| A5 | **任务切换残余** | 切换任务后前一任务的思维痕迹仍在占用资源 `搜-网` [Leroy 2009](https://www.sciencedirect.com/science/article/abs/pii/S0749597809000399) | 切换时不清零旧激活，旧节点残余 `a *= ρ` 并继续占带宽 | `ρ=0.6` | `round.before` | P1 |
| A6 | **沉浸（flow）正反馈** | 挑战-技能平衡与 flow 的关系有元分析支持 `搜-网` [challenge-skill meta-analysis](http://www.aera.net/Portals/38/Users/219/19/89819/DIV%20C%20aera13_proceeding_619766.pdf) | 当驱动长期落在 `[ST, 1.2·CT]`（合意难度带）时：`p₂↑`、带宽 `W↑`；长期过易（`≥CT`）或过难（`<ST`）则反向 | `gain`、`band_center` | `round.before` | **P0** |
| A7 | 微休息与恢复 | `忆`（未核实） | 连续 `N` 轮后 availability 强制下降，短休恢复 | `N` | `round.before` | P2 |
| A8 | 睡眠压力 | `忆`（未核实） | 只接收外部参数（Threadflow Time 模块），模型不自造 | — | 配置 | P2 |
| A9 | **θ–γ 嵌套 → 带宽来源** | 每个 θ 周期里嵌套若干 γ 周期，**每个 γ 周期承载一个项目**；这就是"同时能拿住几个"的机制解释 `读-网` [同 A2，转述 Lisman 2010](https://pmc.ncbi.nlm.nih.gov/articles/PMC4500897/) | 带宽不再是魔数，而是"θ 周期 ÷ γ 周期"的比值 | `K = f_θ/f_γ` → 约 4 | `attention.select` | P1 |
| A10 | **负荷自适应的采样频率** | 工作记忆负荷升高时，**θ 频率下移**（Jensen & Tesche 2002；Axmacher et al. 2010） `读-网` [同 A2](https://pmc.ncbi.nlm.nih.gov/articles/PMC4500897/) | `f_θ = f₀/(1+λ·load)`：**装得越满，节拍越慢** → 直接产出"信息一多就转不动" | `f₀≈8 Hz`、`λ` 未标定 | `tick.before` | P1 |

**A 层是"思维频率"的完整落点**：A1/A3 给出"在/不在"的时间结构，A6 给出"沉浸"为什么能自我维持，A4/A5 给出"为什么不沉浸"，**A10 给出"信息一多节拍就变慢"**。你的 Executive_Architecture §2.3 那三种失配（迭代太慢 / 太快 / 被动冲刷）在 A1+A3+A4+A10 里都能算出来。

---

## B. 注意层（容量与竞争）

| # | 机制 | 现象 / 依据 | 数学形式 | 参数 | 槽位 | 优先级 |
|---|---|---|---|---|---|---|
| B1 | **两级意识容量（焦点 + 直接访问区）** | 注意焦点（FA）只能稳定保持 **3–5 个组块**；Oberauer 三态模型里"窄焦点"只选 **1 个**、直接访问区（DAR）约 **4 个**；回溯线索实验里只有单个线索带来加速 `读-网` [Martini et al. 2015, PMC4500897](https://pmc.ncbi.nlm.nih.gov/articles/PMC4500897/)；你的 Executive §5.1 也说容量"强度相关而非纯容量" `读-本地` | **两级**：`DAR` 软预算 `Σa ≤ W_DAR ≈ 4`；`FA` 每轮只准入 `W_FA = 1`（当前焦点）。抑制调参只在**高负荷时**才决定容量（Rolls et al.：≥7 项时 E/I 平衡成为关键）→ 与 B2 联动 | `W_DAR=4`、`W_FA=1` | `attention.select` | **P0** |
| B2 | 侧抑制 / 竞争 | 你 Cognitive §3.4 的多层阈值与竞争 `读-本地` | `score_v = a_v − γ·Σ_{u∈同簇} a_u` | `γ` | `attention.select` | P1 |
| B3 | **相似簇互压（前摄/倒摄抑制）** | 检索诱发遗忘有专门综述 `搜-网` [RIF review](https://www.sciencedirect.com/science/chapter/bookseries/abs/pii/S0079742114000061) | 相似度 = 邻居集合 Jaccard：`sim(u,v)=|N(u)∩N(v)|/|N(u)∪N(v)|`；`score_v −= γ_s·Σ sim·a_u` | `γ_s` | `attention.select` | P1 |
| B4 | 显著性捕获 | `忆`（未核实） | `drive_v *= (1+salience_v)`，与目标偏置竞争 | `salience` | `drive.compute` | P2 |
| B5 | **目标偏置 `d_v(C)`** | 你的 Application §15「设定上下文：写一句话锚定目标」 `读-本地` | `drive_v += β·sim(goal, v)`（先做邻域版） | `β` | `drive.compute` | **P0** |
| B6 | 硬聚焦 | 用户可插的实验机制 | 只允许目标邻域点火（与 A1 冲突，二选一） | — | `ignite.check` | P2 |
| B7 | fan 效应 | 一个概念入边越多，单条线索的检索越弱 `忆`（Anderson 经典结果，未核实） | `drive_v /= (1+log(1+deg_in(v)))` 或用检索采样竞争 | `fan_k` | `drive.compute` | P1 |

---

## C. 记忆层（跨天）

| # | 机制 | 现象 / 依据 | 数学形式 | 参数 | 槽位 | 优先级 |
|---|---|---|---|---|---|---|
| C1 | **S/D/R 三变量记忆（照 FSRS 的公开公式实现）** | FSRS 的完整公式已取到全文 `读-网` [awesome-fsrs wiki 原始 Markdown](https://raw.githubusercontent.com/wiki/open-spaced-repetition/awesome-fsrs/The-Algorithm.md) | 遗忘曲线：`R(t,S) = (1 + factor·t/S)^(−w₂₀)`，其中 `factor = 0.9^(−1/w₂₀) − 1` 保证 `R(S,S) = 90%`；成功复习后：`S′ = S·e^(w₁₇·(G−3+w₁₈))·S^(−w₁₉)`；遗忘后：`S′_f = w₁₁·D^(−w₁₂)·((S+1)^(w₁₃)−1)·e^(w₁₄(1−R))` | `w₁..w₂₀`（FSRS-6 有公开默认值可直接用；本模型只需 3–5 个） | `review.on` | **P0** |
| C2 | 幂律 vs 指数遗忘 | ACT-R 基础激活 `B=β+ln(Σtⱼ^(−d))` `搜-网` [DTIC 报告片段](https://apps.dtic.mil/sti/trecms/pdf/AD1155186.pdf)；你 Cognitive §3.8 也用它 `读-本地` | 两种可切换 | `d` | `review.on` | P1（取舍见提案 §4） |
| C3 | **三档复习** | 你 Application §1「印象强度不可直接调，通过主动检索间接增强」 `读-本地` | 再读 / 提取成功 / 失败+对答案，三档不同 `k` | `k_rr`、`k_rs`、`k_rf` | `review.on` | **P0** |
| C4 | 间隔效应 | 分布式练习有定量综述 `搜-网` [Cepeda et al. 2006](https://pubmed.ncbi.nlm.nih.gov/16719566/) | `S` 增益随复习间隔呈倒 U（由 C1 的 `(1−R)` 自然涌现） | 无需新参数 | `review.on` | **P0** |
| C5 | **合意难度 / 85% 规则** | 学习在**失败率约 15%**（正确率 85%）时最快 `读-网` [Wilson et al. 2019, Nat Commun, DOI 10.1038/s41467-019-12552-4](https://www.eurekalert.org/news-releases/808209)｜**注意**：该结果来自简单二选一/知觉学习任务，作者本人不主张直接推广到学校成绩 | 排程目标：让练习的期望正确率落在 `0.85`；在本模型里等价于把驱动维持在合意带 `[ST, 1.2·CT]` 内 | `target_success=0.85` | `output.score` / `consolidate.on` | **P0** |
| C6 | 过度学习递减 | `忆`（未核实） | `ΔS ∝ (1 − S/S_max)` | `S_max` | `review.on` | P1 |
| C7 | **失败证据老化** | 本设计（v1.1 的死角终身制，见探针规律 5） | `penalty = Σ w·√(Σ exp(−Δt/τ))` | `τ≈30 天` | `diagnose.on` | **P0** |
| C8 | 睡眠巩固 / 重放 | `忆`（未核实；突触稳态假说未取到全文） | 环节末：本环节点亮过的节点 `S += replay_gain` | `replay_gain` | `consolidate.on` | P1 |
| C9 | 突触下调 | 同上 | 未共同激活的边 `ls *= (1−down)` | `down` | `consolidate.on` | P1 |
| C10 | 编码特异性 | 你 Cognitive §2.4 引 Tulving `读-本地` | `R` 乘情境匹配度：`R *= (1+η·sim(context, node))` | `η` | `review.on` | P1 |
| C11 | **方向不对称 + 元认知盲区** | 联想对的方向性差异真实存在，而**人对这个差异是盲的**——Koriat & Bjork 2005「胜任错觉」，Metcalfe 2009 综述引述 `读-网` [Metcalfe 2009](https://pmc.ncbi.nlm.nih.gov/articles/PMC2742428/) | 节点分 `out_strength`/`in_strength`；`belief` 只看流畅度、**不看方向** → 自动产出"以为会、其实只会单向" | 无需新参数 | `diagnose.on` | **P0** |
| C12 | 检索诱发遗忘 | `搜-网` [RIF review](https://www.sciencedirect.com/chapter/bookseries/abs/pii/S0079742114000061) | 练习 `A→B` 时，同源竞争边 `A→C` 临时 `ls *= (1−rif)` | `rif` | `review.on` | P2 |

> **FSRS 公式自带的四条性质**（`读-网`，直接决定我们该不该照抄它）：
> 1. `D` 越大 → 稳定度增长越小（难的东西涨得慢）；
> 2. `S` 越大 → 增长越小（越牢越难更牢，天然防止无限增长）；
> 3. `R` 越小（拖得越久）→ 成功复习后增长越大 → **间隔效应自动涌现，不需要额外参数**；
> 4. 成功复习时 `SInc ≥ 1`（不会因为复习反而变差）。
> 这四条正好覆盖我们探针里"规律 1"要翻转的目标，且**只有公开默认参数、不需要拟合数据**就能先跑起来。

---

## D. 结构层（图本身）

| # | 机制 | 现象 / 依据 | 数学形式 | 参数 | 槽位 | 优先级 |
|---|---|---|---|---|---|---|
| D1 | **关系类型** | 你 Cognitive §3.3 的六种边类型（语义/情境/操作/元认知/类比/时序）`读-本地` | 边加 `rel` 字段；同类边可加权、可分别统计 | — | 内核字段 | **P0** |
| D2 | **内化深度 D(m)** | 你 Cognitive §3.14 与 Application §1 的参数表 `读-本地` | `D=f(|Reach|, type_div, ΣW_out, ΣW_in, R, Clarity)` | 权重（可先等权） | `diagnose.on` | **P0** |
| D3 | 类比：共享关系节点 | 你 Cognitive §3.11 `读-本地` | 两条边指向同一 `rel` 节点 ⇒ 可类比；产出"可迁移结构"清单 | — | `diagnose.on` | P1 |
| D4 | 桥节点 / 聚类系数 | `忆`（未核实） | 介数中心性近似（只需 top-k，用局部 BFS 估） | — | `diagnose.on` | P2 |
| D5 | 图式节点 α | 你 Application §7 `读-本地` | 层次化原型 + 回忆时 `Recall = Candidate + α·SchemaPrior` | `α` | `output.score` | P2（本提案建议缓做） |
| D6 | 特征子节点 Clarity | 你 Cognitive §3.15 `读-本地` | `Clarity(m)=Σ c_a I_a W / Σ I_a` | — | `diagnose.on` | P1 |

---

## E. 元认知层（你说的"元认知算一个"，这里是完整的一组）

依据主要来自 Metcalfe 2009 `读-网` [Metacognitive Judgments and Control of Study](https://pmc.ncbi.nlm.nih.gov/articles/PMC2742428/)：

| # | 机制 | 现象 / 依据 | 数学形式 | 参数 | 槽位 | 优先级 |
|---|---|---|---|---|---|---|
| E1 | **自信度 belief（流畅性驱动）** | 同一批材料，**集中练 5 次后再练 1 次**与**只练 1 次后再练 5 次**，最终回忆率相同，但前者的自信显著更高（Metcalfe & Finn 2008） `读-网` | `belief = σ(w_f·流畅度 + w_r·R₀ − θ)`，**不含提取历史** | `w_f`、`w_r` | `state.after` | **P0** |
| E2 | **危险区（高自信 × 低可提取）** | 人对"方向性不对称"是盲的（Koriat & Bjork 2005），所以自信会系统性高估 `读-网` | 四象限：`belief` vs `R` | 阈值 | `diagnose.on` | **P0** |
| E3 | **学习区选择（RPL）** | 先剔除"已掌握"，再从剩下的里**先学最容易的**，而不是最难的；时间紧时更明显（Metcalfe 2002；Son & Metcalfe 2000；Kornell & Metcalfe 2006） `读-网` | 先过滤 `belief>τ_mastered`，再按 `R` 降序选 | `τ_mastered` | `output.score` | **P0** |
| E4 | **停止规则：感知学习率→0** | 学习区框架的停止规则：感觉"再学也没进展"就停（对极难项反而很快放弃）（Metcalfe 2009 图 2） `读-网` | `rate = Δbelief/Δt`；`rate < ε` ⇒ 停 | `ε` | `output.score` | P1 |
| E5 | **延迟线索-only 判断提高校准** | 延迟 + 只给线索的 JOL 校准度极高（Dunlosky & Nelson 1992，Metcalfe 2009 引述） `读-网` | 诊断输出建议："先隔一段时间、只看题面再自评" | — | `output.score` | P1 |
| E6 | 时间压力改变学习区 | 有截止时间时，学习区前移到更容易的项（Thiede & Dunlosky 1999） `读-网` | 时间预算 `B` 作为参数，压缩可选项集合 | `B` | `output.score` | P1 |
| E7 | 学习时间分配曲线 | 简单项被间隔、困难项被集中（Son 2004 实测） `读-网` | 直接作为**对照基准**：让模型预测人实际会怎么选，再和"最优选择"对比 | — | `output.score` | P1 |

**E 层是"学生模型"里最值钱的一块**：它让引擎能说出"**你以为你会，其实你不会**"，并且这个判断有实验依据，不是我们编的。

---

## F. 动机 / 能量层（只接收外部参数，不自造）

| # | 机制 | 现象 / 依据 | 数学形式 | 参数 | 槽位 | 优先级 |
|---|---|---|---|---|---|---|
| F1 | 机会成本式疲劳 | 主观努力感与任务表现可用"机会成本"解释 `搜-网` [Kurzban et al. 2013, BBS (PubMed)](https://pubmed.ncbi.nlm.nih.gov/24304775/) | `effort_v = c₀ + c₁·(替代活动价值)`；外部传入"替代价值" | `c₀`、`c₁` | `round.before` | P2 |
| F2 | 时间压力 | 见 E6 `读-网` | 同上 | `B` | `output.score` | P1 |
| F3 | 目标承诺 / 动机 | `忆`（未核实） | 目标节点的 `weight` 与偏置 `β` 由外部设定 | — | 配置 | P2 |

> 纪律：**情绪效价、焦虑、睡眠生理不建模**，只做外部输入接口（避免不可证伪）。

---

## G. 控制 / 排程层（学习的"怎么做"）

| # | 机制 | 现象 / 依据 | 数学形式 | 参数 | 槽位 | 优先级 |
|---|---|---|---|---|---|---|
| G1 | **反事实排程** | 本设计（引擎确定性 ⇒ 可在副本上模拟） | 对每个候选动作模拟 `Δ(目标可达性)/Δ(代价)`，排序 | — | `output.score` | **P0** |
| G2 | 交错 vs 集中（**结论比我原先写的保守得多**） | 尼日利亚 62 个班级、为期一年的随机对照：交错练习在**短期保持**上提高 **0.29 个标准差**，但**在学年末累积测评上没有平均效应**；分布底部似有大改善，却被顶部的负向效应抵消 `读-网` [van der Haar, Kremer, Gray-Lobe & de Laat 2023, NBER w31853](https://research.wur.nl/en/publications/the-long-term-distributional-impacts-of-a-full-year-interleaving-/) | 交错只作为**条件策略**：先预测"对谁有好处"再排（本模型正好能算——低掌握度节点多 → 交错；高掌握度 → 可能相抵） | 交错强度 | `output.score` | P1（带条件） |
| G3 | **错误驱动的最小缺环修复** | 你 Application §12「更正错误：不删除错误联想，只加标记」+ Executive §4.3「初筛错」 `读-本地` | 从失败目标反向搜索"补哪条边/哪个节点能让它过线"（最小改动） | — | `diagnose.on` | **P0** |
| G4 | 刻意练习：弱项优先 | `忆`（未核实，Ericsson） | 排序里给低 `D(m)` 项加权 | `w_weak` | `output.score` | P1 |

---

## H. 输出 / 诊断层

| # | 机制 | 依据 | 形式 | 优先级 |
|---|---|---|---|---|
| H1 | 卡点五分类 | 你的 Executive §4.2（空 / 慢 / 容量太大）+ §4.3（初筛错）+ 走神 `读-本地` | 每类给出可计算判据（见提案 §4-L3） | **P0** |
| H2 | 指令映射 | 你的 Application 17 条指令库 `读-本地` | `诊断 → 指令 id 列表 + 理由` | **P0** |
| H3 | 规律探针与验收 | 本仓库 `probe/learning_laws.js` | 每条机制上线时翻转一条规律 | **P0** |

---

## 我建议先做的 8 条（P0 里的最小闭环）

1. **C1+C3+C4**（S/D/R + 三档复习 + 间隔效应）→ 翻转载习规律 1
2. **C7**（失败证据老化）→ 翻转载习规律 5
3. **D1**（关系类型字段）→ 为 C11 与 D3 铺路
4. **B1+B5**（软带宽 + 目标偏置）→ 翻转载习规律 2
5. **A3+A6**（占空比门控 + 沉浸正反馈）→ 你要的"思维频率/沉浸"
6. **E1+E2**（自信度 + 危险区）→ 产出"以为会其实不会"
7. **C11**（出边/入边不对称 + 元认知盲区）→ 让 E2 有真实来源
8. **G3+H1+H2**（最小缺环修复 + 卡点分类 + 指令映射）→ 把输出变成动作

---

## 不建议做 / 建议缓做（写明理由，避免为了"更像脑"而堆机制）

| 项 | 为什么不 |
|---|---|
| 情绪效价、焦虑、动机内部建模 | 没有可标定数据，写出来只能自说自话；改成"外部输入接口" |
| 图式节点 α（D5） | 需要先有"图式"这一层结构，当前图里没有；做了也无法证伪 |
| 灵感边自动生成 | 同上，且会破坏确定性 |
| 连续时间微分方程 / 脉冲神经元 | 没有反应时数据标定，成本远大于收益；tick 级离散已经够表达节律 |
| 脑区级网络仿真（Wilson–Cowan / Kuramoto 全图耦合） | A9 的 θ–γ 思路已能给"带宽来源"，全网络仿真对学习决策没有额外产出 |
| 给同一现象加两个参数 | 违反"一个机制一个旋钮"，会让消融实验无法解释 |

---

## 需要你拍板

1. **先做哪几条**：我上面给的 P0 八条是否就是第一批？还是你想先看某一条（比如 A3 占空比 / A1 走神）做出来是什么效果？
2. **A 层选哪种时间结构**：A1（随机两态）、A2（θ 正弦）、A3（固定占空比方波）——三者占同一个槽位，**默认用哪个**？（我的建议：A3 默认，因为最贴你的原话且参数最好懂；A1 作为可选，用来表达"不由自主的走神"。）
3. **文献数值要不要硬对齐**：比如走神占比默认 20% 还是对齐文献的 46.9%？对齐会更"真"，但会让默认配置下的学习效率看起来很差。
4. **E1 的 `belief` 来源**：纯模型推断（我倾向）、用户自评、还是两者结合？
