import { describe, expect, it } from 'vitest';
import type { SlotStatus, TaskStatus } from '@shared/contracts.ts';
import { ForgeError } from '@shared/errors.ts';
import {
  allowedSlotActions,
  allowedTaskActions,
  assertSlotTransition,
  assertTransition,
  canSlotTransition,
  canTransition,
  nextSlotStatus,
  nextTaskStatus,
} from './state-machine.ts';

const TASK_STATUSES: TaskStatus[] = ['ready', 'running', 'stopped', 'completed', 'failed'];
const SLOT_STATUSES: SlotStatus[] = ['pending', 'running', 'completed', 'failed'];

describe('任务状态机（文档 §6.4）', () => {
  it.each([
    ['ready', 'start', 'running'],
    ['running', 'stop', 'stopped'],
    ['running', 'fail', 'failed'],
    ['running', 'complete', 'completed'],
    ['stopped', 'resume', 'running'],
    ['failed', 'retry', 'running'],
  ] as const)('%s --%s--> %s', (from, action, to) => {
    expect(canTransition(from, action)).toBe(true);
    expect(nextTaskStatus(from, action)).toBe(to);
    expect(() => assertTransition(from, action)).not.toThrow();
  });

  it('D-14：ready --enqueue--> running（入队后状态即置 running，排队由 queuePosition 表达）', () => {
    expect(nextTaskStatus('ready', 'enqueue')).toBe('running');
  });

  it('start 对 stopped / failed 非法——它们分别用 resume / retry', () => {
    expect(canTransition('stopped', 'start')).toBe(false);
    expect(canTransition('failed', 'start')).toBe(false);
  });

  it('completed 是终态，任何动作都不合法', () => {
    expect(allowedTaskActions('completed')).toEqual([]);
  });

  it('每个状态的合法动作集合是穷举可枚举的', () => {
    expect(allowedTaskActions('ready').sort()).toEqual(['enqueue', 'start']);
    expect(allowedTaskActions('running').sort()).toEqual(['complete', 'fail', 'stop']);
    expect(allowedTaskActions('stopped')).toEqual(['resume']);
    expect(allowedTaskActions('failed')).toEqual(['retry']);
  });

  it('非法迁移抛 TASK_STATE_INVALID 而不是返回 null', () => {
    expect(() => nextTaskStatus('completed', 'start')).toThrow(ForgeError);
    try {
      assertTransition('ready', 'complete');
      expect.unreachable('应当抛错');
    } catch (error) {
      expect(error).toBeInstanceOf(ForgeError);
      expect((error as ForgeError).code).toBe('TASK_STATE_INVALID');
      expect((error as ForgeError).message).toContain('待启动');
    }
  });

  it('全部 状态 × 动作 组合都有确定答案（表是全量的，不存在 undefined）', () => {
    for (const from of TASK_STATUSES) {
      for (const action of ['start', 'stop', 'resume', 'retry', 'complete', 'fail', 'enqueue'] as const) {
        expect(typeof canTransition(from, action)).toBe('boolean');
      }
    }
  });
});

describe('槽位状态机（文档 §6.4）', () => {
  it.each([
    ['pending', 'schedule', 'running'],
    ['running', 'commit', 'completed'],
    ['running', 'exhaust', 'failed'],
    ['running', 'cancel', 'pending'],
    ['failed', 'reset', 'pending'],
  ] as const)('%s --%s--> %s', (from, action, to) => {
    expect(canSlotTransition(from, action)).toBe(true);
    expect(nextSlotStatus(from, action)).toBe(to);
  });

  it('completed 是终态', () => {
    expect(allowedSlotActions('completed')).toEqual([]);
  });

  it('pending 不能直接 commit——绕过调度提交就是 AC-011 要挡的那类写入', () => {
    expect(canSlotTransition('pending', 'commit')).toBe(false);
    expect(() => nextSlotStatus('pending', 'commit')).toThrow(ForgeError);
  });

  it('非法迁移抛 SLOT_NOT_READY，并带上 slot location', () => {
    try {
      assertSlotTransition('completed', 'schedule', 'scene_02');
      expect.unreachable('应当抛错');
    } catch (error) {
      expect(error).toBeInstanceOf(ForgeError);
      expect((error as ForgeError).code).toBe('SLOT_NOT_READY');
      expect((error as ForgeError).location).toBe('slot:scene_02');
    }
  });

  it('全部 状态 × 动作 组合都有确定答案', () => {
    for (const from of SLOT_STATUSES) {
      for (const action of ['schedule', 'commit', 'exhaust', 'cancel', 'reset'] as const) {
        expect(typeof canSlotTransition(from, action)).toBe('boolean');
      }
    }
  });
});
