/**
 * 仓储装配点。
 *
 * 权威来源：§5.4 的 `UnitOfWork` 七个成员（R0 新增 slotReviews）。
 *
 * 唯一的硬性要求：**所有仓储必须收到同一个 `db` 句柄**。
 * 每个仓储各开一个连接，`uow.run()` 就会退化成若干个互不相干的事务，
 * §5.5 的八条边界全部失去原子性——而且不会有任何报错，
 * 只会在某次崩溃后留下一半写入的任务。
 */

import type { ForgeDb } from '../db.ts';
import type { Clock } from './types.ts';
import { systemClock } from './types.ts';
import type { ArtifactRepo } from './artifact-repo.ts';
import { createArtifactRepo } from './artifact-repo.ts';
import type { ExecutionRepo } from './execution-repo.ts';
import { createExecutionRepo } from './execution-repo.ts';
import type { SlotRepo } from './slot-repo.ts';
import { createSlotRepo } from './slot-repo.ts';
import type { SlotReviewsRepo } from './slot-reviews-repo.ts';
import { createSlotReviewsRepo } from './slot-reviews-repo.ts';
import type { SnapshotRepo } from './snapshot-repo.ts';
import { createSnapshotRepo } from './snapshot-repo.ts';
import type { TaskRepo } from './task-repo.ts';
import { createTaskRepo } from './task-repo.ts';
import type { TraceRepo } from './trace-repo.ts';
import { createTraceRepo } from './trace-repo.ts';

export type { ArtifactRepo, ExecutionRepo, SlotRepo, SlotReviewsRepo, SnapshotRepo, TaskRepo, TraceRepo };
export type { InsertArtifactInput } from './artifact-repo.ts';
export type { InsertExecutionInput } from './execution-repo.ts';
export type { CommitSlotContentInput, InsertSlotInput } from './slot-repo.ts';
export type { InsertSlotReviewInput, SlotReview } from './slot-reviews-repo.ts';
export type { InsertSnapshotInput } from './snapshot-repo.ts';
export type { InsertTaskInput, TaskPatch } from './task-repo.ts';
export type { InsertTraceInput } from './trace-repo.ts';
export type { Artifact, Clock, TaskSkillSnapshot, TaskSnapshot } from './types.ts';
export { systemClock } from './types.ts';
export { diagnoseStaleReason } from './stale-diagnosis.ts';

/** §5.4 的仓储集合。 */
export interface Repositories {
  tasks: TaskRepo;
  slots: SlotRepo;
  executions: ExecutionRepo;
  traces: TraceRepo;
  artifacts: ArtifactRepo;
  snapshots: SnapshotRepo;
  slotReviews: SlotReviewsRepo;
}

/**
 * 构造七个仓储。
 *
 * @param clock 注入时间源；测试用固定时钟做确定性断言（§11.4），生产用系统时钟。
 */
export function buildRepositories(db: ForgeDb, clock: Clock = systemClock): Repositories {
  return {
    tasks: createTaskRepo(db, clock),
    slots: createSlotRepo(db, clock),
    executions: createExecutionRepo(db, clock),
    traces: createTraceRepo(db, clock),
    artifacts: createArtifactRepo(db, clock),
    snapshots: createSnapshotRepo(db, clock),
    slotReviews: createSlotReviewsRepo(db, clock),
  };
}
