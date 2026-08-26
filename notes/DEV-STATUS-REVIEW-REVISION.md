# 审核返修（R0–R4）开发进度报告

> 写于 R2 开发完成后、对抗性审查前。供中断恢复用。
> 实施依据：`notes/REVIEW-IMPLEMENTATION-PLAN-R0-R4.md`（主）、
> `notes/AUTOMATED-REVIEW-REVISION-DESIGN-V0.2.md`（D-21…D-32、AC-R-001…017）。

## 一、总体进度

| 阶段 | 内容 | 状态 |
|---|---|---|
| **R0** 数据模型 | 迁移 003、枚举同步、状态机、仓储方法 | ✅ 完成并验收，**已提交 `de3386b`** |
| **R1** domain 纯函数 | `verifyFindings` / `settleReview` / `renderRevisionContext` + `stripReasoning` | ✅ 完成并验收，**已提交 `69a2359`** |
| **R2** Operation+引擎+trace+前端 | 迁移 004、调度/引擎 review 分支、结算落库、4 个新 trace、前端 §7 | ⚠️ **开发完成，未审查、未验收、未提交**（改动全在工作区，25 改 + 4 新） |
| **R3** 上下文连续性 | D-31 填槽连续 / D-32 审核无状态，AC-R-013…017 | 未开始 |
| **R4** 审核 Skill+绑定+端到端 | FR-TPL-003 校验、`skills/scene-review`、scene 绑定、probe 回归 | 未开始 |

基线数字：R0 前 716 测试 → R1 后 771 → R2 开发自报 786（**待我复验**）。
四条命令（typecheck/lint/test/test:coverage）在 R0、R1 交付时均全绿，
`src/server/domain/**` 覆盖率 100/100/100/100。

## 二、R2 工作区现状（未提交，29 个文件）

**新建**：
- `migrations/004_review_unique.sql` —— 去掉 executions 表级 UNIQUE，
  改建部分唯一索引 `UNIQUE(task_id, target_slot_id, attempt_number) WHERE operation='fill_slot'`
  （业主已批准的方案：多判据 review execution 不再撞键，review 行唯一性由 `slot_reviews` 主键兜底）
- `tests/fixtures/skills/scene-review/`、`tests/fixtures/templates/review-chapter/` —— R2 测试夹具
- `tests/integration/r2-review-revision.test.ts` —— AC-R-001…012 验收测试

**修改（要点）**：`slot-scheduler.ts`（review/review_settle 分支，排在 assembly 前）、
`production-engine.ts`（review 与结算分支）、`completion-service.ts`（review 提交 + D-10 同闸门）、
`lifecycle-service.ts`（审核期 stop/孤儿 → `cancelReview`）、`slot-repo.ts`（新增 `cancelReview`）、
`trace.ts`（4 个新 kind）、`template-schema.ts`/`template-loader.ts`（`reviewSlotByType`、
`maxRevisionRounds` 默认 2 的 schema 表面）、`presentation.ts`（§7.3 状态派生行）、
`contracts.ts`/`task-service.ts`（SlotView 加 `revisionRound`/`reviewExhausted`）、
前端 `TaskWorkbench.tsx` 等（§7 过滤组/进度/聚焦）、`tools.ts`/`complete-assignment.ts`（review 载荷）。

**开发 agent 自报**（未经独立验证）：四条命令全绿；11 条 AC 测试；
为测审核中间态把夹具从阻塞式 `start` 改成 `dispatch('start')` + `waitFor` + `stop/drain`；
`template-catalog.test.ts` / `m5-readonly-endpoints.test.ts` 因新增夹具模板而更新。

## 三、关键设计裁定（恢复工作时必须继承）

1. **迁移事务内重建**：`PRAGMA foreign_keys=OFF` 在 migrate.ts 的事务里是 no-op，
   重建用「临时名 + FK 指向临时名 + `active_execution_id` 暂存置 NULL 再恢复 + RENAME 回填」。
   004 必须沿用同一手法，并重建被 DROP 连带删除的索引。
2. **R2/R4 切分**：schema 表面（`reviewSlotByType`/`maxRevisionRounds`）R2 已落；
   **FR-TPL-003 校验规则、正式审核 Skill、scene 绑定、端到端归 R4**。
3. **判据机制**：审核 Skill 的章节 = 判据（S-ID，按 section_index 顺序）。
4. **`cancelReview` ≠ `markForRevision`**：stop/孤儿走前者（不递增轮次、内容保留）；
   结算 revise 走后者（同一条 SQL 递增 `revision_round`，结算事务里**没有**第二个递增步骤）。
5. **措辞铁律（D-30）**：任何输出不得出现「审核通过/质量合格/已校验」，统一「未检出问题」；
   「已完成（返修次数用尽）」不得用警示色。
6. 每阶段一个提交；现有断言不许变红（夹具模板引起的两处既有测试更新是 R2 待审点之一）。

## 四、下一步（按序）

1. **R2 对抗性审查**（独立审查 agent，只读）：
   重点——004 迁移在全新库与 M4 副本上的完整性（含索引）；结算事务原子性与无双倍递增；
   review 与 fill 共用 D-10 闸门（迟到结果同路径拒绝）；调度 reviewing 分支在 assembly 之前；
   返修不消耗 attempt/maxRetries；`cancelReview` 不碰内容与轮次；AC-R-002 单判据 prompt；
   AC-R-010 前后端措辞断言；两处既有测试（template-catalog / m5-readonly）的更新是否只是夹具适配；
   `dispatch('start')` 夹具改造有没有掩盖真实的时序问题。
2. **我验收**：亲跑四条命令；独立复验 004（M4 副本 + 全新库）；抽查反证记录真实性（红测复现）。
3. **提交 R2**（一个提交，格式仿 `de3386b`/`69a2359`）。
4. **R3**：重读实施文档 §5——返修轮 DeterministicContext 接 `renderRevisionContext`
   （D-31：显式可复现，非活会话；`reasoning_content` 剥离，AC-R-014 已在 R1 落纯函数）；
   审核 prompt 每轮全新（D-32，AC-R-016）；AC-R-013…017。
5. **R4**：重读 §6——模板编译期校验（判据唯一等）、`skill-loader` superRefine、
   `skills/scene-review/SKILL.md`（四条判据全上线，照抄 scene-writing）、
   `templates/zhihu-chapter` 绑定 scene、probe 回归脚本化（门槛：判据一二召回 3/3、
   16 正例误报 0；基线：判据三四记录 0/3 不设门槛）。
6. 全部完成后总交付报告（四命令输出、反证记录、偏离、未修问题）。

## 五、已知未修问题（累积清单）

- `countByStatus` 全库零调用方（业主明示本轮不碰，结束后单独清理）。
- 索引断言只查名不查列（现状正确，建议后续加强）。
- `structure-service.ts:262` 既有注释含「已校验」（既有代码、非审核输出，仅记录）。
- `eslint.config.js` 的 `probe/**` 忽略是基线修复（业主已批），与数据模型无关。

## 六、硬约束提醒（恢复工作的任何会话）

- 不 commit 除非到了阶段交付点（每阶段一提交，信息仿现有两条）。
- `data/*.sqlite` 原件只读（`m4-*`/`m7-*` 是唯一实测数据副本）；迁移验证一律用**副本**。
- `probe/` 既有脚本与结果不碰（R4 回归基线）。
- 不写 API Key；`.env` 存值、`config/providers.yaml` 只放环境变量名。
- 每条关键断言先「改坏产品代码看红」再恢复，交付时逐条报告。
- 开发/审查走 subagent，主会话负责调度与验收。
