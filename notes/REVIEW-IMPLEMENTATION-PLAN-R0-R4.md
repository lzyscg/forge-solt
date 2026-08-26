# 审核返修 — 开发实施文档（R0–R4）

> **给实施者**：你可能没有此前的对话上下文。本文档自带全部前提，
> 详到「只差敲代码」。所有文件路径、行号、类型签名、SQL 都已对照当前仓库核准过。
>
> **上位文档**（有冲突时以它们为准，且**它们已经改完了**）：
> - 设计：`notes/AUTOMATED-REVIEW-REVISION-DESIGN-V0.2.md`（决策 D-21…D-32、验收 AC-R-001…017）
> - 需求：REQ 的 §7.1、FR-REVIEW-001..004、FR-TPL-002/003、FR-CTX-002/005、FR-SLOT-004/005、NFR-005
> - 实测依据：`notes/R0.5-REVIEWER-PROBE-REPORT.md` 与 `notes/R0.5-ADDENDUM-PROMPT-ARCHITECTURE.md`
>
> **动手前必读**：本文档 §0 的四条纪律。它们不是客套话，
> 违反其中任何一条都会让这次改动看起来通过而实际是坏的。

---

## §0 四条纪律

### 0.1 每条断言必须先看着它失败（项目规矩 3.4）

写完一条 `expect`，**先去把产品代码改坏**，确认这条断言变红，再改回来。
没红过的断言就是装饰。本文档在多处标了「**必须反证**」，那些是最容易写成装饰的地方。

### 0.2 文档先行已经做完，不要再改需求

REQ、术语表、技术方案、UI Spec 都已经改到位。
你**遇到与文档冲突的情况时先停下来报告**，不要自行改文档迁就实现。

### 0.3 不要顺手重构

已知仓库里有三处枚举重复（Zod / SQL CHECK / domain 表）。**本次不消除它。**
重构混进来会让这次的 diff 没法审。

### 0.4 分层由 ESLint 强制

`shared ← domain（纯函数，零 IO）← application ← runtime/infrastructure ← api`。
`src/server/domain/**` 强制 **100% 分支/函数/行/语句覆盖**（`vitest.config.ts:35`）。
往 domain 里放任何 IO 都会被 lint 拦下。

### 0.5 每阶段的验证命令

```bash
npm run typecheck     # tsc --noEmit
npm run lint          # eslint .
npm run test          # vitest run
npm run test:coverage # 带覆盖率阈值
```

**每个阶段结束时四条都必须绿。** R0 结束时尤其：R0 不该让任何现有断言变红，
红了说明改动语义超出预期，停下来查。

---

## §1 要建的东西（30 秒版）

槽位内容产出后，由审核 Agent 按判据找错；检出问题就带着证据返修，
返修有硬上限，**任务永不因审核卡死**。

核心形状（D-22）——**审核是槽位「完成」的组成部分，不是完成之后的事**：

```
内容提交 → 确定性校验(现有,不变) → 落库,槽位进 reviewing
   → 每条判据各跑一次 review_slot execution
   → 系统结算：全部未检出 → completed
              有检出且预算未尽 → 回 pending（保留上一稿），下一轮带 findings
              有检出且预算耗尽 → completed + review_exhausted=1
   → 下游槽位才开始跑
```

**这个形状让下游永远只读到已审内容，因此不存在级联返修**——
不要实现修复波次、影响面判定、跨槽位协调。它们没有对象。

### 1.1 必须知道的实测结果

四条判据里**只有两条实际有效**，另两条三种提问架构下都是 0/3：

| 判据 | 召回 | 误报 |
|---|---|---|
| 一 首段承接上一场结尾 | 3/3 | 0/16 |
| 二 可见行动而非心理解释 | 3/3 | 0/16 |
| 三 不与骨架撞设定 | **0/3** | 0/16 |
| 四 「停在哪里」必须兑现 | **0/3** | 0/16 |

**四条判据全部上线**（D-28）——无效的照样带，因为误报为 0（不添乱），
且删掉就再也观察不到它们何时开始生效。**不要因为三/四测不出来就不实现它们。**

由此推出一条正确性要求（D-30 / FR-REVIEW-004）：
**系统任何输出不得出现「审核通过」「质量合格」「已校验」。**
统一用「未检出问题」。理由：探测器只会漏不会冤，说「通过」是不实陈述。

---

## §2 R0：数据模型

### 2.1 新建 `migrations/003_review.sql`

迁移由 `src/server/infrastructure/database/migrate.ts` 按文件名顺序执行，
记录在 `schema_migrations` 表。**新建文件，不要改 001/002。**

SQLite 不支持修改 CHECK 约束，因此涉及 CHECK 的表要走
「建新表 → 拷数据 → 删旧表 → 改名」。

**执行顺序（已修订）**：先重建 `slots` 与 `executions`，**最后**建 `slot_reviews`。
`slot_reviews` 对两张表都有外键，最后建可以整类地绕开建表顺序的疑问。

> ### ⚠️ 修正：`PRAGMA foreign_keys=OFF` 在这里用不了
>
> 本文档早期版本要求「重建期间用 `PRAGMA foreign_keys=OFF`」。**那条指令无法执行。**
> `migrate.ts:95` 把每个迁移文件包在 `db.transaction(() => db.exec(sql))` 里，
> 而 SQLite 的 `PRAGMA foreign_keys` **在事务内是 no-op**。写了也不生效。
>
> **正确做法：事务内重建 + 测试兜底。** 不需要关外键，因为指向被重建表的外键
> 全都是 `DEFERRABLE INITIALLY DEFERRED`（`tasks.active_execution_id`、
> `slots.producer_execution_id`、`slots` 的 parent 自引用）——
> 违反只在 COMMIT 时检查，而那时新表已经就位。
>
> **不要为此改 `migrate.ts`。** 那个 runner 是既有资产，
> 为一个迁移改它属于本次禁止的顺手重构。
>
> **重命名方向是死规矩**：`CREATE 新表(别名) → 拷数据 → DROP 原表 → RENAME 新表为原名`。
> **绝不能先把原表 rename 走**——SQLite ≥3.25 在 rename 时会**回填其他表 schema 里
> 指向它的引用**，把 `tasks.active_execution_id REFERENCES executions` 改写成
> 指向改名后的表。按上面的方向做则没有任何表引用那个临时别名，不会触发回填。
>
> 正确性由测试兜底：在**全新库**与 **M4 库的副本**上跑完迁移，
> 断言 `PRAGMA foreign_key_check` 无输出。

```sql
-- ============ 1. 审核结果表（实际执行放在最后，见上方顺序说明） ============
CREATE TABLE slot_reviews (
  task_id       TEXT NOT NULL REFERENCES tasks(id),
  slot_id       TEXT NOT NULL,
  round         INTEGER NOT NULL,           -- 第几轮，从 0 起
  criterion_id  TEXT NOT NULL,              -- 判据 ID，来自冻结的审核 Skill
  execution_id  TEXT NOT NULL REFERENCES executions(id),
  verdict       TEXT NOT NULL CHECK (verdict IN ('no_finding','revise','discarded')),
  findings_json TEXT NOT NULL DEFAULT '[]', -- 只存**通过引文校验**的 finding
  created_at    TEXT NOT NULL,

  -- 判据 ID 是主键的一部分：模板校验保证它在 Skill 内唯一（FR-TPL-003），
  -- 否则两条判据的结果会互相覆盖。
  PRIMARY KEY (task_id, slot_id, round, criterion_id),
  FOREIGN KEY (task_id, slot_id) REFERENCES slots(task_id, slot_id)
);

CREATE INDEX idx_slot_reviews_slot ON slot_reviews(task_id, slot_id, round);
```

> **不要用 `ALTER TABLE ADD COLUMN` 加那两列。** 本文档早期版本写了
> 「先 ADD COLUMN，重建时再纳入」——那是多余的一步：`slots` 反正要重建，
> 直接把 `revision_round` / `review_exhausted` 写进新表定义，
> 拷数据时用 `INSERT INTO slots_new SELECT ..., 0, 0 FROM slots` 补上默认值即可。

`slots` 与 `executions` 两张表都要重建。**重建时的新定义相对旧定义的差异**：

**`slots`**
- `status` CHECK 增加 `'reviewing'`：
  `CHECK (status IN ('pending','running','reviewing','completed','failed'))`
- 新增 `CHECK (review_exhausted IN (0,1))`
- **加固 AC-009 的 CHECK**（原来只覆盖 `completed`，`reviewing` 同样该有内容）：
  ```sql
  CHECK (
    NOT (status IN ('completed','reviewing') AND content_bearing = 1)
    OR (content_text IS NOT NULL
        AND producer_agent_id IS NOT NULL
        AND producer_skill_id IS NOT NULL
        AND producer_execution_id IS NOT NULL)
  )
  ```
- 其余列、外键（含两个 `DEFERRABLE INITIALLY DEFERRED`）、
  「容器槽位不得有正文」的 CHECK **原样保留**。

**`executions`**
- `operation` CHECK 增加 `'review_slot'`
- **UNIQUE 约束必须改**（不改的话 R2 一跑就炸）：
  ```sql
  -- 旧：UNIQUE (task_id, target_slot_id, attempt_number)
  -- 新：
  UNIQUE (task_id, target_slot_id, operation, attempt_number)
  ```
  原因：`review_slot` 的 `target_slot_id` 就是被审槽位，
  于是同一槽位的 `fill_slot` attempt 1 与 `review_slot` attempt 1 撞主键。

> ⚠️ `executions` 与 `tasks.active_execution_id` 构成环（旧表注释里明写了）。
> 该外键是 `DEFERRABLE INITIALLY DEFERRED`，所以事务内重建是安全的——
> 具体做法与重命名方向见本节开头的修正框。

### 2.2 枚举同步的 8 个点（**编译器只帮你抓 4 个**）

`SlotStatus` 加 `'reviewing'`：

| 位置 | tsc 会报错吗 |
|---|---|
| `src/shared/contracts.ts:27` `SlotStatusSchema` | ❌ **不会** |
| `migrations/003_review.sql` 的 CHECK | ❌ **不会** |
| `src/server/runtime/ports.ts` | ❌ 不一定 |
| `src/server/domain/types.ts:60`（从 shared 导入，源头） | — |
| `src/server/domain/state-machine.ts:153` `SLOT_TRANSITIONS` | ✅ 会 |
| `src/server/domain/state-machine.ts:187` `SLOT_STATUS_LABEL` | ✅ 会 |
| `src/server/infrastructure/database/repositories/slot-repo.ts:132` `countByStatus` 签名 | ✅ 会 |
| `src/server/infrastructure/database/repositories/slot-repo.ts:296` 计数器字面量 | ✅ 会 |

**domain 的 `Slot` 类型（`src/server/domain/types.ts`）也在 R0 加这两个字段**：
`revisionRound: number` 与 `reviewExhausted: boolean`。
理由：库里有列而 domain 类型没有，会让 R1/R2 的代码到处绕开它，
中间还留一段「库与 domain 不一致」的窗口。
代价只是三个测试文件的 `slot()` 工厂各加两个默认值——**只改默认值，不动断言**。
（`types.ts` 被 `vitest.config.ts:21` 排除在覆盖率外，不影响 100% 门槛。）

`Operation` 加 `'review_slot'`：
- `src/shared/contracts.ts:31` `OperationSchema`
- `migrations/003_review.sql` 的 CHECK
- `src/server/application/skill-loader.ts` 的 `SkillFrontmatterSchema`
  （它直接用 `OperationSchema`，但 `superRefine` 里对
  `fill_slot` / `create_structure` 有分支，需要为 `review_slot` 补规则，见 §6.2）

> **阶段归属澄清**（§4 的标题「R2：Operation + 引擎 + trace」易生歧义）：
> **R0 只加枚举值**——重建表的 CHECK 本来就逼着必须加；
> **引擎接线归 R2**；**`skill-loader` 的 `superRefine` 规则归 R4 §6.2**。

### 2.3 状态机（`src/server/domain/state-machine.ts`）

现有：`SlotAction = 'schedule' | 'commit' | 'exhaust' | 'cancel' | 'reset'`（第 136 行）。

**新增三个 action**，并给迁移表加 `reviewing` 一行：

| from | action | to | 说明 |
|---|---|---|---|
| `running` | `commit_for_review` | `reviewing` | 绑定了审核 Skill 的槽位走这条 |
| `running` | `commit` | `completed` | 未绑定的走原路，**一个字不改** |
| `reviewing` | `review_clear` | `completed` | 未检出问题，或预算耗尽按现状完成 |
| `reviewing` | `review_revise` | `pending` | 回去返修 |
| `reviewing` | `cancel` | `pending` | 用户 stop 与孤儿恢复在审核期同样有效（AC-011） |

`reviewing` 行的其余动作全部 `null`。三个新 action 在
`pending`/`completed`/`failed` 行上也全部 `null`。

> **为什么不让 `commit` 自己判断去哪**：迁移表是 `(status, action) → status`
> 的纯函数，它不知道也不该知道槽位类型。「这个槽位要不要审」是调用方的知识
> （调用方读得到 `reviewSkillId`），由调用方选动作，表保持纯粹。

`SLOT_STATUS_LABEL` 加 `reviewing: '审核中'`。

`SLOT_ACTION_LABEL` 加三条（措辞受 D-30 约束，不得含「通过/合格」意味）：

```ts
commit_for_review: '提交审核',
review_clear:      '审核结算',
review_revise:     '返修',
```

### 2.3.1 ⚠️ 一个「测试不会变红」正是危险所在的地方

`src/server/domain/state-machine.test.ts:106` 的穷尽性测试是这样写的：

```ts
const SLOT_STATUSES: SlotStatus[] = ['pending', 'running', 'completed', 'failed'];  // 第 16 行，本地清单
...
for (const from of SLOT_STATUSES) {
  for (const action of ['schedule','commit','exhaust','cancel','reset'] as const) {  // 又一份本地清单
    expect(typeof canSlotTransition(from, action)).toBe('boolean');
  }
}
```

**两份清单都是硬编码的本地数组。** 加了 `reviewing` 和三个新 action 之后：

- 测试**依然全绿**（`SlotStatus[]` 的子集仍然类型合法）；
- 但它从覆盖 4×5=20 格，变成只覆盖 5×8=40 格里的 **20 格**——**一半**。

**一个看起来穷尽的测试，会悄悄地不再穷尽。**

而且 **100% 分支覆盖救不了你**：`canSlotTransition` 是一次表查找
（`SLOT_TRANSITIONS[from][action] !== null`），整个函数就一个分支。
覆盖率会照样满分，20 个表格却从没被碰过。**覆盖率不保护表驱动的数据。**

**必须做**：把两层循环改成从**导出的常量**推导——
`SLOT_ACTIONS` 已经在 `state-machine.ts:138` 导出了，直接用；
状态清单同样导出一份并用它。**外加**为五条新迁移各写一条显式断言。

> 这不是被 §0.3 禁止的「顺手重构」。§0.3 禁的是消除枚举重复那类与本次无关的改动；
> 这里是**让一个自称穷尽的测试真的穷尽**，属于本次改动的正当组成部分。

### 2.4 仓储层新增方法（`slot-repo.ts`）

```ts
/** running → reviewing，同时写入内容与 producer。与 commitContent 同一条 D-10 条件 UPDATE。 */
commitContentForReview(input: CommitSlotContentInput): void;

/**
 * reviewing → pending，用于返修。
 * ⚠️ 绝不触碰 content_text 与 producer 各列——下一轮上下文要用上一稿。
 * ⚠️ 同一条 UPDATE 里递增 revision_round（见下方说明），WHERE 必须带 AND status = 'reviewing'。
 */
markForRevision(taskId: string, slotId: string): number;

/** reviewing → completed。exhausted 为 true 时同时置 review_exhausted = 1。 */
clearReview(taskId: string, slotId: string, exhausted: boolean): number;
```

> **不要复用 `resetToPending`**（第 270 行）。它的 SQL 带 `AND status = 'running'`，
> 用在 `reviewing` 上会**静默地一行不改**（`changes = 0`），槽位卡在 `reviewing`。
> 好在它安全失败——不会误删内容。**也不要放宽它的状态条件**：
> 那条守卫同时在保护「已完成的槽位内容永不被重置」（FR-LIFE-004 / AC-012）。

新增 `src/server/infrastructure/database/repositories/slot-reviews-repo.ts`：
`insert(row)` / `listByRound(taskId, slotId, round)`。
**R0 就接进 `buildRepositories`**（成员从六变七，同步改 `index.ts` 里「§5.4 的六个成员」那句注释），
省得 R2 再动一次装配。

> **`revision_round` 必须在 `markForRevision` 的同一条 SQL 里递增**，
> 不要拆成结算事务里的单独一步：
>
> ```sql
> UPDATE slots SET status = 'pending', revision_round = revision_round + 1, updated_at = ?
>   WHERE task_id = ? AND slot_id = ? AND status = 'reviewing'
> ```
>
> 拆开会留下一条「状态回了 pending 但计数没加」的路径——
> **那等于返修预算永不推进，循环无限跑下去**，正是 D-26 要防的东西。
> 合进同一条 UPDATE 则物理上不可能发生。
> （因此 §4.4 结算事务里**没有**单独的「递增」步骤。）

### 2.5 R0 完成判据

- `npm run migrate` 在**全新库**和**已有 M4 数据的库**上都能跑通；
- `PRAGMA foreign_key_check` 无输出；
- **现有测试全绿，一条都不许红**——红了说明改动语义超预期，停下来查；
- 四条验证命令全绿。

---

## §3 R1：domain 层三个纯函数

全部放 `src/server/domain/`，**零 IO**，强制 100% 分支覆盖。
这三个函数是整个功能里唯一能在没有数据库和模型的情况下完整验证的部分。

### 3.1 引文校验 `review-evidence.ts`

```ts
export interface RawFinding { criterionId: string; quote: string; problem: string; }
export interface VerifiedFindings {
  kept: readonly RawFinding[];
  discardedCount: number;
}

/** D-25：quote 必须逐字出自待审正文，允许标点归一化。 */
export function verifyFindings(
  content: string,
  findings: readonly RawFinding[],
): VerifiedFindings;
```

归一化规则（**实测依据**：21 条 finding 里 20 条逐字命中，
唯一未命中的一条是模型把 `"` 写成了 `'`，定位本身是准的）：

- 统一引号：`" " „ « » " '` `' '` → 各自归一到一种；
  **注意直双引号与直单引号也要互相归一**——实测那条正是 `"` → `'`；
- 折叠所有空白（含换行）为空；
- 归一化只用于**比对**，`kept` 里存**模型原文**，不存归一化后的串。

行为表（每行都要有测试）：

| 输入 | 输出 |
|---|---|
| quote 逐字命中 | kept |
| quote 仅在归一化后命中 | kept |
| quote 归一化后仍不命中 | discarded |
| quote 为空串 | discarded（空串 `includes` 恒真，必须显式拦） |
| findings 为空数组 | kept=[], discardedCount=0 |

**必须反证**：把归一化去掉，第 2 行测试必须红；把空串拦截去掉，第 4 行必须红。

### 3.2 审核结算 `review-settlement.ts`

```ts
export type CriterionVerdict = 'no_finding' | 'revise' | 'discarded';

export interface SettlementInput {
  verdicts: readonly CriterionVerdict[];   // 本轮各判据的结果
  revisionRound: number;                   // 当前已用轮次
  maxRevisionRounds: number;               // 上限，来自 Slot Type
}
export type Settlement =
  | { action: 'complete'; exhausted: false }
  | { action: 'complete'; exhausted: true }
  | { action: 'revise'; nextRound: number };

export function settleReview(input: SettlementInput): Settlement;
```

规则：

| 条件 | 结果 |
|---|---|
| 无任何 `revise` | `complete`, exhausted=false |
| 有 `revise` 且 `revisionRound < maxRevisionRounds` | `revise`, nextRound = revisionRound + 1 |
| 有 `revise` 且 `revisionRound >= maxRevisionRounds` | `complete`, **exhausted=true** |
| `verdicts` 为空数组 | `complete`, exhausted=false（防御：无判据等于没审） |

**`discarded` 与 `no_finding` 在结算上等价**（都不触发返修），
但**必须是两个取值**——排查时含义完全不同：
前者是「模型说有问题但证据不成立/审核失败」，后者是「模型说没问题」。

**必须反证**：把 `>=` 改成 `>`，第 3 行必须红（否则会多返修一轮）。

### 3.3 返修上下文装配 `revision-context.ts`

```ts
export interface PriorRound {
  visibleOutput: string;              // 上一轮 Agent 的**公开**输出
  readSlotIds: readonly string[];     // 上一轮读过哪些依赖槽位（只存 ID）
  submittedContent: string;           // 上一轮提交的正文
  findings: readonly RawFinding[];    // 已通过引文校验的
}
/** 装配成注入 Fill Slot Context 的文本段。纯函数。 */
export function renderRevisionContext(
  prior: PriorRound,
  dependencyContents: ReadonlyMap<string, string>,  // 装配时现取的槽位内容
): string;
```

> **不要给工具结果做副本**（FR-CTX-005）。`read_slot` 返回的本来就是库里的
> 槽位内容——存副本既会与权威内容漂移，又白撑大 `context_json`。
> **只记「读过哪些槽位」，内容装配时现取**。判定标准：
> 清空进程内存后，只凭数据库与冻结快照能重建出逐字相同的上下文。

`visibleOutput` 的来源里**绝不能含 `reasoning_content`**（NFR-005 / FR-AGT-005）。
剥离在进入本函数**之前**完成（本函数是纯的，拿到的就该是干净的）。

**必须反证（AC-R-014）**：构造一条**真实带隐藏推理**的 Provider 响应喂进去，
断言产物里不含它。先看着这条断言失败，再实现剥离。
这是本次最容易写成装饰性测试的地方。

### 3.4 R1 完成判据

`npm run test:coverage` 中 `src/server/domain/**` 仍为 100%/100%/100%/100%，
且上述每条「必须反证」都实际红过一次。

---

## §4 R2：Operation + 引擎 + trace（**前端同期改，见 §7**）

### 4.1 trace kind（`src/shared/trace.ts:22` 的 `TRACE_KINDS`）

现有 26 个，追加 4 个：

| kind | 何时写 | 措辞注意 |
|---|---|---|
| `review_started` | 一条判据的审核 execution 建立 | |
| `review_no_finding` | 该判据未检出问题 | **不是 `review_passed`**（D-30） |
| `review_revise` | 检出问题，payload 带通过校验的 findings 与丢弃条数 | |
| `revision_budget_exhausted` | 轮次用尽，按现状完成 | |

> `trace.ts` 的 payload 有**键名黑名单**校验（文件头注释说明了原因）。
> findings 是模型自由文本，**入库前走与其他 Agent 输出相同的过滤路径**，
> 不要为审核另开一条（NFR-005）。

### 4.2 调度：`slot-scheduler.ts` 的 `NextWork`

现有联合类型（第 37–45 行）：
`'running' | 'failed' | 'assembly' | 'slot'`。

**新增一支**：

```ts
| { kind: 'review'; slot: Slot; criterionId: string }
```

选取逻辑插入位置（`selectNext`，约第 100–110 行）：

```
1. 有 running 槽位          → { kind: 'running' }   （现有）
2. 有 failed 槽位           → { kind: 'failed' }    （现有）
3. ★ 有 reviewing 槽位      → 找该轮尚未审的判据
      找到 → { kind: 'review', slot, criterionId }
      全审完 → 触发结算（见 4.4）
4. 全部内容槽 completed     → { kind: 'assembly' }  （现有）
5. 取下一个 ready 槽位      → { kind: 'slot' }      （现有）
```

> **第 3 步必须排在第 4 步之前**。否则一个处于 `reviewing` 的槽位会被
> `allContentSlotsCompleted` 判为「没完成」而落到第 5 步去找新槽位——
> 那会绕过审核直接开下一个。

**依赖判定不用改。** `src/server/domain/readiness.ts:192` 的 `blockedBy` 用
`byId.get(dep)?.status === 'completed'`，`reviewing` 天然不满足，
所以下游自动被挡住。**这是既有代码的现成性质，不要另加判断。**

### 4.3 引擎：`production-engine.ts` 的 `runSlotPhase`（第 423 行）

在现有 `work.kind` 分支里加 `'review'` 一支。它与 `'slot'` 分支的差别：

| | `fill_slot` | `review_slot` |
|---|---|---|
| 绑定来源 | `snapshot.compiled.bindings.fillSlotByType[slot.type]` | `...bindings.reviewSlotByType[slot.type]` |
| execution 的 `target_slot_id` | 该槽位 | 该槽位（**相同**，故 UNIQUE 必须含 operation） |
| `context_json` | 现有 | 现有 + 单条判据文本 + 待审正文 |
| attempt_number | 现有语义 | **只用于它自己的 provider 重试** |

**审核 execution 与填槽 execution 共用 `tasks.active_execution_id` 单车道**（D-29），
因此同受 D-10 的 token 校验保护，迟到的审核结果走与迟到写作结果**完全相同**的
拒绝路径。**不要为审核新写一套并发防护。**

### 4.4 结算的落库

本轮判据全部审完后，在**一个事务内**：

1. 调 `settleReview`（§3.2）拿到 `Settlement`；
2. 按结果调 `markForRevision` 或 `clearReview`（§2.4）；
3. 写对应 trace。

> **没有第 4 步。** `revision_round` 的递增已经合进 `markForRevision` 的
> 同一条 UPDATE（见 §2.4），不要在这里再加一次——加了就是双倍计数。

> **返修不消耗 `attempt_number` 与 `maxRetries`**（D-26 补充）。
> 那两个计的是「同一份工作因故障重试」；返修是「带着新输入做一份新工作」。
> 混用会让 `maxRetries` 被返修轮次吃掉——返修两轮后真正的故障重试预算就没了。
> 每轮返修**开一条新的 attempt 序列**，轮次单独由 `slots.revision_round` 计。

### 4.5 审核失败的兜底（AC-R-011）

`review_slot` execution 重试耗尽，或返回的 JSON 解析不出 verdict 时：
该判据记 `discarded`，槽位**按未检出继续**，trace 说明是**审核失败**而非未检出。

理由：审核是一路附加信号，它的故障不该让内容生产停摆。
（R0.5 里 174 次调用 0 个解析失败，这条路径概率很低，**但不能没有**。）

### 4.6 R2 完成判据

AC-R-001…012 全绿。其中特别注意：

- **AC-R-007** 下游槽位在上游 `reviewing` 期间不得开始执行；
- **AC-R-012** 审核期间 stop / 重启恢复扫到孤儿 execution 时，
  槽位从 `reviewing` 回 `pending`，且**内容与 producer 不写**。

---

## §5 R3：上下文连续性（D-31 / D-32）

**单独成阶段是有意的**：这是唯一一处「模型行为」与「系统不变量」直接接触的地方。
混进 R2 会让一个本来就不小的 diff 没法审。

### 5.1 填槽 Agent 上下文连续（D-31）

返修轮的 `DeterministicContext`（`context-builder.ts`，
`FillSlotContextInput` 在第 102 行）追加 §3.3 定义的段落。

**边界就是槽位**：同一槽位从首稿到第 N 轮返修，Agent 看到一段连续的对话；
**换一个槽位则完全重来**，不同槽位之间没有任何上下文传递。

**实现约束**：连续性必须**完全由重建产生**，不是跨 execution 存活的会话对象。
四条理由（任何一条都足以否决活会话方案）：

1. D-10 的迟到结果防护建立在「1 execution = 1 个带 token 的工作单元」上；
2. `context_hash` / `prompt_hash`（D-12）的意义是可复现，
   输入含「内存里攒的历史」则这两个 hash 不再刻画输入；
3. NFR-005：`reasoning_content` 绝不许进任何 DB 列，
   所以**不能直接存 transcript**，序列化前必须剥离；
4. **重启恢复**：进程中途挂掉，孤儿 execution 会被扫回 pending。
   内存里的会话对象没了，数据库里的显式上下文还在。
   **一个撑不过重启的连续性等于没有连续性。**

### 5.2 审核 Agent 每轮全新（D-32）

`review_slot` 的 prompt **不携带**任何往轮审核记录或往轮 verdict。

**依据很硬**：R0.5 的全部数字（3/3、0/16）都是在单次、全新、无历史的调用下测出的。
带历史的审核 Agent 是一个从没测过的东西，那些数字对它统统不适用。
且失真方向明确：要么为上轮判断辩护而反复打回，要么因「上轮已提过」而放行。

**填槽连续、审核无状态**——这个非对称必须写进实现，不能靠自觉。

### 5.3 R3 完成判据

AC-R-013…017 全绿，尤其：

- **AC-R-014**（`reasoning_content` 不得出现）——见 §3.3 的反证要求；
- **AC-R-015** 返修后 `content_text` 与 producer 各列**原样保留**；
  同时断言 `resetToPending` 对 `reviewing` 槽位返回 `changes = 0`，
  确认两条路径没被实现者合并。

---

## §6 R4：审核 Skill、绑定、端到端回归

### 6.1 模板 schema（`template-schema.ts`）

`RawSlotTypeSchema`（第 75 行附近）增加：

```ts
maxRevisionRounds: z.number().int().min(0).optional(),   // 默认 2
```

`bindings` 增加可选的 `reviewSlotByType`，结构与现有 `fillSlotByType` 相同。

**校验规则**（FR-TPL-003，写在编译期）：

- 绑定的 Skill 的 `operation` 必须是 `review_slot`；
- 该 Skill 至少声明一条判据，且**判据 ID 在 Skill 内唯一**
  （它是 `slot_reviews` 主键的组成部分，重复会让结果互相覆盖）；
- `maxRevisionRounds` 为非负整数。

> **与 `fillSlotByType` 的关键差别**：后者**必须**覆盖所有
> `contentBearing: true` 的槽位类型；`reviewSlotByType` **不作此要求**——
> 不绑定是合法且默认的状态（FR-REVIEW-001 / D-27）。
> 不要照抄 fill 的覆盖性校验。

### 6.2 Skill frontmatter（`skill-loader.ts`）

`SkillFrontmatterSchema` 是 `.strict()` 的，加字段必须显式声明。
为 `review_slot` 增加判据声明，并在 `superRefine` 里补规则：
`operation === 'review_slot'` 时必须声明 `slotTypes` 且至少一条判据。

判据 ID 沿用现有 `SECTION_ID_PATTERN`（`^S\d+$`）风格或另立，**但必须在 Skill 内唯一**。

### 6.3 写审核 Skill

新建 `skills/scene-review/SKILL.md`，四条判据。

**判据文本直接取自 `skills/scene-writing/SKILL.md`**——测的是模型能不能判断，
不是两份标准的分歧。可以参考 `probe/review-skill.md`（R0.5 用的那份，已在仓库里）。

四条判据与现有模板的呼应（`templates/zhihu-chapter/template.yaml:61-63`）：
`scene` 槽位类型的 `guidance` 已经写着

```yaml
- 首段需衔接前一场景的结尾状态
- 通过可见行动推进，不用心理解释代替事件
```

**这两条逐字就是实测 3/3 的判据一和判据二。** 判据三/四对应
「不与骨架撞设定」与「停在哪里必须兑现」，实测 0/3 但照样上线（D-28）。

**每条判据一次独立调用**（D-23），system prompt 里只出现这一条，
**不提示还有别的判据**。

### 6.4 端到端回归基线

复用 `probe/cases.json`（29 条，已在仓库），**不用重造**。
这是唯一能证明「实现出来的东西和实测的东西是同一个」的办法。

分成两类指标，**含义完全不同，不许合并成一个数**：

| 类别 | 判据 | 要求 |
|---|---|---|
| **门槛** | 一、二 | 召回 3/3，**不达标不能发** |
| **门槛** | 全部四条 | 16 条正例误报 = 0，**不达标不能发** |
| **基线** | 三、四 | 当前 0/3，**记录，不设门槛** |

第三行是 D-28 的落点：把测不出来的判据留在线上，**它的 0/3 就成了一条可跟踪的基线**。
往后每次 Skill 迭代、每次换模型档位，拿同一批用例重跑，看这个数动没动。
判据若被裁掉，这条基线就不存在，改进也就无从证明。

回归应固化成可重复执行的脚本（`probe/run-split.mjs` 已是雏形），不是一次性手工验证。

---

## §7 前端（与 R2 同期，不可延后）

前端约 4000 行 / 30 文件。改动很小，但**有一处不改会让界面看起来卡死**。

### 7.1 trace 过滤是白名单——不改则新事件全部不可见

`src/client/workbench/TraceTimeline.tsx:42`：

```ts
traces.filter((e) => TRACE_FILTER_GROUPS[group].includes(e.kind))
```

四个新 kind 不加进 `TRACE_FILTER_GROUPS` 就**一条都不显示**。
而那正好发生在槽位停在 `reviewing` 的时候——**界面上看起来就是卡住了**。
项目有一条硬指标叫「无任务永久停留在 Running」，UI 装成卡死会让人分不清真假。

`review_revise` 不属于失败类，**不要**加进 `FAILURE_KINDS`（第 155 行）走红色。

### 7.2 进度计数会倒退，三处各写了一遍

```ts
contentSlots.filter((s) => s.status === 'completed').length / contentSlots.length
```

- `src/client/workbench/ContentViewer.tsx:105`
- `src/client/workbench/SlotTree.tsx:20`
- `src/client/pages/TaskWorkbench.tsx:212`

返修时槽位从 `completed` 回到 `pending`，这三个数字会往回走。
**这不是 bug，是新的真实语义**，但必须有意处理：
建议不改数字本身，而让该槽位显示 `↻ 返修中（第 N 次）`——
倒退的原因就摆在列表里，不需要额外解释。

`src/client/pages/TaskWorkbench.tsx:96` 的 `lastDone`（取最后一个 completed 槽位
做自动聚焦）在返修期间会前后跳，一并处理。

### 7.3 状态派生表（UI Spec §10.3 已定稿，照抄）

| 数据状态 | 条件 | UI 文案 |
|---|---|---|
| pending | 依赖未完成 | 等待依赖 |
| pending | 依赖已完成 | 可生产 |
| pending | `revisionRound > 0` | 返修中（第 N 次） |
| running | — | 正在生产 |
| reviewing | — | 审核中 |
| completed | `reviewExhausted = 0` | 已完成 |
| completed | `reviewExhausted = 1` | 已完成（返修次数用尽） |
| failed | — | 失败 |

### 7.4 措辞约束（**属正确性要求，不是文案偏好**）

- **不得**出现「审核通过」「质量合格」「已校验」；
- 审核未检出问题时，Slot **直接显示「已完成」，不加任何审核徽标**——
  加一个「已审核」标记就等于做出了未经支持的承诺；
- `已完成（返修次数用尽）` **不得升格为警示色**：
  内容产出来了、进产物了，只是系统停止了尝试。与 `失败`（产不出内容）有本质区别。

> **AC-R-010 光测后端不够。** 后端守的是 trace kind 与 API 字段，
> 而用户真正读到字的地方是前端。**两边都要有断言**，否则是假绿。

---

## §8 最容易做错的七件事（速查）

1. **`executions` 的 UNIQUE 没改** → R2 一跑就撞键。
2. **复用 `resetToPending` 做返修** → 它带 `AND status = 'running'`，静默不改任何行，槽位卡死在 `reviewing`。
3. **调度里 `reviewing` 分支排在 `assembly` 之后** → 绕过审核直接开下一个槽位。
4. **给工具结果存副本** → 与库里权威内容漂移，且违反 FR-CTX-005 的可重建要求。
5. **返修消耗 `attempt_number` / `maxRetries`** → 返修两轮后故障重试预算没了。
6. **trace 新 kind 没加进前端过滤组** → 审核期间界面看起来卡死。
7. **把「未检出问题」写成「审核通过」** → 违反 FR-REVIEW-004，是不实陈述而非文案问题。

---

## §9 阶段与验收对照

| 阶段 | 内容 | 完成判据 |
|---|---|---|
| **R0** | 迁移、UNIQUE、枚举 8 处、状态机、仓储方法 | 迁移可跑；`foreign_key_check` 无输出；**现有测试一条不红**；四命令全绿 |
| **R1** | domain 三个纯函数 | domain 覆盖率仍 100%；每条「必须反证」都实际红过 |
| **R2** | Operation、调度、引擎、结算落库、trace **+ 前端 §7** | AC-R-001…012 全绿 |
| **R3** | 上下文连续性（D-31/D-32） | AC-R-013…017 全绿，尤其 014 与 015 |
| **R4** | 模板 schema、Skill frontmatter、审核 Skill、绑定 `scene`、端到端 | §6.4 的门槛项达标；基线项如实记录 |

---

## §10 交付时要说清楚的话

这次交付的**不是内容质量保证**，是**一个按四条判据找错的审核 Agent，
其中两条经实测有效、两条尚未验证有效**。

它会可靠地修好接不上和干巴说明；对其余一切，它多半会说「未检出问题」，
**包括那些其实有问题的**。

两句话必须同时成立：

- **不因为它现在做不到，就不让它做**——判据不裁剪，能力提升才有地方发生（D-28）；
- **不因为它在做，就说它做到了**——只报「未检出问题」，绝不报「审核通过」（D-30）。

第一句管别把天花板焊死，第二句管别把地板说成天花板。
