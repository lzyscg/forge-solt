/**
 * SlotReviewsRepo —— `slot_reviews` 表（003_review.sql 新建）。
 *
 * 权威来源：§2.1（DDL）、§2.4（仓储方法）、§3.1（findings_json 的引文校验在 R1）。
 *
 * R0 只做 insert / listByRound 的基础往返。结算逻辑（settleReview）与引文校验
 * （verifyFindings）分别在 R1 / R2，本仓储只负责落库与读取。
 */

import type { ForgeDb } from '../db.ts';
import type { Clock } from './types.ts';

/** slot_reviews 表的行形状。findings_json 存字符串，反序列化由调用方负责。 */
export interface SlotReviewRow {
  task_id: string;
  slot_id: string;
  round: number;
  criterion_id: string;
  execution_id: string;
  verdict: string;
  findings_json: string;
  created_at: string;
}

/** domain 侧的审核结果。findings 保留为 JSON 文本，按最小需要不做提前反序列化。 */
export interface SlotReview {
  taskId: string;
  slotId: string;
  round: number;
  criterionId: string;
  executionId: string;
  verdict: 'no_finding' | 'revise' | 'discarded';
  findingsJson: string;
  createdAt: string;
}

export interface InsertSlotReviewInput {
  taskId: string;
  slotId: string;
  round: number;
  criterionId: string;
  executionId: string;
  verdict: 'no_finding' | 'revise' | 'discarded';
  /** 已通过引文校验的 findings 的 JSON 文本；调用方负责序列化 */
  findingsJson: string;
}

function toDomain(row: SlotReviewRow): SlotReview {
  return {
    taskId: row.task_id,
    slotId: row.slot_id,
    round: row.round,
    criterionId: row.criterion_id,
    executionId: row.execution_id,
    verdict: row.verdict as SlotReview['verdict'],
    findingsJson: row.findings_json,
    createdAt: row.created_at,
  };
}

export interface SlotReviewsRepo {
  insert(input: InsertSlotReviewInput): void;
  listByRound(taskId: string, slotId: string, round: number): SlotReview[];
  /**
   * 某槽位**全部轮次**的审核行。排序规则与 `listByRound` 同源，见那里的注释。
   *
   * 单独一条 SQL 而不是循环调用 `listByRound`：调用方（生产流程视图）
   * 拿不到「一共几轮」以外还要先读一次槽位，而这里一次就够。
   */
  listBySlot(taskId: string, slotId: string): SlotReview[];
  /**
   * 删掉一个任务的全部审核行。**只有整棵结构树被作废时才该调用。**
   *
   * 存在的唯一理由是外键：`slot_reviews` 的 `(task_id, slot_id)` 指向 `slots`，
   * 而结构审核检出问题时整棵树要被替换（`SlotRepo.deleteAll`）。
   * 不先删这里，那条 DELETE 会因外键失败——失败信息指向 slots，
   * 而真正拦住它的是另一张表。
   *
   * **不能只删「新树里没有的槽位」那部分。** 新旧两棵树的根几乎总是同名，
   * 留下根的审核行看起来无损，实际不行：这个外键不是 DEFERRABLE，
   * 而替换是「先删光再插回」，根在那两条语句之间**确实不存在**，
   * 于是 DELETE 当场报 `FOREIGN KEY constraint failed`。
   * （我先按「只删外键逼着删的」写了一版，结构重来那一轮直接失败，见 R5 的调试记录。）
   *
   * 删掉的不是唯一副本：每条审核结果在写这张表的同一个事务里也写了一条 trace
   * （`review_revise` / `review_no_finding`，payload 带逐条引文与问题），
   * 而 trace 是只追加的。这张表存的是**结算用的当轮工作状态**，不是档案。
   */
  deleteByTask(taskId: string): number;
}

export function createSlotReviewsRepo(db: ForgeDb, clock: Clock): SlotReviewsRepo {
  const insertStmt = db.prepare(
    `INSERT INTO slot_reviews
       (task_id, slot_id, round, criterion_id, execution_id, verdict, findings_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  /*
   * 按**写入顺序**排，不按 criterion_id 排。
   *
   * 原来是 `ORDER BY criterion_id`，那是字符串比较：'S10' < 'S2'，
   * 判据超过 9 条时读回来是 S1, S10, S2, …。
   *
   * 换成「按数字排」（`CAST(SUBSTR(criterion_id,2) AS INTEGER)`）语法上可行
   * —— SECTION_ID_PATTERN 是 `/^S\d+$/` —— 但那是**另一个错**：判据的权威顺序是
   * SKILL.md 里的书写顺序（§4.3「保持文件中的出现顺序」），而书写顺序不保证
   * 等于数字顺序。一份先写 `## S3.` 再写 `## S1.` 的 Skill 是合法的，
   * 按数字排会把它重排成 S1、S3，与注入模型的顺序不一致。
   *
   * `created_at` 之所以正好是书写顺序：`findNextCriterion` 沿
   * `skill.sections`（= 文件顺序）找第一条还没有行的判据，所以行**就是**
   * 按书写顺序一条条插进来的。这样排不依赖 ID 长什么样，Skill 改判据命名也不会坏。
   *
   * `rowid` 是同毫秒的并列兜底。实际上同一轮里每条判据都是一次独立的模型调用，
   * 相隔十几秒，撞不到一起；但排序的确定性不该建立在「调用很慢」上。
   */
  const listByRoundStmt = db.prepare(
    `SELECT * FROM slot_reviews
     WHERE task_id = ? AND slot_id = ? AND round = ?
     ORDER BY created_at, rowid`,
  );
  const listBySlotStmt = db.prepare(
    `SELECT * FROM slot_reviews
     WHERE task_id = ? AND slot_id = ?
     ORDER BY round, created_at, rowid`,
  );
  const deleteByTaskStmt = db.prepare('DELETE FROM slot_reviews WHERE task_id = ?');

  return {
    insert(input) {
      insertStmt.run(
        input.taskId,
        input.slotId,
        input.round,
        input.criterionId,
        input.executionId,
        input.verdict,
        input.findingsJson,
        clock(),
      );
    },

    listByRound(taskId, slotId, round) {
      return (listByRoundStmt.all(taskId, slotId, round) as SlotReviewRow[]).map(toDomain);
    },

    listBySlot(taskId, slotId) {
      return (listBySlotStmt.all(taskId, slotId) as SlotReviewRow[]).map(toDomain);
    },

    deleteByTask(taskId) {
      return deleteByTaskStmt.run(taskId).changes;
    },
  };
}
