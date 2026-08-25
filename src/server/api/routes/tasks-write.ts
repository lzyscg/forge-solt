/**
 * 任务写端点（§9.1）。
 *
 * ```
 * POST /api/tasks[?start=true]   创建任务（可选立即启动）
 * POST /api/tasks/:id/start      启动
 * POST /api/tasks/:id/stop       停止
 * POST /api/tasks/:id/resume     继续
 * POST /api/tasks/:id/retry      重试
 * ```
 *
 * ## 两条贯穿本文件的纪律
 *
 * 1. **请求体在这里过一次 Zod，且只在这里。**
 *    HTTP body 是不可信输入的边界。往里走一步就没有第二次机会——
 *    `snapshot-service` 的 `createTask` 签名收的是 `Record<string, unknown>`，
 *    它信任调用方已经把形状验过了。
 *
 * 2. **四个生命周期动作立刻返回，不等生产跑完。**
 *    走 `lifecycle.dispatch()`：状态迁移与状态机校验同步做完（失败同步抛，
 *    交给 §9.3 的 setErrorHandler），本轮推进留在后台。
 *    改成 `await lifecycle.start()` 会让一次请求挂几分钟；
 *    而直接丢掉那个 Promise，被拒的请求会返回 200，错误变成未处理的 rejection。
 */

import type { FastifyInstance, FastifyReply } from 'fastify';
import type { z } from 'zod';
import { CreateTaskRequestSchema, type TaskCommandResult } from '@shared/contracts.ts';
import { ForgeError } from '@shared/errors.ts';
import type { ForgeApp } from '@server/application/composition.ts';
import type { LifecycleAction } from '@server/application/lifecycle-service.ts';
import { optionalBool } from '../query.ts';

interface TaskIdParams {
  id: string;
}

/**
 * 请求体解析。
 *
 * 失败时报 `TASK_INPUT_INVALID`（400）并把 Zod 的路径原样带上——
 * 「input: Required」这种提示能让调用方一眼看出漏了哪个字段，
 * 而一句笼统的「请求体非法」只能靠猜。
 */
function parseBody<S extends z.ZodTypeAny>(schema: S, body: unknown): z.infer<S> {
  const parsed = schema.safeParse(body);
  if (parsed.success) return parsed.data;
  const detail = parsed.error.issues
    .map((issue) => `${issue.path.join('.') || '(根)'}: ${issue.message}`)
    .join('；');
  throw new ForgeError('TASK_INPUT_INVALID', `请求体非法：${detail}`, null, '修正请求体后重试');
}

export function registerTaskWriteRoutes(app: FastifyInstance, forge: ForgeApp): void {
  /**
   * 生命周期动作的共同形状。
   *
   * `queued` / `position` 必须在 dispatch **之后**读：D-14 的排队位次
   * 是引擎的内部状态，入队之前读到的永远是 null，
   * 于是「前面还有 n 个任务」这句提示在真正需要它的时候恰好没有。
   */
  const runAction = (action: LifecycleAction, taskId: string): TaskCommandResult => {
    const { done } = forge.lifecycle.dispatch(action, taskId);
    // 后台那段没人 await。引擎自己会把逃逸异常落到任务的终态上
    // （见 production-engine 的 settleEscapedError），这里挂个 catch
    // 只是为了不让 Node 报 unhandled rejection——真正的收尾不在这。
    done.catch((error: unknown) => {
      app.log.error({ err: error, taskId, action }, 'background production run rejected');
    });
    return commandResult(forge, taskId);
  };

  app.post<{ Body: unknown; Querystring: Record<string, unknown> }>(
    '/api/tasks',
    async (request, reply: FastifyReply) => {
      const body = parseBody(CreateTaskRequestSchema, request.body);
      // §9.1：「仅创建」与「创建并启动」是同一个端点带查询参数，不是两个端点——
      // 创建逻辑完全相同，只是末尾多一次 dispatch
      const start = optionalBool(request.query['start'], 'start', false);

      const created = await forge.snapshots.createTask({
        templateId: body.templateId,
        name: body.name,
        input: body.input,
      });

      // **先把可能抛的做完，再设 201 与 Location。** 反过来的话，
      // dispatch 抛错时状态码会被 setErrorHandler 正确改写（这点没问题），
      // 但 `Location` 头会留下来——客户端拿到一个「失败却带着新资源地址」的响应。
      const result = start
        ? runAction('start', created.task.id)
        : commandResult(forge, created.task.id);
      void reply.status(201).header('Location', `/api/tasks/${created.task.id}`);
      return result;
    },
  );

  app.post<{ Params: TaskIdParams }>('/api/tasks/:id/start', (request) =>
    runAction('start', request.params.id),
  );

  app.post<{ Params: TaskIdParams }>('/api/tasks/:id/resume', (request) =>
    runAction('resume', request.params.id),
  );

  app.post<{ Params: TaskIdParams }>('/api/tasks/:id/retry', (request) =>
    runAction('retry', request.params.id),
  );

  app.post<{ Params: TaskIdParams }>('/api/tasks/:id/stop', (request) => {
    // stop 本来就是同步的（§8.3：事务提交后才 abort），没有后台那一段
    forge.lifecycle.stop(request.params.id);
    return commandResult(forge, request.params.id);
  });
}

/**
 * 从库里读回权威状态，而不是拼一个「我以为现在是什么」。
 *
 * 动作的结果不完全由动作决定：start 之后任务可能已经在跑、可能在排队，
 * 也可能——如果队列是空的且引擎同步推进了一步——已经变成别的相位。
 * 照着动作名硬编码 `status: 'running'` 会在这些情形下返回一个假状态，
 * 而前端拿它去渲染，就得到一个与 SSE 推来的真状态打架的界面。
 */
function commandResult(forge: ForgeApp, taskId: string): TaskCommandResult {
  const task = forge.uow.repositories.tasks.getOrThrow(taskId);
  const position = forge.engine.positionOf(taskId);
  return {
    taskId,
    status: task.status,
    // D-14：queued=true 表示已入队而不是被拒绝。直接返回 ENGINE_BUSY
    // 会逼用户手动轮询——那正是队列存在的理由
    queued: position !== null,
    position,
  };
}
