/**
 * Provider 设置页的数据源（D-03 / §9.1 后三行）。
 *
 * ```
 * GET  /api/providers           Provider + 健康 + 别名映射 + 执行默认值
 * POST /api/providers/:id/probe 主动探测
 * GET  /api/providers/defaults  执行默认值
 * ```
 *
 * ## 为什么要一个 service 而不是让路由直接调 Registry
 *
 * 三份数据里只有两份是 Registry 的：`providers` 与 `aliases` 它能给，
 * 而 `usageCount` 要数**模板**（哪些绑定引用了这个别名），
 * Registry 不认识模板，也不该认识。凑数据的地方就是这里。
 *
 * ## 安全边界（REQ §13）
 *
 * 本层出网的东西里只有环境变量**名**与 `apiKeyPresent` 布尔值。
 * 密钥值的唯一读取点是 `ProviderRegistry.resolve()`，而它读出来的值
 * 挂在不可枚举属性上——本文件既不调它，也没有任何路径能碰到那个值。
 */

import type {
  ExecutionDefaults,
  ModelAliasView,
  ProviderHealth,
  ProviderListResponse,
} from '@shared/contracts.ts';
import type { ProviderRegistry } from '@server/runtime/provider/provider-registry.ts';
import type { ProviderConfig } from './provider-config.ts';
import type { TemplateCatalog } from './template-catalog.ts';

export interface ProviderServiceOptions {
  registry: ProviderRegistry;
  catalog: TemplateCatalog;
  /** `defaults` 直接来自 providers.yaml，Registry 不转发它 */
  config: ProviderConfig;
}

export interface ProviderService {
  list(): Promise<ProviderListResponse>;
  probe(providerId: string, signal?: AbortSignal): Promise<ProviderHealth>;
  defaults(): ExecutionDefaults;
}

export function createProviderService(options: ProviderServiceOptions): ProviderService {
  const { registry, catalog, config } = options;

  /**
   * 每个别名被多少条绑定引用。
   *
   * 计入 `createStructure` 与 `fillSlotByType` 两处，见 contracts 里
   * `usageCount` 的注释：只数槽位类型会让 `structure` 别名恒为 0，
   * 而这一栏要回答的正是「改掉它会影响到谁」。
   *
   * 范围是全部加载成功的模板，**含 draft / archived**：一个 archived 模板
   * 仍然可能被 retry 用到（历史任务的快照冻结的是别名，解析是晚绑定的，D-03），
   * 所以它对别名的引用是真实的依赖，不该从计数里消失。
   */
  async function usageByAlias(): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    const bump = (alias: string): void => {
      counts.set(alias, (counts.get(alias) ?? 0) + 1);
    };

    for (const template of await catalog.list()) {
      bump(template.compiled.bindings.createStructure.modelAlias);
      for (const binding of Object.values(template.compiled.bindings.fillSlotByType)) {
        bump(binding.modelAlias);
      }
    }
    return counts;
  }

  return {
    async list() {
      const usage = await usageByAlias();
      const aliases: ModelAliasView[] = registry.listAliases().map((entry) => ({
        ...entry,
        // 配了但没人用是完全正常的状态（D-17 的 L2/L3 梯级别名就是这样），
        // 缺省 0 而不是省略这一行——省略会让人以为别名没配上
        usageCount: usage.get(entry.alias) ?? 0,
      }));

      return { providers: registry.listProviders(), aliases, defaults: config.defaults };
    },

    probe(providerId, signal) {
      return registry.probe(providerId, signal);
    },

    defaults() {
      return config.defaults;
    },
  };
}
