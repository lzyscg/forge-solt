/**
 * 业务化状态投影（文档 §6.5 / D-07 / 附录 B）。
 *
 * 后端显式返回 `tone / state / detail` 三段式，前端只渲染不判断
 * （HANDOFF README：「不要让前端从状态字符串猜」）。
 *
 * 本文件是**附录 B 的逐行实现**：B.1 任务级 14 行、B.2 槽位级 8 行（第 7 行分 7/7' 两支），
 * 按序匹配、首个命中即返回。改动任何一行的顺序都会改变产品行为——
 * 每一行都有一条以行号命名的单测，先看 `presentation.test.ts` 再动这里。
 *
 * 文案质量约束（文档 §6.5，来自 `组件状态变体.dc.html` 的 note）：
 * - 「等待依赖」必须点名在等谁：`等待 scene_03 定稿`，不是「依赖未满足」
 * - 「已完成」必须给可核对的事实：`1,486 字 · 校验通过`，不是「生成成功」
 * - 「超时重试」必须同时给重试计数与上次失败原因
 * - 「结构校验失败」必须并列判据与实收值
 * - 「已停止」措辞不带错误感：`运营手动停止 · 可从此处续跑`
 *
 * 纯函数、零 IO、不读时钟：`elapsedMs` 等一切与时间有关的量都由调用方传入
 * （AC-013 的确定性要求；`Date.now()` 会让这两个函数不可测）。
 */

import type { Presentation } from '@shared/presentation.ts';
import type { TaskStatus } from '@shared/contracts.ts';
import type { Execution, Slot, Task } from './types.ts';
import { blockedBy, documentOrder } from './readiness.ts';

// ---------- 输入形状（文档 §6.5） ----------

export interface SlotPresentationInput {
  slot: Slot;
  allSlots: readonly Slot[];
  activeAttempt: number | null;
  /** 已成文的失败原因，由 lifecycle 层写好。派生层不解析、不拼装（D-19） */
  lastFailureReason: string | null;
  elapsedMs: number | null;
  /** D-18 补：附录 B.2 第 2 行「已停止」需要任务级状态 */
  taskStatus: TaskStatus;
  /** D-18 补：该槽位是否为停止时的中断点 */
  isInterruptionPoint: boolean;
  /**
   * D-19：B.2 第 6 行的 `{agentName}`。这个值**不在** `Slot` 上——
   * `slot.producer` 要到 commit 才写入，running 期间恒为 null，
   * 所以只能由调用方从当前 execution 的 agentId 解析后传入。
   *
   * 必填且无默认值：可选参数 + 「Agent」兜底会把一处调用方接线缺失，
   * 静默降级成一句看不出问题的界面文案。
   * 传 null 时 detail 省略主语（`生成中`），不编造主语。
   */
  agentName: string | null;
}

export type SlotPresentation = Presentation & { blockedBy: string[]; charCount: number | null };

export interface TaskPresentationInput {
  task: Task;
  slots: readonly Slot[];
  activeExecution: Execution | null;
  currentSlotTypeName: string | null;
  /** D-14：非 null 表示任务已入队但尚未轮到它 */
  queuePosition: number | null;
  /**
   * D-19：B.1 第 3 / 5 行的「上次{lastFailureReason}」。
   * 与 `task.errorMessage` 不同源：后者是**终态**失败原因（第 10–12 行），
   * 而重试中的任务 status 仍是 running，两者生命周期不同，不能混用。
   */
  lastFailureReason: string | null;
}

// ---------- B.1 任务级 ----------

/**
 * 附录 B.1，14 行，按序匹配首个命中即返回。
 * 行号注释与测试用例名一一对应，不要重排。
 */
export function deriveTaskPresentation(input: TaskPresentationInput): Presentation {
  const { task, slots, activeExecution, currentSlotTypeName, queuePosition, lastFailureReason } =
    input;
  const contentSlots = slots.filter((slot) => slot.contentBearing);
  const total = contentSlots.length;
  const done = contentSlots.filter((slot) => slot.status === 'completed').length;
  const attempt = activeExecution?.attemptNumber ?? 0;

  // B.1 第 1 行
  if (task.status === 'ready') {
    return { tone: 'idle', state: '待启动', detail: '冻结输入已就绪，尚未开始生产' };
  }

  if (task.status === 'running') {
    // B.1 第 2 行——排队中是任务级状态，不下沉到槽位（附录 B.2 表下说明）
    if (queuePosition !== null) {
      return { tone: 'wait', state: '排队中', detail: `前面还有 ${queuePosition} 个任务` };
    }

    if (task.phase === 'structure') {
      // B.1 第 3 行
      if (attempt > 1) {
        return {
          tone: 'warn',
          state: '结构重试中',
          detail: `第 ${attempt} 次尝试 · 上次${failureText(lastFailureReason)}`,
        };
      }
      // B.1 第 4 行
      return { tone: 'run', state: '创建结构', detail: 'Structure Agent 正在设计章节结构' };
    }

    if (task.phase === 'slots') {
      // B.1 第 5 行
      if (attempt > 1) {
        return {
          tone: 'warn',
          state: '超时重试',
          detail: `第 ${attempt} 次尝试 · 上次${failureText(lastFailureReason)}`,
        };
      }
      const running = firstByDocumentOrder(slots, (slot) => slot.status === 'running');
      // B.1 第 6 行
      if (running !== null) {
        const typeName = currentSlotTypeName ?? running.type;
        return { tone: 'run', state: '正在填充 Slot', detail: `${running.slotId} ${typeName}生成中` };
      }
      // B.1 第 7 行
      return { tone: 'wait', state: '等待调度', detail: `${done}/${total} 已完成，正在选择下一槽位` };
    }

    // B.1 第 8 行
    if (task.phase === 'assembly') {
      return { tone: 'run', state: '组装中', detail: `${total} 个槽位全部通过，正在组装产物` };
    }

    // running + phase=done 落到函数末尾的第 14 行兜底，不在这里假装是「组装中」。
  }

  // B.1 第 9 行
  if (task.status === 'stopped') {
    const resumePoint = findInterruptionPoint(slots);
    return {
      tone: 'idle',
      state: '已停止',
      detail:
        resumePoint === null
          ? '运营手动停止，可继续续跑'
          : `运营手动停止，可从 ${resumePoint.slotId} 续跑`,
    };
  }

  if (task.status === 'failed') {
    // B.1 第 10 行
    if (task.phase === 'structure') {
      return { tone: 'fail', state: '结构校验失败', detail: task.errorMessage ?? '结构提案未通过确定性校验' };
    }
    // B.1 第 11 行
    if (task.phase === 'slots') {
      const failed = firstByDocumentOrder(slots, (slot) => slot.status === 'failed');
      const message = failed?.errorMessage ?? task.errorMessage ?? '槽位生产失败';
      return {
        tone: 'fail',
        state: '槽位生产失败',
        detail: failed === null ? message : `${failed.slotId} ${message}`,
      };
    }
    // B.1 第 12 行
    if (task.phase === 'assembly') {
      return {
        tone: 'fail',
        state: '组装失败',
        detail: `${task.errorMessage ?? '组装未能完成'}，已完成槽位内容保留`,
      };
    }
    // failed + phase=done 同样落到第 14 行
  }

  // B.1 第 13 行
  if (task.status === 'completed') {
    return { tone: 'ok', state: '已完成', detail: `${total} 个槽位全部通过，产物已组装` };
  }

  // B.1 第 14 行（D-19）——TaskStatus × TaskPhase 有 5×4=20 种组合，表只覆盖了一部分。
  // 派生函数跑在每一次列表渲染上，一条脏数据不该把整页打成 500；
  // 也不该被伪装成某个看起来正常的状态。诚实报「状态未知」并把组合原样交出来。
  return {
    tone: 'idle',
    state: '状态未知',
    detail: `任务处于未预期的状态组合：${task.status}/${task.phase}`,
  };
}

/**
 * 「上次{lastFailureReason}」的取值。
 *
 * D-19 定的跨层合同：**失败原因的成文责任在 lifecycle 层**——
 * 只有它同时拿着 execution、超时配置和违规列表。派生层原样取用，不解析不拼装。
 * 这里唯一做的事是给 null / 空串一个不撒谎的兜底。
 */
function failureText(reason: string | null): string {
  if (reason !== null && reason.trim().length > 0) return reason.trim();
  return '执行失败';
}

// ---------- B.2 槽位级 ----------

/**
 * 附录 B.2，8 行，按序匹配首个命中即返回。
 *
 * 两处顺序理由（文档明写，不要动）：
 * - 第 1 行必须最前：容器槽位**无论 status 取什么值**都不该按 status 渲染。
 *   容器没有字数，渲染成「已完成 · N 字」是伪造数据；渲染成「未填充 · 等待执行」
 *   同样是撒谎——它压根不会被执行。先判 `contentBearing` 就绕开了整个问题。
 *   （D-19 澄清：原注释写「容器在结构提交后就是 completed」与实现不符——
 *   仓储把容器落库为 `pending` 且没有改它的入口。把理由改成不依赖具体 status 的版本，
 *   顺带比原来更强：它对任何 status 都成立。）
 * - 第 2 行必须在 `running` 之前：停止发生时中断点槽位仍可能是 `running`，
 *   按自身状态渲染会得到「正在填充」，与任务已停止的事实矛盾。
 */
export function deriveSlotPresentation(input: SlotPresentationInput): SlotPresentation {
  const { slot, allSlots, activeAttempt, lastFailureReason, elapsedMs, taskStatus } = input;
  const blocked = blockedBy(slot, allSlots);
  const charCount = slot.contentText === null ? null : countChars(slot.contentText);

  // B.2 第 1 行。n = **直接子槽位**数（D-19），不是整棵子树的规模——
  // 「收拢」描述的是这一层折叠起来的行数，与 UI 展开一级后看到的条数一致。
  if (!slot.contentBearing) {
    const childCount = allSlots.filter((other) => other.parentId === slot.slotId).length;
    return {
      tone: 'container',
      state: '容器槽位',
      detail: `收拢 ${childCount} 个下级槽位`,
      blockedBy: blocked,
      // 容器不伪造数据（README：不显示 Producer、不显示耗时），字数同理恒为 null
      charCount: null,
    };
  }

  // B.2 第 2 行
  if (taskStatus === 'stopped' && input.isInterruptionPoint) {
    return {
      tone: 'idle',
      state: '已停止',
      detail: '运营手动停止 · 可从此处续跑',
      blockedBy: blocked,
      charCount,
    };
  }

  // B.2 第 3 行
  if (slot.status === 'pending' && blocked.length > 0) {
    return {
      tone: 'wait',
      state: '等待依赖',
      detail: `等待 ${blocked.join('、')} 定稿`,
      blockedBy: blocked,
      charCount,
    };
  }

  // B.2 第 4 行
  if (slot.status === 'pending') {
    // R2：返修中（第 N 次）——revisionRound > 0 时显示返修轮次
    if (slot.revisionRound > 0) {
      return {
        tone: 'warn',
        state: '返修中',
        detail: `第 ${slot.revisionRound} 次返修`,
        blockedBy: blocked,
        charCount,
      };
    }
    return { tone: 'idle', state: '未填充', detail: '等待执行', blockedBy: blocked, charCount };
  }

  if (slot.status === 'running') {
    // B.2 第 5 行
    if (activeAttempt !== null && activeAttempt > 1) {
      return {
        tone: 'warn',
        state: '超时重试',
        detail: `第 ${activeAttempt} 次尝试 · 上次${failureText(lastFailureReason)}`,
        blockedBy: blocked,
        charCount,
      };
    }
    // B.2 第 6 行。agentName 为 null 时省略主语，不退化成「Agent 生成中」——
    // 后者读起来像有个叫 Agent 的东西在干活，把接线缺失盖住了（D-19）。
    const seconds = elapsedMs === null ? null : Math.floor(elapsedMs / 1000);
    const subject = input.agentName === null ? '' : `${input.agentName} `;
    return {
      tone: 'run',
      state: '正在填充',
      detail: seconds === null ? `${subject}生成中` : `${subject}生成中 · 已 ${seconds} 秒`,
      blockedBy: blocked,
      charCount,
    };
  }

  // R2 B.2 第 6' 行：reviewing → run/审核中
  if (slot.status === 'reviewing') {
    return {
      tone: 'run',
      state: '审核中',
      detail: '内容已提交，正在按判据审核',
      blockedBy: blocked,
      charCount,
    };
  }

  // B.2 第 7 / 7' 行（D-19）：两个分支各自成句，**不叠加**。
  // 「校验通过」对工作槽位是句废话——它本来就不进产物，用户关心的正是这件事；
  // 两句都堆上去只会稀释信息。
  if (slot.status === 'completed') {
    // B.2 第 7″ 行（D-19）。AC-009 由 DDL 的 CHECK 保证，落库数据到不了这里；
    // 但纯函数不挑调用方。少了这一支，detail 会变成「0 字 · 校验通过」——
    // 对一个明显违反 AC-009 的数据宣称校验通过，是整张表里唯一会主动撒谎的输出。
    if (charCount === null) {
      return {
        tone: 'warn',
        state: '数据异常',
        detail: '标记为已完成但没有正文（违反 AC-009）',
        blockedBy: blocked,
        charCount: null,
      };
    }
    const count = formatThousands(charCount);
    // R2：返修预算耗尽 → 「已完成（返修次数用尽）」，不得用警示/失败色调（D-26/D-30）。
    // 它产出了内容、进产物了，只是系统停止了尝试。与「失败」（产不出内容）有本质区别。
    if (slot.reviewExhausted) {
      return {
        tone: 'ok',
        state: '已完成',
        detail: `${count} 字 · 返修次数用尽，按现状完成`,
        blockedBy: blocked,
        charCount,
      };
    }
    return {
      tone: 'ok',
      state: '已完成',
      detail: slot.includeInArtifact ? `${count} 字 · 校验通过` : `${count} 字 · 不进正文`,
      blockedBy: blocked,
      charCount,
    };
  }

  // B.2 第 8 行
  return {
    tone: 'fail',
    state: '生产失败',
    detail: slot.errorMessage ?? lastFailureReason ?? '生产失败',
    blockedBy: blocked,
    charCount,
  };
}

// ---------- 内部工具 ----------

/** 中断点：文档序中第一个尚未完成的内容槽位（stop 会把 running 槽位放回 pending） */
function findInterruptionPoint(slots: readonly Slot[]): Slot | null {
  return firstByDocumentOrder(
    slots,
    (slot) => slot.contentBearing && slot.status !== 'completed',
  );
}

function firstByDocumentOrder(
  slots: readonly Slot[],
  predicate: (slot: Slot) => boolean,
): Slot | null {
  for (const slot of documentOrder(slots)) {
    if (predicate(slot)) return slot;
  }
  return null;
}

/**
 * 字数按 Unicode 码点计，不是 UTF-16 长度——否则一个 emoji 算两个字。
 * 这个数字会直接显示给用户（`1,486 字`），必须与人的直觉一致。
 */
function countChars(text: string): number {
  return [...text].length;
}

/**
 * 千分位。手写而不用 `Intl.NumberFormat`：后者的输出随运行时 ICU 数据变化，不满足确定性要求。
 *
 * 入参恒为**非负整数**——唯一的调用点传的是 `countChars` 的返回值（码点个数）或 0。
 * 因此不处理负号与小数：那两段代码永远跑不到，留着只会假装本函数是个通用数字格式化器。
 */
function formatThousands(value: number): string {
  const digits = value.toString();
  let out = '';
  for (let i = 0; i < digits.length; i += 1) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += ',';
    out += digits[i];
  }
  return out;
}
