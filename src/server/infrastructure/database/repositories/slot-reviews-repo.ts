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
}

export function createSlotReviewsRepo(db: ForgeDb, clock: Clock): SlotReviewsRepo {
  const insertStmt = db.prepare(
    `INSERT INTO slot_reviews
       (task_id, slot_id, round, criterion_id, execution_id, verdict, findings_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const listByRoundStmt = db.prepare(
    `SELECT * FROM slot_reviews
     WHERE task_id = ? AND slot_id = ? AND round = ?
     ORDER BY criterion_id`,
  );

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
  };
}
