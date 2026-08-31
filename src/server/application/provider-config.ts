/**
 * `config/providers.yaml` 解析（文档 §4.2 / D-03 / D-17）。
 *
 * **为什么这个文件在 application 而不是 runtime**：
 * §2.1 把 provider 配置的读取画在 `runtime/provider/provider-registry.ts` 里，
 * 但模板编译期就需要它——D-06 的四级回退最后一级是 `defaults.timeoutMs` /
 * `defaults.maxRetries`，没有它 `CompiledTemplate` 的 `timeoutMs` / `maxRetries`
 * 填不满。让 template-loader 反向依赖 runtime 会把「加载模板」和「调模型」
 * 绑在一起（连跑个模板校验都得把 Provider 那套拖起来）。
 * 因此拆法是：**读文件 + Zod 解析在这里，别名的晚绑定解析仍在 ProviderRegistry**。
 * Registry 消费本模块的产物，不再自己 parse——保证两处不会各解析出一份配置。
 *
 * 安全约束（REQ §13）：本文件解析出来的东西里**只有环境变量名，没有值**。
 * `apiKeyEnv` 是名字，值由 ProviderRegistry 在发请求时从 `process.env` 取，
 * 且不得写入任何模板 / 快照 / 编译产物 / 日志。
 */

import { readFile } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { ExecutionDefaultsSchema } from '@shared/contracts.ts';
import type { ExecutionDefaults } from '@shared/contracts.ts';
import { ForgeError } from '@shared/errors.ts';

/**
 * Provider 条目。
 *
 * `.strict()` 在这里不是洁癖而是**防泄密的机器化执行**：多出来的任何键都会报错，
 * 于是「顺手在 providers.yaml 里写了个 `apiKey: sk-xxx` 调试一下」这种事
 * 会当场失败，而不是安安静静地被提交进版本库。
 */
const ProviderEntrySchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9-]*$/),
    name: z.string().min(1),
    /** 决定用哪个 adapter。P0 只实现 openai-compatible（D-17） */
    kind: z.enum(['openai-compatible', 'anthropic']),
    baseUrl: z.string().url(),
    /** 只能是环境变量**名**。全大写下划线的形态约束顺便拦住了「误填成 key 值」 */
    apiKeyEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/, 'apiKeyEnv 只能是环境变量名（全大写下划线），绝不能是 Key 的值'),
    models: z.array(z.string().min(1)).min(1),
  })
  .strict();

const ModelAliasEntrySchema = z
  .object({
    provider: z.string().min(1),
    model: z.string().min(1),
    /**
     * 这一档是按量付费的（D-69）。选中时要在轨迹里重重告警。
     *
     * 它不影响解析，只影响**响不响**。存在的理由是：按量付费档永不耗尽，
     * 一旦滑下去系统会无限期、无提示地持续花钱，而表面上一切正常。
     */
    paid: z.boolean().optional(),
  })
  .strict();

/**
 * 别名 → **有序**降级链（D-66）。数组顺序即优先级，第一档是首选。
 *
 * 兼容单对象写法：视为长度 1 的链。历史配置一个字都不用改。
 */
const ModelAliasChainSchema = z.union([
  ModelAliasEntrySchema.transform((entry) => [entry]),
  z.array(ModelAliasEntrySchema).min(1),
]);

export const ProvidersFileSchema = z.object({
  providers: z.array(ProviderEntrySchema).min(1),
  aliases: z.record(ModelAliasChainSchema),
  defaults: ExecutionDefaultsSchema,
});

export type ProviderEntry = z.infer<typeof ProviderEntrySchema>;
export type ModelAliasEntry = z.infer<typeof ModelAliasEntrySchema>;
/** 一条降级链。至少一档，顺序即优先级 */
export type ModelAliasChain = readonly ModelAliasEntry[];

export interface ProviderConfig {
  providers: readonly ProviderEntry[];
  aliases: Readonly<Record<string, ModelAliasChain>>;
  defaults: ExecutionDefaults;
}

function invalid(message: string, cause?: unknown): ForgeError {
  return new ForgeError(
    'PROVIDER_UNAVAILABLE',
    `config/providers.yaml 非法：${message}`,
    'config:providers.yaml',
    null,
    cause,
  );
}

/**
 * 解析（不含读文件）。与 IO 分离便于用字符串测非法配置。
 *
 * 除 schema 外还做一件事：把别名指向的 provider / model 就地查一遍。
 * 别名解析本身是晚绑定的（D-03），但**别名指向一个根本不存在的 provider**
 * 不是晚绑定问题，是配置写错了——留到运行时才炸只会换来一个
 * 「任务跑到一半 MODEL_ALIAS_UNRESOLVED」的糟糕体验。
 */
export function parseProviderConfig(text: string): ProviderConfig {
  let data: unknown;
  try {
    data = parseYaml(text, { prettyErrors: true });
  } catch (error) {
    throw invalid(`不是合法 YAML：${(error as Error).message}`, error);
  }

  const parsed = ProvidersFileSchema.safeParse(data);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(根)'}: ${issue.message}`)
      .join('；');
    throw invalid(detail, parsed.error);
  }

  const byId = new Map(parsed.data.providers.map((p) => [p.id, p]));
  if (byId.size !== parsed.data.providers.length) {
    throw invalid('providers[].id 存在重复');
  }

  // 逐档校验整条链，不只校验第一档（D-66）。
  // 只校验首档的话，配错的兜底档要等到**高优先级档耗尽那一刻**才炸——
  // 而那正是系统最需要它工作的时刻，也是最难复现的时刻。
  for (const [alias, chain] of Object.entries(parsed.data.aliases)) {
    const seen = new Set<string>();
    chain.forEach((target, index) => {
      const at = chain.length === 1 ? `别名 ${alias}` : `别名 ${alias} 的第 ${index + 1} 档`;
      const provider = byId.get(target.provider);
      if (provider === undefined) {
        throw new ForgeError(
          'MODEL_ALIAS_UNRESOLVED',
          `${at} 指向不存在的 provider：${target.provider}`,
          `alias:${alias}`,
        );
      }
      if (!provider.models.includes(target.model)) {
        throw new ForgeError(
          'MODEL_ALIAS_UNRESOLVED',
          `${at} 指向的模型 ${target.model} 不在 provider ${provider.id} 的 models 列表中`,
          `alias:${alias}`,
        );
      }
      // 同一个 provider+model 在一条链里出现两次是配置错误：降级到自己没有意义，
      // 而且会让「跳过了谁」的轨迹变得没法读。
      const key = `${target.provider}/${target.model}`;
      if (seen.has(key)) {
        throw new ForgeError(
          'MODEL_ALIAS_UNRESOLVED',
          `别名 ${alias} 的降级链里 ${key} 出现了多次`,
          `alias:${alias}`,
        );
      }
      seen.add(key);
    });
  }

  return parsed.data;
}

/** 默认配置路径。相对 cwd——服务与 CLI 都从仓库根启动（§2.1） */
export const DEFAULT_PROVIDER_CONFIG_PATH = 'config/providers.yaml';

export async function loadProviderConfig(
  configPath: string = DEFAULT_PROVIDER_CONFIG_PATH,
): Promise<ProviderConfig> {
  let text: string;
  try {
    text = await readFile(configPath, 'utf8');
  } catch (error) {
    throw invalid(`读取失败：${configPath}`, error);
  }
  return parseProviderConfig(text);
}
