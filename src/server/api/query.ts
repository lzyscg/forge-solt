/**
 * 查询参数解析（§9.3 的 M5-B 补充）。
 *
 * 只有一条规则值得单独成文件：**解析不出来就 400，不许退回默认值**。
 *
 * 分页参数静默兜底看起来无害，实际不是。`?after=abc` 退回 `after=0`
 * 会让 `GET /api/tasks/:id/traces` 从头重放整条轨迹，而调用方拿到的是
 * 一个格式完全正确的 200——它没有任何办法知道自己传错了。
 * SSE 断线重连正是靠这个参数续传的（§9.4 的 `Last-Event-ID`），
 * 一次静默归零就是一次全量重放。
 *
 * 缺省（根本没传）与非法（传了但不是数字）必须分开对待：
 * 前者是「我不关心，你看着办」，后者是「我表达了一个意图，但表达错了」。
 */

import { ForgeError } from '@shared/errors.ts';

export interface IntParamOptions {
  min: number;
  max: number;
}

/**
 * 取一个可选的非负整数查询参数。
 *
 * @param raw   原始值。Fastify 对重复参数（`?limit=1&limit=2`）给的是数组，
 *              所以类型是 unknown 而不是 `string | undefined`——
 *              把数组当字符串 Number() 一下会得到 NaN，
 *              而那时报「不是整数」是准确的：调用方确实表达了两个互相矛盾的意图。
 * @param fallback 未提供时的取值
 */
export function optionalInt(
  raw: unknown,
  name: string,
  fallback: number,
  options: IntParamOptions,
): number {
  if (raw === undefined || raw === '') return fallback;

  // 只接受纯十进制整数字面量。用 Number() 而不加这层的话，
  // `?limit=1e3`、`?limit=0x10`、`?limit= 5 ` 全部会被悄悄接受，
  // 而 `?limit=` 会变成 0——一个「取零条」的请求看起来和空结果一模一样。
  const text = typeof raw === 'string' ? raw : String(raw);
  if (!/^-?\d+$/.test(text)) {
    throw new ForgeError(
      'TASK_INPUT_INVALID',
      `查询参数 ${name} 必须是整数，收到的是「${text}」`,
      `query:${name}`,
      `把 ${name} 改成 ${options.min}..${options.max} 之间的整数`,
    );
  }

  const value = Number(text);
  if (value < options.min || value > options.max) {
    // 越界也报错而不是钳到边界：钳住 `limit=100000` 会返回一页数据，
    // 调用方据此以为「一共就这么多」，然后停止翻页。
    throw new ForgeError(
      'TASK_INPUT_INVALID',
      `查询参数 ${name} 超出范围（${options.min}..${options.max}）：${text}`,
      `query:${name}`,
      `把 ${name} 改成 ${options.min}..${options.max} 之间的整数`,
    );
  }
  return value;
}

/** `?flag=true` / `?flag=1` / `?flag`（空值）为真，缺省为假，其余一律 400 */
export function optionalBool(raw: unknown, name: string, fallback: boolean): boolean {
  if (raw === undefined) return fallback;
  const text = typeof raw === 'string' ? raw : String(raw);
  // 空串是 `?flag` 这种「光秃秃地写上了」的形式，按真处理——
  // 没有人会为了表达「假」而特意把参数名写出来
  if (text === '' || text === 'true' || text === '1') return true;
  if (text === 'false' || text === '0') return false;
  throw new ForgeError(
    'TASK_INPUT_INVALID',
    `查询参数 ${name} 必须是 true 或 false，收到的是「${text}」`,
    `query:${name}`,
    `把 ${name} 改成 true 或 false`,
  );
}
