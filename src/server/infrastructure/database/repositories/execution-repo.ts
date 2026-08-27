/**
 * ExecutionRepo —— `executions` 表。
 *
 * 权威来源：§5.2、§5.5、D-09（Assignment 不建表，全部持久化内容压在这张表上）、
 * D-12（contextHash / promptHash 分离）、§8.1、§8.6。
 *
 * D-09 的直接后果：这张表既是「执行记录」也是「Assignment 的持久形态」，
 * 因此 `context_json` 存的是**结构化上下文输入本身**，不是它的摘要——
 * NFR-004 要求上下文可重建，只留 hash 是重建不出来的。
 */

import type { ErrorCode } from '@shared/errors.ts';
import type { ExecutionStatus, Operation } from '@shared/contracts.ts';
import { ForgeError } from '@shared/errors.ts';
import type { Execution } from '@server/domain/types.ts';
import type { ForgeDb } from '../db.ts';
import type { Clock } from './types.ts';

interface ExecutionRow {
  id: string;
  task_id: string;
  operation: string;
  target_slot_id: string | null;
  agent_id: string;
  skill_id: string;
  skill_version: string;
  token_hash: string;
  context_json: string;
  context_hash: string;
  prompt_hash: string;
  model_alias: string;
  provider: string;
  model: string;
  attempt_number: number;
  status: string;
  input_tokens: number | null;
  output_tokens: number | null;
  error_code: string | null;
  error_message: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
}

export interface InsertExecutionInput {
  /** D-09：AgentAssignment.id 就是这个 id，不另外生成 */
  id: string;
  taskId: string;
  operation: Operation;
  /** create_structure 时为 null。注意 §5.2 的 UNIQUE 在 NULL 上不生效 */
  targetSlotId: string | null;
  agentId: string;
  skillId: string;
  skillVersion: string;
  /** sha256(raw token)。明文 token 只在内存里传给 Runtime，绝不落库（§8.1） */
  tokenHash: string;
  /**
   * 结构化上下文输入的**规范化 JSON 文本**，由调用方用 `domain/canonical.ts` 产出。
   * 仓储不自己 stringify：contextHash 必须与这段文本逐字对应（D-12），
   * 序列化一旦发生在两个地方，hash 就不再是「喂进去的信息变了吗」的可靠信号。
   */
  contextJson: string;
  contextHash: string;
  promptHash: string;
  modelAlias: string;
  provider: string;
  model: string;
  attemptNumber: number;
}

function toDomain(row: ExecutionRow): Execution {
  return {
    id: row.id,
    taskId: row.task_id,
    operation: row.operation as Operation,
    targetSlotId: row.target_slot_id,
    agentId: row.agent_id,
    skillId: row.skill_id,
    skillVersion: row.skill_version,
    tokenHash: row.token_hash,
    contextHash: row.context_hash,
    promptHash: row.prompt_hash,
    modelAlias: row.model_alias,
    provider: row.provider,
    model: row.model,
    attemptNumber: row.attempt_number,
    status: row.status as ExecutionStatus,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    errorCode: row.error_code as ErrorCode | null,
    errorMessage: row.error_message,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    createdAt: row.created_at,
  };
}

export interface ExecutionRepo {
  /** 新建 execution，status = 'created'（§5.5「创建 Assignment」） */
  insert(input: InsertExecutionInput): Execution;
  get(id: string): Execution | null;
  getOrThrow(id: string): Execution;
  /**
   * 取 `context_json` 原文。刻意与 `get()` 分开：
   * 上下文可能有几十 KB，任务详情页每次渲染都带上它是纯粹的浪费，
   * 而 Domain 的 `Execution` 类型里本来就没有这个字段。
   */
  getContextJson(id: string): string | null;
  listByTask(taskId: string): Execution[];
  /** §8.7：按 attempt_number 判断还剩几次配额 */
  latestAttempt(taskId: string, targetSlotId: string | null): number;
  markRunning(id: string): void;
  markSucceeded(id: string, usage?: { inputTokens: number | null; outputTokens: number | null }): void;
  /**
   * 只写 token 用量，**不动 status / finished_at**。
   *
   * 为什么需要一个独立方法，而不是让 `markSucceeded` 顺手带上：
   * `complete_assignment` 是**工具调用**，它在 Agent 循环**进行中**就把 execution
   * 标成了 succeeded；而 usage 要等整个循环跑完、Provider 把最后一帧
   * （`stream_options.include_usage`）发回来才知道。两件事天然不同时，
   * 硬塞进 markSucceeded 只会永远拿到 null——这正是 M4 以来 token 列全空的原因。
   *
   * 失败与取消的 execution 同样要记：那些 token 一样是花掉的，
   * 只记成功的会让「这次任务花了多少」系统性偏低。
   */
  recordUsage(id: string, usage: { inputTokens: number; outputTokens: number }): void;
  markFailed(id: string, errorCode: ErrorCode, errorMessage: string): void;
  /** §8.3 Stop / §8.6 启动恢复。reason 会写进 error_message 供事后排查 */
  markCancelled(id: string, reason?: string): void;
  /** §8.4：迟到结果被拒之后给 execution 盖章 */
  markStale(id: string, reason: string): void;
  /**
   * §8.6：`status IN ('created','running')` 但其 task 已非 running 的孤儿 execution。
   * 走 idx_executions_status，这是启动路径上的必经查询。
   */
  findOrphans(): Execution[];
}

/**
 * 终态取值。`created` / `running` 不在其中——`finish()` 只负责终态收尾，
 * 把它当成通用的状态设置器会让 finished_at 被打在一个还没结束的执行上。
 */
type FinishedStatus = Extract<ExecutionStatus, 'succeeded' | 'failed' | 'cancelled' | 'stale'>;

export function createExecutionRepo(db: ForgeDb, clock: Clock): ExecutionRepo {
  const insertStmt = db.prepare(
    `INSERT INTO executions
       (id, task_id, operation, target_slot_id, agent_id, skill_id, skill_version,
        token_hash, context_json, context_hash, prompt_hash,
        model_alias, provider, model, attempt_number, status,
        input_tokens, output_tokens, error_code, error_message,
        started_at, finished_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'created',
             NULL, NULL, NULL, NULL, NULL, NULL, ?)`,
  );
  const getStmt = db.prepare('SELECT * FROM executions WHERE id = ?');
  const contextStmt = db.prepare('SELECT context_json FROM executions WHERE id = ?');
  const byTaskStmt = db.prepare('SELECT * FROM executions WHERE task_id = ? ORDER BY created_at DESC');
  const finishStmt = db.prepare(
    `UPDATE executions
        SET status = ?, error_code = ?, error_message = ?,
            input_tokens = COALESCE(?, input_tokens),
            output_tokens = COALESCE(?, output_tokens),
            finished_at = ?
      WHERE id = ?`,
  );

  const usageStmt = db.prepare(
    'UPDATE executions SET input_tokens = ?, output_tokens = ? WHERE id = ?',
  );

  const finish = (
    id: string,
    status: FinishedStatus,
    errorCode: ErrorCode | null,
    errorMessage: string | null,
    inputTokens: number | null = null,
    outputTokens: number | null = null,
  ): void => {
    finishStmt.run(status, errorCode, errorMessage, inputTokens, outputTokens, clock(), id);
  };

  return {
    insert(input) {
      const now = clock();
      insertStmt.run(
        input.id,
        input.taskId,
        input.operation,
        input.targetSlotId,
        input.agentId,
        input.skillId,
        input.skillVersion,
        input.tokenHash,
        input.contextJson,
        input.contextHash,
        input.promptHash,
        input.modelAlias,
        input.provider,
        input.model,
        input.attemptNumber,
        now,
      );
      return {
        id: input.id,
        taskId: input.taskId,
        operation: input.operation,
        targetSlotId: input.targetSlotId,
        agentId: input.agentId,
        skillId: input.skillId,
        skillVersion: input.skillVersion,
        tokenHash: input.tokenHash,
        contextHash: input.contextHash,
        promptHash: input.promptHash,
        modelAlias: input.modelAlias,
        provider: input.provider,
        model: input.model,
        attemptNumber: input.attemptNumber,
        status: 'created',
        inputTokens: null,
        outputTokens: null,
        errorCode: null,
        errorMessage: null,
        startedAt: null,
        finishedAt: null,
        createdAt: now,
      };
    },

    get(id) {
      const row = getStmt.get(id) as ExecutionRow | undefined;
      return row === undefined ? null : toDomain(row);
    },

    getOrThrow(id) {
      const row = getStmt.get(id) as ExecutionRow | undefined;
      if (row === undefined) {
        // 没有 EXECUTION_NOT_FOUND 这个码（附录 A）。取不到 execution 只可能发生在
        // 它已经被替换或从未存在，对上层语义上就是「这次执行已失效」。
        throw new ForgeError('EXECUTION_STALE', `Execution ${id} 不存在`, null);
      }
      return toDomain(row);
    },

    getContextJson(id) {
      const row = contextStmt.get(id) as { context_json: string } | undefined;
      return row === undefined ? null : row.context_json;
    },

    listByTask(taskId) {
      return (byTaskStmt.all(taskId) as ExecutionRow[]).map(toDomain);
    },

    latestAttempt(taskId, targetSlotId) {
      // `target_slot_id = ?` 在 NULL 上恒为 NULL，结构 execution 会查不到自己，
      // 所以这里必须用 IS 而不是 =（SQLite 的 IS 对 NULL 做等值比较）。
      // 这与 §5.2 里 UNIQUE 约束在 NULL 上失效是同一个坑的两面。
      const row = db
        .prepare(
          'SELECT MAX(attempt_number) AS n FROM executions WHERE task_id = ? AND target_slot_id IS ?',
        )
        .get(taskId, targetSlotId) as { n: number | null } | undefined;
      return row?.n ?? 0;
    },

    markRunning(id) {
      db.prepare("UPDATE executions SET status = 'running', started_at = ? WHERE id = ?").run(
        clock(),
        id,
      );
    },

    markSucceeded(id, usage) {
      finish(id, 'succeeded', null, null, usage?.inputTokens ?? null, usage?.outputTokens ?? null);
    },

    recordUsage(id, usage) {
      usageStmt.run(usage.inputTokens, usage.outputTokens, id);
    },

    markFailed(id, errorCode, errorMessage) {
      finish(id, 'failed', errorCode, errorMessage);
    },

    markCancelled(id, reason) {
      finish(id, 'cancelled', 'EXECUTION_CANCELLED', reason ?? null);
    },

    markStale(id, reason) {
      finish(id, 'stale', 'EXECUTION_STALE', reason);
    },

    findOrphans() {
      const rows = db
        .prepare(
          `SELECT e.* FROM executions e
             JOIN tasks t ON t.id = e.task_id
            WHERE e.status IN ('created','running') AND t.status <> 'running'
            ORDER BY e.created_at`,
        )
        .all() as ExecutionRow[];
      return rows.map(toDomain);
    },
  };
}
