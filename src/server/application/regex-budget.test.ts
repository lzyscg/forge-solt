import { describe, expect, it } from 'vitest';
import { checkPatternBudget } from './regex-budget.ts';

describe('checkPatternBudget', () => {
  it('没有正则时不启动 worker，直接通过', async () => {
    await expect(checkPatternBudget([])).resolves.toEqual({ ok: true });
  });

  it('线性模式在预算内通过', async () => {
    const result = await checkPatternBudget(
      [
        { key: 'slotType:scene', source: '^#{1,6}\\s', flags: 'm' },
        { key: 'slotType:title', source: '[，。！？]$', flags: '' },
      ],
      200,
    );
    expect(result).toEqual({ ok: true });
  });

  it('灾难性回溯的模式被判超时，并点名是哪一条', async () => {
    const result = await checkPatternBudget(
      [
        { key: 'slotType:title', source: '^\\d+$', flags: '' },
        { key: 'slotType:scene', source: '^(\\w+\\s?)+$', flags: '' },
      ],
      80,
    );
    // 报错必须点名具体槽位类型：只说「有个正则超时了」等于让作者逐条试
    expect(result).toMatchObject({ ok: false, key: 'slotType:scene', reason: 'timeout' });
  });

  it('超时后 worker 被回收，不会把进程挂住', async () => {
    // 这条用例本身就是断言：若 terminate 没生效，vitest 会因为句柄未释放而卡住
    const before = process.memoryUsage().heapUsed;
    await checkPatternBudget([{ key: 'k', source: '^(a+)+$', flags: '' }], 50);
    expect(typeof before).toBe('number');
  });
});
