/**
 * 附录 B 的逐行覆盖测试。
 *
 * 用例名直接写规则表的行号（文档附录 B 的修订说明明确要求这么做）：
 * 规则不可求值、或实现漏了某一行，会在这里立刻暴露，而不是等到前端渲染出空白。
 */

import { describe, expect, it } from 'vitest';
import type { Execution, Slot, Task } from './types.ts';
import type { SlotPresentationInput, TaskPresentationInput } from './presentation.ts';
import { deriveSlotPresentation, deriveTaskPresentation } from './presentation.ts';

function slot(partial: Partial<Slot> & Pick<Slot, 'slotId'>): Slot {
  return {
    taskId: 'task_1',
    type: 'scene',
    parentId: null,
    sortOrder: 0,
    instruction: '',
    dependsOn: [],
    contentBearing: true,
    includeInArtifact: true,
    status: 'pending',
    revisionRound: 0,
    reviewExhausted: false,
    contentText: null,
    producer: null,
    errorCode: null,
    errorMessage: null,
    createdAt: '2026-08-20T00:00:00.000Z',
    updatedAt: '2026-08-20T00:00:00.000Z',
    ...partial,
  };
}

function task(partial: Partial<Task> = {}): Task {
  return {
    id: 'task_1',
    name: '第 3 章',
    snapshotId: 'snap_1',
    input: {},
    status: 'ready',
    phase: 'structure',
    activeExecutionId: null,
    artifactId: null,
    errorCode: null,
    errorMessage: null,
    createdAt: '2026-08-20T00:00:00.000Z',
    updatedAt: '2026-08-20T00:00:00.000Z',
    ...partial,
  };
}

function execution(partial: Partial<Execution> = {}): Execution {
  return {
    id: 'exec_1',
    taskId: 'task_1',
    operation: 'fill_slot',
    targetSlotId: 'scene_01',
    agentId: 'writer',
    skillId: 'scene_skill',
    skillVersion: '1.0.0',
    tokenHash: 'th',
    contextHash: 'ch',
    promptHash: 'ph',
    modelAlias: 'main',
    provider: 'deepseek',
    model: 'deepseek-chat',
    attemptNumber: 1,
    status: 'running',
    inputTokens: null,
    outputTokens: null,
    startedAt: null,
    finishedAt: null,
    errorCode: null,
    errorMessage: null,
    createdAt: '2026-08-20T00:00:00.000Z',
    ...partial,
  };
}

function taskInput(partial: Partial<TaskPresentationInput> & Pick<TaskPresentationInput, 'task'>): TaskPresentationInput {
  return {
    slots: [],
    activeExecution: null,
    currentSlotTypeName: null,
    queuePosition: null,
    lastFailureReason: null,
    ...partial,
  };
}

function slotInput(partial: Partial<SlotPresentationInput> & Pick<SlotPresentationInput, 'slot'>): SlotPresentationInput {
  return {
    allSlots: [partial.slot],
    activeAttempt: null,
    lastFailureReason: null,
    elapsedMs: null,
    taskStatus: 'running',
    isInterruptionPoint: false,
    agentName: null,
    ...partial,
  };
}

// ---------- B.1 任务级，13 行 ----------

describe('附录 B.1 deriveTaskPresentation', () => {
  it('B.1 第 1 行：status=ready → idle/待启动', () => {
    expect(deriveTaskPresentation(taskInput({ task: task({ status: 'ready' }) }))).toEqual({
      tone: 'idle',
      state: '待启动',
      detail: '冻结输入已就绪，尚未开始生产',
    });
  });

  it('B.1 第 2 行：running 且 queuePosition!=null → wait/排队中', () => {
    const out = deriveTaskPresentation(
      taskInput({ task: task({ status: 'running', phase: 'slots' }), queuePosition: 2 }),
    );
    expect(out).toEqual({ tone: 'wait', state: '排队中', detail: '前面还有 2 个任务' });
  });

  it('B.1 第 2 行优先于第 3~8 行：排队中即便 phase=structure 也不显示「创建结构」', () => {
    const out = deriveTaskPresentation(
      taskInput({ task: task({ status: 'running', phase: 'structure' }), queuePosition: 0 }),
    );
    expect(out.state).toBe('排队中');
  });

  it('B.1 第 3 行：running/structure 且 attempt>1 → warn/结构重试中', () => {
    const out = deriveTaskPresentation(
      taskInput({
        // D-19：取 lastFailureReason 而非 task.errorMessage——
        // 重试中的任务 status 仍是 running，errorMessage 是终态字段
        task: task({ status: 'running', phase: 'structure' }),
        lastFailureReason: '缺少 chapter 根槽位',
        activeExecution: execution({ operation: 'create_structure', attemptNumber: 2 }),
      }),
    );
    expect(out).toEqual({
      tone: 'warn',
      state: '结构重试中',
      detail: '第 2 次尝试 · 上次缺少 chapter 根槽位',
    });
  });

  it('B.1 第 4 行：running/structure → run/创建结构', () => {
    const out = deriveTaskPresentation(
      taskInput({
        task: task({ status: 'running', phase: 'structure' }),
        activeExecution: execution({ operation: 'create_structure', attemptNumber: 1 }),
      }),
    );
    expect(out).toEqual({
      tone: 'run',
      state: '创建结构',
      detail: 'Structure Agent 正在设计章节结构',
    });
  });

  it('B.1 第 5 行：running/slots 且 attempt>1 → warn/超时重试', () => {
    const out = deriveTaskPresentation(
      taskInput({
        task: task({ status: 'running', phase: 'slots' }),
        lastFailureReason: '180 秒超时',
        slots: [slot({ slotId: 'scene_01', status: 'running' })],
        activeExecution: execution({ attemptNumber: 2 }),
      }),
    );
    expect(out).toEqual({ tone: 'warn', state: '超时重试', detail: '第 2 次尝试 · 上次180 秒超时' });
  });

  it('B.1 第 6 行：running/slots 且有 running slot → run/正在填充 Slot', () => {
    const out = deriveTaskPresentation(
      taskInput({
        task: task({ status: 'running', phase: 'slots' }),
        slots: [
          slot({ slotId: 'scene_01', sortOrder: 0, status: 'completed' }),
          slot({ slotId: 'scene_02', sortOrder: 1, status: 'running' }),
        ],
        activeExecution: execution({ targetSlotId: 'scene_02' }),
        currentSlotTypeName: '场景正文',
      }),
    );
    expect(out).toEqual({
      tone: 'run',
      state: '正在填充 Slot',
      detail: 'scene_02 场景正文生成中',
    });
  });

  it('B.1 第 7 行：running/slots 且无 running slot → wait/等待调度', () => {
    const out = deriveTaskPresentation(
      taskInput({
        task: task({ status: 'running', phase: 'slots' }),
        slots: [
          slot({ slotId: 'chapter', contentBearing: false }),
          slot({ slotId: 'scene_01', sortOrder: 0, status: 'completed' }),
          slot({ slotId: 'scene_02', sortOrder: 1, status: 'pending' }),
        ],
      }),
    );
    expect(out).toEqual({
      tone: 'wait',
      state: '等待调度',
      detail: '1/2 已完成，正在选择下一槽位',
    });
  });

  it('B.1 第 8 行：running/assembly → run/组装中', () => {
    const out = deriveTaskPresentation(
      taskInput({
        task: task({ status: 'running', phase: 'assembly' }),
        slots: [slot({ slotId: 'scene_01', status: 'completed' })],
      }),
    );
    expect(out).toEqual({ tone: 'run', state: '组装中', detail: '1 个槽位全部通过，正在组装产物' });
  });

  it('B.1 第 9 行：status=stopped → idle/已停止，且点名续跑位置', () => {
    const out = deriveTaskPresentation(
      taskInput({
        task: task({ status: 'stopped', phase: 'slots' }),
        slots: [
          slot({ slotId: 'chapter', contentBearing: false }),
          slot({ slotId: 'scene_01', parentId: 'chapter', sortOrder: 0, status: 'completed' }),
          slot({ slotId: 'scene_02', parentId: 'chapter', sortOrder: 1, status: 'pending' }),
        ],
      }),
    );
    expect(out).toEqual({
      tone: 'idle',
      state: '已停止',
      detail: '运营手动停止，可从 scene_02 续跑',
    });
  });

  it('B.1 第 10 行：failed/structure → fail/结构校验失败，detail 是首条违规 message', () => {
    const out = deriveTaskPresentation(
      taskInput({
        task: task({
          status: 'failed',
          phase: 'structure',
          errorCode: 'STRUCTURE_RETRY_EXHAUSTED',
          errorMessage: '要求恰好 3 个场景，实收 2 个',
        }),
      }),
    );
    expect(out).toEqual({
      tone: 'fail',
      state: '结构校验失败',
      detail: '要求恰好 3 个场景，实收 2 个',
    });
  });

  it('B.1 第 11 行：failed/slots → fail/槽位生产失败，detail 含槽位 ID', () => {
    const out = deriveTaskPresentation(
      taskInput({
        task: task({ status: 'failed', phase: 'slots' }),
        slots: [
          slot({ slotId: 'scene_01', sortOrder: 0, status: 'completed' }),
          slot({
            slotId: 'scene_02',
            sortOrder: 1,
            status: 'failed',
            errorMessage: '连续 2 次超时，重试已用尽',
          }),
        ],
      }),
    );
    expect(out).toEqual({
      tone: 'fail',
      state: '槽位生产失败',
      detail: 'scene_02 连续 2 次超时，重试已用尽',
    });
  });

  it('B.1 第 12 行：failed/assembly → fail/组装失败，并声明已完成内容保留', () => {
    const out = deriveTaskPresentation(
      taskInput({
        task: task({ status: 'failed', phase: 'assembly', errorMessage: '产物写入失败' }),
      }),
    );
    expect(out).toEqual({
      tone: 'fail',
      state: '组装失败',
      detail: '产物写入失败，已完成槽位内容保留',
    });
  });

  it('B.1 第 13 行：status=completed → ok/已完成', () => {
    const out = deriveTaskPresentation(
      taskInput({
        task: task({ status: 'completed', phase: 'done' }),
        slots: [
          slot({ slotId: 'chapter', contentBearing: false }),
          slot({ slotId: 'scene_01', status: 'completed' }),
          slot({ slotId: 'scene_02', status: 'completed' }),
        ],
      }),
    );
    expect(out).toEqual({ tone: 'ok', state: '已完成', detail: '2 个槽位全部通过，产物已组装' });
  });

  /**
   * D-30：「全部通过」这四个字只有在真的全部通过时才能说。
   *
   * 来自 2026-08-27 的真实任务：`scene1` 的 S2 连续三轮检出问题，返修预算打满，
   * 系统按 D-26 放行（`review_exhausted = 1`）。放行是对的——任务永不因审核卡死；
   * 但当时任务列表上写的是「5 个槽位全部通过，产物已组装」，
   * 而那三条 S2 问题**一条都没修掉**。用户要往下点三层才能发现。
   *
   * 与「未检出问题不能写成审核通过」是同一条纪律，只是位置更靠前、危害更大：
   * 它出现在可见度最高的那一层，是绝大多数人唯一会看的一句话。
   */
  it('B.1 第 13 行 · D-30：有槽位返修次数用尽时，不许说「全部通过」', () => {
    const out = deriveTaskPresentation(
      taskInput({
        task: task({ status: 'completed', phase: 'done' }),
        slots: [
          slot({ slotId: 'chapter', contentBearing: false }),
          slot({ slotId: 'scene_01', status: 'completed', reviewExhausted: true }),
          slot({ slotId: 'scene_02', status: 'completed' }),
        ],
      }),
    );
    expect(out.detail).not.toContain('全部通过');
    expect(out).toEqual({
      tone: 'ok',
      state: '已完成',
      detail: '2 个槽位已完成，其中 1 个返修次数用尽、按现状放行，产物已组装',
    });
  });

  it('B.1 第 8 行 · D-30：组装中同样不许把「按现状放行」说成「全部通过」', () => {
    const out = deriveTaskPresentation(
      taskInput({
        task: task({ status: 'running', phase: 'assembly' }),
        slots: [
          slot({ slotId: 'chapter', contentBearing: false }),
          slot({ slotId: 'scene_01', status: 'completed', reviewExhausted: true }),
        ],
      }),
    );
    expect(out.detail).not.toContain('全部通过');
    expect(out.detail).toBe('1 个槽位已完成，其中 1 个返修次数用尽、按现状放行，正在组装产物');
  });

  it('B.1 第 14 行：未命中任何行（running/done、failed/done 这类脏数据）→ idle/状态未知', () => {
    // D-19：不抛错（派生函数跑在每次列表渲染上），也不伪装成某个正常状态；
    // detail 把状态组合原样交出来，便于从界面直接定位脏数据。
    expect(deriveTaskPresentation(taskInput({ task: task({ status: 'running', phase: 'done' }) }))).toEqual({
      tone: 'idle',
      state: '状态未知',
      detail: '任务处于未预期的状态组合：running/done',
    });
    expect(deriveTaskPresentation(taskInput({ task: task({ status: 'failed', phase: 'done' }) }))).toEqual({
      tone: 'idle',
      state: '状态未知',
      detail: '任务处于未预期的状态组合：failed/done',
    });
  });

  it('失败原因缺失时不撒谎也不留空（第 3 / 第 5 行的兜底）', () => {
    const out = deriveTaskPresentation(
      taskInput({
        task: task({ status: 'running', phase: 'structure' }),
        activeExecution: execution({ attemptNumber: 3 }),
      }),
    );
    expect(out.detail).toBe('第 3 次尝试 · 上次执行失败');
  });
});

// ---------- B.2 槽位级，8 行 ----------

describe('附录 B.2 deriveSlotPresentation', () => {
  it('B.2 第 1 行：contentBearing=false → container/容器槽位', () => {
    const container = slot({ slotId: 'chapter', contentBearing: false, status: 'completed' });
    const out = deriveSlotPresentation(
      slotInput({
        slot: container,
        allSlots: [
          container,
          slot({ slotId: 'scene_01', parentId: 'chapter' }),
          slot({ slotId: 'scene_02', parentId: 'chapter' }),
        ],
      }),
    );
    expect(out).toEqual({
      tone: 'container',
      state: '容器槽位',
      detail: '收拢 2 个下级槽位',
      blockedBy: [],
      charCount: null,
    });
  });

  it('B.2 第 1 行必须在最前（理由 a）：completed 的容器槽位显示「容器槽位」而非「已完成 · N 字」', () => {
    const container = slot({
      slotId: 'chapter',
      contentBearing: false,
      status: 'completed',
      contentText: '不该被当成正文的东西',
    });
    const out = deriveSlotPresentation(slotInput({ slot: container, allSlots: [container] }));
    expect(out.state).toBe('容器槽位');
    expect(out.state).not.toBe('已完成');
    expect(out.charCount).toBeNull();
  });

  it('B.2 第 2 行：taskStatus=stopped 且 isInterruptionPoint → idle/已停止', () => {
    const out = deriveSlotPresentation(
      slotInput({
        slot: slot({ slotId: 'scene_02', status: 'pending' }),
        taskStatus: 'stopped',
        isInterruptionPoint: true,
      }),
    );
    expect(out).toMatchObject({
      tone: 'idle',
      state: '已停止',
      detail: '运营手动停止 · 可从此处续跑',
    });
  });

  it('B.2 第 2 行必须在 running 之前（理由 b）：任务已停止时中断点槽位即便仍是 running 也显示「已停止」', () => {
    const out = deriveSlotPresentation(
      slotInput({
        slot: slot({ slotId: 'scene_02', status: 'running' }),
        taskStatus: 'stopped',
        isInterruptionPoint: true,
        activeAttempt: 1,
        elapsedMs: 42_000,
      }),
    );
    expect(out.state).toBe('已停止');
    expect(out.state).not.toBe('正在填充');
  });

  it('B.2 第 2 行不误伤：任务已停止但该槽位不是中断点时，按自身状态渲染', () => {
    const out = deriveSlotPresentation(
      slotInput({
        slot: slot({ slotId: 'scene_01', status: 'completed', contentText: '正文' }),
        taskStatus: 'stopped',
        isInterruptionPoint: false,
      }),
    );
    expect(out.state).toBe('已完成');
  });

  it('B.2 第 3 行：pending 且 blockedBy 非空 → wait/等待依赖，且必须点名在等谁', () => {
    const target = slot({ slotId: 'scene_03', dependsOn: ['scene_01', 'scene_02'] });
    const out = deriveSlotPresentation(
      slotInput({
        slot: target,
        allSlots: [
          target,
          slot({ slotId: 'scene_01', status: 'completed' }),
          slot({ slotId: 'scene_02', status: 'running' }),
        ],
      }),
    );
    expect(out).toEqual({
      tone: 'wait',
      state: '等待依赖',
      detail: '等待 scene_02 定稿',
      blockedBy: ['scene_02'],
      charCount: null,
    });
  });

  it('B.2 第 4 行：pending 且依赖已满足 → idle/未填充', () => {
    const target = slot({ slotId: 'scene_02', dependsOn: ['scene_01'] });
    const out = deriveSlotPresentation(
      slotInput({
        slot: target,
        allSlots: [target, slot({ slotId: 'scene_01', status: 'completed' })],
      }),
    );
    expect(out).toEqual({
      tone: 'idle',
      state: '未填充',
      detail: '等待执行',
      blockedBy: [],
      charCount: null,
    });
  });

  // R2 B.2 第 4' 行：pending 且 revisionRound > 0 → warn/返修中（第 N 次）
  it("R2 B.2 第 4' 行：pending 且 revisionRound>0 → warn/返修中", () => {
    const out = deriveSlotPresentation(
      slotInput({
        slot: slot({ slotId: 'scene_01', status: 'pending', revisionRound: 2, contentText: '上一稿正文' }),
      }),
    );
    expect(out).toEqual({
      tone: 'warn',
      state: '返修中',
      detail: '第 2 次返修',
      blockedBy: [],
      charCount: 5,
    });
  });

  // R2 B.2 第 6' 行：reviewing → run/审核中
  it("R2 B.2 第 6' 行：reviewing → run/审核中", () => {
    const out = deriveSlotPresentation(
      slotInput({
        slot: slot({ slotId: 'scene_01', status: 'reviewing', contentText: '待审正文' }),
      }),
    );
    expect(out).toEqual({
      tone: 'run',
      state: '审核中',
      detail: '内容已提交，正在按判据审核',
      blockedBy: [],
      charCount: 4,
    });
  });

  it('B.2 第 5 行：running 且 activeAttempt>1 → warn/超时重试，含重试计数与上次原因', () => {
    const out = deriveSlotPresentation(
      slotInput({
        slot: slot({ slotId: 'scene_01', status: 'running' }),
        activeAttempt: 2,
        lastFailureReason: '180 秒超时',
        elapsedMs: 5_000,
      }),
    );
    expect(out).toMatchObject({
      tone: 'warn',
      state: '超时重试',
      detail: '第 2 次尝试 · 上次180 秒超时',
    });
  });

  it('B.2 第 6 行：running → run/正在填充，含 Agent 名与已耗秒数', () => {
    const out = deriveSlotPresentation(
      slotInput({
        slot: slot({ slotId: 'scene_01', status: 'running' }),
        activeAttempt: 1,
        elapsedMs: 42_800,
        agentName: '场景作者',
      }),
    );
    expect(out).toMatchObject({ tone: 'run', state: '正在填充', detail: '场景作者 生成中 · 已 42 秒' });
  });

  it('B.2 第 6 行：elapsedMs 为 null 时不编造耗时', () => {
    const out = deriveSlotPresentation(
      slotInput({ slot: slot({ slotId: 'scene_01', status: 'running' }), agentName: '场景作者' }),
    );
    expect(out.detail).toBe('场景作者 生成中');
  });

  it('B.2 第 6 行：agentName 为 null 时省略主语，不退化成「Agent」', () => {
    // D-19：「Agent 生成中」读起来像有个叫 Agent 的东西在干活，
    // 把调用方的接线缺失盖住了。省略主语的句子读得出「这里没有名字」。
    const out = deriveSlotPresentation(
      slotInput({
        slot: slot({ slotId: 'scene_01', status: 'running' }),
        elapsedMs: 12_000,
        agentName: null,
      }),
    );
    expect(out.detail).toBe('生成中 · 已 12 秒');
    expect(out.detail).not.toContain('Agent');
  });

  it('B.2 第 7 行：completed → ok/已完成，detail 给可核对的字数事实', () => {
    const out = deriveSlotPresentation(
      slotInput({
        slot: slot({ slotId: 'scene_01', status: 'completed', contentText: '字'.repeat(1486) }),
      }),
    );
    expect(out).toEqual({
      tone: 'ok',
      state: '已完成',
      detail: '1,486 字 · 校验通过',
      blockedBy: [],
      charCount: 1486,
    });
  });

  // R2 B.2 第 7 修订行：completed 且 reviewExhausted → ok/已完成（返修次数用尽）
  it('R2 B.2 第 7 修订行：completed 且 reviewExhausted → 不用警示色', () => {
    const out = deriveSlotPresentation(
      slotInput({
        slot: slot({
          slotId: 'scene_01',
          status: 'completed',
          reviewExhausted: true,
          contentText: '字'.repeat(1200),
        }),
      }),
    );
    expect(out.tone).toBe('ok');
    expect(out.state).toBe('已完成');
    expect(out.detail).toContain('返修次数用尽');
    expect(out.detail).not.toContain('失败');
  });

  it("B.2 第 7' 行：工作槽位是「{charCount} 字 · 不进正文」，不叠加「校验通过」", () => {
    const out = deriveSlotPresentation(
      slotInput({
        slot: slot({
          slotId: 'outline',
          status: 'completed',
          includeInArtifact: false,
          contentText: '字'.repeat(860),
        }),
      }),
    );
    // 「校验通过」对工作槽位是废话，用户关心的正是「不进正文」这件事（D-19）
    expect(out.detail).toBe('860 字 · 不进正文');
    expect(out.detail).not.toContain('校验通过');
  });

  it('B.2 第 8 行：failed → fail/生产失败，detail 是错误消息', () => {
    const out = deriveSlotPresentation(
      slotInput({
        slot: slot({
          slotId: 'scene_02',
          status: 'failed',
          errorCode: 'PROVIDER_TIMEOUT',
          errorMessage: '连续 2 次 180 秒超时',
        }),
      }),
    );
    expect(out).toMatchObject({ tone: 'fail', state: '生产失败', detail: '连续 2 次 180 秒超时' });
  });

  it('字数按 Unicode 码点计，一个 emoji 算一个字', () => {
    const out = deriveSlotPresentation(
      slotInput({ slot: slot({ slotId: 's', status: 'completed', contentText: '你好🙂' }) }),
    );
    expect(out.charCount).toBe(3);
  });

  it('依赖指向不存在的槽位时算作「在等」，不会静默变成可生产', () => {
    const target = slot({ slotId: 'scene_02', dependsOn: ['ghost'] });
    const out = deriveSlotPresentation(slotInput({ slot: target, allSlots: [target] }));
    expect(out.state).toBe('等待依赖');
    expect(out.blockedBy).toEqual(['ghost']);
  });
});

// ---------- 残缺输入下的兜底文案（D-19：不编造、不崩、不显示 null） ----------
//
// 这些路径都是「上游少接了一根线」或「库里躺着一条历史脏数据」时才会走到的。
// 派生函数跑在每一次列表渲染上，它对残缺输入的表现就是产品的表现——
// 一旦兜底写错，用户看到的是「上次null」「undefined 字」这类字面量。

describe('附录 B 的兜底分支', () => {
  it('B.1 第 6 行：currentSlotTypeName 为 null 时退回槽位 type，不编造类型名', () => {
    const out = deriveTaskPresentation(
      taskInput({
        task: task({ status: 'running', phase: 'slots' }),
        slots: [slot({ slotId: 'scene_02', type: 'scene', status: 'running' })],
        activeExecution: execution({ targetSlotId: 'scene_02' }),
        currentSlotTypeName: null,
      }),
    );
    expect(out.detail).toBe('scene_02 scene生成中');
  });

  it('B.1 第 9 行：没有未完成的内容槽位时，「已停止」不点名续跑位置', () => {
    // 点名一个不存在的槽位比不点名更糟：运营会照着那个 ID 去找一个并不需要重跑的地方
    const out = deriveTaskPresentation(
      taskInput({
        task: task({ status: 'stopped', phase: 'assembly' }),
        slots: [
          slot({ slotId: 'chapter', contentBearing: false }),
          slot({ slotId: 'scene_01', parentId: 'chapter', status: 'completed' }),
        ],
      }),
    );
    expect(out).toEqual({ tone: 'idle', state: '已停止', detail: '运营手动停止，可继续续跑' });
  });

  it('B.1 第 10 行：任务没写 errorMessage 时给出结构校验的兜底原因', () => {
    const out = deriveTaskPresentation(
      taskInput({ task: task({ status: 'failed', phase: 'structure', errorMessage: null }) }),
    );
    expect(out.detail).toBe('结构提案未通过确定性校验');
  });

  it('B.1 第 11 行：失败槽位自己没有原因时退回任务级 errorMessage，仍点名槽位', () => {
    const out = deriveTaskPresentation(
      taskInput({
        task: task({ status: 'failed', phase: 'slots', errorMessage: '模型连续拒答' }),
        slots: [slot({ slotId: 'scene_02', status: 'failed', errorMessage: null })],
      }),
    );
    expect(out.detail).toBe('scene_02 模型连续拒答');
  });

  it('B.1 第 11 行：槽位与任务都没有原因时用兜底句，不渲染出 null', () => {
    const out = deriveTaskPresentation(
      taskInput({
        task: task({ status: 'failed', phase: 'slots', errorMessage: null }),
        slots: [slot({ slotId: 'scene_02', status: 'failed', errorMessage: null })],
      }),
    );
    expect(out.detail).toBe('scene_02 槽位生产失败');
  });

  it('B.1 第 11 行：任务 failed 但没有任何 failed 槽位时，detail 不硬凑槽位前缀', () => {
    // 失败发生在调度层（例如死锁）而非某个槽位上时，前缀会指向一个无辜的槽位
    const out = deriveTaskPresentation(
      taskInput({
        task: task({ status: 'failed', phase: 'slots', errorMessage: '依赖死锁' }),
        slots: [slot({ slotId: 'scene_02', status: 'pending' })],
      }),
    );
    expect(out.detail).toBe('依赖死锁');
  });

  it('B.1 第 12 行：组装失败没写原因时用兜底句，且仍声明已完成内容保留', () => {
    const out = deriveTaskPresentation(
      taskInput({ task: task({ status: 'failed', phase: 'assembly', errorMessage: null }) }),
    );
    expect(out.detail).toBe('组装未能完成，已完成槽位内容保留');
  });

  it("B.2 第 7″ 行：completed 但没有正文（AC-009 被破坏）→ warn/数据异常，不谎称「校验通过」", () => {
    // 这一支必须在 7 / 7' 之前判：否则 detail 会变成「0 字 · 校验通过」，
    // 对一个明显违反 AC-009 的数据宣称校验通过——整张表里唯一会主动撒谎的输出。
    // charCount 同样保持 null 而不是伪造成 0：结构化字段必须诚实反映「无内容」。
    const out = deriveSlotPresentation(
      slotInput({ slot: slot({ slotId: 'scene_01', status: 'completed', contentText: null }) }),
    );
    expect(out).toMatchObject({
      tone: 'warn',
      state: '数据异常',
      detail: '标记为已完成但没有正文（违反 AC-009）',
      charCount: null,
    });
    expect(out.detail).not.toContain('校验通过');
  });

  it('B.2 第 8 行：槽位自己没有 errorMessage 时退回 lastFailureReason', () => {
    const out = deriveSlotPresentation(
      slotInput({
        slot: slot({ slotId: 'scene_02', status: 'failed', errorMessage: null }),
        lastFailureReason: '连续 2 次 180 秒超时',
      }),
    );
    expect(out.detail).toBe('连续 2 次 180 秒超时');
  });

  it('B.2 第 8 行：两处原因都缺失时给兜底句，而不是空白或 null', () => {
    const out = deriveSlotPresentation(
      slotInput({
        slot: slot({ slotId: 'scene_02', status: 'failed', errorMessage: null }),
        lastFailureReason: null,
      }),
    );
    expect(out.detail).toBe('生产失败');
  });
});
