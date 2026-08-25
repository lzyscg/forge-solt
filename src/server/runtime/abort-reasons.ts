/**
 * 中止原因（§8.2 / §8.3）。
 *
 * **为什么是「一个 AbortController + 可辨别的 reason」而不是两个 Controller**：
 * 超时与用户停止是同一条中止链路上的两个来源，但收敛结果完全不同——
 * 超时要标 `failed` 并消耗一次 retry 配额，用户停止已经在 stop 事务里标了
 * `cancelled`，Runtime 此处**不得重复写**。两个 Controller 意味着 adapter 要同时
 * 监听两个 signal（`AbortSignal.any` 又会丢掉 reason），而 reason 是免费的。
 *
 * 用类而不是字符串常量：`signal.reason` 的类型是 `any`，字符串比较写错了不会报错，
 * `instanceof` 至少能在改名时被编译器抓到。
 */

/** 超时中止（AC-010）。收敛为 `PROVIDER_TIMEOUT`，消耗一次 retry 配额 */
export class TimeoutSignal extends Error {
  override readonly name = 'TimeoutSignal';
  constructor(readonly timeoutMs: number) {
    super(`Assignment 超过 ${timeoutMs}ms 未完成`);
  }
}

/**
 * 用户停止（AC-011）。
 *
 * 由 lifecycle 层在 **stop 事务提交之后**构造并 abort（§8.3 的顺序是硬要求）。
 * 放在 runtime 导出是因为 adapter 与 runner 都要认它，而 lifecycle 只需构造。
 */
export class UserStopSignal extends Error {
  override readonly name = 'UserStopSignal';
  constructor() {
    super('用户停止了任务');
  }
}

/** 提交成功后的自我中止（D-11）。不是失败，只是让 Provider 别再说了 */
export class SubmittedSignal extends Error {
  override readonly name = 'SubmittedSignal';
  constructor() {
    super('本次 Assignment 已提交，停止接收后续输出');
  }
}

export type AbortCause = 'timeout' | 'user_stop' | 'submitted' | 'unknown';

/** 把 `signal.reason` 归类。未知 reason 不猜——归为 unknown 由调用方决定怎么收敛 */
export function classifyAbort(reason: unknown): AbortCause {
  if (reason instanceof TimeoutSignal) return 'timeout';
  if (reason instanceof UserStopSignal) return 'user_stop';
  if (reason instanceof SubmittedSignal) return 'submitted';
  return 'unknown';
}

/**
 * 可中止的等待（§8.5）。
 *
 * 限流退避期间必须能被 stop 打断，否则用户点了停止还要干等 60 秒。
 * 中止时 **resolve 而不是 reject**：调用方随后会自己检查 `signal.aborted`，
 * 让退避循环退出的路径只有一条，而不是一条正常返回 + 一条异常。
 */
export function sleepAbortable(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      resolve();
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
