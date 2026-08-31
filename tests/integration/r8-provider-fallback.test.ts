/**
 * D-66…D-70 降级链的端到端验证。
 *
 * 单测覆盖的是挑档纯函数，但这个机制的价值**全在端到端那条路上**：
 * 「耗尽被标记 → 下一个任务挑档时跳过它 → pin 落库 → resolve 只认 pin →
 * 落到付费档时轨迹里响」这一串，任何一环断了单测都发现不了。
 *
 * 这里不烧真额度：耗尽状态直接写进 provider_health，
 * 与真实耗尽被 markProviderExhaustedIfNeeded 写进去的是同一张表、同一列。
 */

import { describe, expect, it } from 'vitest';
import { parseProviderConfig } from '@server/application/provider-config.ts';
import { pickProvider } from '@server/domain/provider-fallback.ts';
import { openDatabase } from '@server/infrastructure/database/db.ts';
import { runMigrations } from '@server/infrastructure/database/migrate.ts';
import { buildRepositories } from '@server/infrastructure/database/repositories/index.ts';

const YAML = `
providers:
  - id: ark
    name: 火山方舟
    kind: openai-compatible
    baseUrl: https://example.invalid/api/coding/v3
    apiKeyEnv: ARK_API_KEY
    models: [deepseek-v4-flash]
  - id: compshare
    name: 优云智算
    kind: openai-compatible
    baseUrl: https://example.invalid/v1
    apiKeyEnv: MODELVERSE_API_KEY
    models: [deepseek-v4-flash-0731]
  - id: deepseek
    name: DeepSeek 官方
    kind: openai-compatible
    baseUrl: https://example.invalid/v1
    apiKeyEnv: DEEPSEEK_API_KEY
    models: [deepseek-chat]
aliases:
  main:
    - { provider: ark, model: deepseek-v4-flash }
    - { provider: compshare, model: deepseek-v4-flash-0731 }
    - { provider: deepseek, model: deepseek-chat, paid: true }
defaults:
  timeoutMs: 1000
  maxRetries: 2
  concurrentSlots: 1
  rateLimitBackoff: { strategy: exponential, initialMs: 1, maxMs: 2, maxAttempts: 1 }
`;

function freshDb() {
  const db = openDatabase(':memory:');
  runMigrations(db);
  return db;
}

describe('R8：降级链端到端', () => {
  const config = parseProviderConfig(YAML);
  const chain = config.aliases.main!;

  it('耗尽标记穿过数据库：写进去、读出来、挑档据此跳档', () => {
    const db = freshDb();
    const repos = buildRepositories(db, () => new Date().toISOString());

    // 一开始谁都没耗尽 → 首选档
    expect(pickProvider(chain, (id) => repos.providerHealth.isExhausted(id)).chosen.provider).toBe(
      'ark',
    );

    // 模拟 markProviderExhaustedIfNeeded 干的事
    repos.providerHealth.markExhausted('ark', 'PROVIDER_RATE_LIMITED: Provider 返回 429');

    const after = pickProvider(chain, (id) => repos.providerHealth.isExhausted(id));
    expect(after.chosen.provider).toBe('compshare');
    expect(after.tier).toBe(1);
    expect(after.paid).toBe(false);
  });

  it('判定原文逐字留在库里 —— 它是 D-68 L2 特征表唯一的数据来源', () => {
    const db = freshDb();
    const repos = buildRepositories(db, () => new Date().toISOString());
    const raw = 'PROVIDER_ERROR: Provider 返回 HTTP 402：{"error":{"code":"QuotaExhausted"}}';
    repos.providerHealth.markExhausted('ark', raw);
    // 不许被改写、截断或换成自拟的话
    expect(repos.providerHealth.get('ark')?.exhaustedReason).toBe(raw);
  });

  it('两档都耗尽 → 落到付费档，且 paid 为真（D-69 的告警条件）', () => {
    const db = freshDb();
    const repos = buildRepositories(db, () => new Date().toISOString());
    repos.providerHealth.markExhausted('ark', 'x');
    repos.providerHealth.markExhausted('compshare', 'y');

    const pick = pickProvider(chain, (id) => repos.providerHealth.isExhausted(id));
    expect(pick.chosen.provider).toBe('deepseek');
    expect(pick.paid).toBe(true);
  });

  it('冷却过期后自动爬回高优先级档，不需要人去清状态', () => {
    const db = freshDb();
    let now = Date.parse('2026-08-31T00:00:00.000Z');
    const repos = buildRepositories(db, () => new Date(now).toISOString());

    repos.providerHealth.markExhausted('ark', 'x');
    expect(repos.providerHealth.isExhausted('ark')).toBe(true);

    // 冷却窗口内：仍然跳过
    now += 5 * 60 * 60 * 1000;
    expect(repos.providerHealth.isExhausted('ark')).toBe(true);

    // 超过 6 小时：重新可用。订阅额度按月重置而我们无从得知重置时刻，
    // 没有这条，一次耗尽会把那一档永久拉黑。
    now += 2 * 60 * 60 * 1000;
    expect(repos.providerHealth.isExhausted('ark')).toBe(false);
    expect(pickProvider(chain, (id) => repos.providerHealth.isExhausted(id)).chosen.provider).toBe(
      'ark',
    );
  });

  it('rate_limited 与 down 不算耗尽 —— 降级是花钱的决定，只认撞过墙的信号', () => {
    const db = freshDb();
    const repos = buildRepositories(db, () => new Date().toISOString());
    db.prepare(
      `INSERT INTO provider_health (provider_id, status, rate_limit_count, checked_at)
       VALUES ('ark', 'rate_limited', 9, ?), ('compshare', 'down', 0, ?)`,
    ).run(new Date().toISOString(), new Date().toISOString());

    expect(repos.providerHealth.isExhausted('ark')).toBe(false);
    expect(repos.providerHealth.isExhausted('compshare')).toBe(false);
    expect(pickProvider(chain, (id) => repos.providerHealth.isExhausted(id)).chosen.provider).toBe(
      'ark',
    );
  });

  it('加载期就拦下配错的兜底档，而不是等它被用到那一刻', () => {
    // 只校验首档的话，这份配置能启动，直到 ark 耗尽的那一刻才炸——
    // 那正是最需要它工作、也最难复现的时刻。
    const bad = YAML.replace(
      '- { provider: deepseek, model: deepseek-chat, paid: true }',
      '- { provider: deepseek, model: 打错的模型名, paid: true }',
    );
    expect(() => parseProviderConfig(bad)).toThrow(/第 3 档.*不在 provider deepseek 的 models/s);
  });

  it('同一档在链上出现两次 → 加载期报错（降级到自己没有意义）', () => {
    const bad = YAML.replace(
      '- { provider: compshare, model: deepseek-v4-flash-0731 }',
      '- { provider: ark, model: deepseek-v4-flash }',
    );
    expect(() => parseProviderConfig(bad)).toThrow(/出现了多次/);
  });
});
