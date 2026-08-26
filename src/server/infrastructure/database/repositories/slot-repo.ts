/**
 * SlotRepo —— `slots` 表。
 *
 * 权威来源：§5.2（DDL 与两条 CHECK）、§5.5、D-10、D-16、D-18、REQ AC-009。
 *
 * 这是整个仓储层风险最集中的一个文件：D-10 的条件 UPDATE 在这里。
 */

import type { ErrorCode } from '@shared/errors.ts';
import type { SlotStatus } from '@shared/contracts.ts';
import { ForgeError } from '@shared/errors.ts';
import type { Slot, SlotProducer } from '@server/domain/types.ts';
import type { ForgeDb } from '../db.ts';
import type { Clock } from './types.ts';
import { fromSqlBool, toSqlBool } from './types.ts';
import { diagnoseStaleReason } from './stale-diagnosis.ts';

interface SlotRow {
  task_id: string;
  slot_id: string;
  type: string;
  parent_id: string | null;
  sort_order: number;
  instruction: string;
  depends_on_json: string;
  content_bearing: number;
  include_in_artifact: number;
  status: string;
  revision_round: number;
  review_exhausted: number;
  content_text: string | null;
  producer_agent_id: string | null;
  producer_skill_id: string | null;
  producer_skill_version: string | null;
  producer_execution_id: string | null;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

/** 结构提交时一次性插入的槽位形状：状态与时间戳由仓储决定，调用方不许自带。 */
export interface InsertSlotInput {
  taskId: string;
  slotId: string;
  type: string;
  parentId: string | null;
  sortOrder: number;
  instruction: string;
  dependsOn: readonly string[];
  contentBearing: boolean;
  includeInArtifact: boolean;
}

export interface CommitSlotContentInput {
  taskId: string;
  slotId: string;
  content: string;
  /**
   * AC-009 要求「完成的内容槽必须同时具备 content 与 producer」。
   * 这里收的是一个整体的 `SlotProducer` 而不是四个平铺参数——
   * 类型上就不存在「只传了 agentId」这种调用。
   */
  producer: SlotProducer;
  /** 提交方出示的 Execution Token 的 sha256（§8.1）。明文 token 不进仓储 */
  tokenHash: string;
}

/**
 * 四个 producer_* 列 → 一个 `SlotProducer | null`。
 *
 * 这不是「顺手做的转换」：DB 里这四列各自可空，是四个独立的自由度；
 * Domain 只承认「四个都有」或「一个都没有」两种状态（AC-009）。
 * 转换点必须唯一，否则每个读路径都会各自决定「三个非空算不算有 producer」。
 * 库层的 CHECK 只保证 completed 内容槽四列齐全，running / failed 槽位可能只有部分列，
 * 因此这里以「四列齐全」为唯一判据，不齐即视为无 producer。
 */
function toProducer(row: SlotRow): SlotProducer | null {
  const { producer_agent_id, producer_skill_id, producer_skill_version, producer_execution_id } = row;
  if (
    producer_agent_id === null ||
    producer_skill_id === null ||
    producer_skill_version === null ||
    producer_execution_id === null
  ) {
    return null;
  }
  return {
    agentId: producer_agent_id,
    skillId: producer_skill_id,
    skillVersion: producer_skill_version,
    executionId: producer_execution_id,
  };
}

function toDomain(row: SlotRow): Slot {
  return {
    taskId: row.task_id,
    slotId: row.slot_id,
    type: row.type,
    parentId: row.parent_id,
    sortOrder: row.sort_order,
    instruction: row.instruction,
    dependsOn: JSON.parse(row.depends_on_json) as string[],
    contentBearing: fromSqlBool(row.content_bearing),
    includeInArtifact: fromSqlBool(row.include_in_artifact),
    status: row.status as SlotStatus,
    revisionRound: row.revision_round,
    reviewExhausted: fromSqlBool(row.review_exhausted),
    contentText: row.content_text,
    producer: toProducer(row),
    errorCode: row.error_code as ErrorCode | null,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface SlotRepo {
  /** §5.5「提交 Structure」：n 个槽位在一个事务内插入，父子顺序无所谓（DEFERRED 外键，D-18） */
  insertMany(slots: readonly InsertSlotInput[]): void;
  get(taskId: string, slotId: string): Slot | null;
  getOrThrow(taskId: string, slotId: string): Slot;
  listByTask(taskId: string): Slot[];
  /** §5.5「创建 Assignment」：pending → running */
  markRunning(taskId: string, slotId: string): void;
  /** §5.5「提交 Slot Content」：D-10 的条件 UPDATE */
  commitContent(input: CommitSlotContentInput): void;
  /** running → reviewing，同时写入内容与 producer。与 commitContent 同一条 D-10 条件 UPDATE */
  commitContentForReview(input: CommitSlotContentInput): void;
  /** reviewing → pending，返修。同一条 UPDATE 递增 revision_round，不触碰内容与 producer */
  markForRevision(taskId: string, slotId: string): number;
  /** reviewing → completed。exhausted 为 true 时同时置 review_exhausted = 1 */
  clearReview(taskId: string, slotId: string, exhausted: boolean): number;
  markFailed(taskId: string, slotId: string, errorCode: ErrorCode, errorMessage: string): void;
  /** §5.5 Stop / 启动恢复：running → pending，清 error */
  resetToPending(taskId: string, slotId: string): number;
  /** §5.5「重置失败 Slot」；§8.7 明确 completed 槽位永不重置 */
  resetFailedToPending(taskId: string): number;
  /** §8.7 结构阶段 retry：整棵结构树作废重来 */
  deleteAll(taskId: string): number;
  countByStatus(taskId: string): Record<SlotStatus, number>;
}

export function createSlotRepo(db: ForgeDb, clock: Clock): SlotRepo {
  const insertStmt = db.prepare(
    `INSERT INTO slots
       (task_id, slot_id, type, parent_id, sort_order, instruction, depends_on_json,
        content_bearing, include_in_artifact, status, revision_round, review_exhausted,
        content_text,
        producer_agent_id, producer_skill_id, producer_skill_version, producer_execution_id,
        error_code, error_message, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, 0, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)`,
  );
  const getStmt = db.prepare('SELECT * FROM slots WHERE task_id = ? AND slot_id = ?');
  // 排序用 (parent_id, sort_order) 只是给出一个稳定顺序；真正的文档序由
  // domain/readiness.ts 的 documentOrder 递归计算——SQL 排不出树的先序遍历。
  const listStmt = db.prepare(
    'SELECT * FROM slots WHERE task_id = ? ORDER BY parent_id IS NOT NULL, parent_id, sort_order, slot_id',
  );

  const commitStmt = db.prepare(
    // §D-10 逐字实现。三处不能动：
    //   1. 校验全部在 WHERE 里，不在 JS 里；
    //   2. `e.target_slot_id = slots.slot_id` 用的是相关子查询引用外层行，
    //      它挡住「用 A 槽位的 execution 提交 B 槽位」；
    //   3. `t.active_execution_id = e.id` 是 D-18 加延迟外键的直接动机——
    //      这一列若能指向不存在的 execution，本条件就形同虚设。
    // 另有 `e.task_id = slots.task_id`（D-19 补）：slot_id 只在任务内唯一，
    // 少了这一行，任务 A 的 execution 能提交任务 B 里同名的槽位——
    // 只要调用方把 taskId 传错。而这条语句存在的全部意义就是不依赖调用方传对参数。
    `UPDATE slots SET
       content_text = ?, status = 'completed',
       producer_agent_id = ?, producer_skill_id = ?,
       producer_skill_version = ?, producer_execution_id = ?,
       error_code = NULL, error_message = NULL,
       updated_at = ?
     WHERE task_id = ? AND slot_id = ? AND status = 'running'
       AND EXISTS (
         SELECT 1 FROM executions e
         JOIN tasks t ON t.id = e.task_id
         WHERE e.id = ? AND e.token_hash = ?
           AND e.status = 'running'
           AND e.task_id = slots.task_id
           AND e.target_slot_id = slots.slot_id
           AND t.active_execution_id = e.id
           AND t.status = 'running'
       )`,
  );

  // commitContentForReview 与 commitContent 唯一的差别：status 置 'reviewing' 而非 'completed'。
  // 同一条 D-10 条件 UPDATE，迟到结果走完全相同的拒绝路径。
  const commitForReviewStmt = db.prepare(
    `UPDATE slots SET
       content_text = ?, status = 'reviewing',
       producer_agent_id = ?, producer_skill_id = ?,
       producer_skill_version = ?, producer_execution_id = ?,
       error_code = NULL, error_message = NULL,
       updated_at = ?
     WHERE task_id = ? AND slot_id = ? AND status = 'running'
       AND EXISTS (
         SELECT 1 FROM executions e
         JOIN tasks t ON t.id = e.task_id
         WHERE e.id = ? AND e.token_hash = ?
           AND e.status = 'running'
           AND e.task_id = slots.task_id
           AND e.target_slot_id = slots.slot_id
           AND t.active_execution_id = e.id
           AND t.status = 'running'
       )`,
  );

  const markForRevisionStmt = db.prepare(
    // reviewing → pending，同一条 UPDATE 递增 revision_round。
    // 绝不触碰 content_text 与 producer 各列——下一轮上下文要用上一稿。
    // WHERE 带 AND status = 'reviewing'：只在审核期回退，不误伤其他状态。
    // 不拆成两步（拆开会留「状态回了 pending 但计数没加」的死循环路径，见 §2.4）。
    `UPDATE slots SET status = 'pending', revision_round = revision_round + 1, updated_at = ?
     WHERE task_id = ? AND slot_id = ? AND status = 'reviewing'`,
  );

  const clearReviewStmt = db.prepare(
    // reviewing → completed。exhausted 为 true 时同时置 review_exhausted = 1。
    `UPDATE slots SET status = 'completed', review_exhausted = ?, updated_at = ?
     WHERE task_id = ? AND slot_id = ? AND status = 'reviewing'`,
  );

  return {
    insertMany(slots) {
      const now = clock();
      for (const slot of slots) {
        insertStmt.run(
          slot.taskId,
          slot.slotId,
          slot.type,
          slot.parentId,
          slot.sortOrder,
          slot.instruction,
          JSON.stringify(slot.dependsOn),
          toSqlBool(slot.contentBearing),
          toSqlBool(slot.includeInArtifact),
          now,
          now,
        );
      }
    },

    get(taskId, slotId) {
      const row = getStmt.get(taskId, slotId) as SlotRow | undefined;
      return row === undefined ? null : toDomain(row);
    },

    getOrThrow(taskId, slotId) {
      const row = getStmt.get(taskId, slotId) as SlotRow | undefined;
      if (row === undefined) {
        throw new ForgeError('SLOT_NOT_FOUND', `槽位 ${slotId} 不存在`, `slot:${slotId}`);
      }
      return toDomain(row);
    },

    listByTask(taskId) {
      return (listStmt.all(taskId) as SlotRow[]).map(toDomain);
    },

    markRunning(taskId, slotId) {
      // 同样把前置状态压进 WHERE：只有 pending 能被调度。
      // 若写成「先读状态再判断」，两次连续调度同一槽位就可能都通过检查。
      const info = db
        .prepare(
          `UPDATE slots SET status = 'running', error_code = NULL, error_message = NULL, updated_at = ?
            WHERE task_id = ? AND slot_id = ? AND status = 'pending'`,
        )
        .run(clock(), taskId, slotId);
      if (info.changes !== 1) {
        throw new ForgeError('SLOT_NOT_READY', `槽位 ${slotId} 当前不可调度`, `slot:${slotId}`);
      }
    },

    commitContent(input) {
      const info = commitStmt.run(
        input.content,
        input.producer.agentId,
        input.producer.skillId,
        input.producer.skillVersion,
        input.producer.executionId,
        clock(),
        input.taskId,
        input.slotId,
        input.producer.executionId,
        input.tokenHash,
      );

      if (info.changes !== 1) {
        // 归因只在失败之后做，且是只读的；它不参与判定（见 stale-diagnosis.ts 头部）。
        const reason = diagnoseStaleReason(db, {
          executionId: input.producer.executionId,
          tokenHash: input.tokenHash,
          taskId: input.taskId,
          slotId: input.slotId,
        });
        // 抛错即回滚：本方法之外的任何状态改动（execution/task/trace）都在同一事务内，
        // 因此「迟到结果被拒时不修改任何状态」不需要额外的补偿逻辑来保证。
        throw new ForgeError(
          'EXECUTION_STALE',
          `槽位 ${input.slotId} 的提交被拒绝：${reason}`,
          `slot:${input.slotId}`,
        );
      }
    },

    commitContentForReview(input) {
      const info = commitForReviewStmt.run(
        input.content,
        input.producer.agentId,
        input.producer.skillId,
        input.producer.skillVersion,
        input.producer.executionId,
        clock(),
        input.taskId,
        input.slotId,
        input.producer.executionId,
        input.tokenHash,
      );

      if (info.changes !== 1) {
        const reason = diagnoseStaleReason(db, {
          executionId: input.producer.executionId,
          tokenHash: input.tokenHash,
          taskId: input.taskId,
          slotId: input.slotId,
        });
        throw new ForgeError(
          'EXECUTION_STALE',
          `槽位 ${input.slotId} 的审核提交被拒绝：${reason}`,
          `slot:${input.slotId}`,
        );
      }
    },

    markForRevision(taskId, slotId) {
      return markForRevisionStmt.run(clock(), taskId, slotId).changes;
    },

    clearReview(taskId, slotId, exhausted) {
      return clearReviewStmt.run(toSqlBool(exhausted), clock(), taskId, slotId).changes;
    },

    markFailed(taskId, slotId, errorCode, errorMessage) {
      db.prepare(
        `UPDATE slots SET status = 'failed', error_code = ?, error_message = ?, updated_at = ?
          WHERE task_id = ? AND slot_id = ?`,
      ).run(errorCode, errorMessage, clock(), taskId, slotId);
    },

    resetToPending(taskId, slotId) {
      // 只回滚 running。已 completed 的槽位内容永不被重置（REQ FR-LIFE-004 / AC-012），
      // 这条限制写在 WHERE 里而不是调用方的 if 里，因为 Stop 与启动恢复是两个调用点，
      // 靠调用方各自记得等于迟早有一个忘了。
      return db
        .prepare(
          `UPDATE slots SET status = 'pending', error_code = NULL, error_message = NULL, updated_at = ?
            WHERE task_id = ? AND slot_id = ? AND status = 'running'`,
        )
        .run(clock(), taskId, slotId).changes;
    },

    resetFailedToPending(taskId) {
      return db
        .prepare(
          `UPDATE slots SET status = 'pending', error_code = NULL, error_message = NULL, updated_at = ?
            WHERE task_id = ? AND status = 'failed'`,
        )
        .run(clock(), taskId).changes;
    },

    deleteAll(taskId) {
      return db.prepare('DELETE FROM slots WHERE task_id = ?').run(taskId).changes;
    },

    countByStatus(taskId) {
      const counts: Record<SlotStatus, number> = { pending: 0, running: 0, reviewing: 0, completed: 0, failed: 0 };
      const rows = db
        .prepare('SELECT status, COUNT(*) AS n FROM slots WHERE task_id = ? GROUP BY status')
        .all(taskId) as Array<{ status: SlotStatus; n: number }>;
      for (const row of rows) counts[row.status] = row.n;
      return counts;
    },
  };
}
