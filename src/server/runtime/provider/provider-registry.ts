/**
 * 模型别名解析与 Provider 健康（D-03 / §7.2）。
 *
 * 别名层存在的全部意义是**晚绑定**：Task Snapshot 冻结的是别名字符串
 * （`agent.model = "main"`），不是解析结果。换模型只改 `providers.yaml`，
 * 历史任务的 retry 照常能跑。代价是同一任务两次 attempt 可能落到不同实际模型，
 * 这由 `executions.provider` / `executions.model` 记录解析后的值来保证可追溯。
 *
 * 因此 `resolve()` 在**每次 Execution 创建时调用一次**，不缓存结果。
 *
 * 安全边界（REQ §13）：本类是全系统唯一读 `process.env[apiKeyEnv]` 的地方。
 * 读出来的值只放进 `ResolvedModel.apiKey`，而那个属性被声明为**不可枚举**——
 * 于是 `JSON.stringify(resolved)` / `{...resolved}` 落日志时不会带出密钥。
 * 这不是万全（`resolved.apiKey` 仍能显式读到），但它挡住的正是最常见的那种事故：
 * 有人图省事把整个对象塞进 trace payload 或 `logger.info`。
 */

import type { ProviderHealth, ProviderView } from '@shared/contracts.ts';
import { ForgeError } from '@shared/errors.ts';
import type {
  ModelAliasChain,
  ProviderConfig,
  ProviderEntry,
} from '@server/application/provider-config.ts';
import type { ProviderAdapter } from './provider-adapter.ts';
import { OpenAiCompatibleAdapter } from './openai-compatible.ts';

export interface ResolvedModel {
  /** 冻结在快照里的别名。写入 `executions.model_alias` */
  readonly alias: string;
  readonly providerId: string;
  /** 解析后的实际模型 id。写入 `executions.model` */
  readonly model: string;
  readonly adapter: ProviderAdapter;
  /** 不可枚举，见文件头。绝不写入 DB / trace / 日志 */
  readonly apiKey: string;
}

export interface ProviderRegistryOptions {
  config: ProviderConfig;
  /** 便于测试注入假环境。缺省读 `process.env` */
  env?: NodeJS.ProcessEnv;
  /**
   * 按 provider 条目造 adapter。返回 `null` 表示该 kind 在 P0 未实现（D-17 的 anthropic）。
   * 注入点存在的理由是集成测试要把真实 HTTP 换成 FakeProvider，而不是为了将来扩展。
   */
  adapterFactory?: (entry: ProviderEntry) => ProviderAdapter | null;
  /** 注入时钟，让「滚动 10 分钟内的 429 次数」可测（domain 的确定性纪律同样适用于此） */
  now?: () => number;
}

/** 与 `ProviderHealthSchema.rateLimitCount` 的定义对齐：滚动 10 分钟 */
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;

/** 默认工厂。P0 只实现 openai-compatible（D-17），anthropic 返回 null 而不是抛——
 *  服务必须能起来，否则 Provider 设置页连「未连通」都显示不出来（§7.2 启动时行为） */
function defaultAdapterFactory(entry: ProviderEntry): ProviderAdapter | null {
  if (entry.kind === 'openai-compatible') {
    return new OpenAiCompatibleAdapter({ baseUrl: entry.baseUrl, providerId: entry.id });
  }
  return null;
}

export class ProviderRegistry {
  readonly #config: ProviderConfig;
  readonly #env: NodeJS.ProcessEnv;
  readonly #now: () => number;
  readonly #byId = new Map<string, ProviderEntry>();
  readonly #adapters = new Map<string, ProviderAdapter | null>();
  readonly #health = new Map<string, ProviderHealth>();
  /** providerId → 最近若干次 429 的时间戳。滚动窗口，读时裁剪 */
  readonly #rateLimitHits = new Map<string, number[]>();

  constructor(options: ProviderRegistryOptions) {
    this.#config = options.config;
    this.#env = options.env ?? process.env;
    this.#now = options.now ?? Date.now;
    const factory = options.adapterFactory ?? defaultAdapterFactory;

    for (const entry of this.#config.providers) {
      this.#byId.set(entry.id, entry);
      this.#adapters.set(entry.id, factory(entry));
      this.#health.set(entry.id, this.#initialHealth(entry));
    }
  }

  /**
   * 启动时行为（§7.2）：环境变量缺失 → `down` + 明确的 note，**但不阻止服务启动**。
   * note 里只写变量**名**——写「值为空」已经是在描述值了，写多了迟早有人顺手打印出来。
   */
  #initialHealth(entry: ProviderEntry): ProviderHealth {
    const present = this.#hasApiKey(entry);
    return {
      status: present ? 'ok' : 'down',
      latencyMs: null,
      note: present ? null : `环境变量 ${entry.apiKeyEnv} 未配置`,
      rateLimitCount: 0,
      checkedAt: null,
    };
  }

  #hasApiKey(entry: ProviderEntry): boolean {
    const raw = this.#env[entry.apiKeyEnv];
    return typeof raw === 'string' && raw.trim() !== '';
  }

  /**
   * 别名的降级链（D-66）。顺序即优先级，至少一档。
   *
   * 挑档的**策略**（谁耗尽了、冷却到了没有）不在这里——那要读库，
   * 属于 application 层。Registry 只回答「这个别名有哪几档可走」。
   */
  chainOf(alias: string): ModelAliasChain {
    const chain = this.#config.aliases[alias];
    if (chain === undefined) {
      const known = Object.keys(this.#config.aliases).sort().join(', ');
      throw new ForgeError(
        'MODEL_ALIAS_UNRESOLVED',
        `模型别名「${alias}」未在 config/providers.yaml 的 aliases 中配置。已配置的别名：${known || '（无）'}`,
        `alias:${alias}`,
      );
    }
    return chain;
  }

  /**
   * 晚绑定解析。每次 Execution 创建调用一次，不缓存。
   *
   * `providerId` 是**任务边界定住的那一档**（D-67）。给了就只解析那一档，
   * 不再看链——这正是「中途不换」的构造性保证落地的地方：
   * pin 一旦写进任务，就没有第二条路径可走。
   * 不给则取链首（无 pin 的历史任务、CLI、测试）。
   */
  resolve(alias: string, providerId?: string): ResolvedModel {
    const chain = this.chainOf(alias);
    const target =
      providerId === undefined ? chain[0] : chain.find((t) => t.provider === providerId);
    if (target === undefined) {
      throw new ForgeError(
        'MODEL_ALIAS_UNRESOLVED',
        providerId === undefined
          ? `别名「${alias}」的降级链是空的`
          : // pin 指向的档已经不在链上了——配置在任务跑到一半时被改过。
            // 这里必须炸而不是悄悄回落到链首：回落等于**在任务中途换了模型**，
            // 而 D-67 全部的意义就是不允许这件事发生。
            `任务定住的 Provider「${providerId}」已不在别名「${alias}」的降级链上` +
            `（当前链：${chain.map((t) => t.provider).join(' → ')}）。` +
            `配置在任务运行期间被改过，本任务不会自动改用其他档。`,
        `alias:${alias}`,
      );
    }

    const entry = this.#byId.get(target.provider);
    if (entry === undefined) {
      // parseProviderConfig 已经查过一遍，这里是第二道网：
      // Registry 也可能被直接用一份手工构造的 config 实例化（测试、CLI）
      throw new ForgeError(
        'MODEL_ALIAS_UNRESOLVED',
        `别名「${alias}」指向不存在的 provider「${target.provider}」`,
        `alias:${alias}`,
      );
    }

    const adapter = this.#adapters.get(entry.id) ?? null;
    if (adapter === null) {
      throw new ForgeError(
        'PROVIDER_UNAVAILABLE',
        `Provider「${entry.name}」的类型 ${entry.kind} 在当前版本未实现（D-17：P0 只实现 openai-compatible）`,
        `provider:${entry.id}`,
      );
    }

    const apiKey = this.#env[entry.apiKeyEnv];
    if (apiKey === undefined || apiKey.trim() === '') {
      throw new ForgeError(
        'PROVIDER_UNAVAILABLE',
        `Provider「${entry.name}」的环境变量 ${entry.apiKeyEnv} 未配置`,
        `provider:${entry.id}`,
      );
    }

    const resolved = {
      alias,
      providerId: entry.id,
      model: target.model,
      adapter,
    } as ResolvedModel;
    // 不可枚举：挡住「整个对象被 stringify 进日志」这类最常见的泄密方式
    Object.defineProperty(resolved, 'apiKey', {
      value: apiKey,
      enumerable: false,
      writable: false,
      configurable: false,
    });
    return resolved;
  }

  /**
   * 只读地看一眼别名指向哪里，**不取 API Key、不要求 adapter 可用**。
   *
   * 与 `resolve()` 的分工是刻意的：`resolve()` 是执行路径，缺凭据就该炸；
   * 本方法是展示路径（模板详情页的 `resolvedModel`、Provider 设置页的映射表），
   * 而「凭据没配」恰恰是那两个页面最需要显示出来的状态之一。
   * 让展示走 `resolve()` 会得到一个 500——用户想看的正是「哪里没配好」，
   * 结果整页打不开。别名本身不存在时返回 null，由调用方决定显示成什么。
   */
  describeAlias(
    alias: string,
  ): { providerId: string; providerName: string; model: string; fallbackCount: number } | null {
    const chain = this.#config.aliases[alias];
    // schema 保证 min(1)，但 Registry 也可能拿手工构造的 config 实例化（测试、CLI），
    // 那条路径绕过了 Zod。空链在这里当成「没配」而不是崩掉展示页。
    const target = chain?.[0];
    if (target === undefined) return null;
    const entry = this.#byId.get(target.provider);
    return {
      providerId: target.provider,
      // provider 条目缺失时退回 ID 而不是「未知」：陌生 ID 至少能拿去 grep 配置，
      // 通用词只会把「别名指向了一个不存在的 provider」这件事盖住（D-19 第 4 条）。
      providerName: entry?.name ?? target.provider,
      model: target.model,
      /** 首档之后还有几档兜底。0 表示没有降级链 */
      fallbackCount: (chain?.length ?? 1) - 1,
    };
  }

  /**
   * 全部已配置的别名，按别名码点序。
   *
   * 排序在这里做而不是留给调用方：`Object.keys` 的顺序是插入序，
   * 也就是 YAML 里的书写序——改一次配置文件的行序，
   * Provider 设置页的映射表就整体重排一次，而映射本身没有任何变化。
   */
  listAliases(): { alias: string; providerId: string; providerName: string; model: string }[] {
    return Object.keys(this.#config.aliases)
      .sort()
      .flatMap((alias) => {
        const described = this.describeAlias(alias);
        return described === null ? [] : [{ alias, ...described }];
      });
  }

  getHealth(providerId: string): ProviderHealth {
    const health = this.#health.get(providerId);
    if (health === undefined) {
      throw new ForgeError('PROVIDER_UNAVAILABLE', `未知 provider：${providerId}`, `provider:${providerId}`);
    }
    return { ...health, rateLimitCount: this.#countRecentRateLimits(providerId) };
  }

  /**
   * 记录一次 429（§8.5 的退避循环每次重试都调）。
   *
   * 只改健康状态，**不做任何退避决策**——退避策略属于 AssignmentRunner，
   * 放在这里会让「限流」与「限流后怎么办」耦合在同一个对象上，
   * 而后者需要 signal 与 trace，前者不该认识它们。
   */
  recordRateLimit(providerId: string): void {
    const hits = this.#rateLimitHits.get(providerId) ?? [];
    hits.push(this.#now());
    this.#rateLimitHits.set(providerId, hits);
    const health = this.#health.get(providerId);
    if (health !== undefined) {
      this.#health.set(providerId, {
        ...health,
        status: 'rate_limited',
        note: '最近触发过限流，正在退避重试',
        checkedAt: new Date(this.#now()).toISOString(),
      });
    }
  }

  #countRecentRateLimits(providerId: string): number {
    const hits = this.#rateLimitHits.get(providerId);
    if (hits === undefined) return 0;
    const cutoff = this.#now() - RATE_LIMIT_WINDOW_MS;
    // 就地裁剪：窗口外的时间戳留着只会无限增长，而它们已经不可能再被计入
    const kept = hits.filter((at) => at >= cutoff);
    this.#rateLimitHits.set(providerId, kept);
    return kept.length;
  }

  /**
   * 主动探测（D-03）。
   *
   * 适配器没实现 `probe` 时**不伪造 ok**：把 note 写成「不支持探测」，
   * 让 UI 显示实情。返回一个假的 ok 会让「Provider 设置页显示正常但任务全失败」
   * 成为可能，而那正是这个页面要防的事。
   */
  async probe(providerId: string, signal?: AbortSignal): Promise<ProviderHealth> {
    const entry = this.#byId.get(providerId);
    if (entry === undefined) {
      throw new ForgeError('PROVIDER_UNAVAILABLE', `未知 provider：${providerId}`, `provider:${providerId}`);
    }
    const at = new Date(this.#now()).toISOString();
    const adapter = this.#adapters.get(providerId) ?? null;
    const apiKey = this.#env[entry.apiKeyEnv];
    const firstModel = entry.models[0];

    if (adapter === null || adapter.probe === undefined || firstModel === undefined) {
      return this.#setHealth(providerId, {
        status: 'down',
        latencyMs: null,
        note: adapter === null ? `类型 ${entry.kind} 未实现` : '该 Provider 不支持连通性探测',
        rateLimitCount: this.#countRecentRateLimits(providerId),
        checkedAt: at,
      });
    }
    if (apiKey === undefined || apiKey.trim() === '') {
      return this.#setHealth(providerId, {
        status: 'down',
        latencyMs: null,
        note: `环境变量 ${entry.apiKeyEnv} 未配置`,
        rateLimitCount: this.#countRecentRateLimits(providerId),
        checkedAt: at,
      });
    }

    const startedAt = this.#now();
    try {
      await adapter.probe({
        model: firstModel,
        apiKey,
        signal: signal ?? new AbortController().signal,
      });
      return this.#setHealth(providerId, {
        status: 'ok',
        latencyMs: this.#now() - startedAt,
        note: null,
        rateLimitCount: this.#countRecentRateLimits(providerId),
        checkedAt: at,
      });
    } catch (error) {
      const isRateLimited = error instanceof ForgeError && error.code === 'PROVIDER_RATE_LIMITED';
      if (isRateLimited) this.recordRateLimit(providerId);
      return this.#setHealth(providerId, {
        status: isRateLimited ? 'rate_limited' : 'down',
        latencyMs: null,
        // 只取 message：ForgeError 的 cause 可能挂着原始 Response，
        // 那上面带着我们刚发出去的请求头
        note: error instanceof Error ? error.message : '探测失败',
        rateLimitCount: this.#countRecentRateLimits(providerId),
        checkedAt: at,
      });
    }
  }

  #setHealth(providerId: string, health: ProviderHealth): ProviderHealth {
    this.#health.set(providerId, health);
    return health;
  }

  /** 供 `GET /api/providers` 投影。只出环境变量**名**与「是否已配置」，绝不出值 */
  listProviders(): ProviderView[] {
    return this.#config.providers.map((entry) => ({
      id: entry.id,
      name: entry.name,
      kind: entry.kind,
      baseUrl: entry.baseUrl,
      apiKeyEnv: entry.apiKeyEnv,
      apiKeyPresent: this.#hasApiKey(entry),
      models: [...entry.models],
      health: this.getHealth(entry.id),
    }));
  }
}
