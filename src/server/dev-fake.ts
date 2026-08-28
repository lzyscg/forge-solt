/**
 * 仅开发用的 FakeProvider 服务器（M6 验证链路）。
 *
 * 与 main.ts 同一张依赖图（buildApp），只把 Provider 换成可脚本化的 FakeProvider，
 * 让工作台 10 态可以在浏览器里被真实驱动（SSE / 流式 / 自动跟随），不联网、不烧钱。
 *
 *   FAKE_SCENARIO=happy|struct-fail|slot-fail|review-revise npm run dev:fake
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
import type { LoadedSkill } from '@server/application/skill-loader.ts';

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
  scriptScenario(fake, loaded.compiled, loaded.skills, SCENARIO);
  console.log(`[dev-fake] scenario=${SCENARIO} template=${TEMPLATE_ID} 已预置脚本`);

  const recovery = forge.lifecycle.recoverOnStartup();
  if (recovery.recovered.length > 0) console.log(`[recover] ${String(recovery.recovered.length)} 个任务置为 stopped`);

  const app = buildServer({ forge, migrationCount: total });
  await app.listen({ port: config.port, host: config.host });
  console.log(`[dev-fake] listening on http://${config.host}:${String(config.port)} · 库 ${config.databasePath}`);
}

/**
 * **R4 修复**：绑了审核的槽位类型必须补审核轮的脚本。
 *
 * 提交内容之后槽位进 `reviewing`，引擎按判据逐条跑 `review_slot`（D-23）。
 * 不补这几轮，假脚本会在第一条判据上耗尽 → `end_turn` 且没有提交 →
 * 槽位重试两次后 `failed`，整个任务失败。R4 把 `scene` 绑上 `scene-review`
 * 之后，本文件漏了这一段，于是 dev-fake 服务器**跑不通默认模板**
 * （实测：ASSIGNMENT_OUTPUT_INVALID「scene_01：Agent 未通过
 * complete_assignment 提交结果（已尝试 2 次）」）。
 *
 * 判据条数从**同一份 Skill** 数 section，与调度器枚举口径一致；
 * 写死数字会在判据增删时静默错位。
 */
function scriptReviewTurns(
  fake: FakeProvider,
  compiled: CompiledTemplate,
  skills: Readonly<Record<string, LoadedSkill>>,
  typeId: string,
  slotId: string,
  scenario: string,
): void {
  const binding = compiled.bindings.reviewSlotByType[typeId];
  if (binding === undefined) return;
  const skill = skills[binding.skillId];
  if (skill === undefined) {
    throw new Error(`模板 ${compiled.id} 的审核绑定引用了未加载的 Skill：${binding.skillId}`);
  }

  const content = fillerFor(compiled.slotTypes.find((t) => t.id === typeId)!);

  skill.sections.forEach((_section, index) => {
    /*
     * review-revise 场景：只让**第一条判据的第一轮**回 revise，其余一律 no_finding。
     * 于是工作台上能看到一次完整的返修——打回、重写、复审通过——而不会
     * 反复打回把 D-26 的两轮预算耗尽（那是 exhausted 路径，另一个场景的事）。
     *
     * 引文必须是正文里**逐字存在**的一段，否则会被 D-11 的引文闸门丢弃、
     * verdict 降级成 discarded，返修根本不会发生——演示就变成了一次空转。
     */
    const revise = scenario === 'review-revise' && index === 0;
    fake.script(
      revise
        ? {
            submitReview: {
              slotId,
              verdict: 'revise',
              findings: [
                {
                  criterionId: skill.sections[index]!.id,
                  quote: [...content].slice(0, 12).join(''),
                  problem: '〔占位〕首段没有接住前一场景的结尾状态。',
                },
              ],
            },
          }
        : { submitReview: { slotId, verdict: 'no_finding' } },
    );
  });
}

/** R5：结构审核的假回合。判据条数同样从 Skill 数 section，不写死 */
function scriptStructureReview(
  fake: FakeProvider,
  compiled: CompiledTemplate,
  skills: Readonly<Record<string, LoadedSkill>>,
  rootSlotId: string,
): void {
  const binding = compiled.bindings.reviewStructure;
  if (binding === null) return;
  const skill = skills[binding.skillId];
  if (skill === undefined) {
    throw new Error(`模板 ${compiled.id} 的结构审核绑定引用了未加载的 Skill：${binding.skillId}`);
  }
  for (const _section of skill.sections) {
    fake.script({ submitReview: { slotId: rootSlotId, verdict: 'no_finding' } });
  }
}

function scriptScenario(
  fake: FakeProvider,
  compiled: CompiledTemplate,
  skills: Readonly<Record<string, LoadedSkill>>,
  scenario: string,
): void {
  const container = compiled.slotTypes.find((t) => !t.contentBearing);
  const contentTypes = compiled.slotTypes.filter((t) => t.contentBearing);
  if (container === undefined || contentTypes.length === 0) throw new Error('模板缺少容器或内容类型');

  if (scenario === 'struct-fail') {
    // 第一份结构提案触发确定性校验失败，重试时给出合法结构
    fake.script({ invalidStructure: 'DEPENDENCY_CYCLE', hangMs: 1200 });
  }

  // 合法结构：容器 + 每个内容类型一个槽位。第一个内容类型无依赖，其余都依赖它，
  // 于是工作台上能看到「等待依赖」这个状态（合并 outline 之前这个角色由骨架槽位担任）。
  const leadId = `${contentTypes[0]?.id ?? ''}_01`;
  const slots = [
    { id: container.id, type: container.id, parentId: null, order: 0, instruction: '', dependsOn: [] },
    ...contentTypes.map((type, index) => ({
      id: `${type.id}_01`,
      type: type.id,
      parentId: container.id,
      order: index,
      instruction: `〔占位〕${type.name}`,
      dependsOn: index === 0 ? [] : [leadId],
    })),
  ];
  fake.script({ submitStructure: { rootSlotId: container.id, slots }, hangMs: 1500 });

  // R5：结构审核在填槽之前，脚本顺序必须与引擎的调度顺序一致。
  // 一律 no_finding：返修演示留给 review-revise 场景在槽位那一层做，
  // 结构返修会把整棵树换掉，界面上正在看的槽位会连 ID 一起变——那是另一个演示。
  scriptStructureReview(fake, compiled, skills, container.id);

  // 内容：按生产顺序消费。slot-fail 场景让第一个内容槽连续失败 → failed
  for (const type of contentTypes) {
    if (scenario === 'slot-fail') {
      fake.script({ throwError: 'PROVIDER_ERROR' });
      fake.script({ throwError: 'PROVIDER_ERROR' });
      fake.script({ throwError: 'PROVIDER_ERROR' });
    } else {
      const slotId = `${type.id}_01`;
      fake.script({ emitText: streamChunks(fillerFor(type)), submitContent: { slotId, content: fillerFor(type) }, hangMs: 900 });
      scriptReviewTurns(fake, compiled, skills, type.id, slotId, scenario);
      if (scenario === 'review-revise' && compiled.bindings.reviewSlotByType[type.id] !== undefined) {
        // 被打回后的第二稿：同一个槽位再产一次，然后各判据复审通过
        fake.script({ emitText: streamChunks(fillerFor(type)), submitContent: { slotId, content: fillerFor(type) }, hangMs: 900 });
        scriptReviewTurns(fake, compiled, skills, type.id, slotId, 'happy');
      }
    }
  }
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
