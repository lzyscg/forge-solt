/**
 * headless 跑一个完整任务（文档 §12.2 的 M3 完成判据）。
 *
 * ```
 * npx tsx src/server/cli/run-task.ts --template zhihu-chapter \
 *    --input-file fixtures/chapter-packet.txt --provider fake
 * ```
 *
 * 存在的理由不是「方便」，而是**可证明性**：整条生产线在没有 UI、没有网络的前提下
 * 能从头跑到尾，说明 M3 的闭环是真的闭上了。任何需要点几下界面才能验证的东西，
 * 在回归时都会被跳过。
 *
 * 它与 HTTP 服务共用 `buildApp` 那张依赖图（`application/composition.ts`），
 * 不另拼一套——拼两套的表现是「CLI 跑得通、服务跑不通」这种最难查的差异。
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { ForgeError } from '@shared/errors.ts';
import { openDatabase } from '@server/infrastructure/database/db.ts';
import { runMigrations } from '@server/infrastructure/database/migrate.ts';
import { FakeProvider } from '@server/runtime/provider/fake.ts';
import { buildApp } from '@server/application/composition.ts';
import { loadProviderConfig } from '@server/application/provider-config.ts';
import type { LoadedSkill } from '@server/application/skill-loader.ts';
import type { CompiledSlotType, CompiledTemplate } from '@server/application/template-loader.ts';
import { loadServerConfig } from '@server/config/env.ts';

interface CliArgs {
  template: string;
  inputFile: string;
  provider: 'fake' | 'real';
  name: string;
  dbPath: string;
  templatesDir: string;
  skillsDir: string;
  providerConfig: string;
}

function parseArgs(argv: readonly string[]): CliArgs {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === undefined || !token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    // 允许 `--flag value` 与 `--flag=value` 两种写法：前者是文档里的例子，
    // 后者是大多数人手上的肌肉记忆。只支持一种一定会被抱怨。
    if (key.includes('=')) {
      const [k, ...rest] = key.split('=');
      flags.set(k ?? '', rest.join('='));
    } else if (next !== undefined && !next.startsWith('--')) {
      flags.set(key, next);
      i += 1;
    } else {
      flags.set(key, 'true');
    }
  }

  const template = flags.get('template');
  const inputFile = flags.get('input-file');
  if (template === undefined || inputFile === undefined) {
    throw new Error(
      '用法：run-task.ts --template <id> --input-file <path> [--provider fake|real]\n' +
        '  --provider fake 走脚本化的假 Provider，不联网；real 读 config/providers.yaml',
    );
  }

  const provider = flags.get('provider') ?? 'fake';
  if (provider !== 'fake' && provider !== 'real') {
    throw new Error(`--provider 只能是 fake 或 real，收到「${provider}」`);
  }

  const envConfig = loadServerConfig();

  return {
    template,
    inputFile,
    provider,
    name: flags.get('name') ?? `${template} CLI 任务`,
    // 默认落到内存库：CLI 的默认行为不该往用户的工作副本里塞数据
    dbPath: flags.get('db') ?? ':memory:',
    // 命令行标志 > 环境配置（统一解析，含默认值）。
    // CLI 自己再写一遍 `?? './templates'` 就会有第二份默认值。
    templatesDir: flags.get('templates-dir') ?? envConfig.templatesDir,
    skillsDir: flags.get('skills-dir') ?? envConfig.skillsDir,
    providerConfig: flags.get('provider-config') ?? './config/providers.yaml',
  };
}

export async function runTask(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);
  const packet = readFileSync(path.resolve(args.inputFile), 'utf8');

  const db = openDatabase(args.dbPath);
  const migrations = runMigrations(db);
  log(`数据库就绪（已应用 ${migrations.total} 个迁移）`);

  const providers = await loadProviderConfig(args.providerConfig);
  const fake = new FakeProvider();

  const app = buildApp({
    db,
    providers,
    templatesDir: args.templatesDir,
    skillsDir: args.skillsDir,
    ...(args.provider === 'fake'
      ? {
          adapterFactory: (): FakeProvider => fake,
          // FakeProvider 不发 HTTP，但 Registry 仍会去 env 里取 apiKey（它不认识 fake）。
          // 给一个显然是假的值，而不是放宽 Registry 的校验——那条校验在真实路径上
          // 是「少配了密钥要当场报错」的唯一防线，不该为了跑个 demo 就打开缺口。
          env: fakeEnv(providers, process.env),
        }
      : {}),
  });

  const loaded = await app.catalog.requireUsable(args.template);
  if (args.provider === 'fake') scriptFakeFromTemplate(fake, loaded.compiled, loaded.skills);
  const created = await app.snapshots.createTask({
    templateId: args.template,
    name: args.name,
    input: singleFieldInput(loaded.compiled.inputFields, packet, args.template),
  });
  log(`任务已创建：${created.task.id}（${created.task.name}）`);

  await app.lifecycle.start(created.task.id);

  const task = app.uow.repositories.tasks.getOrThrow(created.task.id);
  const slots = app.uow.repositories.slots.listByTask(task.id);
  log(`任务收敛：status=${task.status} phase=${task.phase}`);
  // 只数内容承载槽位：容器不产出内容，落库即 pending 且永远保持 pending，
  // 把它算进分母会让「3/4 完成」这种看起来没跑完的数字出现在一次成功的运行里
  const contentSlots = slots.filter((s) => s.contentBearing);
  const doneCount = contentSlots.filter((s) => s.status === 'completed').length;
  log(`槽位：${slots.length} 个（内容槽 ${contentSlots.length} 个，已完成 ${doneCount} 个）`);

  if (task.status === 'completed') {
    const artifact = app.uow.repositories.artifacts.getByTaskOrThrow(task.id);
    log(`产物：${artifact.fileName}（${artifact.byteSize} 字节，checksum ${artifact.checksum}）`);
    db.close();
    return 0;
  }

  // 失败时把成文的原因原样打出来（D-19：它已经是一句可直接展示的完整中文）
  log(`失败原因：${task.errorMessage ?? '（无）'}`, 'error');
  db.close();
  return 1;
}

/**
 * 把整个输入文件塞给模板**唯一**的必填输入字段。
 *
 * CLI 只接一个 `--input-file`，而模板可以声明多个字段。这里不去猜多字段的分配方式
 * （那会变成一个需要用户学习的迷你格式），只覆盖「单一执行包」这个 P0 场景。
 * 遇到第二个必填字段就明确报错——悄悄留空会让 Agent 面对一份残缺输入，
 * 而它产出的东西看起来还挺像样，问题要到很后面才暴露。
 */
function singleFieldInput(
  fields: readonly { id: string; label: string; required?: boolean }[],
  packet: string,
  templateId: string,
): Record<string, string> {
  const required = fields.filter((f) => f.required === true);
  if (required.length === 0) {
    throw new Error(`模板 ${templateId} 没有必填输入字段，CLI 不知道该把执行包放进哪里`);
  }
  if (required.length > 1) {
    throw new Error(
      `模板 ${templateId} 有 ${required.length} 个必填输入字段` +
        `（${required.map((f) => f.label).join('、')}），` +
        'CLI 只支持单一执行包。请用 HTTP 接口创建这类任务。',
    );
  }
  return { [required[0]!.id]: packet };
}

/**
 * 按模板生成一份能跑通全程的假脚本。
 *
 * **这里产出的是占位文本，不是内容**——每段都以「〔占位〕」开头，谁都不会把它
 * 误当成真实产出。这么做而不是随便回一句「好的」，是因为 `--provider fake` 要证明的
 * 是**整条流水线**，包括那些只有在内容满足约束时才会走到的分支：
 * 确定性校验、组装、checksum、产物落库。回一句「好的」只能证明工具循环没崩。
 *
 * 结构上刻意贴着模板：每个 `contentBearing` 类型出一个槽位，长度按 `minChars` 撑够。
 * 于是换一个模板，这个脚本自动跟着变——写死一份结构的话，CLI 就只对当前这个模板有效。
 *
 * **R4：绑了审核的槽位类型还要补审核轮的脚本。**
 * 填槽提交之后槽位进 `reviewing`，引擎会按判据逐条跑 `review_slot` execution（D-23）。
 * 不补这几轮，假脚本会在第一条判据上耗尽 → `end_turn` 且没有提交 → 整条 CLI 路径失败。
 * 判据条数从**冻结前的同一份 Skill** 数（section 数），与调度器的枚举口径一致；
 * 写死一个数字会在判据增删时静默错位。
 * 一律回 `no_finding`：这个脚本要证明的是流水线跑得通，不是审核判得准——
 * 让它回 `revise` 会把 CLI 变成返修循环的测试，而返修循环有自己的集成用例。
 */
function scriptFakeFromTemplate(
  fake: FakeProvider,
  compiled: CompiledTemplate,
  skills: Readonly<Record<string, LoadedSkill>>,
): void {
  const container = compiled.slotTypes.find((t) => !t.contentBearing);
  const contentTypes = compiled.slotTypes.filter((t) => t.contentBearing);
  if (container === undefined || contentTypes.length === 0) {
    throw new Error(`模板 ${compiled.id} 缺少容器类型或内容类型，无法生成假脚本`);
  }

  const rootId = container.id;
  const slots = [
    { id: rootId, type: container.id, parentId: null, order: 0, instruction: '', dependsOn: [] },
    ...contentTypes.map((type, index) => ({
      id: `${type.id}_01`,
      type: type.id,
      parentId: rootId,
      order: index,
      instruction: `〔占位〕${type.name}`,
      dependsOn: [],
    })),
  ];

  fake.script({ submitStructure: { rootSlotId: rootId, slots } });
  for (const type of contentTypes) {
    const slotId = `${type.id}_01`;
    fake.script({ submitContent: { slotId, content: fillerFor(type) } });

    const reviewBinding = compiled.bindings.reviewSlotByType[type.id];
    if (reviewBinding === undefined) continue;
    const reviewSkill = skills[reviewBinding.skillId];
    if (reviewSkill === undefined) {
      throw new Error(`模板 ${compiled.id} 的审核绑定引用了未加载的 Skill：${reviewBinding.skillId}`);
    }
    for (const _criterion of reviewSkill.sections) {
      fake.script({ submitReview: { slotId, verdict: 'no_finding' } });
    }
  }
}

/**
 * 撑到 `minChars`、又不越过 `maxChars` 的占位正文。
 *
 * 两头都要顾：只补下限的话，一个 `maxChars: 40` 的标题槽会拿到一段 60 字的说明文，
 * 被确定性校验拒掉——而那看起来像是系统坏了，实际是假脚本自己没守模板的规矩。
 * 刻意不含 Markdown 小标题：那是模板里最常见的 `forbidPattern`。
 */
function fillerFor(type: CompiledSlotType): string {
  const min = type.validation.minChars ?? 0;
  const max = type.validation.maxChars ?? Number.POSITIVE_INFINITY;

  // 短槽位（标题这类）放不下完整说明，退化成一个仍然一眼可辨的短标记
  let text = max < 30 ? '〔占位〕' : '〔占位〕本段由 --provider fake 生成，用于验证流水线，不是真实内容。';
  while ([...text].length < min) {
    text += max < 30 ? '占位' : `${type.name}的占位文字，仅用于让确定性校验有东西可校验。`;
  }
  const chars = [...text];
  return chars.length > max ? chars.slice(0, max).join('') : text;
}

/** 给 providers.yaml 里每个 `apiKeyEnv` 补一个显眼的假值，真实值原样保留 */
function fakeEnv(
  providers: { providers: readonly { apiKeyEnv: string }[] },
  base: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const entry of providers.providers) {
    env[entry.apiKeyEnv] ??= 'fake-provider-no-network';
  }
  return env;
}

function log(message: string, level: 'info' | 'error' = 'info'): void {
  const stream = level === 'error' ? process.stderr : process.stdout;
  stream.write(`${message}\n`);
}

// 直接执行时才跑；被 import（测试）时不跑
if (process.argv[1] !== undefined && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  runTask(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      const message = error instanceof ForgeError || error instanceof Error ? error.message : String(error);
      log(message, 'error');
      process.exitCode = 1;
    });
}
