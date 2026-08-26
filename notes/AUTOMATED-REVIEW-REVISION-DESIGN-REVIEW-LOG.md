# 自动审核返修闭环设计审查日志

开始时间：2026-08-25（Asia/Shanghai）  
审查对象：`notes/AUTOMATED-REVIEW-REVISION-DESIGN-V0.1.md`  
最大轮数：5  
审查模型：gpt-5.6-sol（xhigh，默认速度）
最终结论：Round 4 `VERDICT: APPROVE`（2026-08-26）

本日志记录独立对抗审查的每轮完整结论，以及主 Agent 对每项意见的处理。

## Round 1 — 独立审查 Agent

第一轮结论：整体方向成立，但下面 8 个问题会直接影响数据正确性、恢复能力或审核有效性，当前版本不能进入实施。

### 1. [P0] 缺少旧任务与旧快照的迁移策略

- 依据：设计修改 `TaskPhase`、`SlotStatus`、`Operation`，但迁移只在实施阶段笼统写了 `migrations`。当前 `migrations/001_initial.sql` 对三组枚举都有 CHECK；历史任务的冻结模板也没有审核 Agent、审核 Skill 和审核预算。
- 失败场景：数据库升级后，一个旧的 `stopped/failed/ready` 任务被恢复或重试。若走新引擎，它找不到审核绑定；若补写旧快照，则违反 AC-002；若把历史 `completed` 槽位直接迁成 `approved`，又会把从未审核过的内容伪装成审核通过。
- 修复建议：增加显式 `protocol_version`。新任务使用 review-v2；旧任务按 legacy-v1 只读展示。若不接受双运行时，则迁移前强制断言不存在非终态 legacy 任务，并明确禁止历史失败任务 retry。SQLite 表重建、状态映射、回滚和历史任务读取兼容必须成为 P1-R0/R2 的正式迁移决议。

### 2. [P0] 新结构版本无法落入现有 `slots` 主键模型

- 依据：设计要求结构审核通过后“物化为当前 slots”，全局结构返修还要求保持 Slot ID；但当前 `slots` 主键是 `(task_id, slot_id)`，设计中的 `slots` 本身也没有 `structure_revision_id`。
- 失败场景：第二版结构继续包含 `scene_01`，直接插入会主键冲突；先删除旧 slots 再插入，则历史 Execution、版本 API、父子关系和旧 Slot ID 的含义失去结构代际，且设计没有定义原子切换点。
- 修复建议：增加不可变的 `structure_revision_slots(structure_revision_id, slot_id, ...)`，并在 `tasks` 增加 `current_structure_revision_id`。现有 `slots` 若继续保留，应明确只是“当前结构投影”，在一个 UoW 中完成旧结构 superseded、新结构 accepted、切换 current 指针、失效旧内容版本、重建当前 slots 投影和写 Trace。所有历史查询必须以 `structureRevisionId + slotId` 定位。

### 3. [P0] 停止、恢复、重启状态机没有闭合

- 依据：设计只给出了正常生成/审核迁移，未定义每个 Operation 被停止后的恢复态。当前生命周期对任何带 `target_slot_id` 的执行统一执行 `resetToPending`，启动恢复也采用同类逻辑。
- 失败场景：`review_slot` 运行中被停止，槽位从 `reviewing` 被错误恢复为 `pending`，Resume 后重新调用 Writer，产生重复候选；或者 Review Execution 被 cancelled，但 `review_runs.status` 仍为 running，调度器永远认为审核尚在进行。`review_global` 的 `target_slot_id=null` 更没有任何恢复对象。
- 修复建议：给出按五种 Operation 展开的 stop/restart/retry 转移表。取消事务必须同时收敛 Execution、Review Run，并恢复到准确的 durable 状态。更简单可靠的替代是减少 `SlotStatus` 状态数量，由候选版本和 Review Run 派生“待审核/审核中”，避免生命周期层维护七态回退。

### 4. [P0] `complete_review` 与失效切换缺少可执行的原子守卫

- 依据：设计只说“同一事务校验”，弱于现有 D-10 的“条件写入自身携带全部守卫”。同时没有定义 `current_review_bundle_id`、当前候选指针或完整事务写集。版本失效时如何处理 `accepted_revision_id`、`content_text` 和 producer 投影也未说明。
- 失败场景：Reviewer 预检 Bundle 为当前后，Stop 或新 Bundle 切换，再提交旧 PASS；或者 Repair Wave 只把 `slot_revisions.status` 改为 invalidated，却仍保留 `slots.accepted_revision_id/content_text`，下游读取到已经失效的正文。
- 修复建议：在 Task/Slot 上增加明确的当前指针。`complete_review` 首条写操作必须是带 Execution token、active execution、task running、Review Run running、current target/bundle 条件的 UPDATE；`changes !== 1` 整体回滚并在第二个事务记迟到拒绝。PASS/REVISE 后的 Execution、Review Run、版本指针、投影、Task/Slot 状态和 Trace 必须列出完整 UoW。失效事务必须同时清空当前认可指针和可读投影，不能只改历史版本状态。

### 5. [P1] 分页不能解决全局 Reviewer 上下文溢出，也没有强制“读完才能 PASS”

- 依据：设计把“分页读取”当作超长内容控制。现模板允许最多 32 槽位，每个 scene 最多 8000 字。同一 Agent 会话依次读取分页后，旧页仍留在消息历史中，最终上下文照样增长。
- 失败场景：最大规模任务在读到一半时触发 Provider context limit；或者 Reviewer 根本不调用全部分页工具，直接提交 PASS。当前设计虽“记录读取范围”，但 `complete_review` 的校验条件里没有覆盖率闸门。
- 修复建议：冻结每个审核模型的输入预算，并在创建 Bundle 前做确定性 token/字符预算检查。超限时采用多个独立 Segment Review Execution，再由只读摘要与结构化 segment findings 做最终综合审核。系统维护 read receipts；全局 PASS 前必须验证 manifest、全部必审 segment/slot 和必需 Skill 条款均已读取。最大 32 槽位验收必须包含接近上限的实际正文，而不只是 32 个短槽位。

### 6. [P1] `criterionId` 和证据目前无法被系统真正验证

- 依据：设计要求拒绝不属于冻结 Skill 的 `criterionId`，但当前 Skill loader 只解析 operation、slotTypes、requiredSections 和 `S1` 类章节，任意 Markdown 正文里并不存在机器可枚举的 criterion registry。`findingId`、quote 也完全由模型生成。
- 失败场景：Reviewer 提交一个格式正确但不存在的 criterion，或引用候选中根本没有的 quote；系统只能检查非空，无法兑现“证据有效”和“绑定审核 Skill 条款”。
- 修复建议：在审核 Skill frontmatter 或独立严格 Schema 中声明唯一 `criteria[]`，由 loader 编译并随 Skill 快照冻结。`findingId` 改为系统生成。Evidence 改为带 `sourceKind/sourceId/revisionId/locator/quote` 的类型联合；系统至少验证 source 属于审核目标、locator 合法、quote 与冻结文本匹配。Trace 的标题和摘要使用系统生成的限长文案，不直接采用 Reviewer 自由文本。

### 7. [P1] 返修上下文的来源链和 Finding 传递不完整

- 依据：当前 D-12 明确把重试反馈排除在 `contextHash` 外。设计只写“context-builder 增加返修上下文”，没有修订这一不变量。结构 Reviewer 的工具中也没有 `read_previous_review_findings`；而“结构 finding 优先”时，内容 findings 只被称为结构返修的附加约束。
- 失败场景：两个 Writer Execution 接收了不同全局 findings，却得到相同 `contextHash`；结构生成 Agent 按 finding 改了结构，但结构 Reviewer 看不到原 finding，无法确认是否修复。新结构通过后全部槽位重跑，原内容 finding 又没有传给对应 Writer，问题只能等下一次全局审核重新发现并消耗预算。
- 修复建议：把语义返修与技术重试分开。返修 Assignment 的结构化语义输入必须包含 source Review Run、Finding IDs、previous revision ID、structure revision ID、依赖 revision manifest，并进入 `context_json/contextHash`。结构复审也必须读取直接导致返修的 findings。对于“结构 + 内容”混合 findings，明确可持久化的 carry-over 规则和新旧 Slot 定位策略；无法可靠映射时应拆波次或声明内容 finding 在新结构下重新定位，而不是静默丢失。

### 8. [P1] 预算仍可能被 Stop/Resume/Retry 重置，终止性没有持久化保证

- 依据：设计只列出建议上限和“增加总 Review Execution 上限”，未定义计数键、持久化来源和 Retry 是否重置。当前 RetryBudget 是 `tick` 的内存局部变量，每次重新入队都会新建。
- 失败场景：审核技术失败一次后停止并恢复，或预算耗尽后调用现有 retry，获得一套新预算；反复操作可无限新增 Review Execution，与 D-28“自动流程必然进入 completed 或 failed”冲突。
- 修复建议：所有语义预算和任务总审核预算从持久化实体事务性派生，定义稳定 `budget_scope_key`，例如结构代际、`structureRevisionId+slotId`、task-global。Stop/Resume 不增加预算。明确现有 retry 对审核耗尽任务的语义：推荐不重置语义预算；需要再试时创建新任务。技术重试是否在显式 retry 后重置也要单独写清。

本轮严格只读，没有修改任何项目文件。

VERDICT: REVISE

### 主 Agent 对 Round 1 的处理

结论：8 项意见全部接受，已修改设计文档，未修改业务代码。

1. 增加 D-29、9.1、9.12：所有历史 Task 标记 `legacy-v1` 并只读锁定；新 Task 使用 `review-v2`；不补造旧审核记录；启动监听前收敛旧 running Execution；明确 SQLite CHECK/表重建与升级验收。
2. 增加 D-30、9.3、9.4：引入不可变 `structure_revision_slots`、Task 当前结构指针和 `slots` 当前投影；结构 PASS 用单一 UoW 切换代际、失效旧内容、重建投影。
3. 增加 D-31、10.3、10.5：放弃七态 SlotStatus，保留 P0 四态并从 candidate/accepted/Review Run 派生 UI 状态；对六种 Operation 明确定义 stop、resume、崩溃恢复与 retry。
4. 增加 9.11：定义数据库 current-pointer Guard、`changes=1` 条件、失败回滚后第二事务记录迟到拒绝，以及结构/槽位/Segment/Synthesis 的完整原子写集；失效同时清 accepted/candidate/content/producer 投影。
5. 增加 D-33、8.4、9.7：全局审核改为冻结输入预算下的独立 Segment Review，再由 Synthesis Review 汇总；增加 coverage、read receipts、受证据约束的 synthesis facts 和最大 32 槽位近上限规模闸门。
6. 增加 D-34、6.2、7.2–7.3、9.6：审核 Skill 使用严格 Criteria Registry/必读 Section；finding ID 由系统生成；Evidence 使用带来源/版本/locator/quote 的类型联合并逐项验证；Trace 摘要由系统生成和截断。
7. 增加 D-35、8.2、8.5、12.5：语义返修来源链正式写入 `context_json`；结构 Reviewer 可读来源 findings；混合结构/内容 finding 中，旧内容意见标记 `requires_revalidation`，在新结构上重新取证后才能再次路由。
8. 增加 D-32、9.9、13：预算使用稳定 scope key 持久化并条件消费；stop/resume/retry/重启均不得重置；预算耗尽后拒绝原 Task retry，只能创建新 Task。

请同一独立审查 Agent 基于上述实际修改重新审查，不把“已回应”视为“已解决”。

## Round 2 — 独立审查 Agent

Round 2 结论：Round 1 的第 1–4、6 项已基本闭合；第 5、7、8 项仍有未闭合部分。当前版本不能进入实施，主要剩余问题如下。

### 1. [P0] 一个全局审核绑定无法同时匹配两种 Operation

- 依据：§6.1 的 `globalReview` 只有一个 `skillId`；§7.1 又定义 `review_global_segment`、`review_global_synthesis` 两种 Operation；审核 Skill frontmatter 只有单值 `operation`。当前 `skill-loader.ts:49` 也是单 Operation，`template-loader.ts:413-428` 会校验 Skill Operation 与绑定精确相等。
- 失败场景：`chapter-global-review` 无论声明哪种 Operation，另一个阶段都无法通过模板编译；若放宽校验，则 Segment 与 Synthesis 会获得错误的 Criteria、工具权限或提交协议。
- 最小修复：把 `globalReview` 拆成 `segment`、`synthesis` 两个显式子绑定，各自冻结 Agent/Skill/Operation；可以复用模型，但必须分别校验。或者正式引入与 Execution Operation 正交的 `review_global` Skill Operation，并给出确定映射规则。

### 2. [P0] 全局审核仍未覆盖全部认可内容

- 依据：§8.4、9.7 只要求 Segment 连续完整覆盖 `artifact_preview`。现有模板的 `chapter_outline` 是 `contentBearing:true`、`includeInArtifact:false`，因此不会进入预览；`read_structure_outline` 只返回结构概要，不等于工作槽位正文。Synthesis 也只能读取 Segment 结果，不能读取该正文。
- 失败场景：章节骨架与最终场景内容矛盾，但全局 Reviewer 从未看到骨架正文，却仍可给整个 Bundle `PASS`，违反“覆盖所有认可槽位版本”的目标。
- 最小修复：定义独立的 `review_corpus`，包含 Artifact 预览以及所有未进入 Artifact 的 content-bearing 认可版本。Segment coverage 和 receipts 必须覆盖整个 corpus，而不只是 Artifact 字符区间。

### 3. [P1] 技术重试的持久化身份仍自相矛盾

- 依据：§9.5 声明“一条审核 Assignment 对应一条 Review Run”，且只有单个 `execution_id`；§13.1 又把审核技术重试绑定到同一个 Review Round。生成技术重试声称绑定候选版本，但生成失败时候选版本尚不存在。§9.9 的预算 key 又只有结构、槽位、全局稳定 scope，无法区分不同语义候选的技术尝试。
- 失败场景：新候选继承上一轮已经消耗的技术失败次数；或者技术 retry 新建 Review Run 后重新获得配额；又或者同一 Review Run 重试时覆盖 `execution_id`，丢失前一次 Execution 关系。
- 最小修复：引入持久化 `generation_cycle/work_item` 和 `review_cycle`。一个 cycle 对应一个语义目标并拥有多个 Execution attempts；技术预算按 cycle 计数，语义预算和任务总上限按稳定 scope 计数。还应明确 Segment 的 `REVISE` 只是“完成且有 findings”，不能在 Synthesis 前消费一次全局语义返修预算。

### 4. [P1] 局部 Reviewer 仍可以不读目标正文就 PASS

- 依据：§7.3 的强制校验只要求必读 Skill Section receipt；只有全局 Segment 明确要求目标内容 receipt。`review_read_receipts` 虽支持 `revision`，但没有把局部目标 revision 的完整读取列为 `complete_review` Guard。
- 失败场景：Reviewer 读取必需 Skill Sections 后，未调用 `read_slot_candidate` 或 `read_structure_candidate`，直接提交字段齐全的 PASS，系统仍可接受。
- 最小修复：建立按 Operation 的强制读取矩阵。结构/槽位审核必须存在当前目标 revision 的完整 receipt；若正文直接注入初始上下文，则由系统记录不可伪造的 `context_injected` receipt，并验证注入版本就是当前目标。依赖内容也应按冻结 Criteria 要求强制覆盖。

### 5. [P1] 混合 structure/content finding 的重新取证仍无法执行

- 依据：§12.5 只把旧内容关注点传给下一次 Synthesis；但 Synthesis 工具集不能读取新正文，只能读 Segment results/findings/facts。Segment Reviewer 又没有收到这些待复核关注点。
- 失败场景：结构重做后，旧内容问题在新内容中仍存在，但 Segment 没被要求复核，也没有产生新 evidence；Synthesis 无法自行读取正文取得合法证据，只能静默丢失问题或错误标记已解决。
- 最小修复：把待复核关注点确定性路由到覆盖相关新内容的 Segment，或创建专用 revalidation Segment。Segment 必须返回 `resolved` 或带新版本 evidence 的新 finding；Synthesis 只消费这个复核结果。

### 6. [P1] 最终 Artifact 不保证与审核过的预览字节一致

- 依据：Bundle 保存 `artifact_preview`，但 §9.11 的 Assembly Guard 只核对版本 manifest。当前 `assembly-service.ts:120` 会重新调用 assembler，再把新结果写入 Artifact。
- 失败场景：Synthesis PASS 后发生重启或部署，assembler 实现改变但版本名没有同步更新；最终 Artifact 虽由相同槽位版本生成，正文却不再是 Reviewer 实际审核的预览。
- 最小修复：通过 Guard 后直接使用 Bundle 中冻结的 `artifact_preview` 创建 Artifact；或者重新装配后与该预览逐字比较，不一致即拒绝 Assembly。Assembler 实现版本也应进入快照和 Bundle。

### 7. [P1] 冻结输入预算与模型别名晚绑定不兼容

- 依据：设计保留 D-03，每次 Execution 都重新解析模型别名；Bundle 却冻结 `maxEstimatedTokens`。当前 Provider 配置只声明模型名称，没有上下文窗口、工具开销或输出预留等能力契约。
- 失败场景：任务创建后将全局审核别名切到上下文更小的模型；已经冻结的 Segment 对旧模型合法，对新模型超限，stop/resume 或技术 retry 后持续失败。
- 最小修复：给模型别名增加最小上下文能力契约，并在模板加载、Bundle 创建和每次晚绑定解析时校验：Segment 输入、系统提示、工具消息、输出预算及安全余量之和不得超过能力下限。不兼容的别名重绑必须被拒绝。

另有一个较小但明确的实施适配缺口：§6.2 示例使用 `rubric` 等命名 Section，而当前 `skill-loader.ts:55-57` 只接受 `^S\d+$`。设计应明确扩展 Section ID 语法，或把示例改为现有 `S1/S2` 体系。

本轮严格只读，未修改任何文件。

VERDICT: REVISE

### 主 Agent 对 Round 2 的处理

结论：7 项问题与 Section ID 适配意见全部接受；其中第 3 项在审查返回前已写入磁盘，随后继续补齐其事务与测试语义。未修改业务代码。

1. 增加 D-36 并改写 6.1：`globalReview.segment` 与 `globalReview.synthesis` 使用两个独立 Agent/Skill/Operation 子绑定，继续执行 Skill 单 Operation 精确校验。
2. 增加 D-37 并改写 8.4、9.7：引入完整 Review Corpus，覆盖 Artifact preview 与全部 `contentBearing=true && includeInArtifact=false` 的认可正文；coverage manifest 必须覆盖每个 accepted revision。
3. 改写 9.1、9.4、9.5、9.9、9.10、10.5、13.1：generationWorkId 与 Review Run 是持久技术 cycle；一个 Review Run 对应多个 Execution attempts；技术/语义预算分 scope；Segment REVISE 只累积 findings，只有 Synthesis REVISE 消耗 global 语义预算。
4. 在 8.1 增加按四类审核 Operation 的强制读取矩阵；系统为工具读取或 Context 注入生成不可伪造 receipt，局部 target/dependency 未完整覆盖时任何 verdict 都拒绝。
5. 扩展 7.2、7.3、8.4、9.6、12.5：carry-over concern 分配到新 Corpus Segment；每段逐项返回 not_observed/reissued 和新 evidence；Synthesis 收齐后才写 resolved/reissued disposition。
6. 增加 D-38 并修改 9.7、9.11、11.3：Bundle 冻结 assembler version；Assembly Guard 通过后直接把已审核 `artifact_preview` 写入 Artifact，不重新装配。
7. 增加 D-39 并修改 6.1、8.4、9.7：Provider/model 声明能力；Snapshot 冻结最低要求；配置加载、Bundle 创建、每次晚绑定均校验；不兼容重绑不激活，冷启动不开 Scheduler。
8. 6.2 示例恢复使用现有 `S1/S2/S3` 与 `^S\d+$` 约束，不在本阶段顺带扩 Section ID 语法。

同时补充最坏 Synthesis 输入包络检查、对应错误码、集成测试与验收条件。请同一审查 Agent 以磁盘最新全文重新进行 Round 3。

## Round 3 — 独立审查 Agent

Round 3 结论：Round 2 的双绑定、Review Corpus 主路径、generationWorkId/ReviewRun 一对多 Execution、carry-over 重新取证、冻结 preview、模型能力契约、S1/S2/S3 适配均已落入最新文档；本轮中发现的跨 Execution receipt 复用问题也已在磁盘版本修正。

仍有以下实质阻塞问题。

### 1. [P0] `complete_review` 的成功事务仍未收敛 Execution 和 Task 活动指针

- 依据：§9.11 的六类提交写集合均未包含“当前 Execution → succeeded”和“`tasks.active_execution_id → null`”。现有 `completion-service.ts:313-317` 与 `structure-service.ts:236-294` 明确把这两项放在提交事务内。
- 失败场景：Review Run 已 passed/revision_requested，但 Execution 仍为 running、Task 仍被活动指针占用；下一 Assignment 被互斥守卫拒绝。此时 stop/restart 还可能把已经生效的审核 Execution 标成 cancelled/stale。
- 最小修复：所有合法审核提交的 UoW 都必须同时标记当前 Execution succeeded、清 Task 活动执行指针、完成 Review Run/目标领域写入并写 Trace；提交闸门只在事务成功后关闭。增加“审核提交后立即调度下一动作”及“提交与 stop 竞态”测试。

### 2. [P0] 技术失败、stop/resume 与技术预算消费规则仍互相冲突

- 依据：D-32 规定 stop/resume 不增加预算；§10.5 又要求 resume 在同一 work/run 下创建新 Execution；§9.9、9.10 则写成创建/切换 Execution 时同步消费技术预算。文档也没有六种 Operation 在技术失败“仍有预算/已耗尽”时的原子转移表。
- 失败场景：若每个新 Execution 都消费预算，用户 stop/resume 会无故耗尽重试；若 resume Execution 不消费但技术失败路径也没有明确消费点，则可无限重试。Review Run、Segment 或 Task 也可能停在 running/pending 的组合态而无人继续调度。
- 最小修复：明确技术预算统计的是“可计费技术失败”而非 Execution 数。逐 Operation 给出四类 UoW：首次执行、失败且有剩余预算、stop/崩溃替换执行、预算耗尽；明确每类对 Execution、Review Run/generationWork、Segment、Slot、Task 活动指针和 Trace 的写入。任务总 Review Execution 上限与技术失败预算应分开定义。

### 3. [P0] 局部审核没有输入预算，合法任务可能永远无法完成强制读取

- 依据：只有 global Segment/Synthesis binding 定义了 `inputBudget`。§8.1 却要求结构审核完整读取任务输入，槽位审核还可能完整读取全部依赖正文。当前 `inputFields` 没有长度上限，槽位 `maxChars` 也是可选；最多 32 个槽位可形成大规模 dependency fan-in。
- 失败场景：一个合法任务输入很长，或后部场景依赖多个 8000 字场景。Reviewer 必须读完才能提交，但同一会话读完后超过模型上下文；反复技术重试只能持续失败。D-39 的静态“模型最低能力”不能证明实际 Assignment 内容可容纳。
- 最小修复：给结构/槽位审核也增加冻结输入预算和实际 payload 预检；为任务输入与内容槽位建立可计算上限，并在模板发布、任务创建或结构接受前拒绝不可满足的最大包络。若必须支持超大依赖集合，则需要专门的局部依赖分段协议，不能依赖顺序调用读取工具。

### 4. [P1] Synthesis “最坏输入包络”仍不是封闭计算

- 依据：§8.4 只提到 `maxFindings/maxFacts/maxEvidenceChars`，但 `ReviewDecision` 中的 `summary`、`problem`、`revisionInstruction`、`acceptanceCriteria` 数量及单条长度没有上限；carry-over concerns/results 的最坏数量与文本也未纳入公式。示例 Skill frontmatter 也没有这些限制字段。
- 失败场景：每个 Segment 输出都低于自己的输出上限，但 20–30 个 Segment 的 problem、返修指令和验收条件汇总后远超 Synthesis 上下文，和“Bundle 创建前即可证明不会溢出”的承诺冲突。
- 最小修复：为所有变长字段定义并冻结严格上限，`complete_review` 在入库前拒绝越界；包络公式必须包含 manifest、findings 全字段、facts、source IDs、revalidation 矩阵、Skill/系统提示和必要任务输入。增加边界值及最坏组合测试。

### 5. [P1] Reviewer 自由文本仍可绕过 Trace/SSE 脱敏边界

- 依据：四类 Reviewer 工具集仍包含 `report_work`。当前 `report-work.ts:33-42` 会把模型的 `summary` 原样写入 Trace；`agent-runtime.ts:101-105` 还会把普通文本 delta 推向 SSE并最终形成 `public_output_chunk`。这与 §14.2–14.3“不记录完整候选、完整 findings/evidence”的要求冲突。
- 失败场景：Reviewer 在工具提交前复述候选正文、证据或完整审核意见，这些文本绕过专用审核实体，直接进入 Trace、SSE 和导出。
- 最小修复：为审核 Operation 禁止持久化/推送自由文本 delta；移除 Reviewer 的自由文本 `report_work`，或改成枚举化进度事件并由系统生成固定摘要。增加 Reviewer 故意回显候选和 evidence 的脱敏测试。

### 6. [P1] Review Corpus 的工作槽位判据与现有“排除整棵子树”语义不一致

- 依据：D-37 和 §8.4 只把自身 `includeInArtifact=false` 的内容槽位加入 work entries；但当前 `assembly.ts` 明确规定任一祖先为 false 时整棵子树都不进入 Artifact。模板允许 `includeInArtifact=false` 的容器。
- 失败场景：内容槽位自身为 true，但祖先容器为 false。它既不在 Artifact preview，也不满足当前 work-entry 条件，导致 coverage 永远无法闭合。另一个允许的结构是全部内容都属于工作区，此时 preview 为空；新 Assembly 直接写冻结 preview，可能绕过现有 Assembly 对空产物的拒绝。
- 最小修复：先使用与 assembler 完全相同的遍历得到“实际进入 Artifact 的 revision 集合”，其余所有 accepted content revisions 都作为 work entries，不根据槽位自身 flag 猜测。Bundle 创建还必须拒绝空 `artifact_preview`，保留当前 `ASSEMBLY_FAILED` 非空产物约束。补 false-container 子树和全工作槽位测试。

### 7. [P1] 全局返修目标没有验证是否可被实际返修

- 依据：§7.3 只要求目标槽位存在于当前结构，没有要求 `slot/cross_slot` 目标是 content-bearing 且拥有当前 accepted revision。当前结构必然包含没有正文的容器根。
- 失败场景：Synthesis 合法提交 `scope=slot,targetSlotIds=[chapter]`。容器没有可失效版本，单槽路由又不会像 subtree 那样展开后代，最终 Repair Wave 为空或重复审核同一 Bundle，直至预算耗尽。
- 最小修复：`slot/cross_slot` 目标必须是当前结构中 content-bearing、具有 accepted revision 的槽位；`subtree` 可指容器，但展开后必须至少得到一个内容槽位；`structure` 应固定不接受内容目标。空失效集合必须在提交阶段作为 `REVIEW_ROUTE_INVALID` 拒绝。

本轮严格只读，未修改任何文件。

VERDICT: REVISE

### 主 Agent 对 Round 3 的处理

结论：7 项问题全部接受并修改设计；未修改业务代码。

1. 增加 D-40 并改写 9.11：`complete_review` Guard 包含 `tasks.active_execution_id`；所有合法 verdict 与领域写入同事务执行 `Execution→succeeded`、清 active pointer、结束 Review Run、写 Trace；明确与 stop 竞态只有一方生效。
2. 改写 D-32、9.9、9.10，并新增 10.6：retry 只计可计费技术失败，首次派发/stop/resume/stale 不消费；任务总量改计 Review Run cycle；对六种 Operation 给出首次、失败可重试、stop/crash、失败耗尽的 UoW 与领域投影。
3. 增加 D-41 并改写 6.1、11.1：结构/槽位 review binding 同样冻结 inputBudget；Task input、Slot maxChars、结构字段/依赖有上限；模板发布、Task 创建、结构接受做最大包络，Execution 派发做实际 payload 预检；首版拒绝超限而不做局部依赖分段。
4. 扩展 6.2 `outputLimits` 与 7.3/8.4：为 ReviewDecision 每个变长字符串/数组/evidence/fact/revalidation 字段设冻结上限；Synthesis 包络纳入任务输入、全部字段、carry-over 矩阵、Schema framing、提示/工具和输出余量。
5. 增加 D-42 并改写 8.1、14：Review Operation 不注册 `report_work`，普通 delta 使用 suppress；进度和 tool Trace 使用固定系统事件，禁止通用 `firstLine(tool result/error)`，防止读工具首行泄漏正文。
6. 增加 D-43 并改写 D-37、8.4、9.7：Review Corpus 复用冻结 assembler 的祖先排除 membership planner；实际 included 集合之外的全部 accepted 内容进入 work Corpus；空 preview 继续 `ASSEMBLY_FAILED`。
7. 改写 7.3、12.1–12.3：slot/cross 只接受 current accepted 内容槽位；subtree 可指容器但展开必须非空；structure 不带内容目标；最终失效集合为空时提交阶段返回 `REVIEW_ROUTE_INVALID`。

测试、模块影响、风险、实施阶段和 AC-R-030～036 已同步。请同一审查 Agent 以磁盘最新版本进行 Round 4。

## Round 4 — 独立审查 Agent

Round 4 采用“发现即修订、同一审查 Agent 继续重读”的方式进行。审查过程中提出并验证闭合了以下问题：

### 1. [P0] 局部 candidate REVISE 被全局 route 规则误拒绝

- 问题：统一 route 校验要求内容目标已有 accepted revision 和非空失效集合，但局部 `review_slot` 正在审核的 candidate 尚未 accepted。
- 修订：§7.3 改为按四种审核 Operation 分表校验。局部结构/槽位只 reject 当前 candidate 并创建下一 generation work；Segment 只形成建议路由；只有 Synthesis 计算最终 Repair Wave。

### 2. [P0] 结构返修的失效时点前后冲突

- 问题：Synthesis structure REVISE 若立即清空旧内容，Structure Agent/Reviewer 又需要旧结构和内容作为返修来源；若不清，Scheduler/Assembly 可能继续交付旧版本。
- 修订：Repair Wave 只记录 `planned_invalidated_slot_ids` 和 `on_structure_pass`；旧 accepted 数据作为只读返修来源，禁止调度/装配；新结构 PASS 的切换事务才应用全量失效并重建投影。

### 3. [P1] 输出预算、示例值与 Synthesis 可表达性未闭合

- 问题：原 outputLimits 示例在 `reservedOutputTokens=4000` 下自相矛盾；只证明 token 也不能保证 Synthesis 的 `maxFindings × maxSourceFindingIds` 足以覆盖全部 Segment findings。
- 修订：用紧凑的 local Skill 示例并声明必须经 estimator 编译；Provider 显式设置冻结 max output；增加 D-47，Bundle 创建前证明 `segmentCount × segment.maxFindings <= synthesis.maxFindings × synthesis.maxSourceFindingIds`，否则返回确定性不可表达错误。

### 4. [P1] 文本坐标协议在 UTF-16、code point、换行与 assembler 间漂移

- 问题：JS slice、Unicode 字符计数、CRLF→LF 与 trim 会让 locator/quote/receipt 使用不同坐标；长结构 scalar 也无法在 quote 上限内整值引用。
- 修订：增加 D-44，内部统一 `unicode-code-point-v1` 半开区间、冻结 source text 与共享 helper；结构 pointer 只指 scalar，长字符串允许 scalar 内区间；Corpus entry、Segment ownership、receipt、API/UI 使用同一坐标版本。

### 5. [P1] 强制读取、工具调用上限与同轮修正没有联合证明

- 问题：31 个依赖、多 Segment Synthesis、必读 Skill Sections 和 `complete_review` 修正可能在 token 仍够时先耗尽 24 次工具调用；首次非法 arguments/错误消息还会占据第二次提交上下文。
- 修订：增加 D-45，冻结 `resource_delivery_plan`；必读 Sections 批量读取，目标/依赖/Segment/Synthesis 资源默认经预检注入；静态包络覆盖 required/optional calls、两次 evidence resolver、首次与一次修正提交及全部消息 framing；第二次仍非法才进入可计费技术失败。

### 6. [P1] Corpus splitter 对无段落超长正文不保证终止

- 问题：只按段落边界切分时，单个超长段没有合法切点。
- 修订：增加 D-48，冻结段落→句界→Unicode code-point 硬切 fallback；每次至少前进一个 code point，ownership 无洞无重叠，overlap 只读；最小单元仍放不下则在 Provider 前拒绝。

### 7. [P1] Review Run 创建缺少数据库幂等约束

- 问题：Run 已创建并消费总预算、Execution 尚未派发时崩溃，重复 tick 可能再建 Run、重复消费。
- 修订：增加 D-49，对 `(review_target_kind, review_target_id)` 建唯一键；Run 与总预算使用事务 get-or-create，只有成功插入才消费，结构/槽位/Segment/Synthesis 统一走该路径。

### 8. [P1] 生成校验 trim 后正文、仓储却保存 raw 正文

- 问题：大量首尾空白可绕过 `maxChars`，入库 raw candidate 又击穿局部审核包络；CRLF 还会与 assembler 产生第二份正文。
- 修订：增加 D-50。先校验 `rawSubmissionMaxCodePoints`，再以 `canonical-slot-content-v1` 执行 CRLF/CR→LF 和冻结 trim；`maxChars`、revision、Reviewer、Corpus、assembler 只使用同一规范正文。

### 9. [P1] 事务表未写全下一 TaskPhase

- 问题：Synthesis slots route 清了 accepted 投影却可能仍停在 `global_review`。
- 修订：增加 D-46 并补齐 §9.11；structure/slot 局部结果和 Synthesis structure/slots 两条 route 都在审核提交 UoW 中写明确 TaskPhase，预算耗尽写 failed。

### 10. [P1] Task 总 Review Run 预算没有模板来源

- 问题：实现不知道 `task_review_cycle_total.limit_value` 从哪里初始化，过小值会让零返修任务也失败。
- 修订：增加 D-51 与 `reviewLimits.maxTaskReviewRuns`、`globalReview.maxSegments`；模板发布证明零返修下界并展示理论上界，Snapshot 是 Task budget 的唯一初始化来源。示例加入 `maxSegments:32`、`maxTaskReviewRuns:512`。

### 11. [P1] Global Segment 没被强制读取 Task input

- 问题：Synthesis 不读正文，Segment 若不读任务目标，整段内容偏题仍可能合法 PASS。
- 修订：每个 Segment required/injected resources 明确包含冻结任务输入，并计入预算与 receipt；缺 receipt 的 PASS/REVISE 都拒绝。

### 12. [P1] LLM 手算 code-point locator 不具真实可用性

- 问题：模型很难对长 CJK/emoji 正文可靠填写精确 start/end，一次修正仍可能因格式而失败。
- 修订：增加 D-52。系统提供 Execution-scoped source chunks；Reviewer 批量提交 `sourceChunkId + exactQuote + occurrence?`，resolver 生成数据库 evidenceRef；finding/fact 只提交 ref，不提交坐标。重复 quote 有一次歧义修正，raw locator、伪造、旧 Execution 与跨 Bundle ref 均拒绝。

### 13. [P1] Evidence ref 的持久化、外键与容量不完整

- 问题：只在文字中提 resolver，无法实现其事务、幂等、Synthesis 复用和旧 ref Guard；resolver 上限还漏算 PASS 时的 synthesis facts evidence。
- 修订：§9.6 增加 `review_source_chunks`、`review_evidence_refs`、幂等批次键、finding/fact evidence 外键关联和生命周期规则；去除重复 `evidence_json` 真相；resolver batch 容量按 findings evidence + facts evidence 编译并预留两批。

### 14. [P1] 新协议错误码没有进入共享边界

- 问题：correction exhausted、Synthesis unrepresentable、Segment unsatisfiable 和 evidence resolver 分支若不进入 shared ErrorCode/DTO/PublicError，就无法按设计编码。
- 修订：§13.3 补齐全部错误码、是否消耗技术 retry 的分类及 API/CLI 测试要求。

### 15. 文档同步与规模边界

- 修订：所有落地清单统一到 D-21～D-52；规模测试纠正为 1 个容器根 + 31 个内容槽位；模块影响、风险、R0–R7、42 条 Engine 路径和 AC-R-001～050 全部同步。

审查 Agent 对最新全文再次检查后，未发现剩余 material blocker。其最终结论如下：

- 六种 Operation 的成功、失败、停止与恢复事务完整，提交 Guard、活动指针、Review Run、领域状态与 Trace 同事务闭合；
- 技术预算、语义预算、Task 总 Run 预算、静态/实际输入输出包络、工具调用、一次修正与 Synthesis finding 容量均可证明；
- Review Corpus/assembler、planned invalidation、冻结 preview、模型晚绑定与脱敏边界一致；
- canonical content、code-point locator、终止性 splitter、carry-over 重新取证和 evidence resolver 都有持久化、Guard、测试与验收落点；
- 剩余工作属于实现与真实 Provider 能力验收，不再是设计阻塞。

本轮审查 Agent 严格只读；主 Agent 仅修改设计文档与本日志，未修改业务代码。

VERDICT: APPROVE

### 主 Agent 对 Round 4 的处理

结论：审查过程中提出的 15 组问题全部接受并写入设计；同一独立审查 Agent 基于最新磁盘全文复核后正式批准。设计文档当前以 D-21～D-52、AC-R-001～050 为冻结候选，可以进入 P1-R0 的业务取舍确认、基准冻结和权威文档同步；该批准不代表尚未实现的代码或 Reviewer 质量已经验收通过。
