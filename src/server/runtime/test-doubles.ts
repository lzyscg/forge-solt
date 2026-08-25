/**
 * Runtime 集成测试用的内存假实现。
 *
 * §11.1 要求 Runtime 集成测试「无网络、可控时序」，因此每个 port 都有一份
 * 不碰数据库的实现。它们**不是 mock 框架生成的桩**：断言要能证伪，就得能查
 * 「写了哪些 trace」「提交了什么」，而不是「某个方法被调用了几次」。
 *
 * 本文件只被 `*.test.ts` 引用；放在 src 下是为了让它和被测代码走同一套
 * tsconfig 与 eslint 规则——test-double 写出类型错误也应该让 `tsc` 变红。
 */

import type { ErrorCode } from '@shared/errors.ts';
import type { TraceKind } from '@shared/trace.ts';
import type { StructureViolation } from '@server/domain/structure-validation.ts';
import type {
  CompletionOutcome,
  CompletionPort,
  CompletionRequest,
  OutlineSlot,
  SkillSnapshotView,
  SlotContentView,
  StructurePort,
  TracePort,
  TraceRecord,
} from './ports.ts';

export class FakeTracePort implements TracePort {
  readonly records: (TraceRecord & { taskId: string })[] = [];
  readonly deltas: { taskId: string; executionId: string; text: string }[] = [];

  record(taskId: string, record: TraceRecord): void {
    this.records.push({ ...record, taskId });
  }

  bufferOutput(taskId: string, executionId: string, delta: string): void {
    this.deltas.push({ taskId, executionId, text: delta });
  }

  kinds(kind: TraceKind): (TraceRecord & { taskId: string })[] {
    return this.records.filter((r) => r.kind === kind);
  }

  get outputText(): string {
    return this.deltas.map((d) => d.text).join('');
  }
}

export class FakeCompletionPort implements CompletionPort {
  readonly submissions: CompletionRequest[] = [];
  /** 按到达顺序消费；用完后一律成功。这样「第一次拒、第二次收」不需要写状态机 */
  readonly queued: CompletionOutcome[] = [];

  constructor(...outcomes: CompletionOutcome[]) {
    this.queued = [...outcomes];
  }

  static rejecting(code: ErrorCode, message: string, violations: StructureViolation[] = []): CompletionOutcome {
    return { ok: false, code, message, violations };
  }

  async submit(request: CompletionRequest): Promise<CompletionOutcome> {
    this.submissions.push(request);
    return this.queued.shift() ?? { ok: true };
  }
}

export class FakeStructurePort implements StructurePort {
  constructor(
    private readonly outline: readonly OutlineSlot[] = [],
    private readonly contents: Readonly<Record<string, SlotContentView>> = {},
  ) {}

  async readOutline(): Promise<readonly OutlineSlot[]> {
    return this.outline;
  }

  async readSlotContent(_taskId: string, slotId: string): Promise<SlotContentView | null> {
    return this.contents[slotId] ?? null;
  }
}

export const FAKE_SKILL: SkillSnapshotView = {
  id: 'scene-writing',
  version: '1.0.0',
  summary: '场景写作方法',
  preamble: '先读目标，再动笔。',
  requiredSections: ['S1'],
  sections: [
    { id: 'S1', title: '理解槽位目标', content: '把 instruction 拆成可写的动作。' },
    { id: 'S6', title: '提交前自检', content: '检查字数与禁用表达。' },
  ],
  sectionIndex: {
    S1: { id: 'S1', title: '理解槽位目标', content: '把 instruction 拆成可写的动作。' },
    S6: { id: 'S6', title: '提交前自检', content: '检查字数与禁用表达。' },
  },
};
