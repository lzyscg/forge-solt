/**
 * §9.3 错误映射（M5 完成判据：「每个错误码至少一条测试断言其 HTTP status 与 action 文案」）。
 *
 * 用 `it.each(ERROR_CODES)` 遍历**全部**错误码，而不是挑几个有代表性的写。
 * 理由与 `ERROR_HTTP_STATUS` 写成 `Record<ErrorCode, number>` 是同一条：
 * 新增一个错误码时，遍历式的用例会自动覆盖到它，
 * 而「挑几个代表」的用例集会在无人察觉的情况下漏掉新码——
 * 漏掉的表现是线上一个本该 409 的错误回了 500。
 */

import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_ERROR_ACTION,
  ERROR_HTTP_STATUS,
  ErrorCodeSchema,
  ForgeError,
  INTERNAL_ONLY_ERROR_CODES,
  PublicErrorSchema,
  type ErrorCode,
} from '@shared/errors.ts';
import { INTERNAL_ESCAPE_LOG_MESSAGE, registerErrorHandler } from '@server/api/error-handler.ts';

const ERROR_CODES = ErrorCodeSchema.options as readonly ErrorCode[];
const INTERNAL_ONLY = new Set<ErrorCode>(INTERNAL_ONLY_ERROR_CODES);

let app: FastifyInstance | null = null;

afterEach(async () => {
  await app?.close();
  app = null;
});

/** 收集 pino 写出的日志行，供「对内刺眼」那半边断言 */
function buildApp(): { app: FastifyInstance; logs: string[] } {
  const logs: string[] = [];
  const instance = Fastify({
    logger: {
      level: 'error',
      // 直接接管 pino 的输出流，比 mock logger 更贴近真实：
      // 走的是同一条序列化路径，redact 配置也照样生效
      stream: {
        write(chunk: string): void {
          logs.push(chunk);
        },
      },
    },
  });
  registerErrorHandler(instance);

  instance.get<{ Params: { code: string } }>('/boom/:code', (request) => {
    throw new ForgeError(request.params.code as ErrorCode, `测试用错误：${request.params.code}`, 'slot:scene_02');
  });
  instance.get('/plain-boom', () => {
    throw new Error('sqlite: no such table: secret_internal_table /Users/someone/private/path');
  });
  instance.get('/with-action', () => {
    throw new ForgeError('PROVIDER_TIMEOUT', '超时了', null, '这是调用方自己给的 action');
  });

  return { app: instance, logs };
}

describe('§9.3 错误码 → HTTP', () => {
  it.each(ERROR_CODES)('%s：状态码与 action 都符合附录 A', async (code) => {
    const built = buildApp();
    app = built.app;

    const response = await app.inject({ method: 'GET', url: `/boom/${code}` });
    const body = PublicErrorSchema.parse(response.json());

    if (INTERNAL_ONLY.has(code)) {
      // D-18：内部码不出网。连 code 都不能是原来那个
      expect(response.statusCode).toBe(500);
      expect(body.code).toBe('STORAGE_ERROR');
      expect(body.message).toBe('服务内部错误');
      return;
    }

    expect(response.statusCode).toBe(ERROR_HTTP_STATUS[code]);
    expect(body.code).toBe(code);
    expect(body.action).toBe(DEFAULT_ERROR_ACTION[code]);
  });
});

/**
 * 从附录 A **手抄**下来的字面值。
 *
 * 上面那组遍历用例有一个结构性弱点：`expect(status).toBe(ERROR_HTTP_STATUS[code])`
 * 两边读的是同一张表，所以「有人把 SLOT_NOT_READY 改成 500」不会变红——
 * 而 §9.3 点名的金丝雀恰恰就是它。遍历的价值（新增码不会漏）要留，
 * 但得再有一份**独立于实现**的对照，否则整组断言是拿实现对实现。
 *
 * 这里只抄 §9.3 与附录 A 明确点过、或语义上最容易被改错的那几条。
 * 全表照抄没有意义——那只是把 errors.ts 复制一遍。
 */
const APPENDIX_A: ReadonlyArray<readonly [ErrorCode, number, string | null]> = [
  // §9.3 原文点名：走「默认 500」就会错的那一条
  ['SLOT_NOT_READY', 409, '等待前置槽位完成'],
  ['TASK_STATE_INVALID', 409, '刷新页面查看最新状态'],
  ['ENGINE_BUSY', 429, '等待当前任务完成后重试'],
  ['PROVIDER_RATE_LIMITED', 503, '该 Provider 正在限流，稍后重试或切换模型别名'],
  ['PROVIDER_UNAVAILABLE', 503, '前往 Provider 设置检查配置'],
  ['TEMPLATE_NOT_FOUND', 404, '返回模板列表重新选择'],
  ['TEMPLATE_NOT_PUBLISHED', 400, '该模板不可用于新任务，请选择已发布模板'],
  ['TASK_INPUT_INVALID', 400, '补齐必填字段后重新创建'],
  // action 为 null 是有意义的取值（UX §18.8：没有可执行下一步就不显示按钮）
  ['TASK_NOT_FOUND', 404, null],
  ['ARTIFACT_NOT_FOUND', 404, null],
  ['SLOT_NOT_FOUND', 404, null],
  ['STRUCTURE_RETRY_EXHAUSTED', 500, '点击重试重新设计结构，已冻结的输入不变'],
  ['PROVIDER_TIMEOUT', 500, '点击重试从当前槽位继续，已完成的槽位不会重新生成'],
  ['DEPENDENCY_DEADLOCK', 500, '结构存在无法满足的依赖，需要重新创建任务'],
];

describe('附录 A 的字面值对照', () => {
  it.each(APPENDIX_A)('%s → %d', async (code, status, action) => {
    const built = buildApp();
    app = built.app;

    const response = await app.inject({ method: 'GET', url: `/boom/${code}` });
    const body = PublicErrorSchema.parse(response.json());
    expect(response.statusCode).toBe(status);
    expect(body.action).toBe(action);
  });

  it('对照表本身没有抄到已经不存在的错误码', () => {
    // 手抄的表会烂：某个码被删了而这里还留着，`/boom/:code` 会照样 500，
    // 上面那组用例反而全绿。这条守住对照表与词表的同步
    for (const [code] of APPENDIX_A) {
      expect(ERROR_CODES, `${code} 已不在词表中`).toContain(code);
    }
  });
});

describe('D-18：内部错误码不得出网', () => {
  it.each(INTERNAL_ONLY_ERROR_CODES)('%s：对外是通用 500，对内是一条可 grep 的 error 日志', async (code) => {
    const built = buildApp();
    app = built.app;

    const response = await app.inject({ method: 'GET', url: `/boom/${code}` });

    // 对外安全：响应体里不该出现内部码，也不该出现内部 message
    const raw = response.body;
    expect(response.statusCode).toBe(500);
    expect(raw).not.toContain(code);
    expect(raw).not.toContain('测试用错误');

    // 对内刺眼：默默改写会掩盖 bug，所以必须留下明确痕迹
    const logged = built.logs.join('\n');
    expect(logged).toContain(INTERNAL_ESCAPE_LOG_MESSAGE);
    expect(logged, '日志里要能看出是哪一条逃逸了').toContain(code);
  });
});

describe('非 ForgeError', () => {
  it('一律 STORAGE_ERROR，且原始 message 不出网', async () => {
    const built = buildApp();
    app = built.app;

    const response = await app.inject({ method: 'GET', url: '/plain-boom' });
    const body = PublicErrorSchema.parse(response.json());

    expect(response.statusCode).toBe(500);
    expect(body.code).toBe('STORAGE_ERROR');
    // sqlite 的报错带表名，Node 的报错带绝对路径——这是最常见的信息泄露路径
    expect(response.body).not.toContain('secret_internal_table');
    expect(response.body).not.toContain('/Users/');
  });

  it('但它仍要进日志，否则线上排查无从下手', async () => {
    const built = buildApp();
    app = built.app;
    await app.inject({ method: 'GET', url: '/plain-boom' });
    expect(built.logs.join('\n')).toContain('unhandled error');
  });
});

describe('action 兜底', () => {
  it('调用方显式给了 action 就用它的，不被默认值覆盖', async () => {
    const built = buildApp();
    app = built.app;

    const body = PublicErrorSchema.parse((await app.inject({ method: 'GET', url: '/with-action' })).json());
    expect(body.action).toBe('这是调用方自己给的 action');
    expect(body.action).not.toBe(DEFAULT_ERROR_ACTION.PROVIDER_TIMEOUT);
  });

  it('没有可执行下一步时 action 是 null，而不是一句点了没用的「重试」（UX §18.8）', async () => {
    const built = buildApp();
    app = built.app;

    const body = PublicErrorSchema.parse((await app.inject({ method: 'GET', url: '/boom/TASK_NOT_FOUND' })).json());
    expect(body.action).toBeNull();
  });
});

describe('404', () => {
  it('未命中的路由也回 PublicError 形状，前端不必为它单写一套解析', async () => {
    const built = buildApp();
    app = built.app;

    const response = await app.inject({ method: 'GET', url: '/api/no-such-endpoint' });
    expect(response.statusCode).toBe(404);
    expect(() => PublicErrorSchema.parse(response.json())).not.toThrow();
  });
});
