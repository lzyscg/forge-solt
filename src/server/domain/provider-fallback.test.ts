import { describe, expect, it } from 'vitest';
import type { ModelAliasChain } from '@server/application/provider-config.ts';
import { describePick, pickProvider } from './provider-fallback.ts';

const CHAIN: ModelAliasChain = [
  { provider: 'ark', model: 'deepseek-v4-flash' },
  { provider: 'compshare', model: 'deepseek-v4-flash-0731' },
  { provider: 'deepseek', model: 'deepseek-chat', paid: true },
];

const exhausted =
  (...ids: string[]) =>
  (id: string) =>
    ids.includes(id);

describe('pickProvider', () => {
  it('都没耗尽 → 首选档，tier 0，不算降级', () => {
    const pick = pickProvider(CHAIN, exhausted());
    expect(pick.chosen.provider).toBe('ark');
    expect(pick.tier).toBe(0);
    expect(pick.skipped).toEqual([]);
    expect(pick.paid).toBe(false);
  });

  it('首档耗尽 → 落到第二档，并记下跳过了谁（D-70）', () => {
    const pick = pickProvider(CHAIN, exhausted('ark'));
    expect(pick.chosen.provider).toBe('compshare');
    expect(pick.tier).toBe(1);
    expect(pick.skipped).toEqual([
      { provider: 'ark', model: 'deepseek-v4-flash', reason: 'exhausted' },
    ]);
    expect(pick.paid).toBe(false);
  });

  it('前两档都耗尽 → 落到付费档，paid 为真（D-69）', () => {
    const pick = pickProvider(CHAIN, exhausted('ark', 'compshare'));
    expect(pick.chosen.provider).toBe('deepseek');
    expect(pick.tier).toBe(2);
    expect(pick.paid).toBe(true);
    expect(pick.skipped.map((s) => s.provider)).toEqual(['ark', 'compshare']);
  });

  it('全都被标成耗尽 → 退回最后一档硬试，而不是抛「无可用 Provider」', () => {
    // 最后一档按约定是按量付费的、不会真耗尽。它被标记多半是误伤，
    // 此时宁可去试一次让真实错误暴露，也不要变成一堵查不出原因的墙。
    const pick = pickProvider(CHAIN, exhausted('ark', 'compshare', 'deepseek'));
    expect(pick.chosen.provider).toBe('deepseek');
    expect(pick.tier).toBe(2);
    // 被选中的那一档不该同时出现在「跳过」里
    expect(pick.skipped.map((s) => s.provider)).toEqual(['ark', 'compshare']);
  });

  it('长度 1 的链（无降级链的别名）照常工作', () => {
    const single: ModelAliasChain = [{ provider: 'ark', model: 'm' }];
    expect(pickProvider(single, exhausted()).tier).toBe(0);
    // 唯一一档被标耗尽也照样返回它，不抛
    expect(pickProvider(single, exhausted('ark')).chosen.provider).toBe('ark');
  });

  it('空链抛错', () => {
    expect(() => pickProvider([], exhausted())).toThrow(/降级链为空/);
  });
});

describe('describePick 的措辞（D-30：不许含糊）', () => {
  it('首选档不说「降级」', () => {
    const text = describePick('main', pickProvider(CHAIN, exhausted()));
    expect(text).toContain('首选档');
    expect(text).not.toContain('降级');
  });

  it('降级时写明跳过了谁', () => {
    const text = describePick('main', pickProvider(CHAIN, exhausted('ark')));
    expect(text).toContain('降级到第 2 档');
    expect(text).toContain('ark');
  });

  it('落到付费档必须写明「按量付费」，不能只说切换了 Provider', () => {
    const text = describePick('main', pickProvider(CHAIN, exhausted('ark', 'compshare')));
    expect(text).toContain('按量付费');
    expect(text).toContain('实际费用');
  });
});
