/**
 * 仅开发用的 FakeProvider 服务器（M6 验证链路）。
 *
 * 与 main.ts 同一张依赖图（buildApp），只把 Provider 换成可脚本化的 FakeProvider，
 * 让工作台 10 态可以在浏览器里被真实驱动（SSE / 流式 / 自动跟随），不联网、不烧钱。
 *
 *   FAKE_SCENARIO=happy|struct-fail|slot-fail npm run dev:fake
 *
 * 运行时不要同时跑 dev:server（两者都用 3311）。前端 vite 代理指向 3311，
 * 因此 dev:fake 期间 `npm run dev:client` 照常可用。
 *
 * 这是 dev-only 工具：不改任何产品代码，脚本逻辑自成一体。
 */

import process from 'node:process';
import { openDatabase } from '@server/infrastructure/database/db.ts';
import { runMigrations } from '@server/infrastructure/database/migrate.ts';
import { FakeProvider } from '@server/runtime/provider/fake.ts';
import { buildApp } from '@server/application/composition.ts';
import { loadProviderConfig } from '@server/application/provider-config.ts';
import { loadServerConfig } from '@server/config/env.ts';
import { buildServer } from '@server/api/server.ts';
import type { CompiledSlotType, CompiledTemplate } from '@server/application/template-loader.ts';

const SCENARIO = process.env['FAKE_SCENARIO'] ?? 'happy';
const TEMPLATE_ID = process.env['FAKE_TEMPLATE'] ?? 'zhihu-chapter';

async function main(): Promise<void> {
  /**
   * 与 main.ts 共用同一份配置解析，只把**库的默认值**换掉。
   *
   * 换默认库不是洁癖：FakeProvider 造的是占位正文，混进真实生产库之后
   * 从任务列表上看不出区别（状态、槽位数、产物都长得一样），
   * 只有点开正文才发现是「〔占位〕」。
   * 用户显式设了 DATABASE_PATH 时仍以用户的为准。
   */
  const config = loadServerConfig({ defaultDatabasePath: './data/dev-fake.sqlite' });
  const db = openDatabase(config.databasePath);
  const { total } = runMigrations(db);

  const providers = await loadProviderConfig();
  const fake = new FakeProvider();

  const forge = buildApp({
    db,
    providers,
    templatesDir: config.templatesDir,
    skillsDir: config.skillsDir,
    adapterFactory: () => fake,
    env: fakeEnv(providers, process.env),
  });

  // 按场景预置脚本。第一个创建的任务会按序消费
  const loaded = await forge.catalog.requireUsable(TEMPLATE_ID);
  scriptScenario(fake, loaded.compiled, SCENARIO);
  console.log(`[dev-fake] scenario=${SCENARIO} template=${TEMPLATE_ID} 已预置脚本`);

  const recovery = forge.lifecycle.recoverOnStartup();
  if (recovery.recovered.length > 0) console.log(`[recover] ${String(recovery.recovered.length)} 个任务置为 stopped`);

  const app = buildServer({ forge, migrationCount: total });
  await app.listen({ port: config.port, host: config.host });
  console.log(`[dev-fake] listening on http://${config.host}:${String(config.port)} · 库 ${config.databasePath}`);
}

function scriptScenario(fake: FakeProvider, compiled: CompiledTemplate, scenario: string): void {
  const container = compiled.slotTypes.find((t) => !t.contentBearing);
  const contentTypes = compiled.slotTypes.filter((t) => t.contentBearing);
  if (container === undefined || contentTypes.length === 0) throw new Error('模板缺少容器或内容类型');

  if (scenario === 'struct-fail') {
    // 第一份结构提案触发确定性校验失败，重试时给出合法结构
    fake.script({ invalidStructure: 'DEPENDENCY_CYCLE', hangMs: 1200 });
  }

  // 合法结构：容器 + 每个内容类型一个槽位；title/scene 依赖 outline（制造「等待依赖」态）
  const outlineId = `${firstType(contentTypes, 'outline')}_01`;
  const slots = [
    { id: container.id, type: container.id, parentId: null, order: 0, instruction: '', dependsOn: [] },
    ...contentTypes.map((type, index) => ({
      id: `${type.id}_01`,
      type: type.id,
      parentId: container.id,
      order: index,
      instruction: `〔占位〕${type.name}`,
      dependsOn: type.id === firstType(contentTypes, 'outline') ? [] : [outlineId],
    })),
  ];
  fake.script({ submitStructure: { rootSlotId: container.id, slots }, hangMs: 1500 });

  // 内容：按生产顺序消费。slot-fail 场景让第一个内容槽连续失败 → failed
  for (const type of contentTypes) {
    if (scenario === 'slot-fail') {
      fake.script({ throwError: 'PROVIDER_ERROR' });
      fake.script({ throwError: 'PROVIDER_ERROR' });
      fake.script({ throwError: 'PROVIDER_ERROR' });
    } else {
      fake.script({ emitText: streamChunks(fillerFor(type)), submitContent: { slotId: `${type.id}_01`, content: fillerFor(type) }, hangMs: 900 });
    }
  }
}

function firstType(types: CompiledSlotType[], hint: string): string {
  const hit = types.find((t) => t.id.includes(hint));
  if (hit !== undefined) return hit.id;
  const first = types[0];
  return first === undefined ? '' : first.id;
}

function streamChunks(text: string): string[] {
  const chars = [...text];
  const chunks: string[] = [];
  for (let i = 0; i < chars.length; i += 12) chunks.push(chars.slice(i, i + 12).join(''));
  return chunks;
}

/** 撑到 minChars、不越 maxChars、不含 Markdown 小标题的占位正文 */
function fillerFor(type: CompiledSlotType): string {
  const min = type.validation.minChars ?? 0;
  const max = type.validation.maxChars ?? Number.POSITIVE_INFINITY;
  let text = max < 30 ? '〔占位〕' : '〔占位〕本段由 dev:fake 生成，用于验证流水线，不是真实内容。';
  while ([...text].length < min) text += max < 30 ? '占位' : `${type.name}的占位文字，仅用于让确定性校验有东西可校验。`;
  const chars = [...text];
  return chars.length > max ? chars.slice(0, max).join('') : text;
}

/** 给 providers.yaml 里每个 apiKeyEnv 补一个假值，真实值原样保留 */
function fakeEnv(providers: { providers: readonly { apiKeyEnv: string }[] }, base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const entry of providers.providers) env[entry.apiKeyEnv] ??= 'fake-provider-no-network';
  return env;
}

main().catch((err: unknown) => {
  console.error('dev-fake 启动失败', err);
  process.exit(1);
});
