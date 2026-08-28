/**
 * TraceRepo —— `trace_events` 表。
 *
 * 权威来源：§5.2（sequence 的合同）、§5.5（Trace 写在事务内）、§3.3、§9.4、REQ §13。
 *
 * ## 只 insert，不 publish
 *
 * §5.5 的结论是「trace 写入在事务内，SSE 推送在事务提交之后」。理由：
 * 事务回滚而 trace 已经发出去，UI 会显示一个从未发生的事件——用户据此做的判断全是错的。
 * 所以本仓储**没有任何推送能力**，也不持有 sseHub。调用形态永远是
 * 事务内 `uow.traces.insert(...)` → `run()` 返回 → 事务外 `sseHub.publish(...)`。
 * 把 publish 塞进这里会让「事务提交之后」这个时序无处可保证。
 *
 * ## sequence 由这里分配，且只能在事务内
 *
 * `trace_events.sequence` 不是自增列，也没有序列表（见 001_initial.sql 表上方的注释）。
 * 本仓储在插入前执行 `SELECT MAX(sequence) + 1 FROM trace_events WHERE task_id = ?`。
 * 这个「读 + 写」之所以安全，恰恰是因为它必须跑在 `uow.run()` 的事务里：
 * better-sqlite3 全同步 + 单个 SQLite 写事务，读到写之间没有调度点。
 * `UNIQUE (task_id, sequence)` 是这条约定失守时的兜底——它只会让错误立刻炸掉，
 * 不会替你分配序号。
 */

import { randomUUID } from 'node:crypto';
import type { TraceActor, TraceEvent, TraceKind, TracePayload } from '@shared/trace.ts';
import { REVIEW_SETTLEMENT_KINDS } from '@shared/trace.ts';
import { TraceEventSchema } from '@shared/trace.ts';
import type { ForgeDb } from '../db.ts';
import type { Clock } from './types.ts';

interface TraceRow {
  id: string;
  task_id: string;
  execution_id: string | null;
  sequence: number;
  actor: string;
  kind: string;
  title: string;
  summary: string;
  payload_json: string | null;
  created_at: string;
}

export interface InsertTraceInput {
  taskId: string;
  executionId: string | null;
  actor: TraceActor;
  kind: TraceKind;
  title: string;
  summary: string;
  /** 已脱敏的展开区。写入前过 `TracePayloadSchema`，见 insert 的注释 */
  payload?: TracePayload | null;
  /** 仅供确定性测试注入；生产路径留空由仓储生成 */
  id?: string;
}

function toDomain(row: TraceRow): TraceEvent {
  return {
    id: row.id,
    taskId: row.task_id,
    executionId: row.execution_id,
    sequence: row.sequence,
    actor: row.actor as TraceActor,
    kind: row.kind as TraceKind,
    title: row.title,
    summary: row.summary,
    payload: row.payload_json === null ? null : (JSON.parse(row.payload_json) as TracePayload),
    createdAt: row.created_at,
  };
}

export interface TraceRepo {
  /** 分配 sequence 并插入；返回落库后的完整事件，供事务外推 SSE */
  insert(input: InsertTraceInput): TraceEvent;
  /** `GET /api/tasks/:id/traces?after=&limit=`（§9.4 断线补发也走它） */
  listByTask(taskId: string, options?: { after?: number; limit?: number }): TraceEvent[];
  listByExecution(executionId: string): TraceEvent[];
  /**
   * R2 的**轮次结算**事件：`execution_id IS NULL` 且 kind ∈ REVIEW_SETTLEMENT_KINDS。
   *
   * 两个条件缺一不可，见 `@shared/trace.ts` 里那组常量的注释：`review_no_finding`
   * 这个 kind 被用了两次，只按 kind 筛会把逐条判据的结果一起捞进来，
   * 一轮 4 条判据会被读成 5 条结算。
   *
   * 单独开一个方法而不是让调用方拉全量再筛：一个槽位的轨迹实测能到 685 条 / 81.7 KB，
   * 为了挑出 3 条结算把整条时间线读进内存，代价与收益差了两个数量级。
   */
  listSettlements(taskId: string): TraceEvent[];
  /** 当前已分配到的最大序号；0 表示该任务还没有事件 */
  maxSequence(taskId: string): number;
}

const DEFAULT_LIMIT = 200;

export function createTraceRepo(db: ForgeDb, clock: Clock): TraceRepo {
  const nextSeqStmt = db.prepare(
    'SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM trace_events WHERE task_id = ?',
  );
  const maxSeqStmt = db.prepare(
    'SELECT COALESCE(MAX(sequence), 0) AS max FROM trace_events WHERE task_id = ?',
  );
  const insertStmt = db.prepare(
    `INSERT INTO trace_events
       (id, task_id, execution_id, sequence, actor, kind, title, summary, payload_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const listStmt = db.prepare(
    'SELECT * FROM trace_events WHERE task_id = ? AND sequence > ? ORDER BY sequence LIMIT ?',
  );
  const byExecStmt = db.prepare(
    'SELECT * FROM trace_events WHERE execution_id = ? ORDER BY sequence',
  );
  // 占位符按常量长度展开一次。kind 列表来自 @shared/trace.ts 的 as const 数组，
  // 不含任何外部输入，但仍走参数绑定——SQL 里没有字符串拼接的例外。
  const settlementStmt = db.prepare(
    `SELECT * FROM trace_events
     WHERE task_id = ? AND execution_id IS NULL
       AND kind IN (${REVIEW_SETTLEMENT_KINDS.map(() => '?').join(', ')})
     ORDER BY sequence`,
  );

  return {
    insert(input) {
      const { next } = nextSeqStmt.get(input.taskId) as { next: number };

      const event: TraceEvent = TraceEventSchema.parse({
        id: input.id ?? randomUUID(),
        taskId: input.taskId,
        executionId: input.executionId,
        sequence: next,
        actor: input.actor,
        kind: input.kind,
        title: input.title,
        summary: input.summary,
        payload: input.payload ?? null,
        createdAt: clock(),
      });
      // 先 parse 再落库，而不是「拼 JSON 直接 insert」：
      // TracePayloadSchema 带 REQ §13 的递归键名黑名单（api_key / authorization /
      // reasoning ...），绕开 schema 就等于绕开脱敏。trace 会原样进 API 响应和页面，
      // 一次疏漏就是密钥上屏，所以这道校验放在**唯一的写入口**上，
      // 而不是指望每个调用点自己记得先 parse。

      insertStmt.run(
        event.id,
        event.taskId,
        event.executionId,
        event.sequence,
        event.actor,
        event.kind,
        event.title,
        event.summary,
        event.payload === null ? null : JSON.stringify(event.payload),
        event.createdAt,
      );

      return event;
    },

    listByTask(taskId, options) {
      const rows = listStmt.all(
        taskId,
        options?.after ?? 0,
        options?.limit ?? DEFAULT_LIMIT,
      ) as TraceRow[];
      return rows.map(toDomain);
    },

    listByExecution(executionId) {
      return (byExecStmt.all(executionId) as TraceRow[]).map(toDomain);
    },

    listSettlements(taskId) {
      const rows = settlementStmt.all(taskId, ...REVIEW_SETTLEMENT_KINDS) as TraceRow[];
      return rows.map(toDomain);
    },

    maxSequence(taskId) {
      return (maxSeqStmt.get(taskId) as { max: number }).max;
    },
  };
}
