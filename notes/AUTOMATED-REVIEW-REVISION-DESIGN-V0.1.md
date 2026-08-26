# Forge Core vNext —— 自动审核返修闭环设计 V0.1

> **状态**：独立对抗评审 Round 4 已 `APPROVE`；待业务方确认核心取舍后，并入权威 REQ 与《可执行技术实现方案》。
>
> **日期**：2026-08-25
>
> **最后修订**：2026-08-26
>
> **适用基线**：Forge Core vNext P0（M0–M7）完成态
>
> **主题**：在不引入人工审核的前提下，用审核 Agent + 审核 Skill 建立“生成—审核—返修—复审—交付”的全自动闭环。

---

## 0. 结论先行

下一阶段不是给现有页面增加一个“人工打回”按钮，而是把审核正式纳入生产协议。

新的完整生产协议由两层审核、三个质量闸门组成：

```text
第一层：局部审核
  闸门 A：结构生成 Agent → 结构审核 Agent
  闸门 B：槽位生成 Agent → 槽位审核 Agent

第二层：整体审核
  闸门 C：全部槽位局部通过 → Segment Reviewer → Synthesis Reviewer
```

完整闭环：

```text
创建任务并冻结模板、生成 Skill、审核 Skill
  → 生成结构候选
  → 19 条确定性结构校验
  → 结构审核
      ├─ REVISE → 结构生成 Agent 带审核意见重新生成
      └─ PASS   → 提升为当前有效结构
  → 按依赖逐槽生成内容候选
  → 槽位确定性校验
  → 槽位局部审核
      ├─ REVISE → 原槽位生成 Agent 带审核意见返修
      └─ PASS   → 提升为该槽位当前认可版本
  → 所有内容槽位局部通过
  → 确定性生成整章预览，但不创建最终 Artifact
  → 按冻结输入预算做全量 Segment Review
  → Synthesis 全局审核
      ├─ 槽位问题 → 返修指定槽位，并自动失效受影响下游
      ├─ 子树问题 → 返修指定子树，并自动计算受影响范围
      ├─ 结构问题 → 返回结构生成 Agent，生成新结构版本并做结构复审
      └─ PASS     → 对审核覆盖的精确版本集合做最终装配
  → Task completed
```

审核 Agent 不直接改数据库、不直接修改槽位、不直接调用另一个 Agent，也不能自行把任务置为完成。审核 Agent 只通过受约束工具提交结构化 `PASS` 或 `REVISE` 结论；系统校验结论、计算影响范围、创建返修 Assignment，并继续掌握唯一的状态裁决权。

---

## 1. 背景与范围修正

### 1.1 对现有 P0 边界的显式反转

当前 REQ §7 把 Slot Review 列为非目标，FR-SLOT-004 明确 P0 不进行语义质量审核。现有实现因此只有两类质量控制：

1. 模板加载期与结构提交期的确定性校验；
2. 模型未提交、格式不合法、字数/正则不合规等运行期重试。

本设计有意反转上述非目标：下一阶段将“语义质量审核”纳入正式生产协议，但审核主体是 Agent，不是人。

同时显式反转 P0 的一项 retry 语义：P0 用户点击 retry 会获得一份新的 tick 内技术配额；review-v2 为保证全自动流程必然终止，生成/审核技术预算与语义预算都持久化，原 Task 的 retry 不再清零配额。legacy-v1 也不会继续执行，因此两种语义不会在同一运行协议内混用。

### 1.2 对旧背景文档的纠正

`notes/PROJECT-BRIEF.md` 当前把下一阶段描述为人工审核，并在 §7.5 排除了 AI 审核。该描述与业务方最新目标冲突。本设计以以下目标为准：

> Forge Core 的最终目标是自动产出满足预期的内容。审核、定位问题、生成返修要求、执行返修与复审都应由系统和 Agent 自动完成；人工不进入正常生产闭环。

文档通过评审后，应同步修订 PROJECT-BRIEF、REQ、核心名词文档与可执行技术实现方案，不能只让本文件成为孤立说明。

---

## 2. 目标与非目标

### 2.1 目标

1. 每次结构生成都必须经过结构审核 Agent 审核。
2. 每个内容槽位都必须经过与其类型绑定的槽位审核 Agent 审核。
3. 所有槽位局部通过后，必须经过一次覆盖完整槽位树与完整内容的全局审核。
4. 审核发现问题后，系统能够自动将问题精确路由到结构、单槽、子树或多个相关槽位。
5. 返修后的内容必须重新经过对应局部审核，随后重新进入全局审核。
6. 审核与返修的每一轮都有独立 Execution、版本、结构化结论和 Trace。
7. 审核意见必须可执行：指出证据、违反的审核条款、目标位置、修改要求和验收条件。
8. 全流程在没有人工介入的情况下收敛为 `completed` 或明确的失败终态。
9. 保留 P0 的冻结快照、确定性调度、迟到结果拒绝、串行执行、前后端分离和可追溯性。
10. 用真实 Provider、基准案例和留出集证明审核能力，不能用 FakeProvider 绿灯替代语义质量证据。

### 2.2 非目标

首版不做：

- 人工审核、人工批准、人工打回按钮；
- 多用户、审核角色、权限与审批流；
- 多 Agent 投票、陪审团或共识协议；
- 任务完成后的原任务重新开启；如需修改，首版创建新任务；
- 跨任务学习、自动改写审核 Skill；
- 用审核 Agent 替代确定性校验；
- 让审核 Agent 自由选择和调用任意生成 Agent；
- 全局并发或同任务多槽位并行，P0 的全局串行约束继续保留。

### 2.3 诚实边界

审核 Agent 仍是概率模型。自动审核能建立可量化、可迭代的质量闸门，但不能从架构上保证文学质量绝对正确。因此下一阶段的“完成”只能表示：

> 指定版本的结构与内容通过了冻结的审核 Skill、结构化审核协议和系统流程约束，并通过了相应的真实模型基准。

不能把一次 `PASS` 宣传成客观真理。

---

## 3. 术语

| 术语 | 含义 |
|---|---|
| 生成 Agent | 创建结构或填充槽位的 Agent |
| 审核 Agent | 使用审核 Skill 对候选产出进行语义审核的 Agent |
| 局部审核 | 针对一个结构候选或一个槽位内容候选的审核 |
| 全局审核 | 针对当前完整槽位树、所有认可内容版本及装配预览的整体审核 |
| 候选版本 Candidate Revision | 已通过确定性校验、尚未通过对应语义审核的结构或内容版本 |
| 认可版本 Accepted Revision | 已通过局部审核、可供下游读取或进入全局审核的版本 |
| 审核轮 Review Round | 对某个精确候选版本执行的一次审核 Assignment |
| 返修轮 Revision Cycle | 一次 `REVISE` 之后，由生成 Agent 创建新候选并重新审核的完整循环 |
| 返修波次 Repair Wave | 一次全局审核产生的一组返修目标，经系统展开影响范围后的执行批次 |
| 失效 Invalidation | 某个认可版本因上游或结构变化不再可作为当前有效输入，但历史记录仍保留 |
| 审核包 Review Bundle | 全局审核所绑定的结构版本、槽位版本集合与确定性装配预览 |
| 全局审核分段 Review Segment | Review Bundle 中按冻结预算确定性切分、由独立 Execution 完整审核的一段 |
| 综合审核 Synthesis Review | 汇总所有 Segment 的已验证 findings/facts，做跨段判断并对 Bundle 给出最终结论 |

---

## 4. 必须保留的现有地基

### 4.1 AC-002 冻结快照继续成立

任务创建时除现有模板与生成 Skill 外，还必须冻结：

- 结构审核 Skill；
- 各槽位类型的审核 Skill；
- 全局审核 Skill；
- Global Reviewer 输入预算、估算器、分段策略与 synthesis fact registry；
- 审核 Agent 与模型别名绑定；
- 审核/返修循环限制。

审核意见和返修内容是任务创建后的运行时数据，不修改冻结快照。它们存入版本与审核记录表。这样可以同时满足：

- 任务始终使用同一套生成与审核规则；
- 每轮审核意见可以在任务运行中新增；
- 修改磁盘上的审核 Skill 不影响已经创建的任务。

### 4.2 AC-014 完成仍由系统判定

审核 Agent 拥有的是“提交审核建议”的能力，不是修改状态的能力。

系统只有在以下条件全部满足时才允许进入 Assembly：

1. 当前结构版本通过结构局部审核；
2. 当前结构下所有内容槽位都有认可版本；
3. 所有认可版本与当前结构的依赖关系一致；
4. 存在一次 `PASS` 的全局审核；
5. 该全局审核绑定的结构版本和槽位版本集合与当前集合逐项一致；
6. 全局审核之后没有任何版本被替换或失效。

审核 Agent 返回 `PASS` 只是上述条件之一。最终状态迁移仍由系统完成。

### 4.3 D-10 迟到结果保护扩展到审核提交

`complete_review` 必须像 `complete_assignment` 一样使用一次性执行凭据，并在同一事务中校验：

- Review Execution 仍为活动执行；
- Token 正确；
- 被审核的候选版本仍是当前候选；
- Review Segment 或 Review Bundle 仍是 Task 当前全局审核包中的当前目标；
- 任务未被停止；
- 审核尚未成功提交。

一个审核 Agent 对旧版本给出的迟到 `PASS` 必须被拒绝，不能覆盖新版本状态。

### 4.4 D-11 / D-20 的提交闸门语义复用

审核结论不合法时：

- 返回结构化错误给审核 Agent；
- 允许它在同一个 Review Assignment 中修正后再次提交；
- 不结束 Execution；
- 不消耗返修轮数；
- 不改变候选版本状态。

只有合法的 `PASS` 或 `REVISE` 成功提交后才关闭闸门。

### 4.5 状态改变必须写 Trace

首版没有人工审核 POST，因此审核状态仍全部由引擎推进。但以下状态变化必须与业务写入同事务记录 Trace：

- 候选版本创建；
- 审核开始；
- 审核通过；
- 请求返修；
- 版本失效；
- 返修波次创建；
- 全局审核通过；
- 审核/返修预算耗尽。

SSE Hub 继续通过 Trace 后读取权威状态并发送 `state` 失效通知。

---

## 5. 提议决议

### D-21：审核 Agent 是质量闸门，系统仍是唯一状态裁判

审核 Agent 只能读取授权上下文并调用 `complete_review`。它不能写槽位、修改结构、创建 Artifact、改变 Task 状态或直接调度另一个 Agent。

**否掉的方案**：让审核 Agent 直接调用生成 Agent。
**原因**：这会形成第二套调度器，绕开 ProductionEngine 的串行队列、重试预算、停止语义、Execution 记录和迟到结果保护。

### D-22：采用两层审核、三个闸门

结构局部审核、槽位局部审核和全局审核都是必经路径，不提供模板级跳过开关。P1 初期只有一条完整协议，避免出现“有的模板审核、有的模板不审核”的双运行时。

### D-23：候选内容与审核结论全部版本化，不覆盖历史

结构和槽位内容每次重新生成都创建新版本。审核记录绑定精确版本 ID。旧版本被标记为 `superseded`、`rejected` 或 `invalidated`，但不删除、不覆盖。

**否掉的方案**：继续只覆盖 `slots.content_text`。
**原因**：无法回答审核 Agent 看的是哪一版、全局 `PASS` 覆盖哪一版，也无法复盘返修是否真正解决了原问题。

### D-24：审核输出必须结构化，并绑定审核 Skill 条款

自由文本可以作为说明，但不能单独驱动返修。系统只接受符合统一 Schema、目标合法、证据非空、返修要求可执行的审核结论。

### D-25：审核 Agent 提出返修根，系统计算强制失效范围

全局审核 Agent可以指出结构、单槽、子树或跨槽问题，并给出建议目标。系统根据当前结构与 `dependsOn` 计算最终受影响集合：

- 精确槽位返修：至少失效该槽位及其传递下游依赖；
- 子树返修：失效子树内容槽位，再叠加它们的传递下游依赖；
- 跨槽返修：合并各目标的影响闭包并去重；
- 结构返修：先生成并审核新结构；新结构通过后，首版保守失效全部内容槽位。

审核 Agent不能要求系统保留一个已经读取了旧上游内容的下游版本。

### D-26：全局审核发生在最终 Artifact 之前

系统可以确定性生成内存中的装配预览或 Review Bundle，但只有全局审核 `PASS` 后才写入最终 `artifacts` 表并把任务置为完成。

这样首版不需要处理“Artifact 已经发布后再打回”的复杂语义。

### D-27：审核重试与语义返修是两套独立预算

必须区分：

1. Provider 限流退避：同一 Execution 内，不计语义返修；
2. Review Execution 技术失败：超时、输出非法、未调用工具，消耗审核执行重试；
3. 合法 `REVISE`：审核成功完成，但消耗一次语义返修轮；
4. 生成 Agent 技术失败：消耗生成执行重试，不应被统计成审核打回。

Segment Reviewer 的合法 `REVISE` 只表示该 Segment Review Run 成功结束且产生 findings；它不创建 Repair Wave，也不消费 global 语义返修轮。只有 Synthesis 对整个 Bundle 提交合法 `REVISE` 时，才原子消费一次 global 语义预算。

### D-28：自动化失败进入明确终态，不回退人工兜底

审核或返修预算耗尽后，任务进入 `failed`，保留完整候选、审核意见和 Trace，并返回可诊断错误。正常协议中不出现“等待人工处理”。

### D-29：用 `protocol_version` 隔离 legacy-v1 与 review-v2

数据库中的现有任务和冻结快照没有审核绑定，不能在升级时伪装成已经通过审核。迁移为所有现有 Task 标记 `protocol_version=legacy-v1`；升级后创建的新任务使用 `review-v2`。

- legacy-v1 任务继续只读展示历史结构、槽位、Trace 与 Artifact；
- legacy-v1 的 `completed` 只表示旧协议完成，UI 明确显示“未经过自动审核协议”；
- legacy-v1 的 `ready/running/stopped/failed` 在升级收尾步骤中转为只读锁定，禁止 start/resume/retry；
- 若升级时发现 legacy-v1 `running`，HTTP 监听前原子取消活动 Execution、把运行槽位复位并将 Task 置为 stopped，再写协议锁定 Trace；
- 不给旧快照补写审核 Agent 或审核 Skill，因为那会违反 AC-002；
- 需要重新生产时，用原任务输入创建新的 review-v2 Task。

这不是维护两套可运行引擎：legacy-v1 只有读取兼容，ProductionEngine 只执行 review-v2。

### D-30：不可变结构代际与当前结构投影分离

每个结构版本的完整节点存入不可变 `structure_revision_slots`。`tasks.current_structure_revision_id` 是当前结构的唯一指针；现有 `slots` 表退化为当前结构的可查询物化投影，不承担历史结构存储。

切换结构必须在一个 UoW 中完成：旧结构 superseded、新结构 accepted、切换 Task 指针、使旧内容版本失效、清除旧槽位可读投影、重建当前 slots 投影并写 Trace。历史查询一律用 `structureRevisionId + slotId` 定位，不能只用 `taskId + slotId`。

### D-31：保留 P0 四态 SlotStatus，审核展示状态从版本与 Review Run 派生

`SlotStatus` 继续保持：

```text
pending | running | completed | failed
```

对 review-v2：

- `pending`：当前没有认可版本，且生成 Agent 未运行；候选待审核或待返修时也保持 pending；
- `running`：仅表示 fill-slot 生成 Execution 正在运行；
- `completed`：当前版本已通过局部审核并被提升为认可版本；
- `failed`：该槽位的生成或审核预算已耗尽。

“待审核、审核中、待返修”由 `slot_revisions`、`review_runs` 与 Repair Wave 确定性派生，不写进 `slots.status`。这样 stop/restart 不需要维护七态回退，也保留 legacy-v1 数据读取兼容。

### D-32：审核与返修预算必须持久化，生命周期操作不得重置

新增持久化预算实体，以稳定 scope key 计数并用条件 UPDATE 原子消费：

```text
structure:<taskId>
slot:<structureRevisionId>:<slotId>
global:<taskId>
task-review-cycle-total:<taskId>
```

技术 retry 预算只统计**可计费技术失败**，不是 Execution 行数；Stop/Resume 和崩溃恢复创建替代 Execution 时既不增加也不重置。任务总量预算统计新建的逻辑 Review Run 数，在 Review Run 创建事务中消费；同 Run 的技术 retry 不重复计算。review-v2 的显式 Retry 不能清零任何计数；预算耗尽时拒绝 Retry，需要重新尝试则创建新 Task。

### D-33：全局审核采用独立 Segment Review + Synthesis，不用单会话分页

Review Bundle 创建前，系统按冻结的 Reviewer 模型输入预算做确定性估算。系统把完整结构与内容分成不会超预算的不可变 Segment，每个 Segment 使用独立 Review Execution；所有 Segment 完成后，再用结构化 findings、受限摘要与全局 manifest 运行 Synthesis Review。

即使只有一个 Segment，也执行 Segment → Synthesis，以保持单一协议。分页工具不能作为上下文溢出方案，因为同一会话读过的旧页仍留在消息历史。

### D-34：审核 Criteria 与 Evidence 必须机器可验证

审核 Skill 的严格 frontmatter 声明唯一 `criteria[]` 与必读 Sections，由 Skill Loader 编译并随快照冻结。`findingId` 由系统生成。Evidence 必须引用审核目标中的精确来源、版本与定位；系统验证引用属于当前目标且 quote 与冻结文本一致。

### D-35：语义返修上下文是正式输入，不属于技术重试反馈

技术重试反馈继续遵守现有 D-12，不进入语义 `context_json`。但合法 `REVISE` 产生的新生成 Assignment 必须把来源 Review Run、Finding IDs、上一版本、当前结构版本、依赖版本 manifest 与 Repair Wave 写入结构化上下文并参与 `context_json`。不同审核意见驱动的返修不能得到相同的语义上下文记录。

### D-36：全局审核是两个强类型绑定，不复用一个 Skill Operation

`globalReview.segment` 与 `globalReview.synthesis` 分别绑定独立 Agent、Skill 和 Operation。两者可以解析到同一 Provider 模型，但不能共享 Skill 定义、Criteria Registry、工具集或提交权限。模板加载器继续执行“绑定 Operation 必须与 Skill 单值 operation 精确一致”，不为全局审核开后门。

### D-37：全局覆盖对象是 Review Corpus，不只是 Artifact Preview

Review Bundle 冻结一个完整 `review_corpus`。系统先用与冻结 assembler 完全相同的祖先排除遍历，得到实际进入 Artifact 的 accepted revision 集合；Corpus 包含最终 Artifact 预览，以及**所有未进入该集合的其他 content-bearing accepted revisions**。不能只检查槽位自身的 `includeInArtifact`，因为 false 容器会排除整棵子树。Bundle 创建沿用现有非空产物约束：`artifact_preview` 为空则以 `ASSEMBLY_FAILED` 拒绝。每个认可 slot revision 必须被 Corpus manifest 覆盖。

### D-38：最终 Artifact 直接使用已审核的冻结预览

Synthesis PASS 后，Assembly 不再次调用可能已经变化的 assembler 生成正文。Guard 通过后直接把 Review Bundle 中冻结的 `artifact_preview` 写入 Artifact。Assembler 的实现版本随 TaskSnapshot 与 Bundle 冻结，用于解释预览来源；若未来必须重装配，只能逐字等于冻结预览，否则拒绝。

### D-39：模型晚绑定必须满足冻结的最小能力契约

保留 D-03 的别名晚绑定，但模型配置必须声明最小上下文、最大输出、工具能力和 token estimator 兼容信息。TaskSnapshot 冻结所有 Reviewer 的最低能力要求及由 outputLimits 编译出的最大合法输出包络；局部审核做最大输入包络与实际 payload 预检，Bundle 按全局下限分段。模板加载、Task/结构接受、Bundle 创建与每次 Execution 解析别名时都校验输入总量和 `max legal output <= reserved output <= model max output`，不兼容的任务或重绑不得进入 Provider 执行。

### D-40：技术 retry 只计可计费失败，审核成功必须关闭活动执行

首次派发、stop/resume 和 crash replacement 不消费 retry；只有 Provider/超时/未提交等终结技术失败才条件消费。同一 work/run 内持续计数。任何合法审核 verdict 必须在同一 UoW 中把 Execution 置 succeeded、清 Task active pointer 并完成领域写入。

### D-41：局部审核与全局审核都必须在执行前证明输入可容纳

结构/槽位 review binding 和 global 双绑定都冻结 input budget。任务输入、正文、结构字段与依赖 fan-in 具有可计算上限；模板发布、Task 创建、结构接受和 Execution 派发分别做最大/实际包络校验。首版不实现局部依赖分段，超限设计直接拒绝。

### D-42：Reviewer 只能通过结构化审核通道产生可见文本

Review Operation 不注册 `report_work`，普通模型 delta 不写 Trace、SSE 或导出。进度由系统按状态/读工具生成固定事件；完整问题、证据与返修要求只能经 `complete_review` 校验后进入专用审核实体。

### D-43：Corpus membership 与返修目标都复用确定性领域语义

Corpus 实际装配集合必须使用冻结 assembler 的祖先排除 planner，差集全部进入 work Corpus，preview 必须非空。slot/cross 只能指向当前 accepted 内容槽位；subtree 展开和最终失效集合必须非空；structure 不携带内容目标。

### D-44：审核文本、定位坐标与 quote 必须共用一个冻结协议

所有文本 Evidence、Corpus range、Segment 归属范围和 read receipt 统一使用半开区间 `[start, end)` 与 `unicode-code-point-v1` 坐标；实现通过同一纯函数按 Unicode code point 切片，禁止直接用 JavaScript UTF-16 `String.slice`。进入 review-v2 的字符串先拒绝未配对 surrogate，之后定位协议不做 NFC、换行或 trim 转换。Evidence 的 quote 必须逐字等于冻结 source text 的该区间。

局部槽位 source text 是 D-50 已规范化并不可变保存的 `slot_revisions.content_text`；字符串 Task input 使用冻结原值，非字符串 input 使用 `canonical-json-v1`；Corpus Evidence 指向冻结 Corpus entry 的 `text`，其中 Artifact entry 是装配后的 preview，work-slot entry 是 accepted revision 的同一规范正文。结构 Evidence 使用 RFC 6901 JSON Pointer 指向不可变 proposal 的 scalar：字符串 source text 是原字符串值，number/boolean/null 是完整 `canonical-json-v1`。locator 可再用同一 code-point `[start,end)` 引用长字符串的一段；对象/数组必须继续下钻到 scalar。协议版本随 Snapshot、Bundle、locator 和 receipt 冻结，API/UI 也复用同一 helper。

### D-45：强制读取、工具调用与同轮修正必须做联合可满足性证明

每个 Review Assignment 冻结 `resource_delivery_plan`：每项必需资源明确为 `context_injected` 或一次确定性批量 tool-read，不能运行时临时决定逐项分页。必读 Skill Sections 使用一次 `read_skill_sections(sectionIds[])` 批量读取；局部目标/全部依赖、Segment 正文、Synthesis 全部 Segment 结果默认在已通过 token 预检后注入。工具仍可用于受限重读，但可选调用额度也必须预留。

首版冻结 `maxReviewSubmissionCorrections=1`。静态证明同时覆盖必需读取调用、可选重读预留、首次 `complete_review`、一次修正提交，以及首次被拒 tool arguments、固定错误 framing、全部 tool-result/message framing 和第二次输出预留。若一次修正仍非法，本 Execution 以可计费的 `REVIEW_SUBMISSION_CORRECTION_EXHAUSTED` 技术失败结束；不得无限留在同一会话。模板发布、结构接受、Bundle 创建和实际派发都必须同时证明 token 与工具调用数可满足。

### D-46：合法审核提交的 UoW 必须写全下一阶段

`complete_review` 的结果表是实现契约，不只描述数据副作用。结构 PASS/REVISE、槽位 PASS/REVISE 和 Synthesis PASS/REVISE 都在同一事务写入唯一正确的 `TaskPhase`；尤其 Synthesis 内容 route 必须切回 `slots`，结构 route 切回 `structure`。不得依赖 Scheduler 根据残留指针猜阶段，否则清除 accepted 投影后可能永久停在 `global_review`。

### D-47：Synthesis 必须同时证明输出容量与结论可表达

仅证明 token 能容纳还不够。模板发布和 Bundle 创建还要证明最坏 active Segment findings 能被 Synthesis Schema 无损覆盖：`segmentCount × segment.maxFindings <= synthesis.maxFindings × synthesis.maxSourceFindingIds`，并把全部 source IDs 的实际序列化开销计入输出包络。若不成立，以 `REVIEW_SYNTHESIS_DECISION_UNREPRESENTABLE` 在运行前拒绝；不能让“有 finding 时 PASS 被禁、REVISE 又装不下”的 Bundle 进入 Provider。

### D-48：Corpus 分段必须对任意合法正文确定性终止

Segment splitter 使用冻结的 `segment-boundary-v1`：优先在段落边界切分，其次在句界切分，仍超限时按 D-44 的 Unicode code point 坐标硬切。硬切点由 token estimator 在最大可容纳前缀上确定性搜索，并至少前进一个 code point；若连一个 code point 加固定 framing 都不能容纳，模板或 Bundle 以 `REVIEW_SEGMENT_BUDGET_UNSATISFIABLE` 拒绝。相邻段可带只读 overlap/window，但 ownership range 必须半开、无重叠、无缺口。这样无换行的超长单段、CJK、emoji 与 CRLF 都不会让构建循环或静默丢字。

### D-49：Review Run 创建必须按不可变目标幂等

每个不可变 review target 只有一个语义 Review Run，数据库唯一键固定为 `(review_target_kind, review_target_id)`。Scheduler 使用单事务 get-or-create：只有成功插入新 Run 时才消费 `task_review_cycle_total`，冲突时返回既有 pending/running Run 并继续派发，不再消费预算。结构/槽位候选、Bundle Segment 与 Synthesis 全部走同一路径；Bundle 批量预创建也依赖相同唯一约束。这样“Run 已落库、Execution 尚未派发”之间崩溃或重复 tick 不会制造第二个语义轮次。

### D-50：槽位候选只校验、存储和审核同一份规范正文

`complete_assignment` 先拒绝未配对 surrogate 和超过 Slot Type `rawSubmissionMaxCodePoints` 的原始参数，再用冻结 `canonical-slot-content-v1` 把 CRLF/孤立 CR 统一成 LF，并按明确冻结的 ECMAScript trim code-point 集去除首尾空白。`maxChars` 对这份规范正文按 Unicode code point 计数；同一字符串同时写入 `slot_revisions.content_text`、供 Reviewer 取证、进入 work Corpus，并作为 assembler 的槽位输入。assembler 不得再次对单槽正文做另一套 trim/换行转换。

原始 tool arguments 只存在受 Provider 输出上限约束的 Execution 消息/审计边界，不作为领域正文保存。这样现有“trim 后校验、raw 入库”的差异被消除，首尾空白或 CRLF 不能绕过局部审核最大包络；若规范正文为空或超限，生成 Agent 在同 Assignment 的既有确定性纠错协议内修正，不会创建不可审核 candidate。

### D-51：任务总 Review Run 预算必须由模板显式给出并证明下界

review-v2 模板必填 `reviewLimits.maxTaskReviewRuns`，TaskSnapshot 原样冻结并用它初始化 `task-review-cycle-total`。模板还冻结/推导 `maxContentSlots` 与 `globalReview.maxSegments`，发布时至少证明它能覆盖零返修成功路径：`1 structure + maxContentSlots local + maxSegments global segment + 1 synthesis`。

编译器同时展示保守理论上界。令 `G=global maxRevisionCycles`、`S=structure local maxRevisionCycles`、`M=maxSegments`，各内容类型最大数量/局部返修上限为 `C_t/R_t`，则上界为 `(1+G)×(1+S) + (1+G)×Σ[C_t×(1+R_t)] + (1+G)×(M+1)`。业务可把总预算设在初始下界与理论上界之间以限制成本，但不能低于零返修路径；实际结构/Bundle 创建仍按当前 slot/segment 数预留并原子消费。

### D-52：Reviewer 不手算全局坐标，Evidence locator 由系统解析

D-44 的 code-point range 是内部真相，不是要求 LLM 精确计数的输出格式。Context/读取工具给每段可引用文本附稳定 `sourceChunkId`；Reviewer 用一次批量 `resolve_evidence_batch([{sourceChunkId, exactQuote, occurrence?}])` 请求解析。系统只在该 Execution 已有完整 read receipt 的冻结 source/revision/chunk 内做逐字搜索，唯一命中时创建数据库 `evidenceRefId`；重复 quote 返回候选 occurrence 序号，Reviewer 可在预留的一次解析修正中指定。`complete_review` 只接受 evidence refs，不接受模型直填 start/end/jsonPointer。

Evidence ref 保存系统计算的 source kind/id/revision、D-44 locator、quote、origin Execution/Run 与 Bundle；局部/Segment 提交只可使用当前 Execution 创建的 refs，Synthesis 可沿用当前 Bundle 已完成 Segment findings 的已验证 refs。ref 是随机数据库 ID 与外键记录，不使用内容哈希。resource delivery/tool-call 包络必须预留最多两次 resolver batch；若仍无法唯一定位，以固定错误结束本次技术 attempt，而不是接受近似 locator。

---

## 6. 模板、Agent 与 Skill 模型

### 6.1 推荐模板形状

以下是概念形状，不是最终 YAML Schema：

```yaml
agents:
  - id: structure_designer
    model: structure
  - id: structure_reviewer
    model: structure_review
  - id: chapter_writer
    model: main
  - id: slot_reviewer
    model: review
  - id: global_segment_reviewer
    model: global_review
  - id: global_synthesis_reviewer
    model: global_review

skills:
  - id: chapter-structure-design
    source: skills/chapter-structure-design/SKILL.md
  - id: chapter-structure-review
    source: skills/chapter-structure-review/SKILL.md
  - id: scene-writing
    source: skills/scene-writing/SKILL.md
  - id: scene-review
    source: skills/scene-review/SKILL.md
  - id: chapter-global-segment-review
    source: skills/chapter-global-segment-review/SKILL.md
  - id: chapter-global-synthesis-review
    source: skills/chapter-global-synthesis-review/SKILL.md

reviewLimits:
  maxTaskReviewRuns: 512

bindings:
  createStructure:
    generate:
      agentId: structure_designer
      skillId: chapter-structure-design
    review:
      agentId: structure_reviewer
      skillId: chapter-structure-review
      maxExecutionRetries: 2
      maxRevisionCycles: 2
      maxReviewSubmissionCorrections: 1
      maxToolCallsPerAssignment: 24
      inputBudget:
        estimator: conservative-v1
        requiredContextWindowTokens: 32000
        reservedOutputTokens: 4000
        maxSystemAndToolTokens: 5000
        safetyMarginTokens: 3000

  fillSlotByType:
    scene:
      generate:
        agentId: chapter_writer
        skillId: scene-writing
      review:
        agentId: slot_reviewer
        skillId: scene-review
        maxExecutionRetries: 2
        maxRevisionCycles: 2
        maxReviewSubmissionCorrections: 1
        maxToolCallsPerAssignment: 24
        inputBudget:
          estimator: conservative-v1
          requiredContextWindowTokens: 64000
          reservedOutputTokens: 4000
          maxSystemAndToolTokens: 5000
          safetyMarginTokens: 5000

  globalReview:
    maxSegments: 32
    segment:
      agentId: global_segment_reviewer
      skillId: chapter-global-segment-review
      maxExecutionRetries: 2
      maxReviewSubmissionCorrections: 1
      maxToolCallsPerAssignment: 24
      inputBudget:
        estimator: conservative-v1
        targetRatio: 0.70
        requiredContextWindowTokens: 32000
        reservedOutputTokens: 4000
        maxSystemAndToolTokens: 5000
        safetyMarginTokens: 3000
    synthesis:
      agentId: global_synthesis_reviewer
      skillId: chapter-global-synthesis-review
      maxExecutionRetries: 2
      maxReviewSubmissionCorrections: 1
      maxToolCallsPerAssignment: 24
      inputBudget:
        estimator: conservative-v1
        requiredContextWindowTokens: 32000
        reservedOutputTokens: 4000
        maxSystemAndToolTokens: 5000
        safetyMarginTokens: 3000
    maxRevisionCycles: 2
    segmentStrategy: document-order-v1
```

最终模板必须要求：

- `createStructure.generate` 与 `createStructure.review` 同时存在；
- 每个 `contentBearing` 槽位类型同时存在 `generate` 与 `review`；
- 存在且只有一个 `globalReview`，其中 `segment` 与 `synthesis` 子绑定都完整；
- `reviewLimits.maxTaskReviewRuns` 与 `globalReview.maxSegments` 存在，且总 Run 预算不少于模板最大零返修路径；编译器输出 D-51 的初始下界、理论上界与配置上限供成本检查；
- 生成绑定与审核绑定引用不同 Agent ID；
- `globalReview.segment` 与 `.synthesis` 使用不同 Agent ID 和 Skill ID；
- 审核 Skill 的单值 `operation` 与绑定精确一致，不放宽现有 loader 规则；
- 每份审核 Skill 都声明可冻结、可校验的 Criteria Registry 和必读 Section；
- 结构与每种槽位 review binding 也必须声明完整 inputBudget；
- `globalReview.segment/synthesis.inputBudget`、估算器版本和分段策略完整，且能在模板加载期校验；
- 所有模型别名在加载期存在。

以上 token 数是字段形状示例，不是可直接复制的生产配置。真正模板必须由冻结 estimator 用各 Skill 的 `outputLimits` 编译出 input/output/tool framing 包络；编译结果超出示例值时提高能力契约或收紧 Skill 上限，禁止把无法通过编译的数字当默认值发布。

Provider/model 配置中的每个可绑定模型还必须声明 `contextWindowTokens`、`maxOutputTokens`、`supportsTools` 与兼容的 `tokenEstimator`。Task 创建时把 binding 的最低要求和 Skill 编译出的最大合法 ReviewDecision 输出包络冻结进 Snapshot；可用输入上限由 `requiredContextWindow - reservedOutput - maxSystemAndTool - safetyMargin` 确定，同时要求 `maxLegalDecision + toolEnvelope <= reservedOutput <= model.maxOutputTokens`。Provider 配置加载/热更新时先扫描非终态 review-v2 Task 的冻结要求，不兼容的 alias 重绑不激活并保留上一份有效 Registry；冷启动没有可用旧 Registry 时直接报配置错误、不开启 Scheduler。每次 Execution 解析别名仍做防御性校验，失败返回 `MODEL_CAPABILITY_INSUFFICIENT`，不能把超限请求交给 Provider 后反复失败。

review-v2 模板还要求：每个输入字段声明 `serializedMaxChars`；每个 content-bearing Slot Type 同时声明原始工具参数的 `rawSubmissionMaxCodePoints` 与 `canonical-slot-content-v1` 后的 `maxChars`；结构 proposal、单槽 instruction/guidance 和依赖数量都有上限。模板发布先检查结构审核的最大包络。结构候选通过现有 19 条校验后，再按实际依赖图计算每个槽位局部审核的最坏包络：任务输入上限 + 目标规范正文上限 + 全部必读依赖上限 + 结构/Skill/工具固定开销 + 输出预留 + 余量。任一槽位超过其 review binding 能力就以确定性 violation 拒绝该结构候选。首版不为局部审核增加依赖分段协议，而是拒绝不可满足的模板/结构。

Task 创建时校验实际序列化输入不超过字段上限；每次局部 Review Execution 派发前还用冻结 estimator 对实际 payload 预检。超过上限属于确定性 `REVIEW_INPUT_BUDGET_EXCEEDED`，不消耗技术 retry、也不向 Provider 发请求。按上述发布/结构校验正常创建的任务原则上不会走到此错误；它用于防止数据损坏、旧配置或估算器漂移。

每个审核绑定还必须声明 `maxReviewSubmissionCorrections` 与 `maxToolCallsPerAssignment`。编译器为每种 Operation 生成最坏 `resource_delivery_plan`，并证明：

```text
requiredBatchReadCalls
  + optionalReadCallReserve
  + 1 initial resolve_evidence_batch
  + 1 evidence-resolution correction reserve
  + 1 initial complete_review
  + maxReviewSubmissionCorrections
  <= maxToolCallsPerAssignment
```

输入包络还要计入每次工具调用/结果的消息 framing、两次 resolver batch 参数/结果、首次最大被拒 decision、固定错误返回和下一次完整输出预留。若结论无 finding，可以省略 resolver，但静态证明仍按最坏 REVISE 预留。结构候选接受与 Bundle 创建用实际资源数量重新证明；31 个内容槽位的高 fan-in、多个 Segment 等边界不能靠逐依赖/逐 Segment 调用侥幸通过。

审核 Agent 可以复用同一个底层 Provider/模型，但必须是独立 Agent 定义、独立 Execution、独立上下文和独立 Skill。这样即使首版出于成本使用同一模型，也不会变成生成 Agent 在同一段对话里自我确认。

### 6.2 审核 Skill 的统一结构

每份审核 Skill 至少包含：

1. 审核目标与明确非目标；
2. 审核对象和允许读取的上下文；
3. 必检维度；
4. 每个维度的 `criterionId`、通过条件与反例；
5. 证据要求；
6. `PASS` 门槛；
7. `REVISE` 的返修指令写法；
8. 避免误报和过度改写的约束；
9. 完成前检查清单。

推荐首版新增六份审核 Skill：

- `chapter-structure-review`；
- `outline-review`；
- `title-review`；
- `scene-review`；
- `chapter-global-segment-review`；
- `chapter-global-synthesis-review`。

审核输出协议由系统工具 Schema 统一定义，不允许每份 Skill 发明自己的 JSON 格式。Skill 负责质量标准，系统负责通信协议。

审核 Skill 的 frontmatter 必须是严格 Schema，而不是只靠正文约定。例如：

```yaml
operation: review_slot
criteria:
  - id: scene.goal-coverage
    title: 场景目标覆盖
    blocking: true
    stage: local
    allowedScopes: [slot]
    evidenceKinds: [slot_revision, task_input]
  - id: scene.dependency-consistency
    title: 依赖一致性
    blocking: true
    stage: local
    allowedScopes: [slot]
    evidenceKinds: [slot_revision, structure_revision]
requiredSections:
  - S1
  - S2
  - S3
outputLimits:
  summaryChars: 300
  maxFindings: 3
  problemChars: 300
  revisionInstructionChars: 500
  maxAcceptanceCriteria: 3
  acceptanceCriterionChars: 150
  maxEvidencePerFinding: 2
  evidenceQuoteChars: 120
  maxSourceFindingIds: 0
  maxSynthesisFacts: 0
  maxEvidencePerFact: 0
  factStatementChars: 0
  subjectKeyChars: 0
  maxRevalidationResults: 0
```

`stage` 对普通审核为 `local`，全局审核 Skill 则区分 `segment` 与 `synthesis`。`skill-loader` 将 registry 与必读 Section 编译进冻结 TaskSnapshot。`complete_review` 只接受 registry 中存在且与当前 stage、scope/evidence 类型相容的 `criterionId`，并要求 `checkedCriterionIds` 精确覆盖该 stage 的全部必检项。Section receipt 由系统根据实际批量 `read_skill_sections` 调用逐 Section 生成，Reviewer 不能在输出中自行声明“已读”。

`outputLimits` 的字段在所有审核 Skill 中必填，可按 Operation 取不同值。它覆盖 ReviewDecision 中每个可变字符串、数组数量、finding/fact 各自 evidence 数量/quote、source finding IDs、facts 与 revalidation results；Schema 入库前逐项拒绝越界，不依赖模型自律。

上例是 `review_slot` 的紧凑参考形状，所以 Segment/Synthesis 专属字段上限为 0；它的数值目标是能落入前述 4000-token 示例预留，但仍必须由实际 `conservative-v1` 编译器验算后才能发布。全局 Segment 与 Synthesis Skill 必须分别声明适合自己的非零 facts/source IDs/revalidation 上限，不得照抄本例。

Skill 编译器还要按统一 Schema/规范 JSON framing 和冻结 token estimator，把 `outputLimits` 展开为该 Operation 的 `maxSerializedReviewDecisionTokens`。模板发布必须证明：

```text
maxSerializedReviewDecisionTokens + toolCallEnvelopeTokens
  <= binding.inputBudget.reservedOutputTokens
  <= 当前绑定模型与最低能力契约的 maxOutputTokens
```

该数值随 Skill 与 TaskSnapshot 冻结，每次模型晚绑定再次校验。Provider 请求显式把 `max_output_tokens` 设为冻结的 `reservedOutputTokens`。若合法最大审核结论无法容纳，模板以 `REVIEW_OUTPUT_BUDGET_UNSATISFIABLE` 拒绝发布，不能靠运行时截断或技术 retry。Synthesis 还必须同时满足 D-47 的 finding cardinality 可表达性，token 足够不等于 Schema 一定能表示合法结论。

首版沿用当前 Skill Loader 的 `^S\d+$` Section ID 约束；正文中可把 `S1/S2/S3` 标题分别命名为 Rubric、Counterexamples、Completion Checklist，但模板 Schema 不接受任意英文 ID。若未来扩展命名语法，需要单独迁移 loader 与现有 Skill 测试。

全局审核 Skill 还必须声明 `synthesisFactRegistry`（允许的 factKind、每段必填/选填、每类最大条数与单条长度）。它决定 Segment 为跨段 Synthesis 提取哪些有证据的事实，避免任意自由摘要挤爆上下文。

---

## 7. 审核输出协议

### 7.1 新操作类型

`Operation` 从当前两种扩展为：

```text
create_structure
review_structure
fill_slot
review_slot
review_global_segment
review_global_synthesis
```

返修不新增 `revise_structure` / `revise_slot` Operation。返修仍是新的 `create_structure` 或 `fill_slot` Assignment，只是上下文中带有上一轮审核意见和版本信息。这样生成路径仍只有两条。

### 7.2 新提交工具

审核 Assignment 的唯一写动作是 `complete_review`，与生成 Assignment 的 `complete_assignment` 物理分离。

概念 Schema：

```ts
type ReviewDecision =
  | {
      verdict: 'PASS';
      reviewTargetId: string;
      reviewedRevisionIds: string[];
      checkedCriterionIds: string[];
      summary: string;
      synthesisFacts?: ReviewSynthesisFact[]; // 仅 global segment 可提交
      revalidationResults?: SegmentRevalidationResult[];
      revalidationDispositions?: SynthesisRevalidationDisposition[];
    }
  | {
      verdict: 'REVISE';
      reviewTargetId: string;
      reviewedRevisionIds: string[];
      checkedCriterionIds: string[];
      summary: string;
      findings: ReviewFinding[];
      synthesisFacts?: ReviewSynthesisFact[]; // 仅 global segment 可提交
      revalidationResults?: SegmentRevalidationResult[];
      revalidationDispositions?: SynthesisRevalidationDisposition[];
    };

type SegmentRevalidationResult = {
  sourceFindingId: string;
  result: 'not_observed' | 'reissued';
  reissuedFindingIndex: number | null;
};

type SynthesisRevalidationDisposition = {
  sourceFindingId: string;
  result: 'resolved' | 'reissued';
  reissuedFindingIndex: number | null;
};

type ReviewSynthesisFact = {
  factKind: string;       // 来自 global review Skill registry
  subjectKey: string;     // 例如 character:张三、timeline:day-2
  statement: string;
  evidence: ReviewFinding['evidence'];
};

type ReviewFinding = {
  criterionId: string;
  sourceFindingIds?: string[]; // 仅 Synthesis 合并 Segment findings 时使用
  scope: 'structure' | 'slot' | 'subtree' | 'cross_slot';
  targetSlotIds: string[];
  evidence: Array<{ evidenceRefId: string }>;
  problem: string;
  revisionInstruction: string;
  acceptanceCriteria: string[];
};

// 系统解析并持久化；不是 Reviewer 直接提交的 locator Schema
type ResolvedEvidenceRef =
    | {
        evidenceRefId: string;
        sourceKind: 'slot_revision' | 'review_corpus_entry';
        sourceId: string;
        revisionId: string;
        locator: {
          coordinateVersion: 'unicode-code-point-v1';
          start: number;
          end: number;
        };
        quote: string;
      }
    | {
        evidenceRefId: string;
        sourceKind: 'structure_revision';
        sourceId: string;
        revisionId: string;
        locator: {
          jsonPointer: string;
          canonicalValueVersion: 'canonical-json-v1';
          coordinateVersion: 'unicode-code-point-v1';
          start: number;
          end: number;
        };
        quote: string;
      }
    | {
        evidenceRefId: string;
        sourceKind: 'task_input';
        sourceId: string;
        revisionId: null;
        locator: {
          coordinateVersion: 'unicode-code-point-v1';
          start: number;
          end: number;
        };
        quote: string;
      };
```

`reviewTargetId` 是不可变审核目标：结构局部审核时是结构候选版本 ID，槽位局部审核时是槽位候选版本 ID，Segment Review 时是 Segment ID，Synthesis Review 时是 Review Bundle ID。结构局部审核没有现成槽位 ID 时，`scope=structure`，证据可以引用结构节点、依赖或任务输入，`slotId` 可为空。

`resolve_evidence_batch` 生成的 Evidence 标识规则固定：`slot_revision.sourceId=slotId` 且 `revisionId=slotRevisionId`；`structure_revision.sourceId=taskId` 且 `revisionId=structureRevisionId`；`review_corpus_entry.sourceId=corpusEntryId` 且 `revisionId=reviewBundleId`；`task_input.sourceId=inputKey`。Corpus Evidence 不指向包含 prompt framing 的 Segment 拼接字符串，而是指向 Bundle 中精确冻结的 entry text。Synthesis 沿用当前 Bundle Segment 已验证 evidence refs，不重新发明 locator。

持久化 locator、Segment ownership range 与 read receipt 全部遵循 D-44：统一半开 `[start,end)`、Unicode code point 坐标和共享切片函数。Reviewer 只提供 `sourceChunkId + exactQuote + occurrence?`，由 resolver 计算 locator；`quote` 对冻结 source text 不再做 trim、NFC 或换行转换。work-slot Corpus entry 保留 D-50 规范正文，Artifact entry引用冻结 preview。结构 chunk 已绑定 RFC 6901 scalar pointer；字符串按原值、其他 scalar 按完整 `canonical-json-v1` 形成 source text，对象/数组不生成可解析 chunk。长字符串可拆为多个稳定 chunk。

`reviewedRevisionIds` 也由目标决定并按规范序比较：局部审核只有候选 revision；Segment 是其 manifest 覆盖的结构与 slot revisions；Synthesis 是整个 Bundle manifest。Reviewer 不能少报或追加其他版本。

### 7.3 系统校验规则

系统必须拒绝：

- `PASS` 同时携带 findings；
- `REVISE` 没有 findings；
- `reviewTargetId` 不是当前候选、当前 Bundle 中当前 Segment 或当前 Review Bundle；
- `reviewedRevisionIds` 与审核目标包含的版本集合不一致；
- `criterionId` 不属于当前冻结审核 Skill；
- `checkedCriterionIds` 未精确覆盖当前审核 stage 的必检 criteria，或包含其他 stage 的 criterion；
- 证据、问题、返修指令或验收条件为空；
- summary、finding 数、problem、revisionInstruction、acceptanceCriteria、evidence/quote、source IDs、facts 或 revalidation results 任一超过冻结 `outputLimits`；
- finding 直接提交 source/locator/quote 而不是 `evidenceRefId`，或 ref 不存在、不属于允许的当前 Execution/Bundle Segment finding；
- Evidence ref 的 source 不属于当前审核目标、revision 不匹配、内部 locator 越界或 quote 与冻结文本不一致；
- resolver/locator 协议版本不等于 Snapshot/Bundle 冻结版本、文本含未配对 surrogate，或实现用 UTF-16 offset 解释 code-point range；
- 审核 Agent 自带 `findingId`；finding ID 必须在提交事务中由系统生成；
- 缺少当前审核 Skill 声明的必读 Section receipt；
- Global Synthesis 前仍有未完成的必审 Segment；
- 非 Segment Review 提交 `synthesisFacts`，或 factKind 不在冻结 registry、数量/文本超过上限、evidence 未通过相同来源校验；
- Segment 没有逐项返回分配给它的 revalidation concern，或 `reissuedFindingIndex` 未指向带新版本 evidence 的当前 finding；
- Synthesis 没有覆盖 Bundle 中全部待复核 finding，或把仍被任一 Segment/Synthesis finding 重新发现的问题标记为 resolved；
- Synthesis 在存在 active Segment finding 时提交 PASS，或 REVISE findings 的 `sourceFindingIds` 并集没有覆盖全部 active Segment findings；
- 结构审核试图修改槽位内容；
- 槽位审核试图修改结构；
- 审核旧候选或旧 Review Bundle 的迟到结果。

scope/route 校验必须按 Operation 分开，不能把全局失效规则套到局部 candidate：

| Operation | 允许的 finding 与目标 | 是否要求失效集合 |
|---|---|---|
| `review_structure` | 只允许 `scope=structure`、`targetSlotIds=[]`；目标是 Task 当前 pending structure candidate | 否；REVISE 只 reject candidate 并创建下一 structure generation work |
| `review_slot` | 只允许 `scope=slot` 且恰好指向正在审核的 current slot candidate 的 slotId；该 candidate 尚未 accepted | 否；REVISE 只 reject candidate 并返修同槽，不触碰 accepted 下游 |
| `review_global_segment` | slot/cross 目标必须是该 Segment coverage 内的 current accepted 内容槽位；subtree 根可为结构节点，但它的 current accepted 内容后代必须与本段 coverage 相交；structure 不带内容目标 | 只校验可计算出非空的**建议路由**；不立即失效、不创建 Repair Wave，跨 Segment 目标留给 Synthesis |
| `review_global_synthesis` | slot/cross 只接受 current accepted 内容槽位；subtree 根可为当前结构节点但展开后至少一个 current accepted 内容槽位；structure 不带内容目标 | 是；所有 final findings 合并后必须得到非空 route：内容 route 有非空失效闭包，structure route 有非空“新结构 PASS 后全量失效”计划 |

任何目标不存在/不属于当前结构、global 内容目标没有 current accepted revision，或 Synthesis 最终 route 为空，都返回 `REVIEW_ROUTE_INVALID`。

被系统拒绝的审核提交遵循 D-20：把可执行错误返回审核 Agent，让它在同一轮修正。

### 7.4 为什么首版只有 PASS / REVISE

不增加 `WARN`、`ACCEPT_WITH_NOTES` 或分数阈值。自动流水线需要二值闸门；如果某个问题不应阻止交付，就不应作为 finding 提交。评分可以作为观测字段在后续加入，但不能在首版参与状态迁移。

---

## 8. Reviewer 上下文与工具权限

### 8.1 共同原则

- 每次审核都是新的独立 Execution；
- 不继承生成 Agent 的对话历史；
- 不提供隐藏推理；
- 默认不提供局部审核的 `PASS` 理由给全局审核，减少确认偏差；
- 只读取当前任务冻结快照和明确版本；
- 读取动作全部进入 Trace；
- Review Assignment 只能注册审核工具集，不能注册 `complete_assignment`。
- Review Operation 不注册自由文本 `report_work`；Runtime 对 Reviewer 普通文本 delta 使用 `suppress` 策略，不写 `public_output_chunk`、不向 SSE 推送、也不进入导出。Reviewer 若未调用 `complete_review`，普通文本只能导致 no-submission 技术失败。

审核进度只由系统根据状态和读工具调用生成固定枚举事件，例如 `review_started / review_resource_read / review_submitted`；事件摘要只包含 Operation、资源种类、ID 与计数，不接受模型自由文本。

Review Operation 的 Tool Dispatcher 也使用专用脱敏策略：`tool_call_started` 只记 tool name/call ID/arguments length；`tool_call_completed` 使用固定系统文案和 `ok/errorCode`，不得采用当前通用实现的 `firstLine(tool result/error message)`，因为读工具返回的首行也可能是候选正文。工具完整返回值只回到本次模型上下文。

`complete_review` 还必须按 Operation 校验不可伪造的读取矩阵：

| Operation | 必须完整覆盖的资源 |
|---|---|
| `review_structure` | 当前 structure candidate、任务输入、当前 Skill 必读 Sections；返修复审还包括全部 source findings |
| `review_slot` | 当前 slot candidate、当前结构中的目标定义、任务输入、Skill 必读 Sections；Criteria 声明依赖一致性时还包括冻结 dependency revision manifest 的全部正文 |
| `review_global_segment` | 冻结任务输入、当前 Segment 的全部 Review Corpus 归属区间、必要衔接窗口、结构 manifest、Skill 必读 Sections、分配给该段的全部 revalidation concerns |
| `review_global_synthesis` | 任务输入、Bundle manifest、全部 Segment 结果/facts/findings/revalidation results、Skill 必读 Sections |

若资源由工具读取，系统按实际返回范围写 `tool_read` receipt；若目标正文随初始 Context 一次性注入，Context Builder 在创建 Execution 时写 `context_injected` receipt，绑定精确 source/revision/range。Reviewer 不能自行提交 receipt。缺失、版本不当前或范围未完整覆盖时，`PASS` 与 `REVISE` 都拒绝；这样也防止 Reviewer 不读正文却给出表面合法结论。

Assignment 创建时还要冻结 `resource_delivery_plan`，逐项记录 `resourceKind/resourceId/revision/range/deliveryMode/batchId`。首版默认把已通过预算预检的目标、依赖、每个 Segment 必需的冻结任务输入与正文、以及 Synthesis 结果注入 Context；全部必读 Skill Sections 通过一次批量 `read_skill_sections(sectionIds[])` 获取并逐 Section 写 receipt。禁止让 Synthesis 按 Segment 数逐个调用，也禁止让高 fan-in 槽位逐依赖调用。若某模板选择其他 delivery mode，编译器必须先证明 D-45 的 token 与 tool-call 联合上限。

所有可取证的注入/读取文本同时返回稳定 `sourceChunkId`，chunk manifest 绑定 source kind/id/revision、内部 D-44 range 和结构 scalar pointer；chunk 正文与该 source range 逐字一致。`resolve_evidence_batch` 只搜索这些已读 chunk，单批上限由 Skill `(maxFindings × maxEvidencePerFinding) + (maxSynthesisFacts × maxEvidencePerFact)` 编译，最多允许一次 ambiguity 修正 batch；即使 Segment PASS 没有 finding，也必须容纳上限 facts 的 refs。它生成的 ref 记录在数据库，Trace 仍只写调用类型、数量与固定 error code，不写 exactQuote。

同 Assignment 最多允许一次 `complete_review` 修正。首次非法 tool arguments 与固定、脱敏、长度受限的错误返回都留在模型消息历史，因此实际 payload 预检必须为这段历史和第二份完整 decision 预留空间；工具调用计数也同时预留第二次提交。第二次仍非法则关闭本次 Execution 并走可计费技术失败，不继续第三次提交。

### 8.2 结构审核工具

```text
read_task_input
read_skill_sections
read_structure_candidate
read_previous_review_findings
resolve_evidence_batch
complete_review
```

结构审核 Agent 不需要 `read_slot`，因为结构尚未进入内容生产。若它审核的是全局结构返修后的候选，系统必须把导致这次返修的结构 findings 作为 `context_json` 的正式输入，并允许通过 `read_previous_review_findings` 读取；不能只把意见塞入生成 Agent 的上下文。

### 8.3 槽位局部审核工具

```text
read_task_input
read_skill_sections
read_structure_outline
read_slot_candidate
read_dependency_slots
read_previous_review_findings
resolve_evidence_batch
complete_review
```

审核 Agent 看到：

- 本槽位 instruction、guidance 与确定性约束；
- 本槽位候选正文；
- 生成时允许读取的同一组认可依赖；
- 若为返修后复审，看到直接导致本次返修的上一轮 findings；
- 不看到无关槽位与生成 Agent 的自由文本思考。

### 8.4 全局审核：Segment Review 与 Synthesis Review

全局审核不让一个 Agent 在同一会话里分页读取任意长内容。它在创建 Review Bundle 时就按冻结输入预算确定性分段，形成多个彼此独立的 Segment Review Execution；即使当前内容只需一个 Segment，也走同一协议。

Segment Reviewer 工具集：

```text
read_task_input
read_skill_sections
read_structure_outline
read_review_bundle_manifest
read_review_segment
resolve_evidence_batch
complete_review
```

Synthesis Reviewer 工具集：

```text
read_task_input
read_skill_sections
read_structure_outline
read_review_bundle_manifest
read_segment_review_results
resolve_evidence_batch
complete_review
```

Review Bundle 包含当前结构版本、所有认可槽位版本、文档顺序、确定性装配预览、工作槽位清单与依赖图。系统先构造不可变 Review Corpus：

1. 先调用冻结 assembler 的同一 membership planner，按“任一祖先 exclude 即整棵子树排除”得到实际 included revision 集合；planner 结果与 assembler version 一起冻结；
2. `artifact_preview` entry：记录非空最终装配预览，并用 range manifest 映射 included revisions；若 preview 为空立即 `ASSEMBLY_FAILED`，不创建 Bundle；
3. `work_slot` entries：逐个收录所有 accepted content revisions 减去 actual included 集合后的差集；这同时覆盖自身 false 的工作槽位和被 false 容器祖先排除的内容后代；
4. coverage manifest：证明当前结构下每个 content-bearing accepted revision 至少被一个 Corpus entry 覆盖。

创建 Bundle 时，系统使用模板冻结的能力下限、估算器版本、固定提示/工具开销、输出预留和安全余量，把整个 Corpus 按 entry/文档边界切成不可变 Segment。每个 Segment 保存自身 Corpus entry/range、覆盖的槽位/修订版本、前后必要衔接窗口和预计 token；超过预算的单 entry 按 D-48 的段落→句界→Unicode code-point 硬切策略继续细分。硬切必须前进且 ownership range 无重叠、无缺口；只读衔接窗口可以重叠但不算重复 ownership。P0 全局串行约束继续成立：这些 Segment 逻辑独立但由同一 Task 串行执行，不引入并发写入。

Bundle 创建时计算封闭的 Synthesis 最坏输入包络。公式包含：系统/Skill 提示与工具 Schema、必要任务输入、结构与 Corpus/Segment manifest、每段 `summary`、findings 的所有字段、evidence/quote、acceptance criteria、source IDs、facts、全部 carry-over concern 文本、Segment×concern revalidation 结果矩阵、JSON framing、resource delivery/tool message framing、一次非法提交的最大历史，以及第二次输出预留/安全余量；每项上界来自冻结 input/output limits 和实际 Segment/concern 数。只有总和在 synthesis binding 能力预算内才允许创建。同时必须满足 D-47 的 `segmentCount × segment.maxFindings <= synthesis.maxFindings × synthesis.maxSourceFindingIds`。若最大 32 槽位配置无法满足 token、tool-call 或结论可表达性任一条件，模板发布或 Bundle 创建以对应的确定性错误明确失败，不能运行到一半再截断 findings。

若 Bundle 带有 `requires_revalidation` concerns，结构变化后无法证明 Slot ID 映射的 concern 首版分配给**每一个** Corpus Segment；能以新结构精确证明目标映射的，也至少分配给覆盖目标及其依赖的所有 Segment。每段必须逐 concern 返回 `not_observed` 或用该段新版本 evidence 重新发出 finding。Synthesis 收齐所有分配结果，并结合跨段 facts 后，才可把旧 finding 标记 resolved 或 reissued。

每个 Segment Review 必须满足：

- 它是独立 Execution，不继承其他 Segment 的上下文；
- Segment 的全部 Corpus 归属正文与必要结构信息在冻结预算内；
- 系统记录该 Segment Corpus 内容、所有必读 Skill Section、revalidation concerns 和必要 manifest 的 read receipt；
- 输出包含经校验的 findings，以及审核 Skill 要求的少量 `synthesisFacts`（人物状态、时间线、关键承诺、因果前提等）；每条 fact 都绑定原文 evidence，系统校验 registry、数量、长度与引用；
- Segment 可以返回 `PASS` 表示本段无 finding，但不能把整个 Bundle 判为 PASS。

所有 Segment 完成后才激活 Bundle 创建时预留的 pending Synthesis Review Run。Synthesis 读取完整结构 manifest、Corpus/Segment 覆盖表、已验证且受限的 `synthesisFacts`、全部结构化 findings 和 revalidation results；它不依赖把原始长文再次塞入一个上下文。Synthesis 可比较来自不同 Segment、相同 subjectKey 的事实，并沿用其原始 evidence 形成跨段 finding。它负责跨 Segment 冲突合并、旧 concern 的 resolved/reissued disposition、scope/target 路由和 Bundle 的最终 `PASS / REVISE`。Segment finding 已经是合法阻断 finding，Synthesis 只能用 `sourceFindingIds` 合并去重，不能把它否决或省略；存在任一 active Segment finding 时系统拒绝 Synthesis PASS。缺少任一 Corpus entry/Segment、覆盖范围有洞、read receipt 不全、revalidation result 不全、必需 factKind 缺失、active finding 未被覆盖或汇总超过冻结预算时，系统不得接受 Synthesis。

这套设计承认一个边界：跨很远文本的细腻语义判断依赖 Segment findings 与摘要质量。首版必须用最大 32 槽位、接近模型输入上限的真实内容做能力测试；不能用“工具支持分页”代替“Reviewer 实际完整覆盖”的证据。

### 8.5 返修 Assignment 的来源链

合法 `REVISE` 创建的新生成 Assignment 必须冻结如下来源链，并原样进入 Execution 的 `context_json`：

```ts
type SemanticRevisionContext = {
  sourceReviewRunId: string;
  sourceFindingIds: string[];
  previousRevisionId: string;
  currentStructureRevisionId: string;
  dependencyRevisionManifest: Record<string, string>;
  repairWaveId: string | null;
  revisionCycle: number;
};
```

结构返修的 `previousRevisionId` 是旧结构版本，槽位返修时是被打回的 slot revision。Review Assignment 也继承导致本轮候选的 source IDs，使 Reviewer 能核验每条 acceptance criteria 是否已解决。Provider 超时、格式错误等技术 retry 只写 Execution attempt/error，不改这份语义上下文。

---

## 9. 版本与数据模型

本节描述逻辑实体，不锁定最终 DDL。DDL 应在设计评审通过后单独编写并做迁移审查。

### 9.1 `tasks` 的协议与当前指针

新增或明确：

```text
protocol_version: legacy-v1 | review-v2
current_structure_revision_id
pending_structure_revision_id
current_review_bundle_id
pending_structure_generation_work_id
```

`review-v2` 的所有调度、提交和装配入口先检查协议版本。`legacy-v1` 只允许读取、停止与导出；不得恢复、重试、返修或补造审核记录。迁移只补 `protocol_version` 与必要的空指针，不把旧 `slots` 反向伪造成 structure/slot revisions。

### 9.2 `structure_revisions`

每次结构生成成功通过19条确定性校验后写一条：

```text
id
task_id
revision_number
proposal_json
root_slot_id
producer_execution_id
status: candidate | accepted | rejected | superseded | invalidated
created_at
accepted_at
```

结构审核 `PASS` 后才把候选提升为 accepted，并将其物化为当前 `slots` 结构。

### 9.3 `structure_revision_slots`

`slots` 现有主键 `(task_id, slot_id)` 只能表达一套当前结构，不能承载多个不可变结构版本。新增代际成员表：

```text
structure_revision_id
task_id
slot_id
parent_slot_id
slot_type
ordinal
content_bearing
instruction / guidance
depends_on_json
constraints_json
```

主键至少包含 `(structure_revision_id, slot_id)`。结构候选写入此表后永不原地修改。当前 `slots` 表保留为 API、Scheduler 和 UI 使用的**当前结构投影**，不是历史真相来源。

结构审核 PASS 的单一事务必须：锁定 Task；确认 pending 候选、Review Run、Execution token 与协议仍当前；把上一 accepted 结构标为 superseded；提升新结构；删除或替换该 Task 的 `slots` 当前投影；从 `structure_revision_slots` 物化新投影；更新 `tasks.current_structure_revision_id` 并清空 pending 指针；写 Trace。任一步失败则全部回滚，因此永远不会出现“Task 指向新结构但 slots 还是旧结构”。

### 9.4 `slots` 当前投影与 `slot_revisions`

每次槽位生成成功通过确定性校验后写一条：

```text
id
task_id
slot_id
structure_revision_id
revision_number
content_text
content_normalization_version: canonical-slot-content-v1
producer_execution_id
status: candidate | accepted | rejected | superseded | invalidated
created_at
accepted_at
```

`slot_revisions(structure_revision_id, slot_id)` 外键指向不可变 `structure_revision_slots`，不指向可被替换的当前 `slots` 投影；因此结构切换不会让历史 revision/Execution 失去目标。

`content_text` 只能写入通过 `rawSubmissionMaxCodePoints` 检查并经 `canonical-slot-content-v1` 处理后的字符串；同一 helper 的结果用于空值/`maxChars` 校验、Reviewer、Corpus 与 assembler，禁止 validation 使用 trim 后值而 repository 保存原始参数。

`slots` 增加：

```text
structure_revision_id
current_candidate_revision_id
accepted_revision_id
pending_generation_work_id
```

为兼容现有 API，`slots.content_text` 与 producer 字段保留为当前认可版本的物化投影；候选正文只能写 `slot_revisions` 并更新 candidate 指针，不能覆盖它。局部审核 `PASS` 时在同一事务中更新 accepted 指针、清空 candidate 指针、物化正文/producer 并把 `SlotStatus` 置为 `completed`。

任何结构或依赖失效事务都必须把受影响槽位的 `accepted_revision_id`、`current_candidate_revision_id`、`content_text` 和 producer 投影一起清空，版本历史改为 invalidated，`SlotStatus` 回到 `pending`。禁止只改状态而让旧正文仍能被下游读取。

### 9.5 `review_runs`

一个不可变目标上的一次语义 Review Round 对应一条 Review Run。Provider、超时、格式等技术重试可以产生多个 Execution，但仍挂在同一 Review Run，不增加 `round_number`：

```text
id
task_id
scope: structure | slot | global_segment | global_synthesis
target_slot_id
review_target_kind: structure_revision | slot_revision | review_segment | review_bundle
review_target_id
semantic_cycle_key       # 由 review_target_kind + review_target_id 确定
review_bundle_id / review_segment_id
target_revision_id
current_execution_id
reviewer_agent_id
reviewer_skill_id / version
round_number
status: pending | running | passed | revision_requested | failed | cancelled | stale
summary                 # 系统生成或系统截断，不接受为自由事实来源
created_at / finished_at
```

数据库对 `(review_target_kind, review_target_id)` 建唯一约束。Run 创建与 `task_review_cycle_total` 消费处于同一事务：`INSERT ... ON CONFLICT DO NOTHING` 成功插入才消费一次；命中冲突则读取既有 Run，不再消费。`round_number` 只用于同 scope 的展示顺序，不参与目标幂等。Scheduler 必须先按当前 candidate/Segment/Bundle 找或建 Run，再对该 Run 找或建 Execution，不能用“Task 没有 active Execution”推断“没有 Run”。

### 9.6 `review_findings` 与 read receipts

Findings 独立存储，不塞进 Trace payload：

```text
review_run_id
finding_id
criterion_id
scope
target_slot_ids_json
evidence_ref_count
problem
revision_instruction
acceptance_criteria_json
disposition: active | requires_revalidation | resolved_on_revalidation | reissued
carried_to_review_bundle_id
revalidated_by_review_run_id
```

Trace 只保存 finding 数量、目标 ID 和摘要；完整正文通过专用只读 API 获取，避免时间线被大段文本淹没。

`finding_id` 在提交事务中由系统生成。另存 `review_read_receipts`：

```text
review_run_id
execution_id
receipt_kind: tool_read | context_injected
resource_kind: skill_section | task_input | manifest | revision | dependency_revision | review_corpus_range | revalidation_concern | segment_result
resource_id
range_or_section
coordinate_version
read_at
```

`complete_review` 只接受 `execution_id = review_runs.current_execution_id` 的 receipts；上一技术 attempt 被 cancelled/stale 后，其 receipts 只保留审计价值，不能被新 Execution 继承。每次新 Execution 的 Context Builder 重新写本次 `context_injected` receipts，Reviewer 也必须在本次 Execution 重新完成工具读取。

Context Builder/读工具先为每个 Execution 写 `review_source_chunks`；`sourceChunkId` 只在该 Execution 内稳定，不要求跨技术 attempt 复用：

```text
id
task_id / execution_id / review_run_id / review_bundle_id
source_kind / source_id / revision_id / revision_key
source_locator_json
coordinate_version / canonical_value_version
ordinal
created_at
```

`revision_key` 把 Task input 的 null revision 规范为固定 sentinel，数据库对 `(execution_id, source_kind, source_id, revision_key, ordinal)` 建唯一键，避免 SQLite 的 NULL 唯一性空洞。chunk 不复制第二份正文；resolver 通过 locator 回读不可变 source，并再次验证它仍属于当前 receipt。旧 attempt chunk 只保留审计关联，不能供新 attempt 解析。

`resolve_evidence_batch` 再存 `review_evidence_refs`：

```text
id
task_id
origin_execution_id / origin_review_run_id
review_bundle_id
resolution_batch_id / item_ordinal
source_chunk_id
source_kind / source_id / revision_id
locator_json
coordinate_version / canonical_value_version
quote
status: resolved | consumed | stale
created_at
```

ref ID 是数据库生成的随机 ID，不由内容派生；`(origin_execution_id, resolution_batch_id, item_ordinal)` 唯一，保证同一 tool call 重放幂等。`review_finding_evidence(finding_id, evidence_ref_id, ordinal)` 用真实外键连接 finding 与 refs，`review_synthesis_fact_evidence` 同理，不能只把无外键 ID 塞进 JSON。resolver 按冻结目标重新读取 source/revision/chunk，并调用共享 `unicode-code-point-v1` / `canonical-json-v1` helper逐字搜索 quote；唯一或指定 occurrence 命中后才落库。`complete_review` 再次校验 ref 权限、当前性与 quote；成功提交时同事务标为 consumed。上一 attempt 的未消费 refs stale，不可被新 Execution 继承；Synthesis 只可沿用相同 task/current Bundle 已提交 Segment findings 上的 consumed refs，跨 Bundle/旧 revision 直接拒绝。refs 与 Review Run/findings 一起保留用于审计，不做提前物理删除。receipt range 使用同一坐标。Trace 与 synthesis summary 只能由系统从已验证字段生成，Reviewer 自由文本不能直接进入状态判断或日志摘要。

Segment 的 `synthesisFacts` 单独存入 `review_synthesis_facts`，包括 `review_run_id / fact_kind / subject_key / statement / evidence_ref_count`；证据唯一真相是 `review_synthesis_fact_evidence` 关联表，不再保留 `evidence_json` 副本。它们不是阻断性 finding，也不进入 Trace；系统按 Skill registry 验证数量、长度、fact kind 与 evidence refs 后，才可供 Synthesis 读取。

`review_revalidation_results` 保存 Segment 对每个 carry-over finding 的结果，以及 Synthesis 的最终 disposition；外键同时指向 source finding、当前 Bundle、Segment/Review Run 与可选的新 finding，保证问题不会仅靠自由摘要“宣布已解决”。

### 9.7 `review_bundles` 与 `global_review_segments`

全局审核包保存精确版本集合：

```text
id
task_id
structure_revision_id
slot_revision_manifest_json
artifact_preview
review_corpus_json
text_coordinate_version
canonical_json_version
corpus_coverage_manifest_json
assembler_membership_manifest_json
assembler_version
input_budget_json
minimum_model_capability_json
estimator_version
segment_strategy_version
status: created | segment_reviewing | synthesis_pending | synthesis_reviewing | passed | revision_requested | failed | stale
created_at
```

不使用内容摘要来判断是否过期，以精确 revision ID 集合为准。

每个 `global_review_segment` 保存：

```text
id
review_bundle_id
ordinal
slot_revision_manifest_json
corpus_ranges_json
segment_content                 # prompt view；Evidence 不以它作为坐标源
estimated_tokens
status: pending | running | passed | revision_requested | failed | cancelled | stale
review_run_id
```

`review_corpus_json` 的每个 entry 冻结 `entryId/kind/sourceRevisionId/text`；`corpus_ranges_json` 以 `entryId + unicode-code-point-v1 [start,end)` 指向这些 source texts。Segment 覆盖范围必须逐 Corpus entry 连续、无重叠歧义并完整覆盖 `artifact_preview + work_slot entries`；衔接窗口可以重叠，但正文归属区间不能缺失。splitter 按段落→句界→code-point 硬切的 D-48 规则保证终止。系统还验证每个 accepted revision 出现在 coverage manifest。Synthesis 的目标是 Bundle，不是最后一个 Segment。

Bundle 创建、Segment manifest、全部 pending Segment Review Runs、一个 pending Synthesis Review Run 落库、任务 Review cycle 总量一次性消费、旧未通过 Bundle 标记 stale，以及 `tasks.current_review_bundle_id` 切换必须在同一事务完成。任何结构/slot current pointer 变化都会在同一失效事务中把当前 Bundle/未执行 Runs 标记 stale 并清 Task 指针。

### 9.8 `repair_waves`

每次全局 `REVISE` 创建一条：

```text
id
task_id
source_review_run_id
requested_scopes_json
requested_target_slot_ids_json
planned_invalidated_slot_ids_json
applied_invalidated_slot_ids_json
carried_finding_ids_json
route: structure | slots
invalidation_timing: immediate | on_structure_pass
status: pending | running | completed | failed
created_at / finished_at
```

它让系统能够回答：这次为什么返修、Reviewer 指了哪里、系统最终展开了哪些槽位、是否已经全部重新通过。

### 9.9 `review_budgets`

预算是持久化领域数据，不是 `ProductionEngine.tick()` 的局部变量：

```text
task_id
scope_key
budget_kind: generation_retry_failure | review_retry_failure | semantic_revision | task_review_cycle_total
limit_value
consumed_value
updated_at
```

唯一键为 `(task_id, scope_key, budget_kind)`。技术预算使用：

```text
generation:<generationWorkId>
review:<reviewRunId>
```

第一次派发一个语义生成动作时，系统创建 `generationWorkId`，写入 Task 的 `pending_structure_generation_work_id` 或 Slot 的 `pending_generation_work_id`。所有技术 retry、stop/resume 与崩溃恢复复用它；候选成功落库或动作终止后才清除。Review Run 本身就是审核技术重试的稳定逻辑工作 ID。

语义返修与任务总量预算使用：

```text
structure:<taskId>
slot:<structureRevisionId>:<slotId>
global:<taskId>
task-review-cycle-total:<taskId>
```

`task-review-cycle-total:<taskId>` 的 `limit_value` 唯一来源是 TaskSnapshot 冻结的 `reviewLimits.maxTaskReviewRuns`；Task 创建事务初始化该行，不读运行期模板漂移值。模板发布先执行 D-51 初始下界/理论上界证明，Task 创建再按实际输入与快照复核；不存在“引擎自行猜一个默认总量”的分支。

技术 retry 行表示已获准的**替代尝试次数**：首次 Execution 不消费；Execution 因 Provider、超时、未提交或不可修正输出而失败时，事务执行 `consumed_value < limit_value` 的条件 UPDATE。成功加一才把同一 work/run 复位 pending 并允许新 attempt；更新为 0 行则直接走预算耗尽终态。stop、主动取消和崩溃 stale 不属于技术失败，不消费该行。

`task_review_cycle_total` 在创建新的 Review Run 时条件消费；同 Run 的任何技术 attempt、stop/resume 都不重复消费。局部审核每次消费 1；Bundle 创建事务预先创建全部 Segment Review Runs 和一个 pending Synthesis Review Run，并用 `consumed + segmentCount + 1 <= limit` 一次性消费，避免跑完部分 Segment 才发现总量不足。一次合法 REVISE 会创建新语义候选及新的 generation work / Review Run 技术 scope，同时继续消费相同 structure/slot/global 语义 scope。只有新建 Task 才获得新的语义与任务总量预算。

### 9.10 `executions`

沿用现有表，扩展 `operation`，并增加 `logical_work_id`、`review_run_id`、`structure_revision_id` 与不可变 `target_revision_id/target_review_id`。Review Execution 同样记录上下文、模型别名、实际 Provider、尝试次数、开始/结束时间和错误，并冻结 `resource_delivery_plan_json / max_submission_corrections / submission_correction_count / text_coordinate_version`。创建/切换当前 Execution 指针本身不消费 retry；只有可计费技术失败事务才消费 retry 行。历史 Execution 不得只靠 `taskId + slotId` 解释目标代际。

当前 `(task_id, target_slot_id, attempt_number)` 唯一性不足以区分生成与审核，且结构的 NULL target 不受 SQLite UNIQUE 约束。review-v2 改为 `(logical_work_id, attempt_number)` 唯一；每个 Execution 必须有 logical work，避免生成/审核 attempt 冲突并保留一对多历史。

### 9.11 审核提交 Guard 与原子工作单元

`complete_review` 的第一项数据库写不是相信内存状态，而是在事务中执行 `executions running→succeeded` 的条件 UPDATE；这既是成功状态写入，也是唯一的提交占有动作。条件同时包括：

- Task 为 `review-v2` 且仍为 `running`；
- Execution 为 `running`、提交 token 与当前执行一致，且 `tasks.active_execution_id` 正好指向它；
- Review Run 为 `running` 且绑定该 Execution；
- required-read receipts 全部属于该 Review Run 的 `current_execution_id`；
- target revision / Segment / Bundle 仍等于 Task 或 Slot 的当前指针；
- Synthesis 还要求所有 Segment 结束、coverage 完整且 receipts 齐全。

只有受影响行数为 1 才继续。若为 0，当前事务回滚；随后用第二个独立事务把这次调用记录为 `late_result_rejected`，不得顺手改变当前 Review Run、版本或任务。这样 stop、重启恢复、结构切换和迟到 PASS 不会互相覆盖。

每一次合法 PASS/REVISE/Segment 结论都有相同的提交 UoW，并与下表领域写入处于**同一事务**：以上首条 UPDATE 把当前 Execution 置 succeeded；随后 `tasks.active_execution_id→null`、Review Run 进入对应终态并写系统 Trace。任一后续写失败会回滚首条 UPDATE，提交闸门只在整个事务 commit 后关闭。若 stop 先取得 Guard，审核提交 changes=0 并走迟到拒绝；若审核提交先 commit，stop 看不到活动 Execution，不得把已成功审核改为 cancelled。

各结果的同事务写集合：

| 结果 | 必须原子完成的写入 |
|---|---|
| 结构 PASS | 候选 accepted；旧结构 superseded；若存在旧当前结构则使其全部内容版本 invalidated；切换 Task 当前指针与 `slots` 投影；清 pending；TaskPhase→slots |
| 结构 REVISE | findings；候选 rejected；消费语义预算；创建下一 generation work 且 TaskPhase→structure，或预算耗尽时 Task→failed |
| 槽位 PASS | 候选 accepted；旧 accepted superseded；更新 Slot 指针/正文/producer/status；TaskPhase 保持 slots |
| 槽位 REVISE | findings；候选 rejected；清 candidate；消费稳定 slot scope 预算；创建下一 generation work 且 TaskPhase→slots，或预算耗尽时 Task→failed |
| Segment 提交 | Segment passed/revision_requested；findings、receipts、系统摘要；Bundle 聚合状态；不消费 global 语义预算；TaskPhase 保持 global_review |
| Synthesis PASS | Bundle passed；Task 当前 Bundle 指针保持；TaskPhase→assembly |
| Synthesis REVISE | Bundle revision_requested；findings；消费 global 预算；创建唯一 Repair Wave；清 Task 当前 Bundle 指针。slots route 立即清实际失效闭包并 TaskPhase→slots；structure route 只保存“新结构 PASS 时全量失效”计划、当前 accepted 结构/内容暂留为返修只读来源并 TaskPhase→structure；两者都禁止继续装配，预算耗尽则 Task→failed |

装配事务再次锁定 Task，并核对 `current_review_bundle_id`、结构指针和所有槽位 accepted revision 与 PASS Bundle manifest 完全一致；不一致就拒绝装配，不依赖先前内存检查。Guard 通过后直接使用 Bundle 中冻结的 `artifact_preview` 作为 Artifact content，不重新调用当前 assembler。Artifact 同时记录 `review_bundle_id` 与 `assembler_version`，从而保证交付字节就是审核对象。

### 9.12 迁移与升级启动顺序

迁移脚本为所有已有 Task 写 `legacy-v1`，新 Task 默认 `review-v2`；不回填伪 Review Run。应用在 HTTP 监听前执行恢复事务：若 legacy Task 仍为 running，则取消活动 Execution、把运行投影复位到可读状态、Task 置 stopped，并写 `legacy_protocol_locked` Trace。之后 Scheduler、resume、retry 和启动恢复都必须拒绝 legacy Task。

现有已发布 Template/Skill 版本保持历史可读，但缺少 review 双绑定、input/output limits 或模型能力要求的版本不能创建 review-v2 Task；必须发布满足新 Schema 的模板版本。不得原地修改旧模板快照来“补齐”上限。

CHECK/枚举约束需要以重建表方式迁移时，先在临时表按新约束复制、验证行数与外键，再原子替换；不能只改 TypeScript union 而让数据库仍拒绝新 Operation/Phase。升级验收同时证明：旧完成任务可读/可导出，旧未完成任务不可继续，新任务完整走 review-v2。

部署采用维护窗口：先停止旧进程并保存可恢复的数据库副本，再在单事务内迁移，完成启动校验后才开放 HTTP。若在创建任何 review-v2 Task 前失败，可恢复迁移前副本并回到旧程序；一旦已有 review-v2 数据，禁止直接降级到不认识新协议的旧二进制，只能使用向前修复版本或经审查的数据恢复方案。

---

## 10. 状态机

### 10.1 TaskStatus 保持不变

```text
ready | running | stopped | completed | failed
```

审核不是新的顶层状态；它是运行任务中的阶段。停止、恢复、失败和完成语义继续沿用。

### 10.2 TaskPhase 扩展

```text
structure
structure_review
slots
global_review
assembly
done
```

主要迁移：

```text
structure
  → structure_review
      ├─ REVISE → structure
      └─ PASS   → slots

slots
  → global_review
      ├─ 结构 REVISE → structure
      ├─ 内容 REVISE → slots
      └─ PASS        → assembly → done
```

局部槽位审核与生成交错进行，因此不单独占用 TaskPhase。

### 10.3 SlotStatus 保持 P0 四态，审核状态使用派生投影

```text
pending | running | completed | failed
```

不扩充持久化 SlotStatus，以免破坏 P0 约束和大量现有查询。对 `review-v2`，`completed` 的定义收紧为“当前结构下存在 accepted revision 且已通过局部审核”；Writer 刚提交 candidate 后 Slot 回到 `pending`，由 Scheduler 根据 candidate 指针派发审核，而不是再次生成。

API/UI 使用版本指针和 Review Run 派生展示态：

| 条件 | 展示状态 |
|---|---|
| status=pending 且无 candidate | 待生成 / 待返修 |
| status=running 且当前 Execution=create/fill | 生成中 |
| status=pending 且有 candidate、无运行 Review | 待审核 |
| status=pending 且有 candidate、Review running | 审核中 |
| status=completed 且 accepted_revision_id 非空 | 已通过 |
| status=failed | 失败 |

“待返修”再由最新 Review Run 为 `revision_requested` 且无新 candidate 派生。所有调度条件由一个 domain projector 统一实现，不能让 API、UI 和 Scheduler 各写一套推断。

上述展示态只用于 `contentBearing=true` 的槽位；容器槽位继续保持 `pending`，在调度、审核和完成判据中先过滤，UI 显示为结构节点而不是“待生成”。

### 10.4 ExecutionStatus 保持不变

```text
created | running | succeeded | failed | cancelled | stale
```

审核合法返回 `REVISE` 仍然是一次成功的 Execution：它完成了审核职责。语义结果记录在 `review_runs.status=revision_requested`，不能把它误记为执行失败。

### 10.5 stop / resume / 重启恢复 / retry 的逐操作语义

stop 与启动恢复不能使用“凡是 running slot 一律改 pending”的通用清理。系统按当前 Operation 执行同一张恢复表，并在一个事务中关闭 Execution、Review Run/Segment、Slot 投影和 Trace：

| Operation | stop/崩溃后保留 | 复位 | resume 后下一动作 |
|---|---|---|---|
| `create_structure` | 已完成的旧 accepted 结构和 generationWorkId；未提交模型输出不保留 | Execution cancelled/stale，pending candidate 不凭空创建 | 复用同一 work id 重建 Structure Execution |
| `review_structure` | 当前 structure candidate、Review Run 与 findings 历史 | Review Run→pending；Execution→cancelled/stale；phase 保持 structure_review | 在同一 Review Run 下新建 Execution |
| `fill_slot` | 当前 accepted 版本、历史 candidate 和 generationWorkId | Slot running→pending；Execution cancelled/stale；未提交输出不保留 | 复用同一 work id 重建 Writer Execution |
| `review_slot` | 当前 candidate 与 Review Run | Review Run→pending；Execution→cancelled/stale；Slot 保持 pending | 在同一 Review Run 下新建 Execution |
| `review_global_segment` | Bundle、全部已完成 Segment 及 findings | 当前 Segment/Run→pending；Execution→cancelled/stale | 在同一 Review Run 下只重跑未完成 Segment |
| `review_global_synthesis` | Bundle、Synthesis Run 和全部 Segment 结果 | Synthesis Run→pending；Execution→cancelled/stale；Bundle→synthesis_pending | 在同一 Review Run 下重建 Synthesis Execution |

主动 stop 使用 `cancelled`；进程崩溃后的启动恢复使用 `stale`，但领域复位相同。恢复事务必须先于 HTTP 监听和 Scheduler tick。`resume` 只把 review-v2 Task 从 stopped 改 running，再由持久化指针推导下一动作，不复制候选、不清 findings、不重置预算。

`retry` 只允许对 review-v2 的 failed 技术动作或明确可重试 Task；它复用同一稳定 scope 的剩余预算。语义预算或任务总 Review 预算已经耗尽时拒绝 retry，用户若要重新尝试必须创建新 Task。legacy-v1 的 resume/retry 一律拒绝。

### 10.6 技术 Execution 的四类原子转移

技术预算只在可计费失败时变化；下面四类 UoW 适用于六种 Operation：

| 事件 | Execution / Task 活动指针 | retry 预算 | 逻辑工作 | Task |
|---|---|---|---|---|
| 首次派发或 stop 后替代派发 | 新 Execution created→running；`active_execution_id` 指向它 | 不消费 | 同一 generationWork/ReviewRun→running | 保持 running，写 started Trace |
| 可计费技术失败且有 retry | 当前 Execution→failed；清 active | 条件消费 1 次 | 同一 work/run→pending，保留候选/Segment | 保持 running，写 failed + retry_scheduled Trace，Scheduler 创建下一 attempt |
| stop / 崩溃恢复 | 当前 Execution→cancelled/stale；清 active | 不消费 | 同一 work/run→pending，保留可持久对象 | 主动 stop 或启动恢复均置 stopped，写 cancelled/stale Trace |
| 可计费技术失败且无 retry | 当前 Execution→failed；清 active | 条件消费失败，不清零 | work/run 与对应领域对象→failed | Task→failed，写 budget_exhausted Trace，不再调度 |

各 Operation 的“对应领域对象”固定如下，所有列与上表写入同事务：

| Operation | running | pending（失败可重试或停止） | exhausted |
|---|---|---|---|
| `create_structure` | pending structure generation work；phase=structure | 保留 generationWorkId；不创建候选 | generation work failed；Task failed |
| `review_structure` | Review Run running；候选保留；phase=structure_review | Review Run pending；候选保留 | Review Run failed；候选保留；Task failed |
| `fill_slot` | generation work running；Slot running | generation work pending；Slot pending；accepted 历史保留 | work/Slot failed；Task failed |
| `review_slot` | Review Run running；Slot pending；candidate 保留 | Review Run pending；Slot pending；candidate 保留 | Review Run/Slot failed；candidate 保留；Task failed |
| `review_global_segment` | Run/Segment running；Bundle segment_reviewing | Run/Segment pending；已完成 Segments 保留 | Run/Segment/Bundle failed；Task failed |
| `review_global_synthesis` | Run running；Bundle synthesis_reviewing | Run pending；Bundle synthesis_pending；Segment 结果保留 | Run/Bundle failed；Task failed |

可计费失败仅包括 Provider 最终错误、超时、未提交或同 Assignment 内无法修正的协议输出；主动 stop、进程崩溃、部署取消与被新 current pointer 置 stale 均不计费。`task_review_cycle_total` 与本表分离：它在新 Review Run 创建时消费一次，同 Run 的所有 Execution attempts 只受该 Run 的技术失败预算约束。

---

## 11. 三个质量闸门

### 11.1 闸门 A：结构局部审核

1. Structure Agent 提交完整结构候选。
2. 系统执行现有19条确定性校验，再执行 review-v2 的局部 Reviewer 最坏输入包络校验。
3. 全部通过后保存 `structure_revision(candidate)`，但不创建当前有效 slots。
4. TaskPhase 进入 `structure_review`。
5. Structure Reviewer 审核任务目标、槽位拆分、层级、依赖、粒度与覆盖。
6. `PASS`：原子提升结构版本，物化 slots，进入 `slots`。
7. `REVISE`：保存 findings，结构候选标记 rejected，回到 `structure`。
8. 新 Structure Assignment 收到原任务输入、上一版结构和直接 findings，提交完整新结构，而不是局部 patch。

要求提交完整结构可以继续复用现有19条校验，避免设计第二套结构 patch 协议。

### 11.2 闸门 B：槽位局部审核

1. Scheduler 只把依赖槽位均为 `completed`，且 accepted revision 指针完整的内容槽位视为 ready；review-v2 中这等价于已局部通过。
2. Writer 提交内容，经现有确定性校验后保存 candidate revision。
3. 槽位回到 `pending` 并保留 candidate 指针，派生展示为“待审核”，调度同一槽位的 Reviewer。
4. Reviewer 只能审核该 candidate 及生成时相同的依赖版本。
5. `PASS`：candidate 提升为 accepted，槽位进入 `completed`。
6. `REVISE`：candidate 标记 rejected、清 candidate 指针，槽位保持 `pending`，由最新 Review Run 派生“待返修”。
7. 新 Writer Assignment 收到当前槽位目标、依赖认可版本、上一候选及 findings。
8. 新候选必须再次经过确定性校验与局部审核。

因为下游只有在上游 completed/accepted 后才会生产，局部返修不会导致下游失效。这是把局部审核放在调度门前的核心收益。

### 11.3 闸门 C：全局审核

1. 所有内容槽位 completed 且 accepted 指针完整后创建 Review Bundle，并冻结输入预算、估算器和分段 manifest。
2. 用现有确定性 assembler 生成预览，但不写最终 Artifact。
3. 系统创建全部不可变 Segment，并为每段运行独立 Reviewer；每段都必须覆盖完整归属范围、满足 receipts 并提交合法结果。
4. 所有 Segment 完成后，Synthesis Reviewer 检查结构合理性、跨段一致性、整体节奏、重复/遗漏、标题与正文关系、人物和信息连续性，并合并 findings。
5. Synthesis `PASS`：Review Run 绑定当前完整 Corpus/版本集合，TaskPhase 进入 assembly；Assembly 直接写入 Bundle 的冻结 artifact preview。
6. Synthesis `REVISE`：系统校验 findings，创建 Repair Wave 并计算失效范围。
7. Repair Wave 完成后，所有受影响槽位重新局部通过，再创建新的 Review Bundle；Segment 结果不能跨 Bundle 复用。
8. 旧全局 PASS/REVISE 永远只绑定旧 Bundle，不可复用。

---

## 12. 全局返修路由与失效传播

### 12.1 单槽问题

Reviewer 指定一个具有当前 accepted revision 的内容槽位作为返修根；容器不能使用 `slot` scope。系统失效：

- 该槽位当前认可版本；
- `dependsOn` 传递闭包中所有读取了它的下游槽位。

按现有确定性文档序重新生成与审核。

### 12.2 子树问题

Reviewer 指定一个子树根。系统先取结构树中的全部内容后代，再对这组槽位计算依赖下游闭包，合并去重后形成 Repair Wave。

子树根可以是容器或内容槽位，但展开后必须至少包含一个具有当前 accepted revision 的内容槽位，否则提交阶段返回 `REVIEW_ROUTE_INVALID`。

树层级表示内容组织，不自动等于数据依赖。因此只有 Reviewer 明确选择 `subtree` 时才按后代展开；单槽问题不会因为它有子节点就无条件重写整棵子树。

### 12.3 跨槽问题

Reviewer 指定两个或以上具有当前 accepted revision 的内容槽位作为最小返修根。系统对每个根计算依赖闭包并取并集。Reviewer 需要在 finding 中说明这些槽位之间的冲突证据和希望保持的共同约束。

### 12.4 结构问题

结构问题返回 Structure Agent。新 Structure Assignment 收到：

- 当前认可结构；
- 全局审核中的结构 findings；
- 当前已认可槽位清单；
- 保持稳定 Slot ID 的要求。

Structure Agent 仍提交完整新结构。结构局部审核通过后，首版**失效全部内容槽位并按新结构重新生产**。

失效时点固定为新结构 PASS 的原子切换事务，而不是 Synthesis 刚提出结构 REVISE 时。Repair Wave 创建时记录 `planned_invalidated_slot_ids` 和 `invalidation_timing=on_structure_pass`，清当前 Bundle 并把 TaskPhase 切回 structure；旧 accepted 结构/内容仅作为 Structure Agent/Reviewer 的只读返修来源，Scheduler 与 Assembly 不得把它们继续生产或交付。新结构 PASS 时才写 applied 集合、清旧投影并重建 slots；若结构返修最终失败，旧版本历史仍可诊断但 Task 为 failed、无 Artifact。

这是基于现有实现的保守决定，不是为了省设计：当前填槽上下文包含完整结构 outline。即使某个槽位自己的 ID、type、instruction 与 `dependsOn` 都没变，只要槽位树其他位置变化，它当时收到的确定性上下文就已经不同。继续保留旧正文会违反“当前产出由当前冻结规则和当前结构上下文生成”的可追溯语义。

**否掉的首版方案**：按 Slot ID 和局部字段相同就保留旧内容。
**原因**：这个判据漏掉了完整结构 outline 也是生成上下文的一部分，会把旧上下文生成的内容冒充成新结构下的有效内容。

未来若要优化成本，必须先把 fill-slot 的结构上下文收窄成可证明的局部投影，再以“所有确定性上下文输入逐项相同”为保留条件；不能依赖模型声明，也不能只比较 Slot ID。

### 12.5 多 finding 合并

一次全局审核的全部 findings 先统一校验，再合并成一个 Repair Wave：

- 任一 finding 为 `structure`，整个波次只路由结构返修；旧结构下的内容 findings 标记为 `requires_revalidation`，不能继续按旧 Slot ID 直接派发 Writer；
- 否则合并所有槽位、子树和跨槽目标；
- 重叠目标去重；
- 系统只创建一份最终失效集合，避免同一槽位重复返修。

结构生成 Agent 和随后结构 Reviewer 都必须看到本波次的结构 findings。结构候选通过后，全部旧内容失效并重跑；`requires_revalidation` 的内容 finding 写入下一 Review Bundle 的 required concerns。系统在 Segment 创建时确定性分配：无法证明新旧 Slot 映射的 concern 发给每个 Corpus Segment；能证明映射的至少发给覆盖目标与依赖的全部 Segment。Segment 对新正文逐项返回 `not_observed` 或带新 evidence 的 reissued finding，Synthesis 收齐结果并检查跨段 facts 后才写 `resolved_on_revalidation` / `reissued`。Synthesis 自己不读取正文，也不能跳过 Segment 重新取证。这样既不会把旧 locator/Slot ID 错映射到新结构，也不会在结构返修时悄悄丢掉同时发现的内容问题。

---

## 13. 重试、预算与终止

### 13.1 四类预算

| 类型 | 作用域 | 示例 | 是否增加返修轮 |
|---|---|---|---|
| Provider 退避 | 单 Execution | 429 | 否 |
| 生成执行重试 | 单 generationWorkId | 超时、未提交、Provider 错误 | 否 |
| 审核执行重试 | 单 Review Round | 审核超时、非法输出、未调用 `complete_review` | 否 |
| 语义返修轮 | 结构、槽位或全局 | 合法 `REVISE` | 是 |

前两类技术预算绑定 generationWorkId / Review Run；语义预算与任务总预算使用 9.9 的稳定 scope key 持久化。同一 work/run 的 `context_json` 来源链不可变且技术 retry 继续原计数；合法 REVISE 才创建带新 source findings 的下一语义 cycle，为它建立新的技术 scope，并同时消费原稳定语义 scope。

全局 Segment 的 verdict 无论 PASS 还是 REVISE 都只结束 segment cycle；Segment findings 累积给 Synthesis，不消费 global semantic revision。global scope 只在 Synthesis REVISE 创建 Repair Wave 时增加一次。

### 13.2 建议初始默认值

以下是需要真实基准校准的启动值，不应直接当最终结论：

- 结构局部返修最多 2 轮；
- 单槽局部返修最多 2 轮；
- 全局返修最多 2 个 Repair Wave；
- 每次生成/审核 Execution 的技术重试沿用当前最多 2 次；
- 整个任务增加总 Review Run cycle 上限，Bundle 创建时为全部 Segment + Synthesis 一次性预留，防止结构变化反复触发大规模复审。

### 13.3 预算耗尽

建议错误码：

```text
REVIEW_OUTPUT_INVALID
REVIEW_EVIDENCE_NOT_FOUND
REVIEW_EVIDENCE_AMBIGUOUS
REVIEW_EVIDENCE_RESOLUTION_EXHAUSTED
REVIEW_TARGET_STALE
REVIEW_ROUTE_INVALID
REVIEW_CORPUS_INCOMPLETE
REVIEW_SYNTHESIS_BUDGET_UNSATISFIABLE
REVIEW_SYNTHESIS_DECISION_UNREPRESENTABLE
REVIEW_SEGMENT_BUDGET_UNSATISFIABLE
REVIEW_INPUT_BUDGET_UNSATISFIABLE
REVIEW_INPUT_BUDGET_EXCEEDED
REVIEW_OUTPUT_BUDGET_UNSATISFIABLE
REVIEW_SUBMISSION_CORRECTION_EXHAUSTED
MODEL_CAPABILITY_INSUFFICIENT
STRUCTURE_REVIEW_EXHAUSTED
SLOT_REVIEW_EXHAUSTED
GLOBAL_REVIEW_EXHAUSTED
REVIEW_BUDGET_EXHAUSTED
```

这些值必须进入 shared `ErrorCode`/DTO、PublicError 映射和 API/CLI 测试。`REVIEW_EVIDENCE_NOT_FOUND/AMBIGUOUS` 是 resolver 的固定、可修正 tool error；预留修正后仍失败转为 `REVIEW_EVIDENCE_RESOLUTION_EXHAUSTED`。`REVIEW_SYNTHESIS_DECISION_UNREPRESENTABLE`、`REVIEW_SEGMENT_BUDGET_UNSATISFIABLE` 是 Provider 前的确定性模板/Bundle 错误，不消耗技术 retry；`REVIEW_SUBMISSION_CORRECTION_EXHAUSTED` 与 evidence resolution exhausted 表示同 Execution 修正已用完，按可计费审核技术失败处理并在预算允许时新建同 Review Run 的替代 Execution。

预算耗尽后：

- Task 进入 failed；
- 不生成最终 Artifact；
- 保留最后候选、全部 Review Run、Findings 和 Repair Wave；
- PublicError 明确说明是生成失败、审核技术失败还是语义返修未收敛；
- stop/resume、进程重启或 retry 都不能重置、迁移或复制该 Task 的预算；retry 遇到耗尽预算时直接返回 `REVIEW_BUDGET_EXHAUSTED`。

---

## 14. Trace、SSE 与可观测性

### 14.1 复用通用 Assignment 事件

每次审核仍使用：

```text
assignment_created
assignment_started
context_built
skill_loaded / skill_section_read
tool_call_started / tool_call_completed
assignment_completed / failed / cancelled
```

通过 `operation` 区分生成与审核。`work_*` 与 `public_output_chunk` 仅保留给生成 Operation；审核进度使用系统生成的 `review_started / review_resource_read / review_submitted`，Reviewer 普通文本既不落 Trace 也不发 SSE delta。

### 14.2 新增领域事件

建议新增：

```text
structure_revision_created
slot_revision_created
review_submitted
review_passed
revision_requested
revision_invalidated
repair_wave_created
repair_wave_completed
review_budget_exhausted
global_review_segment_created
global_review_segment_completed
global_review_synthesis_started
global_review_passed
late_result_rejected
legacy_protocol_locked
```

Trace payload 只放定位信息，不放完整正文或完整 findings：

```text
reviewRunId
scope
targetSlotIds
findingCount
structureRevisionId
slotRevisionIds
repairWaveId
reviewBundleId
reviewSegmentId
```

事件摘要只能由系统从 verdict、已验证 criterion、目标和计数生成，并执行固定长度截断；不能把 Reviewer 的 `summary`、problem 或 evidence 原样复制进 Trace/SSE。完整审核正文仍从专用实体读取。

Review 的 assignment/tool 失败事件只使用稳定 error code 与系统文案；Provider 原始响应、模型普通文本、工具返回正文和包含 quote 的校验错误只回当前 Execution 或进入受限错误实体，不得进入 Trace/SSE。

### 14.3 不记录的内容

- Provider 隐藏推理；
- Reviewer 普通文本 delta 与自由文本进度；
- API Key；
- 完整候选正文；
- 完整装配预览；
- 完整 findings 证据文本。

这些内容分别进入版本/审核实体，通过授权的只读端点获取。

---

## 15. API、CLI 与前端

### 15.1 API 原则

后端继续只有 `/api/*`。首版审核全自动，不新增人工审核写端点。

建议新增只读能力：

```text
GET /api/tasks/:id/reviews
GET /api/tasks/:id/reviews/:reviewId
GET /api/tasks/:id/repair-waves
GET /api/tasks/:id/slots/:slotId/revisions
GET /api/tasks/:id/structure-revisions
```

现有 `TaskDetail`、`SlotDetail` 和 `ExecutionView` 增加审核摘要、当前版本和返修轮信息。所有 DTO 继续由 shared Zod Schema 定义。

### 15.2 CLI

`run-task` 默认跑完整审核返修闭环，不提供“跳过审核”开关。建议扩展：

- 终端进度显示当前审核阶段、Review Round 与 Repair Wave；
- `dump-trace` 正确显示审核事件；
- 新增只读 `dump-reviews` 或等价参数，导出结构化审核历史；
- 失败退出码区分生产失败与审核未收敛。

### 15.3 前端工作台

五段 Stepper 扩展为：

```text
创建结构 → 结构审核 → 槽位生产与局部审核 → 全局审核 → 系统装配
```

槽位树至少显示：

- 待生成；
- 生成中；
- 待审核；
- 审核中；
- 待返修；
- 已通过；
- 失败。

右侧面板增加：

- 当前候选与认可版本；
- Reviewer、Review Skill 与模型；
- PASS/REVISE；
- Findings 列表；
- 证据、返修指令和验收条件；
- 版本历史；
- 哪个全局 finding 导致本槽失效；
- 受影响下游槽位。

Q-25 应并入本阶段：已完成槽位必须能看到生产与审核 Execution 的技术详情，并提供 Trace/Review JSON/Markdown 导出。这里的导出是观察能力，不是人工审核入口。

### 15.4 SSE

`useWorkbench` 继续遵守：

- REST 是权威状态；
- SSE `state` 只做失效通知；
- 首连由 REST 播种；
- 重连用 Last-Event-ID 补 trace；
- delta 断线不补发；
- 断线不把任务标失败。

新增审核状态前，必须补齐 `useWorkbench` 的首连播种、合并去重、断线重连和跨任务隔离测试。

---

## 16. 对现有模块的影响

| 现有模块 | 主要变化 |
|---|---|
| `shared/contracts.ts` | 扩展 Operation、TaskPhase、protocol_version、Review DTO；SlotStatus 保持四态并增加派生 Review View |
| `shared/text-coordinates.ts`（新增） | `unicode-code-point-v1` 校验/计数/半开区间切片、RFC 6901 scalar source text 与 quote 验证；Engine/API/Client 共用，禁止各自换算 UTF-16 offset |
| `domain/content-normalization.ts`（新增） | `canonical-slot-content-v1` 的 CRLF/CR→LF、冻结 trim 集、raw/canonical code-point 上限与空值校验；completion/review/assembly 共用 |
| `shared/tools.ts` | 增加审核工具 Schema；生成与审核工具集合分离 |
| `shared/trace.ts` | 增加审核/版本/返修领域事件 |
| `template-schema.ts` | 生成/审核绑定、global segment/synthesis 双绑定、Criteria、全字段上限、局部/全局输入预算、工具调用/修正上限与持久化审核预算 |
| `template-loader.ts` | 编译审核绑定；校验内容槽位覆盖、输入字段/正文上限、resource delivery、最坏 payload/tool-call 包络与 Synthesis 可表达性 |
| `skill-loader.ts` | 支持 review operation，校验 Criteria/Sections/outputLimits，编译最大合法 ReviewDecision 输出包络并冻结 Skill |
| `snapshot-service.ts` | 将所有审核定义写入任务快照 |
| `provider-service.ts` / provider schema | 模型能力契约；晚绑定时校验快照最低上下文/输出/工具要求 |
| `assignment-service.ts` | 支持 Review Execution 与目标版本 |
| `context-builder.ts` | 局部 Reviewer、Segment、Synthesis、resource delivery plan、修正轮消息包络与语义返修来源链上下文 |
| Runtime toolset | `complete_review`、Reviewer 只读工具和提交闸门；Review Operation 禁用 report_work/public text delta |
| `production-engine.ts` | 增加结构审核、局部审核、Segment/Synthesis 与 Repair Wave 分支；按 Operation 恢复 |
| `slot-scheduler.ts` | completed + accepted 指针才满足依赖；区分 candidate 待审核与无 candidate 待生成 |
| `structure-service.ts` | 保存不可变结构代际，审核通过后原子切换当前 slots 投影 |
| `completion-service.ts` / `review-service.ts` | 生成提交先做 raw 上限并只保存规范正文；候选/审核提交 UoW 同时结束 Execution、清 Task active pointer 并推进领域状态 |
| `assembly-service.ts` | 用冻结 membership planner 构建非空 preview/Corpus；PASS 后直接用 Bundle preview 创建 Artifact |
| `lifecycle-service.ts` | 六种 Operation 的 stop/recover 与可计费技术失败转移，不把取消计入 retry |
| repositories / migrations | 协议隔离、结构代际、版本、审核、ReviewRun target 唯一键、receipts、segments、预算、bundle、repair wave 与 UoW |
| `task-service.ts` | 审核阶段、版本、finding 与返修影响的投影 |
| SSE Hub | 协议不改，消费新增 Trace 后继续发 state 通知 |
| Client | 新阶段、槽位审核状态、审核历史和返修波次展示 |

建议不要把所有逻辑继续堆进 `ProductionEngine`。可新增 application 层的 `ReviewService`、`RevisionService` 与纯 domain 的影响范围计算函数；ProductionEngine 只负责按阶段编排。

---

## 17. 测试与能力证明

### 17.1 Domain 纯函数

保持100%覆盖门槛，至少包括：

- ReviewDecision 合法性；
- Review Bundle 精确版本匹配；
- 四态 SlotStatus + 派生审核状态投影；
- Criteria/scope/evidence kind 匹配；
- Evidence locator/quote 验证；
- `unicode-code-point-v1` 在 CJK、surrogate-pair emoji、combining mark、LF 与正文内空格上的半开切片；slot 规范正文、assembler preview、Corpus entry、receipt 与 API 高亮使用同一坐标；结构 JSON Pointer 的长 string scalar 可局部引用，对象/数组拒绝；
- source chunk 稳定性、exactQuote 唯一/重复 occurrence/未命中解析、resolver tool 重放幂等、跨 Execution/Bundle evidence ref 拒绝；Reviewer Schema 直接提交 raw locator 被拒；
- `canonical-slot-content-v1` 对首尾冻结 trim 集、CRLF、孤立 CR、CJK/emoji 的规范结果；raw/canonical code-point 上限、空正文、校验值与入库值完全相同；
- 全局 Segment 确定性覆盖、预算与无缺口；
- Review Corpus 使用 assembler 同一祖先排除语义，覆盖 Artifact 预览与全部实际未装配 content-bearing revisions；
- 空 artifact preview 拒绝创建 Bundle；
- slot/cross/subtree/structure scope 的可返修目标与非空失效集合校验；
- ReviewDecision 所有变长字段上限和封闭 Synthesis 包络边界值；
- outputLimits 展开后的最大合法 tool-call JSON 输出包络；
- required resource delivery plan 的 batch/injected 覆盖、最坏工具调用数、一次拒绝 decision 历史与第二次输出预留；
- resolver batch capacity 同时覆盖 finding evidence 与 Segment PASS 的上限 synthesisFacts evidence；
- Synthesis finding cardinality 可表达性边界；
- `maxTaskReviewRuns` 的零返修下界、保守理论上界与 Task budget 初始化；
- 段落→句界→code-point splitter 对无换行长段、CJK/emoji 和最小不可容纳单元的终止/拒绝；
- 每种 Operation 的 required-read 矩阵与完整 range receipts；
- cancelled/stale Execution 的 receipts 不能供同 Review Run 的新 Execution 提交使用；
- 单槽依赖闭包；
- 子树 + 依赖闭包；
- 多 finding 合并去重；
- 结构返修后全量内容失效；
- 全局完成判据；
- 旧 Review PASS 失效；
- 文档序返修调度；
- 混合 structure/content findings 的 revalidation carryover。

### 17.2 持久化与事务

- 候选版本保存不覆盖认可版本；
- 结构 PASS 原子切换 Task 指针、structure revision 和 `slots` 当前投影；
- 槽位 PASS 原子提升版本并更新 content/producer/current pointers；
- REVISE 原子保存 findings、消费持久预算并进入返修；
- 每个合法审核提交同事务 Execution→succeeded、清 Task active_execution_id，并可立即调度下一动作；
- 停止与审核提交竞态；
- 旧候选迟到 PASS 被拒；
- Guard 条件更新为 0 后，只在第二事务写 `late_result_rejected`；
- 返修波次失效集合与 Trace 同事务；
- structure Repair Wave 创建只记录 planned invalidation；新结构 PASS 才原子写 applied invalidation 并清旧投影；
- 失效同时清 accepted/candidate/content/producer 投影；
- 六种 Operation 分别覆盖 stop、resume 与重启恢复；
- 六种 Operation 的可计费失败有/无 retry、stop/stale 四类 UoW；
- stop/resume/stale 替代 Execution 不消费 retry，Provider/timeout 技术失败才消费；
- stop/resume/retry/重启不重置持久预算；
- 同一 generationWorkId / Review Run 的技术 retry 共用预算，合法 REVISE 的新语义候选获得新技术 scope 但继续消费原语义 scope；
- semantic revision `context_json` 精确保存 source review/finding/previous revision/dependency manifest；
- Review Run 一对多 Execution、generationWorkId 在 stop/retry 后稳定且新语义 cycle 不复用；
- 结构候选使用 `structure_revision_slots`，同 Slot ID 的多代数据互不覆盖；
- legacy-v1 旧完成任务可读、旧未完成任务锁定、resume/retry 被拒；
- 新 Operation/Phase 的数据库 CHECK 在真实迁移后可写；
- 历史版本不可丢失；
- Artifact content 与 PASS Bundle 冻结 preview 逐字一致，并记录 assembler version；
- 最大合法审核输出 ≤ reservedOutput ≤ model maxOutput 的模板编译、快照与晚绑定校验；
- 结构/槽位局部 Reviewer 最大包络和实际 payload 超限在 Provider 前拒绝；
- Reviewer 回显候选、evidence 或自由进度时不产生 Trace/public_output_chunk/SSE delta。
- Review Run 创建成功后、Execution 派发前注入崩溃；恢复/重复 tick 命中同一 target unique Run，预算只消费一次；
- Synthesis slots/structure 两种 REVISE 路由与所有局部结果都在提交 UoW 中写入正确 TaskPhase；
- evidence refs 创建、finding 关联与审核提交同事务；失败回滚不留下 consumed ref，旧 attempt ref stale，Synthesis 只复用当前 Bundle Segment consumed refs；

### 17.3 Engine 集成路径

至少覆盖：

1. 结构一次生成、一次审核通过；
2. 结构审核打回一次后通过；
3. 槽位审核打回一次后通过；
4. 全部局部通过、全局一次通过；
5. 全局单槽打回及下游级联；
6. 全局子树打回；
7. 全局跨槽打回；
8. 全局结构打回、结构复审和全部内容失效重跑；
9. 审核输出非法后同 Assignment 修正；
10. 审核技术重试与语义返修预算分离；
11. 停止、恢复与重启恢复发生在审核阶段；
12. 预算耗尽进入明确失败终态；
13. 全局 PASS 后版本变化时 Assembly 拒绝；
14. 连续多任务全自动收敛；
15. 全局审核按 Segment 全覆盖后再 Synthesis；任一缺段或 receipt 缺失都不能 PASS；
16. Synthesis 运行中 stop/崩溃后只重跑 Synthesis，不重跑已完成 Segment；
17. 混合结构与内容 findings 经结构重跑后，旧内容问题必须 revalidate，不得按旧 Slot ID 误路由；
18. 预算耗尽后 retry 被拒，新 Task 才获得新预算；
19. legacy-v1 与 review-v2 升级共存的只读/可运行边界；
20. 自身 false 或被 false 祖先排除的内容槽位都进入 Review Corpus，并可触发全局 REVISE；
21. 局部 Reviewer 未读完整 candidate 或必需 dependency 时，合法形状的 PASS 仍被拒绝；
22. Segment REVISE 只累积 finding，不消耗 global semantic budget，Synthesis REVISE 才消费一次；
23. 结构重做后的 carry-over finding 在新 Corpus Segments 全量复核并形成 resolved/reissued disposition；
24. Synthesis PASS 后跨重启/assembler 版本变化，最终 Artifact 仍逐字使用已审核 preview；
25. Alias 重绑到更小模型时 resume/retry 在发请求前返回明确能力错误。
26. 审核 PASS/REVISE 提交后同事务关闭 Execution/active pointer，下一动作立即可调度；stop 与提交竞态只有一方生效；
27. 对六种 Operation 分别注入 Provider failure、stop 和 crash，证明只有可计费失败消耗 retry；
28. 超长 Task input、无 maxChars Slot Type、依赖 fan-in 超局部预算时在模板发布、Task 创建或结构接受阶段确定性拒绝；
29. 四类 ReviewDecision 全部变长字段取上限时，规范 JSON/tool envelope 不超过 reserved/model output；越界模板拒绝，Provider 请求使用冻结 max_output_tokens；Synthesis carry-over 矩阵最坏组合仍在输入预算内；
30. Reviewer 故意在普通 delta、禁止的 report_work、读工具首行和工具错误中回显候选/evidence，Trace/SSE/导出均不出现原文；
31. false 容器下自身 true 的内容后代进入 work Corpus；全部内容被排除时以空 Artifact 拒绝；
32. local review_slot 对尚未 accepted candidate 的 REVISE 合法且不要求失效集合；local review_structure 同理；global slot/cross 指向容器、subtree 展开为空、structure 携带内容目标时返回 REVIEW_ROUTE_INVALID；
33. global structure REVISE 后旧 accepted 投影只读保留且不能调度/装配；新结构 PASS 时才全量 applied invalidation。
34. slot/Task/Corpus/structure evidence 在 CJK、emoji、combining mark、CRLF 与尾随空格下由 code-point range 精确回显；JS UTF-16 offset、对象 pointer 与错 quote 被拒；
35. 31 个依赖的局部审核、多 Segment Synthesis 都使用冻结 batch/injected delivery plan，在 24 次工具上限内完成；首次 `complete_review` 非法后保留最大历史仍能提交一次修正，第三次被拒并结束 Execution；
36. 无换行超长单段经句界或 code-point 硬切确定性终止，ownership 无重叠/缺口，overlap 不重复计入 coverage；
37. 构造 `segmentCount × segment.maxFindings` 恰等于/超过 Synthesis source capacity 的 Bundle，前者可创建、后者在 Provider 前返回 `REVIEW_SYNTHESIS_DECISION_UNREPRESENTABLE`；
38. Review Run 落库并消费总预算后在派发前崩溃，恢复和重复 tick 仍只有一个 target Run、一次预算消费；Synthesis slots route 同事务切回 slots，structure route 切回 structure。
39. 生成提交包含接近 raw 上限的首尾空白、CRLF/孤立 CR、CJK/emoji 时，raw 超限先拒绝；合法输入只把 `canonical-slot-content-v1` 结果写入 revision，局部 Reviewer、Corpus 和 Artifact 映射看到同一规范正文。
40. 模板总 Review Run 预算低于零返修最大路径时拒绝发布；合法值冻结进 Task 后，结构/Bundle 实际预留只消费该行；每个 global Segment 缺少冻结任务输入 receipt 时 PASS/REVISE 均被拒。
41. Reviewer 只用 sourceChunkId/exactQuote 解析 evidence：唯一 quote 一次成功，重复 quote 经 occurrence 修正成功，错 quote 用完一次修正后进入可计费技术失败；全程不要求模型输出 code-point 数字，伪造/跨 Bundle evidenceRef 被拒。
42. Segment `PASS` 且 findings 为零、`synthesisFacts` 与每 fact evidence 都取上限时，两次 resolver/output 包络仍满足 binding；漏算 fact refs 的模板在发布期拒绝。

### 17.4 FakeProvider 的用途边界

FakeProvider 只证明：

- 状态流；
- 工具协议；
- 事务；
- 返修路由；
- Trace/SSE；
- 预算与恢复；
- 分段 coverage 与 receipts 协议。

它不能证明 Reviewer 能识别真实质量问题。

### 17.5 真实 Reviewer 基准

在实现 Reviewer Skill 之前冻结：

- 开发集：用于改 Skill；
- 留出集：不得在迭代中查看答案；
- 正例：应该 PASS 的结构、槽位和整章；
- 反例：植入明确问题并标注正确 scope/target；
- 返修例：审核意见是否能让 Writer 在下一版真正修复；
- 对抗例：文辞流畅但逻辑错误、局部正确但全局矛盾、错误证据指向等。

至少度量：

```text
应打回召回率
误打回率
目标定位准确率
证据有效率
返修指令可执行率
一次返修解决率
全局审核漏检率
平均 Review Execution 数
平均返修轮数
单任务耗时与成本增量
```

进入生产验收前，必须保存真实 Provider 的 Review Run、Findings、返修前后版本和最终 Artifact 作为证据。

另设规模闸门：达到模板 `maxSlots=32` 的合法结构（当前规则下为 1 个容器根 + 31 个内容槽位，同时包含进入和不进入 Artifact 的认可正文），总 Corpus 接近冻结 Reviewer 上限。必须证明每个 Corpus 字符都落入唯一归属 Segment、每个 accepted revision 都被覆盖、每段 Execution 未超能力预算、receipts 完整、全部 Segment 被 Synthesis 消费，且在头尾跨段植入的问题能够被发现。小样本通过不能替代此项。

---

## 18. 实施阶段建议

### P1-R0：需求、决议与基准冻结

- 业务方确认本设计的核心取舍；
- 修订 REQ 非目标与完成定义；
- 将 D-21～D-52 并入权威技术方案；
- 定义 ReviewDecision Schema；
- 冻结 protocol_version 迁移边界、Criteria/output limits、模型能力契约、局部/全局输入预算估算器、文本坐标协议、resource delivery/tool-call/修正轮包络、Review Corpus 与终止性分段策略；
- 冻结开发集/留出集和审核评分规则。

### P1-R1：Domain 与共享契约

- 四态 SlotStatus 派生投影、Operation、Review DTO、共享 code-point locator/quote 与 `canonical-slot-content-v1` 纯函数；
- 影响闭包与结构返修全量失效；
- 完成判据；
- 100% Domain 覆盖。

### P1-R2：版本与审核持久化

- migrations；
- repositories / UoW；
- legacy-v1 隔离、structure revision members、ReviewRun target 唯一键、持久化预算、Corpus/Segment 坐标版本、revalidation 实体；
- 原子提升、结构投影切换、审核提交关闭 Execution/active pointer、技术失败预算、失效与迟到审核拒绝；
- 冻结审核 Skill。

### P1-R3：Reviewer Runtime

- Reviewer 上下文；
- 结构/槽位/Segment/Synthesis 独立绑定与工具集；
- `complete_review`；
- 生成提交的 `rawSubmissionMaxCodePoints`/规范正文适配、read receipts/source chunks/evidence resolver、批量/注入 resource delivery plan、局部 payload/tool-call/一次修正预检、审核执行重试、public text suppression 与系统生成 Trace 摘要。

### P1-R4：局部审核闭环

- 结构生成—审核—返修；
- 槽位生成—审核—返修；
- 模板/结构最坏依赖包络校验；
- Scheduler 改为等待 completed + accepted revision；
- FakeProvider 完整回归。

### P1-R5：全局审核与返修波次

- Review Bundle 与完整 Review Corpus；
- 可终止的确定性 Segment Review + 通过 cardinality 证明的 Synthesis Review；
- 单槽/子树/跨槽/结构路由；
- 失效与重生产；
- 最终 Assembly Guard 与冻结 preview 直接交付。

### P1-R6：API、CLI、SSE 与前端

- 只读审核 API；
- CLI 全自动进度和导出；
- 工作台审核状态、版本、findings 与 Repair Wave；
- Q-25 与 SSE 时序测试。

### P1-R7：真实 Provider 调优与验收

- 分别迭代生成 Skill 与审核 Skill；
- 迭代审核 Skill 时冻结生成 Skill，反之亦然；
- 通过开发集后只跑留出集；
- 完整 E2E、规模、恢复、脱敏与成本报告；
- 独立审查通过后再宣布 P1 完成。

---

## 19. 验收条件

### 功能验收

- AC-R-001：每个结构候选都经过结构 Review Execution。
- AC-R-002：每个内容槽位的当前版本都经过对应局部 Review Execution。
- AC-R-003：局部未通过的版本不能供下游读取。
- AC-R-004：所有槽位局部通过前不能创建全局 Review Bundle。
- AC-R-005：没有绑定当前精确版本集合的全局 PASS 不能 Assembly。
- AC-R-006：Reviewer 不能直接修改结构、槽位或 Task 状态。
- AC-R-007：合法 REVISE 自动创建新的生成 Assignment。
- AC-R-008：单槽返修自动失效传递下游依赖。
- AC-R-009：子树返修正确合并树后代与依赖闭包。
- AC-R-010：结构返修通过后，旧结构下的全部内容版本都失效并重新生产。
- AC-R-011：旧候选或旧 Bundle 的迟到 PASS 被拒绝。
- AC-R-012：所有审核/返修状态迁移均有 Trace。
- AC-R-013：停止、恢复、重启恢复覆盖审核阶段。
- AC-R-014：预算耗尽进入明确失败终态，不等待人工。
- AC-R-015：版本历史、findings 与 Repair Wave 可通过 API/CLI/UI 查询。
- AC-R-016：legacy-v1 历史任务保持可读，但任何非完成旧任务都不能 start/resume/retry；新 Task 只走 review-v2。
- AC-R-017：结构 PASS 在单事务中切换不可变结构代际和当前 slots 投影，不存在混合代际可见状态。
- AC-R-018：每种审核 Operation 的 stop、resume、重启恢复都按目标类型保留候选/Segment，并拒绝旧 Execution 的迟到结果。
- AC-R-019：`complete_review` 的 current-pointer Guard 失败时，不得改变当前领域状态，只记录独立的 late rejection。
- AC-R-020：全局审核的所有 Segment 在预算内完整覆盖 Bundle；缺段、缺 receipt 或旧 Segment 不能启动/通过 Synthesis。
- AC-R-021：每条 finding 的 criterion、scope、source revision、locator 与 quote 均通过系统校验，finding ID 与 Trace 摘要由系统生成。
- AC-R-022：语义返修 Execution 的 `context_json` 包含完整来源链；技术 retry 不改变该来源链。
- AC-R-023：stop/resume/retry/进程重启都不重置持久化审核或返修预算，耗尽后 retry 被拒。
- AC-R-024：global Segment 与 Synthesis 使用两个独立 Agent/Skill/Operation 绑定，模板加载期分别校验。
- AC-R-025：Review Corpus 使用 assembler 同一祖先排除语义，覆盖 Artifact preview 和所有实际未进入 Artifact 的 content-bearing accepted revisions；缺失任一版本不能 Synthesis PASS。
- AC-R-026：结构/槽位 Reviewer 缺少当前目标完整 receipt，或缺少 Criteria 所需依赖 receipt 时，任何 verdict 都被拒绝。
- AC-R-027：结构重做后的 carry-over 内容 finding 必须由新 Corpus Segments 逐项复核，并由 Synthesis 写 resolved/reissued disposition。
- AC-R-028：最终 Artifact content 与 PASS Bundle 冻结 `artifact_preview` 逐字一致，并可追溯 assembler version。
- AC-R-029：每次模型别名晚绑定都满足 TaskSnapshot 冻结的最低能力；较小模型重绑在 Provider 调用前被拒绝。
- AC-R-030：每个合法审核提交同事务结束当前 Execution、清 Task active pointer、完成 Review Run/领域写入并写 Trace；下一动作可立即调度。
- AC-R-031：技术 retry 只由可计费失败消费；stop/resume/stale 替代 Execution 不消费，六种 Operation 均有明确 pending/failed 收敛态。
- AC-R-032：结构与槽位局部审核都有冻结最大包络和实际 payload 预检；不可满足的模板、Task 或结构在 Provider 调用前拒绝。
- AC-R-033：所有 ReviewDecision 变长字段有冻结上限；最大合法序列化输出不超过 binding reserved output/model max output；Synthesis 最坏输入包络包含完整 revalidation 矩阵和输入/输出开销。
- AC-R-034：Reviewer 普通文本与自由进度不写 Trace、不发 SSE、不进入导出，只能通过结构化审核实体提交内容。
- AC-R-035：Review Corpus membership 与冻结 assembler 的祖先排除语义一致，覆盖所有未实际装配的 accepted revisions，且空 preview 被拒绝。
- AC-R-036：scope/route 按 Operation 校验：局部 candidate REVISE 不要求 accepted/失效集合；global slot/cross 只接受 current accepted 内容槽位，Synthesis 内容/结构计划非空，structure 不携带内容目标。
- AC-R-037：global structure REVISE 只记录 planned invalidation 并禁止旧版本调度/装配；新结构 PASS 的切换事务才全量失效旧内容并写 applied 集合。
- AC-R-038：所有持久化 Evidence、Corpus range、Segment ownership、receipt 与 UI 高亮共用冻结 `unicode-code-point-v1` 半开坐标；CJK/emoji/CRLF 下 quote 仍逐字一致，结构长 scalar 可局部引用。
- AC-R-039：每个 Review Assignment 的 required resource delivery、工具调用次数和一次提交修正都有静态与实际包络证明；31 依赖/多 Segment 边界在调用上限内可完成。
- AC-R-040：每个合法审核结果在同一 UoW 写全下一 TaskPhase；Synthesis 内容 route 回 slots、结构 route 回 structure，不会残留 global_review。
- AC-R-041：Bundle 创建前同时证明 Synthesis 输入/输出 token 与 finding cardinality 可表达；任意合法长正文的 splitter 确定性终止且 ownership 无缺口/重叠。
- AC-R-042：每个不可变 review target 只创建一个 Review Run；创建后派发前崩溃或重复 tick 不会重复消费 task review cycle 预算。
- AC-R-043：模板显式冻结 `maxTaskReviewRuns` 并证明覆盖零返修路径；Task 总预算有唯一初始化来源，global Segment 必须实际收到任务输入并形成 receipt。
- AC-R-044：生成候选的 raw 上限、规范化、`maxChars`、入库、局部审核与装配使用同一 `canonical-slot-content-v1` 字符串，首尾空白/CRLF 不能绕过预算。
- AC-R-045：Reviewer 只通过已读 source chunk 的 exact quote 解析 evidenceRef，不手填全局坐标；重复 quote 有一次可预算修正，伪造、旧 Execution 与跨 Bundle ref 均被拒绝。

### 质量验收

- AC-R-046：审核 Skill 在冻结开发集达到约定目标。
- AC-R-047：独立留出集达到约定的漏检率和误打回率。
- AC-R-048：返修指令能够被生成 Agent 执行，并达到约定的一次修复率。
- AC-R-049：全局 Reviewer 能识别局部 Reviewer 无法发现的跨槽/跨 Segment 问题。
- AC-R-050：真实任务的耗时、成本和返修轮数处于业务可接受范围。

具体阈值不在没有基准数据时编造，应由 P1-R0 基准阶段给出。

---

## 20. 风险与控制

| 风险 | 后果 | 控制 |
|---|---|---|
| Reviewer 与 Writer 使用同一模型产生自我确认 | 漏检 | 独立 Agent/Execution/Skill；全局审核不默认读取局部 PASS 理由；真实留出集 |
| Reviewer 过度挑错 | 无限返修、成本失控 | 二值闸门、明确非目标、误打回率、返修轮上限 |
| Findings 空泛 | Writer 无法修复 | 强制证据、criterionId、返修指令、验收条件 |
| 旧版本被误批准 | 错误内容进入 Artifact | Review Bundle + revision ID + 同事务迟到保护 |
| 上游返修后下游仍使用旧上下文 | 全局不一致 | 系统计算依赖闭包并强制失效 |
| 结构返修导致全量内容重跑 | 成本增加 | 首版接受保守正确性；保留全部历史；未来先收窄结构上下文再讨论安全复用 |
| 全局内容超出上下文 | Reviewer 实际没看全 | 冻结输入预算、确定性 Segment Review、receipts、Synthesis、最大32槽位实测 |
| 非 Artifact 工作槽位漏审 | 骨架与成品矛盾仍 PASS | 复用 assembler ancestor-exclusion planner；included 集合之外的全部 accepted 内容进入 work Corpus |
| 结构返修后旧内容问题丢失 | 同一缺陷反复漏检 | carry-over concerns 分配到新 Segments，逐项 revalidation disposition |
| 审核预览与最终 Artifact 漂移 | 交付的不是审核对象 | 直接写 Bundle 冻结 preview；记录 assembler version |
| 模型别名重绑到小上下文 | resume/retry 永久超限 | 快照最低能力契约；每次解析前校验；不兼容重绑拒绝 |
| 局部 Reviewer 输入超限 | 永久无法满足强制阅读 | 输入/正文上限；模板与结构最坏包络；Execution 实际 payload 预检 |
| 合法 ReviewDecision 输出超限 | tool call 被截断且 retry 无法修复 | outputLimits 编译最大 JSON 包络；reserved/model output 双校验；Provider 显式 max_output_tokens |
| locator 在 JS/UI/assembler 间漂移 | quote 合法性误判或高亮错位 | 冻结 code-point 半开坐标；保留精确 source text；共享 helper；CJK/emoji/CRLF 测试 |
| LLM 手算长文本坐标不可靠 | 语义正确却因 locator 反复技术失败 | 系统 source chunks + exactQuote resolver + evidence refs；一次歧义修正基准 |
| 强制读取耗尽工具调用或修正轮挤爆上下文 | Reviewer 看全了却无法提交 | 冻结 batch/injected delivery plan；联合 token/tool-call 证明；只允许一次已预留修正 |
| Synthesis Schema 无法覆盖全部 Segment findings | PASS 被禁且 REVISE 永远非法 | Bundle 前做 finding cardinality 可表达性证明；source IDs 计入输出包络 |
| 超长无边界正文使分段不终止 | Bundle 卡死或丢字 | 段落→句界→code-point 硬切；至少前进一步；ownership 无洞测试 |
| Scheduler 重复创建 Review Run | 总预算被重复消费、同目标多审 | review target 唯一键；事务 get-or-create；崩溃恢复测试 |
| Task 总审核预算无模板来源或低于初始路径 | 零返修任务也会中途失败 | 模板显式 maxTaskReviewRuns；发布期初始下界/理论上界；Snapshot 初始化唯一来源 |
| stop/resume 消耗 retry | 生命周期操作导致假性耗尽 | 技术预算只计可计费失败；逐 Operation UoW；Review cycle 总量单独计数 |
| 局部/全局 route 规则混用 | candidate REVISE 被拒或 Repair Wave 为空 | 按 Operation 校验；局部绑定 candidate；全局绑定 current accepted 与非空计划 |
| 旧任务被新协议误调度 | 没有审核定义却被伪装通过 | protocol_version；legacy 只读；启动前锁定；不回填伪审核记录 |
| 结构多代覆盖当前 slots 主键 | 历史丢失或新旧结构混合 | structure_revision_slots + Task 当前指针 + 原子投影切换 |
| 生命周期操作重置审核状态/预算 | 无限重试或迟到结果越权 | 逐 Operation 恢复表、持久预算、数据库 current-pointer Guard |
| 审核 Trace/SSE 泄漏正文 | 候选、证据绕过审核实体 | Review Operation 禁 report_work/public delta；系统枚举进度；回显对抗测试 |
| ProductionEngine 继续膨胀 | 难以维护 | ReviewService、RevisionService、纯 domain 影响计算 |
| FakeProvider 造成假绿 | 语义能力未证明 | 真实 Provider 基准、留出集、返修前后产物证据 |

---

## 21. 需要业务方确认的取舍

本设计已经给出推荐默认方案，但以下取舍在进入实现计划前需要明确确认：

1. 是否接受所有模板强制具备三道审核闸门，首版不提供关闭开关；
2. 是否接受全局审核前只生成预览、全局 PASS 后才创建最终 Artifact；
3. 是否接受上游槽位变化后，系统强制失效全部传递下游，而不是交给 Reviewer 决定；
4. 是否接受首版结构返修通过后全量重跑内容，以匹配当前“完整结构 outline 进入每个填槽上下文”的事实；
5. 是否接受首版任务完成后不可在原任务中重新审核返修；
6. 是否接受审核预算耗尽直接失败，不转人工；
7. 是否接受初始两轮返修上限仅作为基准起点，最终值由真实测量决定；
8. 是否接受 Reviewer 输出只有 `PASS / REVISE`，首版不引入评分和警告态；
9. 是否接受升级前的旧未完成任务只读锁定，需要继续生产时创建 review-v2 新任务；
10. 是否接受全局审核固定采用 Segment → Synthesis，即使短任务只有一个 Segment；
11. 是否接受审核预算耗尽后原 Task 不允许清零 retry，只能新建 Task；
12. 是否接受全局审核在实现上拆成 Segment Reviewer 与 Synthesis Reviewer 两个独立 Agent/Skill 绑定；
13. 是否接受不进入最终 Artifact 的内容型工作槽位也进入全局 Review Corpus；
14. 是否接受最终 Artifact 直接采用审核通过 Bundle 的冻结 preview，不在 PASS 后重新装配；
15. 是否接受首版局部审核不做依赖分段，模板、任务或结构的最大包络超限时提前拒绝；
16. 是否接受 Reviewer 普通文本与自由进度不在 UI/Trace 展示，只展示系统阶段和结构化审核结果；
17. 是否接受所有实际未装配的内容型工作槽位（包括被 false 容器祖先排除的后代）都进入全局 Review Corpus。
18. 是否接受所有审核定位统一使用 Unicode code-point 半开坐标，并拒绝未配对 surrogate，而不是沿用 JavaScript UTF-16 offset；
19. 是否接受首版必需资源按冻结 delivery plan 批量读取/注入、同 Assignment 只预留一次审核提交修正；
20. 是否接受当 Synthesis cardinality、工具调用或单 Segment 最小包络不可满足时，在模板/Bundle 阶段直接拒绝，而不是运行后降级或人工介入。
21. 是否接受模板显式冻结 Task 总 Review Run 上限，且该上限必须至少覆盖最大零返修路径；更高成本上限由业务在理论上界内选择。
22. 是否接受 Reviewer 不直接填写字符坐标，而是通过批量 exact-quote resolver 获取 evidenceRef；内部 code-point locator 仍由系统严格校验和展示。

---

## 22. 文档落地清单

本设计通过后，至少要同步修改：

1. `Forge Core vNext：结构槽原生 Agent 内容生产平台需求规格说明书.md`
   - 删除 Slot Review 非目标；
   - 修订 FR-SLOT-004；
   - 新增结构审核、槽位审核、全局审核、返修和版本要求；
   - 修订完成定义与验收条件。
2. `Forge-Core-vNext-可执行技术实现方案-V1.0.md`
   - 收录 D-21～D-52；
   - 修订状态机、模板、数据模型、Runtime、API、SSE、测试和里程碑。
3. `notes/PROJECT-BRIEF.md`
   - 把“人工审核”改为“审核 Agent 自动审核返修”；
   - 删除“AI 审核不在主线”的旧表述。
4. `Forge Core vNext 核心名词与概念说明.md`
   - 增加候选版本、认可版本、Review Run、Finding、Review Bundle、Repair Wave。
5. `notes/HANDOFF.md` 与 `notes/OPEN-QUESTIONS.md`
   - 更新当前阶段、决议状态、风险和接手顺序。

在这些文档修订完成并通过独立评审之前，不应开始数据库迁移或业务代码实现。
