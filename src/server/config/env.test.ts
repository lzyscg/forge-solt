/**
 * 环境配置的判据测试。
 *
 * 这一层的价值不在「能读出值」，而在**读不出来时会不会炸**：
 * 配置层最危险的失败是「悄悄用了一个你没设过的值」，
 * 而那种失败在运行期表现为完全无关的现象（连错库、跑错目录、日志全没了）。
 */

import { describe, it, expect } from 'vitest';
import { loadServerConfig, describeConfig } from './env.ts';

/** 干净的空环境。不继承 process.env，否则本机的 .env 会让断言随机漂移 */
const EMPTY: NodeJS.ProcessEnv = {};

describe('loadServerConfig', () => {
  it('全部缺省时给出成文的默认值', () => {
    const config = loadServerConfig({ env: EMPTY });

    expect(config).toEqual({
      port: 3311,
      host: '127.0.0.1',
      nodeEnv: 'development',
      databasePath: './data/forge-core.sqlite',
      templatesDir: './templates',
      skillsDir: './skills',
      logLevel: 'info',
    });
  });

  it('显式设置覆盖默认值', () => {
    const config = loadServerConfig({
      env: { PORT: '8080', DATABASE_PATH: './data/other.sqlite', LOG_LEVEL: 'debug' },
    });

    expect(config.port).toBe(8080);
    expect(config.databasePath).toBe('./data/other.sqlite');
    expect(config.logLevel).toBe('debug');
  });

  /**
   * `.env` 从 `.env.example` 复制过来、只填了一部分时，
   * 留下的是 `PORT=` 而不是「没有这一行」。
   * 若把空串当值，用户会看到「端口 0 非法」——指向一个他没做过的动作。
   */
  it('空串按未设置处理，而不是解析成 0 / 空路径', () => {
    const config = loadServerConfig({
      env: { PORT: '', DATABASE_PATH: '   ', TEMPLATES_DIR: '' },
    });

    expect(config.port).toBe(3311);
    expect(config.databasePath).toBe('./data/forge-core.sqlite');
    expect(config.templatesDir).toBe('./templates');
  });

  it('端口非法时抛，且错误里指名是哪一项', () => {
    expect(() => loadServerConfig({ env: { PORT: 'abc' } })).toThrow(/PORT/);
    expect(() => loadServerConfig({ env: { PORT: '0' } })).toThrow(/PORT/);
    expect(() => loadServerConfig({ env: { PORT: '70000' } })).toThrow(/PORT/);
  });

  /**
   * 拼错日志级别必须炸。若静默退回 'info'，
   * 现象是「我明明开了 debug 却什么都没多出来」——查半天查不到原因。
   */
  it('日志级别拼错时抛，而不是静默降级', () => {
    expect(() => loadServerConfig({ env: { LOG_LEVEL: 'infoo' } })).toThrow(/LOG_LEVEL/);
  });

  it('错误信息指向 .env，让人知道去哪改', () => {
    expect(() => loadServerConfig({ env: { PORT: 'abc' } })).toThrow(/\.env/);
  });

  describe('defaultDatabasePath（dev-fake 用）', () => {
    it('只改默认值', () => {
      const config = loadServerConfig({ env: EMPTY, defaultDatabasePath: './data/dev-fake.sqlite' });
      expect(config.databasePath).toBe('./data/dev-fake.sqlite');
    });

    /**
     * 反证方向：用户显式设过就必须以用户的为准。
     * 反过来（覆盖掉用户的设置）的现象是「我指定了库，它却写到别处」，
     * 而且不会报错——数据静默进了错误的文件。
     */
    it('不覆盖用户显式设置的 DATABASE_PATH', () => {
      const config = loadServerConfig({
        env: { DATABASE_PATH: './data/mine.sqlite' },
        defaultDatabasePath: './data/dev-fake.sqlite',
      });
      expect(config.databasePath).toBe('./data/mine.sqlite');
    });
  });

  /**
   * REQ §13：配置对象会被打日志、被传遍依赖图，因此它一个凭据字段都不许有。
   * 这条断言的作用是：将来有人「顺手」把 apiKey 加进 ServerConfig 时立刻变红。
   */
  it('配置对象里不含任何凭据字段', () => {
    const config = loadServerConfig({
      env: { DEEPSEEK_API_KEY: 'sk-should-never-appear', OPENAI_API_KEY: 'sk-nope' },
    });

    const serialized = JSON.stringify(config);
    expect(serialized).not.toContain('sk-should-never-appear');
    expect(serialized).not.toContain('sk-nope');
    expect(Object.keys(config).join(',')).not.toMatch(/key|token|secret|credential/i);
  });
});

describe('describeConfig', () => {
  it('把关键取值都摆到启动第一屏', () => {
    const lines = describeConfig(loadServerConfig({ env: { DATABASE_PATH: './data/x.sqlite' } })).join('\n');

    expect(lines).toContain('./data/x.sqlite');
    expect(lines).toContain('3311');
    expect(lines).toContain('./templates');
  });

  it('横幅里同样不含凭据', () => {
    const lines = describeConfig(
      loadServerConfig({ env: { DEEPSEEK_API_KEY: 'sk-should-never-appear' } }),
    ).join('\n');

    expect(lines).not.toContain('sk-should-never-appear');
  });
});
