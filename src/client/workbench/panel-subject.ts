/**
 * 工作台右栏主体的**单一判据**（§10.3②）。
 *
 * 右栏三块（摘要 / 轨迹 / 生产信息）共用这一个判别值，子组件拿到
 * `PanelSubject` 后**不得再判断 `task.phase` 或 `slot.contentBearing`**，
 * 否则会出现「上下打架」。容器分支不携带 execution，从类型上禁止伪造
 * Producer/耗时（§10.3③）。
 *
 * 纯函数，无 React、无 IO——便于穷举五分支做组件/单元测试。
 */

import type { ExecutionView, SlotView, StepperKey, TaskDetail } from '@shared/contracts.ts';

export type PanelSubject =
  | { kind: 'container'; slot: SlotView }
  | { kind: 'content'; slot: SlotView; execution: ExecutionView | null }
  | { kind: 'structure'; execution: ExecutionView | null }
  | { kind: 'input' }
  | { kind: 'assembly' };

export function determinePanelSubject(
  task: TaskDetail,
  selectedSlotId: string | null,
  stepperFocus: StepperKey | null,
  executions: ExecutionView[],
): PanelSubject {
  const structureExecution = latestBy(executions.filter((e) => e.operation === 'create_structure'));

  // 选中了槽位：按容器 / 内容分支
  if (selectedSlotId !== null) {
    const slot = task.slots.find((s) => s.id === selectedSlotId);
    if (slot !== undefined) {
      if (!slot.contentBearing) return { kind: 'container', slot };
      const execution =
        executions.find((e) => e.targetSlotId === slot.id && e.status === 'running') ??
        (task.activeExecution !== null && task.activeExecution.targetSlotId === slot.id ? task.activeExecution : null);
      return { kind: 'content', slot, execution };
    }
  }

  // 未选槽位：按 Stepper 焦点
  if (stepperFocus === 'input') return { kind: 'input' };
  if (stepperFocus === 'assembly' || stepperFocus === 'done') return { kind: 'assembly' };
  if (stepperFocus === 'structure') return { kind: 'structure', execution: structureExecution };

  // 未选槽位、无焦点：按任务阶段兜底
  if (task.phase === 'assembly' || task.phase === 'done') return { kind: 'assembly' };
  return { kind: 'structure', execution: structureExecution };
}

function latestBy(list: ExecutionView[]): ExecutionView | null {
  if (list.length === 0) return null;
  return [...list].sort((a, b) => a.attemptNumber - b.attemptNumber)[list.length - 1] ?? null;
}
