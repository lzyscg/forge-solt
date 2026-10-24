# 仿写保真演进设计 V0.1（I0–I5 / F0）

> 状态：2026-09-02，S0–S5 已完成，S6 机制实验未达生产提升门槛。下一阶段为 I0/I1。
> 目标：不是继续刷格式指标，而是在不复制独特句子的前提下，复现真人范文的叙事效率、轻重分配、变化链、人物策略、读者压力和声音距离。

## 0. 已测事实

同一授权故事中，原文约 6,920 汉字、23 个编号小节；r2 AI 为 14,844 汉字、25 节。原文小节汉字中位 225、范围 102–784；AI 中位 602.5、范围 520–632，几乎全部贴着动态上限。

根因不是单一禁词或排版，而是当前 outline 没有表达：重点优先级、展开等级、功能容量、变化闭环、人物/读者压力和叙述声音。正文模型遂把每个 section 同等完整地场景化。

私有诊断与完整论证见 `notes/IMITATION-QUALITY-GAP-ROADMAP.md`。付费正文、outline、draft、逐字证据只允许存在于 gitignored `bench/runs/`。

## 1. 不可协商边界

1. 私有原文不进入正文 Prompt、`read_task_input`、API、trace、ReplayInput 或公开报告。
2. 仓库只提交工具、schema、合成反证和无正文汇总；公开 summary 必须做 14 字源片段泄漏扫描。
3. 每个条件固定 Provider/model/case/repeat，结果不 best-of；失败不删除。
4. Skill 变体在 `skills-variants/`，达到门槛才提升生产并升级版本。
5. 指纹和冗余只作分维度闸门/趋势，不创建“真人度总分”。
6. 先仿写后原创；F0 多故事仿写发布回归通过前，不声明原创能力。
7. 不使用多 Agent；真实调用串行并逐样本 checkpoint。

## 2. 四层 Regression Benchmark

### R0：零模型机制回归

CI 每次执行：outline v2 parse、容量上限、非均分预算守恒、Prompt/提交/Replay 预算一致、S3 hard/warn、防抄、隐私、assembler 文字保真、checkpoint/resume、Provider/model fail-closed、S2 Replay 114/114。

### R1：真实 ReplayInput 单变量回归

- outline：每条件 n≥3；
- section：每条件 n=6；
- `contextHash` 相同、`promptHash` 不同；
- development 3 故事用于迭代，holdout 1–2 故事只在提升前运行；
- 全部提交失败、未提交、Provider 错误与 validation 拒绝进入报告。

### R2：真人叙事效果回归

分开报告：

1. 硬保真：人物/事件/因果/关系/反转/结局/知识时点；
2. 展开分配：源文与 AI 小节 share、长度排序、展开档位、上限饱和率；
3. 变化闭环：触发→回应→反馈→新状态；
4. 人物与压力：目标/防御/策略、情绪链、读者压力链；
5. 声音：偏见/自欺/反讽、社会语域、对白策略、快叙/场景/留白；
6. 信息权限：新增身份/物件/地点/数字/动机/证据渠道/程序机制；
7. 表面趋势：段句、对白占比、镜头载体、冗余 v1，仅诊断。

硬保真或权限失败不能被文笔优点抵消。

### R3：Reviewer 能力回归

每条新判据至少：3 对口缺陷、3 干净正例、1 易误判边界、1 重复样本。报告召回、误报、ERROR/未提交、引文存活和重复一致性。会触发整纲重写的判据要求 0 误报。

## 3. 三个深模块

### 3.1 ImitationFidelityAudit

唯一接口：

```ts
auditImitation({ source, outline, draft, compiledPlan }): FidelityAudit
```

内部隐藏分节映射、展开倍率、事实/机制新增、声音/压力分析、逐字证据与隐私清理。文件/SQLite 读取属于 CLI adapter，不进入 domain。

### 3.2 NarrativePlanCompiler

唯一接口：

```ts
compileNarrativePlan({ outlineMarkdown, storyBudget })
```

成功产出 `CompiledNarrativePlan.units[]`：变化、priority、expansion、mode、capacity、出场人物、目标、冲突、结束状态、可选信息控制和动态预算。I1 输入契约只接受本文件 §5 定义的 Outline v2 Markdown；JSON 对象/数组失败关闭，不为尚未出现的产物格式建立兼容承诺。实现隐藏 Markdown parser、容量加权、确定性有界分配与总量守恒。`正向有限清单` 及其授权语义属于 I4；I1 可兼容读取含该行的既有实验 Markdown，但不把它编入 plan，也不宣称已实现信息权限。计划启用后，unit Han 预算是对应正文 section 的唯一长度真源，模板不得再为同一 slot type 配置单位不同且互相竞争的 `minChars/maxChars`。

### 3.3 StagedDraftProtocol（I5）

接口：`advanceDraft` / `resumeDraft`。内部顺序固定：focus→change→prose→causality→character→integrity→compression；每轮不可变落盘，问题回最早责任节点。

## 4. I0：三故事私有基线

选择三种主要阅读动力：高概念快叙、强冲突/对白驱动、现实情感或悬疑发现。另留 1–2 holdout。

完成门槛：

- source→outline→draft 问题能定位到最早责任层；
- 已知“均匀铺开”和“新增程序机制”被检出；
- 私有逐字证据可复核；公开 summary 无 14 字原文命中；
- 网络调用 0。

## 5. I1：展开等级与容量预算

Outline v2 每节字段：

```text
N. 标题
变化：[起始] → [新状态]
重点：P0/P1/bridge
展开：细写/标准/轻过渡
模式：快叙/冲突场景/悬疑发现/现实情感/自定义
容量：对白轮次 N；动作反馈闭环 N；认知转折 N；事后余波 N
出场/目标/冲突/结束状态/信息控制
```

预算按 expansion 与 capacity 非均分，总量仍受 story budget 控制。参数先由 I0 三故事拟合并版本化，不预拍绝对字数。编译后至少出现两个展开档，全部同档直接失败。

实验：3 个 outline case × baseline/variant × n=3，最多 18 次。发布门槛：P0/因果/反转/结局零遗漏；展开轻重与原文功能排序同向；上限饱和率下降；share error 和 rank 优于 baseline；私有 Claude 审计不把必要内容压成梗概。提升前用户只审三份展开表和 light/detailed 代表样本。

## 6. I2：变化骨架

每个 unit 必须有起始状态、触发、回应、反馈、新状态；P0 只有一个兑现 unit。合成缺环反证与 3 故事 light/standard/detailed section A/B。轻过渡不得被还原成完整场景，高权重不得只有结果。

## 7. I3：声音与人物/读者压力

稳定声音契约包含视角距离、叙述者偏见/自欺/反讽、叙事模式比例、社会语域、对白策略、语言呼吸和章尾类型。每个重点 unit 记录人物目标/防御/策略、情绪链和独立读者压力链。

## 8. I4：信息权限与上下文隔离

正文只读当前短 packet、稳定声音契约、上一节最短状态和当前正向有限清单。完整 outline、未来答案、源边界和攻击词留私有层。AuthorizationAudit 逐句登记新增事实类型，找不到明确来源即 reject。

## 9. I5：分轮生产与回滚

同一 section 会话逐轮 JIT 注入；现有 edit-list 限制附带改动。finding 带 introducedAt/responsibility；同一问题两轮不降即回最早责任层，不增加轮数。连续两轮无新错误模式才冻结生产版。

## 10. F0：多故事完整仿写发布闸门

I0–I5 通过后，3–5 篇授权故事各跑一次正式完整链路，不 best-of。验收：S3/防抄/隐私、硬保真、展开轻重、变化闭环、人物/读者压力、声音、未授权事实为零、2,000 汉字趋势。Claude 否决有私有逐字证据；用户每故事抽查至少一 accept、一 reject。

全部通过后冻结“仿写生产版”，才开始第一阶段持续试产；原创另建 O0–O4。

## 11. 成本上限与停止条件

- I0：0 调用；I1：≤18 outline；I2：≤54 section；I3：≤18；I4：≤18；I5 先 3 unit×n=3；F0 每篇一次。
- 任一阶段未通过，后续只做不依赖它的零调用工具，不标完成。
- 失败原因若来自 harness/快照非法，整 run 标 invalid，不混入产品结论。
