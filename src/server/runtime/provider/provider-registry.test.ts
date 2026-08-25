/**
 * ProviderRegistry（D-03 / D-17 / §7.2）。
 *
 * 三件事必须成立：别名解析是晚绑定的、缺凭据不阻止服务启动、密钥只出名不出值。
 */

import { describe, expect, it } from 'vitest';
import { ForgeError } from '@shared/errors.ts';
import type { ProviderConfig } from '@server/application/provider-config.ts';
import { FakeProvider } from './fake.ts';
import { ProviderRegistry } from './provider-registry.ts';

const KEY = 'sk-registry-test-secret';

const CONFIG: ProviderConfig = {
  providers: [
    {
      id: 'deepseek',
      name: 'DeepSeek',
      kind: 'openai-compatible',
      baseUrl: 'https://api.deepseek.test/v1',
      apiKeyEnv: 'DEEPSEEK_API_KEY',
      models: ['deepseek-chat'],
    },
    {
      id: 'anthropic',
      name: 'Anthropic',
      kind: 'anthropic',
      baseUrl: 'https://api.anthropic.test',
      apiKeyEnv: 'ANTHROPIC_API_KEY',
      models: ['claude'],
    },
  ],
  aliases: {
    main: { provider: 'deepseek', model: 'deepseek-chat' },
    future: { provider: 'anthropic', model: 'claude' },
  },
  defaults: {
    timeoutMs: 1000,
    maxRetries: 2,
    concurrentSlots: 1,
    rateLimitBackoff: { strategy: 'exponential', initialMs: 1, maxMs: 2, maxAttempts: 2 },
  },
};

function registry(env: NodeJS.ProcessEnv, now?: () => number): ProviderRegistry {
  return new ProviderRegistry({
    config: CONFIG,
    env,
    ...(now === undefined ? {} : { now }),
    adapterFactory: (entry) => (entry.kind === 'openai-compatible' ? new FakeProvider() : null),
  });
}

describe('别名解析（晚绑定）', () => {
  it('解析出 providerId 与实际模型', () => {
    const resolved = registry({ DEEPSEEK_API_KEY: KEY }).resolve('main');
    expect(resolved.providerId).toBe('deepseek');
    expect(resolved.model).toBe('deepseek-chat');
    expect(resolved.alias).toBe('main');
  });

  it('未配置的别名 → MODEL_ALIAS_UNRESOLVED，且列出已配置别名', () => {
    const error = catchError(() => registry({ DEEPSEEK_API_KEY: KEY }).resolve('nope'));
    expect(error.code).toBe('MODEL_ALIAS_UNRESOLVED');
    expect(error.message).toContain('main');
  });

  it('环境变量缺失 → PROVIDER_UNAVAILABLE，消息里只有变量名', () => {
    const error = catchError(() => registry({}).resolve('main'));
    expect(error.code).toBe('PROVIDER_UNAVAILABLE');
    expect(error.message).toContain('DEEPSEEK_API_KEY');
  });

  it('空字符串的环境变量等同于未配置', () => {
    const error = catchError(() => registry({ DEEPSEEK_API_KEY: '   ' }).resolve('main'));
    expect(error.code).toBe('PROVIDER_UNAVAILABLE');
  });

  it('P0 未实现的 adapter 类型 → PROVIDER_UNAVAILABLE（D-17），但不影响别的别名', () => {
    const reg = registry({ DEEPSEEK_API_KEY: KEY, ANTHROPIC_API_KEY: KEY });
    expect(catchError(() => reg.resolve('future')).code).toBe('PROVIDER_UNAVAILABLE');
    expect(reg.resolve('main').providerId).toBe('deepseek');
  });
});

describe('启动时行为与健康（§7.2）', () => {
  it('缺凭据的 provider 标 down 并给出变量名，但构造不抛错（服务必须能起来）', () => {
    const reg = registry({});
    const health = reg.getHealth('deepseek');
    expect(health.status).toBe('down');
    expect(health.note).toContain('DEEPSEEK_API_KEY');
    expect(JSON.stringify(health)).not.toContain(KEY);
  });

  it('listProviders 只出 apiKeyEnv 与 apiKeyPresent，绝不出值', () => {
    const views = registry({ DEEPSEEK_API_KEY: KEY }).listProviders();
    const deepseek = views.find((v) => v.id === 'deepseek');
    expect(deepseek?.apiKeyPresent).toBe(true);
    expect(deepseek?.apiKeyEnv).toBe('DEEPSEEK_API_KEY');
    expect(JSON.stringify(views)).not.toContain(KEY);
    // 反向验证：这份 dump 确实非空
    expect(JSON.stringify(views)).toContain('DEEPSEEK_API_KEY');
  });

  it('429 计数是滚动 10 分钟窗口', () => {
    let now = 1_000_000;
    const reg = registry({ DEEPSEEK_API_KEY: KEY }, () => now);
    reg.recordRateLimit('deepseek');
    reg.recordRateLimit('deepseek');
    expect(reg.getHealth('deepseek').rateLimitCount).toBe(2);
    expect(reg.getHealth('deepseek').status).toBe('rate_limited');

    now += 10 * 60 * 1000 + 1;
    expect(reg.getHealth('deepseek').rateLimitCount).toBe(0);
  });

  it('adapter 不支持探测时如实标 down，而不是伪造 ok', async () => {
    // FakeProvider 没有实现 probe
    const health = await registry({ DEEPSEEK_API_KEY: KEY }).probe('deepseek');
    expect(health.status).toBe('down');
    expect(health.note).toContain('不支持连通性探测');
  });

  it('未知 providerId → PROVIDER_UNAVAILABLE', () => {
    expect(catchError(() => registry({}).getHealth('nope')).code).toBe('PROVIDER_UNAVAILABLE');
  });
});

function catchError(fn: () => unknown): ForgeError {
  try {
    fn();
  } catch (error) {
    if (error instanceof ForgeError) return error;
    throw error;
  }
  throw new Error('期望抛出 ForgeError，但没有抛');
}
