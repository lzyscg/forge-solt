import { describe, expect, it } from 'vitest';
import { loadProviderConfig, parseProviderConfig } from './provider-config.ts';

const VALID = `
providers:
  - id: deepseek
    name: DeepSeek
    kind: openai-compatible
    baseUrl: https://api.deepseek.com/v1
    apiKeyEnv: DEEPSEEK_API_KEY
    models: [deepseek-chat, deepseek-reasoner]
aliases:
  main: { provider: deepseek, model: deepseek-chat }
defaults:
  timeoutMs: 180000
  maxRetries: 2
  concurrentSlots: 1
  rateLimitBackoff:
    strategy: exponential
    initialMs: 1000
    maxMs: 60000
    maxAttempts: 5
`;

describe('provider-config', () => {
  it('解析仓库里真实的 config/providers.yaml', async () => {
    const config = await loadProviderConfig();
    expect(config.defaults.timeoutMs).toBe(180000);
    // §4.2 明确要求这两个默认值同为 2（D-19 更正）
    expect(config.defaults.maxRetries).toBe(2);
    expect(config.defaults.concurrentSlots).toBe(1);
    expect(Object.keys(config.aliases).sort()).toEqual(['configured', 'main', 'structure']);
    expect(config.providers[0]?.apiKeyEnv).toBe('DEEPSEEK_API_KEY');
  });

  it('只解析出环境变量名，不含任何 Key 值', async () => {
    const config = await loadProviderConfig();
    expect(JSON.stringify(config)).not.toMatch(/sk-/);
  });

  it('provider 条目里多写一个 apiKey 会被 strict 当场拦下（REQ §13）', () => {
    const withKey = VALID.replace('apiKeyEnv: DEEPSEEK_API_KEY', 'apiKeyEnv: DEEPSEEK_API_KEY\n    apiKey: sk-abc');
    expect(() => parseProviderConfig(withKey)).toThrowError(/apiKey/);
  });

  it('apiKeyEnv 写成了 Key 的值 → 被形态约束拦下', () => {
    expect(() => parseProviderConfig(VALID.replace('DEEPSEEK_API_KEY', 'sk-live-abc123'))).toThrowError(
      /apiKeyEnv/,
    );
  });

  it('别名指向不存在的 provider → MODEL_ALIAS_UNRESOLVED', () => {
    const bad = VALID.replace('main: { provider: deepseek', 'main: { provider: openai');
    expect(() => parseProviderConfig(bad)).toThrowError(/不存在的 provider/);
  });

  it('别名指向 provider 没声明的模型 → MODEL_ALIAS_UNRESOLVED', () => {
    const bad = VALID.replace('model: deepseek-chat }', 'model: gpt-4 }');
    expect(() => parseProviderConfig(bad)).toThrowError(/不在 provider/);
  });

  it('providers[].id 重复', () => {
    const bad = VALID.replace('aliases:', `  - id: deepseek\n    name: 重复\n    kind: openai-compatible\n    baseUrl: https://x.example/v1\n    apiKeyEnv: X_KEY\n    models: [m]\naliases:`);
    expect(() => parseProviderConfig(bad)).toThrowError(/重复/);
  });

  it('concurrentSlots 只能是 1（D-04：P0 固定，不可配）', () => {
    expect(() => parseProviderConfig(VALID.replace('concurrentSlots: 1', 'concurrentSlots: 4'))).toThrowError(
      /concurrentSlots/,
    );
  });

  it('不是合法 YAML / 文件不存在', () => {
    expect(() => parseProviderConfig('providers: [unclosed')).toThrowError(/不是合法 YAML/);
    return expect(loadProviderConfig('config/no-such.yaml')).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
    });
  });
});
