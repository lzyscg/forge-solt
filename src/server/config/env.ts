/**
 * 全局环境配置：**全系统唯一一处为「配置」读 `process.env` 的地方**。
 *
 * ## 为什么要有这个文件
 *
 * 在它出现之前，`process.env['X'] ?? 默认值` 散在 9 个地方，
 * 而且默认值是**抄过去的**：`'./templates'` 出现 4 次、`3311` 出现 2 次。
 * 后果不是「不好看」，是改一个默认值要改四处，漏一处的表现是
 * 「main.ts 用新值、CLI 还用旧值」——两条路径行为不一致，且不会有任何报错。
 *
 * 现在默认值只有这一份，其余文件从入口接收**已经解析好的配置对象**。
 *
 * ## 与凭据的分工（REQ §13，别合并这两件事）
 *
 * 本文件负责**配置**：端口、库路径、目录、日志级别。
 * 它**不读、不碰、不返回任何 API Key**。
 *
 * 凭据仍然只由 `ProviderRegistry` 读（那里是全系统唯一读 `process.env[apiKeyEnv]`
 * 的地方，见该文件头部的安全边界说明）。两者刻意不合并：
 * 一旦本模块开始返回 key，它就会随配置对象被传遍整个依赖图，
 * 而配置对象是会被打日志、被 JSON.stringify 的东西。
 *
 * ## 为什么抛裸 Error 而不是 ForgeError
 *
 * `ForgeError` 的错误码要进 `ERROR_HTTP_STATUS` 那张**完备**的映射表，
 * 而配置错误永远不会变成一个 HTTP 响应——它发生在监听端口之前，
 * 唯一的去向是 stderr 加退出码。为它新增一个错误码，
 * 等于往一张「每个值都要有 HTTP 语义」的表里塞一个没有 HTTP 语义的值。
 */

import { z } from 'zod';

/**
 * 空串按「未设置」处理。
 *
 * `.env` 里写 `PORT=` 是很常见的写法（尤其是从 `.env.example` 复制过来、
 * 只填了一部分）。若不做这层处理，`z.coerce.number()` 会把 `''` 变成 `0`，
 * 于是用户看到的是「端口 0 非法」，而他其实是**没填**——
 * 报错指向了一个他没做过的动作。
 */
const blankAsUndefined = (value: unknown): unknown =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;

const optional = <T extends z.ZodTypeAny>(schema: T) => z.preprocess(blankAsUndefined, schema);

/** pino 的级别集合。写死成枚举，拼错 `LOG_LEVEL=infoo` 会在启动时报错而不是静默降级 */
const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

const RawEnvSchema = z.object({
  PORT: optional(z.coerce.number().int().positive().max(65535).default(3311)),
  HOST: optional(z.string().min(1).default('127.0.0.1')),
  NODE_ENV: optional(z.string().min(1).default('development')),
  DATABASE_PATH: optional(z.string().min(1).default('./data/forge-core.sqlite')),
  TEMPLATES_DIR: optional(z.string().min(1).default('./templates')),
  SKILLS_DIR: optional(z.string().min(1).default('./skills')),
  LOG_LEVEL: optional(z.enum(LOG_LEVELS).default('info')),
});

/** 解析后的服务端配置。**不含任何凭据** */
export interface ServerConfig {
  readonly port: number;
  readonly host: string;
  readonly nodeEnv: string;
  readonly databasePath: string;
  readonly templatesDir: string;
  readonly skillsDir: string;
  readonly logLevel: (typeof LOG_LEVELS)[number];
}

export interface LoadServerConfigOptions {
  /** 便于测试注入假环境。缺省读 `process.env` */
  env?: NodeJS.ProcessEnv;
  /**
   * 覆盖 `DATABASE_PATH` 的**默认值**（不是覆盖用户显式设置的值）。
   *
   * 存在的唯一理由是 `dev-fake.ts`：它必须默认落到另一个库，
   * 否则 FakeProvider 造出来的占位任务会混进真实生产库。
   * 用户显式设了 `DATABASE_PATH` 时仍然以用户的为准。
   */
  defaultDatabasePath?: string;
}

/**
 * 解析并校验环境配置。失败即抛，由入口打印后退出——
 * 宁可启动失败，也不要让一个配置不确定的进程开始接管任务生命周期
 * （与 `main.ts` 里「迁移跑不完就不启动」「providers.yaml 读不出来就不启动」同一条纪律）。
 */
export function loadServerConfig(options: LoadServerConfigOptions = {}): ServerConfig {
  const env = options.env ?? process.env;
  const schema =
    options.defaultDatabasePath === undefined
      ? RawEnvSchema
      : RawEnvSchema.extend({
          DATABASE_PATH: optional(z.string().min(1).default(options.defaultDatabasePath)),
        });

  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`);
    throw new Error(`环境配置非法（检查 .env）：\n${lines.join('\n')}`);
  }

  const raw = parsed.data as z.infer<typeof RawEnvSchema>;
  return {
    port: raw.PORT,
    host: raw.HOST,
    nodeEnv: raw.NODE_ENV,
    databasePath: raw.DATABASE_PATH,
    templatesDir: raw.TEMPLATES_DIR,
    skillsDir: raw.SKILLS_DIR,
    logLevel: raw.LOG_LEVEL,
  };
}

/**
 * 启动横幅的文本行。
 *
 * 这不是装饰。此前「服务起来了、`/api/health` 还是绿的、但任务一跑就失败」
 * 是一个真实发生过的现象：`npm run dev:server` 不加载 `.env`，
 * `DEEPSEEK_API_KEY` 为空，而你要翻到 Provider 设置页才看得见原因。
 * 把「我现在到底用的是哪个库、哪个目录」直接打在启动第一屏，
 * 是让这类问题在**发生的那一刻**就可见，而不是等它变成一次失败的生产。
 */
export function describeConfig(config: ServerConfig): string[] {
  return [
    `端口       ${config.host}:${String(config.port)}`,
    `数据库     ${config.databasePath}`,
    `模板目录   ${config.templatesDir}`,
    `Skill 目录 ${config.skillsDir}`,
    `日志级别   ${config.logLevel}   环境 ${config.nodeEnv}`,
  ];
}
