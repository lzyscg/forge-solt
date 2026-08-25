/**
 * TaskRepo —— `tasks` 表。
 *
 * 权威来源：§5.2（DDL）、§5.5（事务边界：创建 Task / 创建 Assignment / 提交 Structure /
 * 提交 Slot Content / Stop / 完成 Artifact / 重置失败 Slot / 启动恢复）、D-10、D-18。
 *
 * 本仓储承担 §5.5 八条边界里 tasks 那一半的写入。它自己不开事务——
 * 事务由 `uow.run()` 统一划定，仓储方法都是「事务内的一步」。
 */

import type { ErrorCode } from '@shared/errors.ts';
import type { TaskPhase, TaskStatus } from '@shared/contracts.ts';
import { ForgeError } from '@shared/errors.ts';
import type { Task } from '@server/domain/types.ts';
import type { ForgeDb } from '../db.ts';
import type { Clock } from './types.ts';
import { buildSetClause } from './types.ts';

interface TaskRow {
  id: string;
  name: string;
  snapshot_id: string;
  input_json: string;
  status: string;
  phase: string;
  active_execution_id: string | null;
  artifact_id: string | null;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

export interface InsertTaskInput {
  id: string;
  name: string;
  snapshotId: string;
  input: Readonly<Record<string, string>>;
  status: TaskStatus;
  phase: TaskPhase;
}

/**
 * 可更新字段。
 *
 * `undefined` = 不动这一列，`null` = 置空。两者必须区分：Stop 与「提交 Structure」
 * 都要把 `activeExecutionId` 显式置 null，若把 null 与「没传」混为一谈，
 * 旧 execution 会一直挂在任务上，D-10 的 `t.active_execution_id = e.id` 就永远成立——
 * 停止功能会静默失效而不报错。
 *
 * `updatedAt` 不在其中：它由仓储无条件维护，让调用方可选地传一个时间戳，
 * 等于允许出现「改了内容但 updatedAt 没动」的行，任务列表的排序（idx_tasks_status_upd）会失真。
 */
export interface TaskPatch {
  name?: string;
  status?: TaskStatus;
  phase?: TaskPhase;
  activeExecutionId?: string | null;
  artifactId?: string | null;
  errorCode?: ErrorCode | null;
  errorMessage?: string | null;
}

const PATCH_COLUMNS: Record<keyof TaskPatch, string> = {
  name: 'name',
  status: 'status',
  phase: 'phase',
  activeExecutionId: 'active_execution_id',
  artifactId: 'artifact_id',
  errorCode: 'error_code',
  errorMessage: 'error_message',
};

function toDomain(row: TaskRow): Task {
  return {
    id: row.id,
    name: row.name,
    snapshotId: row.snapshot_id,
    input: JSON.parse(row.input_json) as Record<string, string>,
    status: row.status as TaskStatus,
    phase: row.phase as TaskPhase,
    activeExecutionId: row.active_execution_id,
    artifactId: row.artifact_id,
    errorCode: row.error_code as ErrorCode | null,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface TaskRepo {
  insert(input: InsertTaskInput): Task;
  get(id: string): Task | null;
  /** 取不到即抛 `TASK_NOT_FOUND`，省掉调用点满地的 `if (!task) throw` */
  getOrThrow(id: string): Task;
  findByStatus(status: TaskStatus): Task[];
  listRecent(limit: number): Task[];
  /**
   * D-08 模板详情页的「引用该模板的任务」。
   *
   * 模板归属记在 `task_snapshots.template_id`（tasks 表上没有 template_id——
   * 任务用的是**快照**，不是磁盘上那份模板），所以要 JOIN 一次。
   * 放在 TaskRepo 而不是 SnapshotRepo：返回的是 Task 行，
   * 而 SnapshotRepo 那边的 `countTasksByTemplate` 数的是 snapshot 行，
   * 不需要 JOIN 也不需要认识 tasks 的排序列。
   */
  listByTemplate(templateId: string, limit: number): Task[];
  update(id: string, patch: TaskPatch): void;
  /**
   * §5.5「提交 Structure」的守卫写法，见方法体注释。
   * 返回值无意义时不返回；不满足条件直接抛 `EXECUTION_STALE`。
   */
  completeStructurePhase(input: { taskId: string; executionId: string }): void;
}

export function createTaskRepo(db: ForgeDb, clock: Clock): TaskRepo {
  const insertStmt = db.prepare(
    `INSERT INTO tasks
       (id, name, snapshot_id, input_json, status, phase,
        active_execution_id, artifact_id, error_code, error_message, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?)`,
  );
  const getStmt = db.prepare('SELECT * FROM tasks WHERE id = ?');
  const byStatusStmt = db.prepare('SELECT * FROM tasks WHERE status = ? ORDER BY updated_at DESC');
  /**
   * `id DESC` 是**同刻并列的破平手段**，不是排序意图。
   *
   * `updated_at` 只到毫秒，而连着建两个任务完全可能落在同一毫秒里。
   * 不破平的话，并列行的先后由 SQLite 自己决定——今天是 rowid 序，
   * 换一个查询计划（比如走 idx_tasks_status_upd 而不是全表扫）就可能是另一个序。
   * 表现是任务列表在两次刷新之间自己跳行，而数据一个字都没变。
   *
   * ID 是 randomUUID，所以这个次序本身没有意义；有意义的是它**稳定**。
   * 与 template-catalog 里对目录序排序是同一条纪律：
   * 宁可要一个任意但可复现的顺序，也不要一个「在别人机器上不一样」的顺序。
   */
  const recentStmt = db.prepare('SELECT * FROM tasks ORDER BY updated_at DESC, id DESC LIMIT ?');
  // `t.*` 而不是 `*`：JOIN 之后 `*` 会把 task_snapshots 的列也带出来，
  // 其中 `id` / `created_at` 与 tasks 同名，toDomain 读到的会是快照的那一份。
  const byTemplateStmt = db.prepare(
    `SELECT t.* FROM tasks t
       JOIN task_snapshots s ON s.task_id = t.id
      WHERE s.template_id = ?
      ORDER BY t.updated_at DESC, t.id DESC
      LIMIT ?`,
  );

  return {
    insert(input) {
      const now = clock();
      insertStmt.run(
        input.id,
        input.name,
        input.snapshotId,
        JSON.stringify(input.input),
        input.status,
        input.phase,
        now,
        now,
      );
      return {
        ...input,
        activeExecutionId: null,
        artifactId: null,
        errorCode: null,
        errorMessage: null,
        createdAt: now,
        updatedAt: now,
      };
    },

    get(id) {
      const row = getStmt.get(id) as TaskRow | undefined;
      return row === undefined ? null : toDomain(row);
    },

    getOrThrow(id) {
      const row = getStmt.get(id) as TaskRow | undefined;
      if (row === undefined) {
        throw new ForgeError('TASK_NOT_FOUND', `任务 ${id} 不存在`, `task:${id}`);
      }
      return toDomain(row);
    },

    findByStatus(status) {
      return (byStatusStmt.all(status) as TaskRow[]).map(toDomain);
    },

    listRecent(limit) {
      return (recentStmt.all(limit) as TaskRow[]).map(toDomain);
    },

    listByTemplate(templateId, limit) {
      return (byTemplateStmt.all(templateId, limit) as TaskRow[]).map(toDomain);
    },

    update(id, patch) {
      const set = buildSetClause(patch as Record<string, unknown>, PATCH_COLUMNS);
      if (set === null) return; // 空 patch 不该拼出 `SET updated_at = ?` 这种「只碰了时间」的假更新
      db.prepare(`UPDATE tasks SET ${set.sql}, updated_at = ? WHERE id = ?`).run(
        ...set.params,
        clock(),
        id,
      );
    },

    completeStructurePhase({ taskId, executionId }) {
      // 与 D-10 同一套手法：把「这次结构提交是否仍然当前」的判据压进 WHERE，
      // 用受影响行数判成败，而不是先 SELECT 再 if。
      // §5.5 的表里「提交 Structure」没有像「提交 Slot Content」那样点名 D-10，
      // 但两者面对的是同一个风险——stop 事务插进读判写窗口，把一次已被取消的
      // 结构执行的结果照样写进库。结构提交同时要 INSERT n 个槽位，
      // 一旦漏判，留下的是一棵不该存在的完整结构树，比单个槽位更难收拾。
      // 槽位 INSERT 与本语句在同一事务内，本语句抛错即整体回滚。
      const info = db
        .prepare(
          `UPDATE tasks
              SET phase = 'slots', active_execution_id = NULL, updated_at = ?
            WHERE id = ? AND status = 'running' AND active_execution_id = ?`,
        )
        .run(clock(), taskId, executionId);

      if (info.changes !== 1) {
        throw new ForgeError(
          'EXECUTION_STALE',
          `结构提交被拒绝：任务 ${taskId} 的活动执行已不是 ${executionId}`,
          `task:${taskId}`,
        );
      }
    },
  };
}
