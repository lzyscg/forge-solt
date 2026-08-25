/**
 * D-10 条件 UPDATE 失败之后的**事后**归因（§8.4）。
 *
 * 这个模块存在的理由，以及它绝不能被误用的方式，必须一起讲清楚：
 *
 * D-10 的条件 UPDATE 已经从物理上拒绝了迟到结果——`changes !== 1` 就是结论，
 * 不需要任何补充判断。本模块补的**只有可观测性**：告诉排查的人「到底哪一条不满足」，
 * 好写进 `late_result_rejected` 的 trace summary。
 *
 * 因此本模块的函数只允许在 `changes !== 1` **之后**调用。
 * 把它挪到 UPDATE 之前当作前置校验，就正好写回了 D-10 明令禁止的
 * 「读 → 判 → 写」三段式——那中间有窗口。
 *
 * 它是只读查询，与失败的 UPDATE 在同一个事务内执行，看到的是同一份快照。
 */

import type { ForgeDb } from '../db.ts';

export interface StaleDiagnosisInput {
  executionId: string;
  /** 提交方出示的 token 的 sha256。明文 token 从不落库也从不进这里（§8.1） */
  tokenHash: string;
  taskId: string;
  /** fill_slot 时为目标槽位；create_structure 时为 null */
  slotId: string | null;
}

interface DiagnosisRow {
  exec_task_id: string | null;
  exec_status: string | null;
  exec_target_slot_id: string | null;
  token_matches: number | null;
  task_status: string | null;
  task_active_execution_id: string | null;
  slot_status: string | null;
}

/**
 * 依次检查 §8.4 列出的五条，返回第一条不满足的中文原因。
 *
 * 顺序不是随意的：从「最外层的前提」查到「最内层的状态」，
 * 这样给出的原因总是**根因**而不是根因的连锁后果。
 * 例如 execution 已被 stop 取消时，task.activeExecutionId 也必然已被清空，
 * 但值得报告的是前者。
 */
export function diagnoseStaleReason(db: ForgeDb, input: StaleDiagnosisInput): string {
  const row = db
    .prepare(
      `SELECT
         e.task_id                AS exec_task_id,
         e.status                 AS exec_status,
         e.target_slot_id         AS exec_target_slot_id,
         CASE WHEN e.token_hash = ? THEN 1 ELSE 0 END AS token_matches,
         t.status                 AS task_status,
         t.active_execution_id    AS task_active_execution_id,
         s.status                 AS slot_status
       FROM (SELECT ? AS id) AS q
       LEFT JOIN executions e ON e.id = q.id
       LEFT JOIN tasks      t ON t.id = ?
       LEFT JOIN slots      s ON s.task_id = ? AND s.slot_id = ?`,
    )
    .get(input.tokenHash, input.executionId, input.taskId, input.taskId, input.slotId) as
    | DiagnosisRow
    | undefined;

  if (row === undefined || row.exec_task_id === null) {
    return `Execution ${input.executionId} 不存在`;
  }
  if (row.token_matches !== 1) {
    return 'Execution Token 不匹配';
  }
  if (row.exec_status !== 'running') {
    return `Execution 已不是 running（当前 ${row.exec_status}）`;
  }
  if (row.exec_task_id !== input.taskId) {
    return `Execution 属于另一个任务（${row.exec_task_id}）`;
  }
  if (row.exec_target_slot_id !== input.slotId) {
    return `Execution 的目标槽位是 ${row.exec_target_slot_id ?? 'null'}，与提交目标 ${input.slotId ?? 'null'} 不符`;
  }
  if (row.task_status === null) {
    return `任务 ${input.taskId} 不存在`;
  }
  if (row.task_active_execution_id !== input.executionId) {
    return `任务的活动执行已变更为 ${row.task_active_execution_id ?? 'null'}`;
  }
  if (row.task_status !== 'running') {
    return `任务已不是 running（当前 ${row.task_status}）`;
  }
  if (input.slotId !== null && row.slot_status === null) {
    return `槽位 ${input.slotId} 不存在`;
  }
  if (input.slotId !== null && row.slot_status !== 'running') {
    return `槽位已不是 running（当前 ${row.slot_status}）`;
  }
  // 五条全过却仍然 changes !== 1：说明条件 UPDATE 与本函数的判据出现了分歧，
  // 这是实现缺陷而不是业务上的迟到结果，不能伪装成正常原因返回。
  return '未能确定原因：条件 UPDATE 未命中但所有已知前提均满足，这是实现缺陷';
}
