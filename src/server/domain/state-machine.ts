/**
 * 任务与槽位状态机（文档 §6.4 / REQ §19.1 §19.2）。
 *
 * 把迁移表编码成数据而不是散落在各 service 的 if 判断里，理由有二：
 * 一是「哪些迁移合法」变成可穷举测试的对象；二是新增状态时编译器会强制
 * 补齐每张表的每一行（`Record<Status, ...>` 是全量的，漏一行不通过编译）。
 */

import type { SlotStatus, TaskStatus } from '@shared/contracts.ts';
import { ForgeError } from '@shared/errors.ts';

// ---------- 任务级 ----------

export type TaskAction = 'start' | 'stop' | 'resume' | 'retry' | 'complete' | 'fail' | 'enqueue';

export const TASK_ACTIONS = [
  'start',
  'stop',
  'resume',
  'retry',
  'complete',
  'fail',
  'enqueue',
] as const satisfies readonly TaskAction[];

/**
 * 迁移表（文档 §6.4）。`null` 表示该动作在该状态下非法。
 *
 * `start` 对 `stopped` / `failed` 非法是刻意的：它们分别用 `resume` / `retry`。
 * API 层把 `POST /start`、`/resume`、`/retry` 映射到不同 action，
 * 前端按 status 显示不同按钮文案（UX §9.1）。
 *
 * `enqueue`（D-14）：文档 §6.4 把它列进了 `TaskAction`，但下面的迁移表里没有它。
 * 按 D-14 的正文——「入队并返回 { queued: true }，任务状态置为 running」——
 * 补为 `ready → enqueue → running`。排队中是**任务级**表现（附录 B.1 第 2 行），
 * 由 `queuePosition` 而非独立状态表达，因此没有 `queued` 这个状态值。
 */
const TASK_TRANSITIONS: Record<TaskStatus, Record<TaskAction, TaskStatus | null>> = {
  ready: {
    start: 'running',
    enqueue: 'running',
    stop: null,
    resume: null,
    retry: null,
    complete: null,
    fail: null,
  },
  running: {
    start: null,
    enqueue: null,
    stop: 'stopped',
    resume: null,
    retry: null,
    complete: 'completed',
    fail: 'failed',
  },
  stopped: {
    start: null,
    enqueue: null,
    stop: null,
    resume: 'running',
    retry: null,
    complete: null,
    fail: null,
  },
  failed: {
    start: null,
    enqueue: null,
    stop: null,
    resume: null,
    retry: 'running',
    complete: null,
    fail: null,
  },
  // 终态：任何动作都不合法。产物已组装，再迁移就意味着历史被改写。
  completed: {
    start: null,
    enqueue: null,
    stop: null,
    resume: null,
    retry: null,
    complete: null,
    fail: null,
  },
};

export function canTransition(from: TaskStatus, action: TaskAction): boolean {
  return TASK_TRANSITIONS[from][action] !== null;
}

/** 非法迁移直接抛错而不是返回 null——返回 null 会诱使调用方用 `?? from` 静默吞掉 */
export function nextTaskStatus(from: TaskStatus, action: TaskAction): TaskStatus {
  const next = TASK_TRANSITIONS[from][action];
  if (next === null) throw taskTransitionError(from, action);
  return next;
}

export function assertTransition(from: TaskStatus, action: TaskAction): void {
  if (!canTransition(from, action)) throw taskTransitionError(from, action);
}

function taskTransitionError(from: TaskStatus, action: TaskAction): ForgeError {
  return new ForgeError(
    'TASK_STATE_INVALID',
    `任务处于「${TASK_STATUS_LABEL[from]}」状态，不能执行「${TASK_ACTION_LABEL[action]}」`,
    null,
    '刷新页面查看最新状态',
  );
}

/** 允许的迁移全表，供 UI 决定按钮可用性与测试穷举 */
export function allowedTaskActions(from: TaskStatus): TaskAction[] {
  return TASK_ACTIONS.filter((action) => canTransition(from, action));
}

const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  ready: '待启动',
  running: '生产中',
  stopped: '已停止',
  completed: '已完成',
  failed: '失败',
};

const TASK_ACTION_LABEL: Record<TaskAction, string> = {
  start: '启动',
  stop: '停止',
  resume: '继续',
  retry: '重试',
  complete: '完成',
  fail: '标记失败',
  enqueue: '入队',
};

// ---------- 槽位级 ----------

export type SlotAction =
  | 'schedule'
  | 'commit'
  | 'exhaust'
  | 'cancel'
  | 'reset'
  | 'commit_for_review'
  | 'review_clear'
  | 'review_revise';

export const SLOT_ACTIONS = [
  'schedule',
  'commit',
  'exhaust',
  'cancel',
  'reset',
  'commit_for_review',
  'review_clear',
  'review_revise',
] as const satisfies readonly SlotAction[];

/**
 * 状态清单导出，供测试穷举推导（§2.3.1）。
 * 与 SLOT_ACTIONS 一起用于「状态 × 动作」的完整遍历，避免本地硬编码清单。
 */
export const SLOT_STATUSES = [
  'pending',
  'running',
  'reviewing',
  'completed',
  'failed',
] as const satisfies readonly SlotStatus[];

/**
 * 槽位迁移表（文档 §6.4）。
 *
 * `running → cancel → pending` 覆盖两条路径：用户 stop，以及 §8.6 的重启恢复
 * 扫到孤儿 execution 后把槽位放回 pending。两者语义相同——本次尝试作废，
 * 槽位回到未开始，内容与 producer 都不写（AC-011）。
 *
 * 审核返修新增三条迁移与 reviewing 一行（§2.3）：
 * - `running → commit_for_review → reviewing`：绑定了审核 Skill 的槽位走这条；
 * - `reviewing → review_clear → completed`：未检出问题，或预算耗尽按现状完成；
 * - `reviewing → review_revise → pending`：回去返修（内容保留）；
 * - `reviewing → cancel → pending`：用户 stop 与孤儿恢复在审核期同样有效（AC-011）。
 *
 * `commit` 的现有行为一个字不改——未绑定审核的槽位仍走 `running → completed`。
 */
const SLOT_TRANSITIONS: Record<SlotStatus, Record<SlotAction, SlotStatus | null>> = {
  pending: {
    schedule: 'running',
    commit: null,
    exhaust: null,
    cancel: null,
    reset: null,
    commit_for_review: null,
    review_clear: null,
    review_revise: null,
  },
  running: {
    schedule: null,
    commit: 'completed',
    exhaust: 'failed',
    cancel: 'pending',
    reset: null,
    commit_for_review: 'reviewing',
    review_clear: null,
    review_revise: null,
  },
  reviewing: {
    schedule: null,
    commit: null,
    exhaust: null,
    cancel: 'pending',
    reset: null,
    commit_for_review: null,
    review_clear: 'completed',
    review_revise: 'pending',
  },
  failed: {
    schedule: null,
    commit: null,
    exhaust: null,
    cancel: null,
    reset: 'pending',
    commit_for_review: null,
    review_clear: null,
    review_revise: null,
  },
  completed: {
    schedule: null,
    commit: null,
    exhaust: null,
    cancel: null,
    reset: null,
    commit_for_review: null,
    review_clear: null,
    review_revise: null,
  },
};

export function canSlotTransition(from: SlotStatus, action: SlotAction): boolean {
  return SLOT_TRANSITIONS[from][action] !== null;
}

export function nextSlotStatus(from: SlotStatus, action: SlotAction): SlotStatus {
  const next = SLOT_TRANSITIONS[from][action];
  if (next === null) throw slotTransitionError(from, action);
  return next;
}

export function assertSlotTransition(from: SlotStatus, action: SlotAction, slotId?: string): void {
  if (!canSlotTransition(from, action)) throw slotTransitionError(from, action, slotId);
}

export function allowedSlotActions(from: SlotStatus): SlotAction[] {
  return SLOT_ACTIONS.filter((action) => canSlotTransition(from, action));
}

function slotTransitionError(from: SlotStatus, action: SlotAction, slotId?: string): ForgeError {
  return new ForgeError(
    'SLOT_NOT_READY',
    `槽位处于「${SLOT_STATUS_LABEL[from]}」状态，不能执行「${SLOT_ACTION_LABEL[action]}」`,
    slotId === undefined ? null : `slot:${slotId}`,
    '等待前置槽位完成',
  );
}

const SLOT_STATUS_LABEL: Record<SlotStatus, string> = {
  pending: '未填充',
  running: '正在填充',
  reviewing: '审核中',
  completed: '已完成',
  failed: '生产失败',
};

const SLOT_ACTION_LABEL: Record<SlotAction, string> = {
  schedule: '调度',
  commit: '提交',
  exhaust: '重试耗尽',
  cancel: '取消',
  reset: '重置',
  commit_for_review: '提交审核',
  review_clear: '审核结算',
  review_revise: '返修',
};
