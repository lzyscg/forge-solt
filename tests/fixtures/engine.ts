/**
 * 生产引擎的集成测试夹具。
 *
 * 组装的是**真实的整张图**（`buildApp`），只把两样东西换掉：
 * 数据库换成 `:memory:`，Provider 换成 `FakeProvider`。
 * 其余每一层——仓储、事务、快照、上下文构建、工具循环、闸门——都是产品代码。
 *
 * 这一点是刻意的：M3 的完成判据说的是「headless 跑通一个完整任务」，
 * 而用替身替掉中间任何一层，跑通的就是替身而不是系统。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase, type ForgeDb } from '@server/infrastructure/database/db.ts';
import { runMigrations } from '@server/infrastructure/database/migrate.ts';
import { buildApp, type ForgeApp } from '@server/application/composition.ts';
import type { ProviderConfig } from '@server/application/provider-config.ts';
import { FakeProvider } from '@server/runtime/provider/fake.ts';
import type { ProviderAdapter } from '@server/runtime/provider/provider-adapter.ts';

const FIXTURE_ROOT = fileURLToPath(new URL('.', import.meta.url));

/**
 * 与 `config/providers.yaml` 同形的最小配置。
 *
 * 不直接读那个文件：测试若依赖仓库根的真实配置，改一次别名就会红一片，
 * 而红的原因与被测行为毫无关系。别名集合刻意与 fixture 模板对齐
 * （`structure` 给结构 Agent，`main` 给写作 Agent）。
 */
export const FAKE_PROVIDERS: ProviderConfig = {
  providers: [
    {
      id: 'fake',
      name: 'Fake',
      kind: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:0/v1',
      apiKeyEnv: 'FAKE_API_KEY',
      models: ['fake-model'],
    },
  ],
  aliases: {
    main: { provider: 'fake', model: 'fake-model' },
    structure: { provider: 'fake', model: 'fake-model' },
  },
  defaults: {
    timeoutMs: 5000,
    maxRetries: 2,
    concurrentSlots: 1,
    rateLimitBackoff: { strategy: 'exponential', initialMs: 1, maxMs: 4, maxAttempts: 3 },
  },
};

export interface EngineHarness extends ForgeApp {
  provider: FakeProvider;
  /**
   * 裸库句柄。**只给「模拟库被写坏了」这类用例用**——
   * 仓储层没有、也不该有写出非法数据的入口，而有些不变量恰恰是
   * 「万一库里有了非法数据会怎样」。正常用例一律走 uow。
   */
  db: ForgeDb;
  /** `/api/health` 要自证「迁移跑完了」，断言得对着一个真实数字 */
  migrationCount: number;
  close(): void;
}

export interface EngineHarnessOptions {
  provider?: FakeProvider;
  /**
   * 用一个**真实** adapter 顶掉 FakeProvider。
   *
   * 只给 AC-R-014 那一类用例：要证明「隐藏推理不出现在返修上下文里」，
   * 就必须让一条**真的带 `reasoning_content` 的 Provider 响应**走完整条链路。
   * 拿手工构造的干净对象去测这件事等于什么都没测。
   */
  adapter?: ProviderAdapter;
  /** 落到磁盘上的库路径。默认 `:memory:`；测「进程重启」时要用真文件 */
  dbPath?: string;
  templatesDir?: string;
  skillsDir?: string;
  /** 注入心跳调度器，让测试能同步触发心跳而不是真的等 15 秒 */
  startHeartbeat?: (fn: () => void, intervalMs: number) => () => void;
  /** 覆盖 Provider Registry 读取的环境变量（脱敏审计用显眼假值） */
  env?: NodeJS.ProcessEnv;
}

export function createEngineHarness(options: EngineHarnessOptions = {}): EngineHarness {
  const provider = options.provider ?? new FakeProvider();
  const db = openDatabase(options.dbPath ?? ':memory:');
  const { total: migrationCount } = runMigrations(db);

  const app = buildApp({
    db,
    providers: FAKE_PROVIDERS,
    templatesDir: options.templatesDir ?? path.join(FIXTURE_ROOT, 'templates'),
    skillsDir: options.skillsDir ?? path.join(FIXTURE_ROOT, 'skills'),
    // 所有 provider 条目都换成同一个 FakeProvider：测试要观察的是
    // 「引擎给 Provider 送了什么、拿回什么」，不是 HTTP 传输
    adapterFactory: () => options.adapter ?? provider,
    env: options.env ?? { FAKE_API_KEY: 'sk-fake-not-a-real-key' },
    ...(options.startHeartbeat !== undefined ? { startHeartbeat: options.startHeartbeat } : {}),
  });

  return {
    ...app,
    provider,
    db,
    migrationCount,
    close(): void {
      app.sse.close();
      db.close();
    },
  };
}

/** 供「进程重启」测试用的临时目录。返回的路径下会落一个真实 sqlite 文件 */
export function createTempDbPath(): { dbPath: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), 'forge-engine-'));
  return {
    dbPath: path.join(dir, 'forge.sqlite'),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

// ---------------------------------------------------------------------------
// 脚本片段
// ---------------------------------------------------------------------------

/** fixture 模板下一份合法结构：容器 + 骨架 + 标题 + 两个场景 */
export const VALID_STRUCTURE = {
  rootSlotId: 'chapter',
  slots: [
    { id: 'chapter', type: 'chapter', parentId: null, order: 0, instruction: '', dependsOn: [] },
    {
      id: 'outline',
      type: 'chapter_outline',
      parentId: 'chapter',
      order: 0,
      instruction: '规划三个场景的目标与冲突',
      dependsOn: [],
    },
    {
      id: 'title',
      type: 'title',
      parentId: 'chapter',
      order: 1,
      instruction: '拟定本章标题',
      dependsOn: ['outline'],
    },
    {
      id: 'scene_01',
      type: 'scene',
      parentId: 'chapter',
      order: 2,
      instruction: '雨夜对峙的开场',
      dependsOn: ['outline'],
    },
    {
      id: 'scene_02',
      type: 'scene',
      parentId: 'chapter',
      order: 3,
      instruction: '摊牌与收束',
      dependsOn: ['scene_01'],
    },
  ],
} as const;

/** 满足 scene 的 minChars=300 且不含 Markdown 小标题 */
export function sceneText(marker: string): string {
  return `${marker}。她推开门，雨声灌了进来。${'屋里没有人回答，只有水滴顺着窗框往下淌。'.repeat(20)}`;
}

/** 满足 chapter_outline 的 minChars=100 */
export function outlineText(): string {
  return `场景一：雨夜对峙，目标是逼出债主的底牌，冲突是双方都不肯先开口，出场人物为主角与债主。${'场景二：摊牌，目标是让主角做出选择。'.repeat(4)}`;
}

/** 满足 title 的 4..40 字 */
export const TITLE_TEXT = '雨夜里的第三次敲门';

/**
 * 轮询等待某个条件成立。
 *
 * 用在「让任务停在半路上」这类用例里：引擎是异步跑的，
 * 想在 running 状态下观察它，就得等它真的进到那个状态再动手，
 * 否则测的是「停一个还没开始的任务」。
 *
 * 超时抛错而不是静默返回：静默返回会让后续断言在一个**错误的前提**下运行，
 * 失败信息指向断言本身，而真正的原因是「条件根本没成立」。
 */
export async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() > deadline) throw new Error('waitFor 超时：条件始终没有成立');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
