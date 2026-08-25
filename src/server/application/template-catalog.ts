/**
 * 模板目录（文档 §4.1 / D-08 / §12.2 M2）。
 *
 * 枚举 `TEMPLATES_DIR` 下的模板，按 `status` 过滤，供模板列表页与新建任务页使用。
 *
 * 两条关键取舍：
 *
 * 1. **一个坏模板不许让整个列表页空白。**
 *    加载失败的模板收进 `failures` 而不是让 `reload()` 抛错。理由：
 *    模板是人手写的文件，写坏一个是常态；如果一坏就全站没模板可用，
 *    用户既看不到列表也无从知道是哪个坏了。反过来，坏模板必须**显式可见**
 *    （failures 带 PublicError），而不是静默消失——静默消失的表现是
 *    「我明明建了模板，列表里没有」，比报错难查得多。
 *
 * 2. **`draft` / `archived` 可见但不可用（D-08）。**
 *    列表页要显示它们（带状态 chip），创建任务时必须拒绝。
 *    因此分成两个入口：`list()` 默认不过滤，`requireUsable()` 强制 published。
 *    合成一个「listUsable」看似简洁，但会诱使调用方用「能不能查到」
 *    来判断能不能用，于是 draft 模板的报错会变成 TEMPLATE_NOT_FOUND——
 *    对着一个自己刚建的模板说「不存在」是最令人困惑的错误。
 */

import type { Dirent } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import type { TemplateStatus } from '@shared/contracts.ts';
import { ForgeError } from '@shared/errors.ts';
import type { PublicError } from '@shared/errors.ts';
import { compareCodePoints } from '@server/domain/canonical.ts';
import type { LoadedTemplate, TemplateLoaderOptions } from './template-loader.ts';
import { loadTemplate, TEMPLATE_FILE_NAME } from './template-loader.ts';
import { loadProviderConfig, DEFAULT_PROVIDER_CONFIG_PATH } from './provider-config.ts';

export interface TemplateCatalogOptions extends TemplateLoaderOptions {
  /** .env 的 `TEMPLATES_DIR`。其下每个含 template.yaml 的子目录算一个模板 */
  templatesDir: string;
}

export interface TemplateLoadFailure {
  /** 目录名。加载失败时模板 ID 未必解析得出来，只有目录名一定有 */
  dirName: string;
  sourcePath: string;
  error: PublicError;
}

export interface TemplateCatalogSnapshot {
  templates: readonly LoadedTemplate[];
  failures: readonly TemplateLoadFailure[];
}

export interface TemplateListFilter {
  /** 省略 = 不过滤。列表页要显示全部状态并打 chip（D-08） */
  status?: TemplateStatus | readonly TemplateStatus[];
}

function toPublicError(error: unknown): PublicError {
  if (error instanceof ForgeError) return error.toPublic();
  return {
    code: 'TEMPLATE_INVALID',
    message: error instanceof Error ? error.message : String(error),
    location: null,
    action: '检查 template.yaml 后重新加载',
  };
}

export class TemplateCatalog {
  #snapshot: TemplateCatalogSnapshot | null = null;
  readonly #options: TemplateCatalogOptions;

  constructor(options: TemplateCatalogOptions) {
    this.#options = options;
  }

  /**
   * 重新扫描目录。
   *
   * 全量重扫而不是增量：模板数量是十几个的量级，重扫的成本可以忽略，
   * 而增量缓存要处理「文件改了但 mtime 没变」「目录被整体替换」这类
   * 与收益完全不成比例的边界情况。
   */
  async reload(): Promise<TemplateCatalogSnapshot> {
    const root = path.resolve(this.#options.templatesDir);

    // 显式标注类型：`readdir` 有 Buffer 重载，靠 ReturnType 推导会命中错的那个
    let entries: Dirent[];
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch (error) {
      throw new ForgeError(
        'TEMPLATE_NOT_FOUND',
        // 不带路径：这条会经 `POST /api/templates/:id/reload` 出网（§9.3）。
        // 要查具体是哪个目录，看日志里的 cause
        '模板根目录不可读',
        'config:TEMPLATES_DIR',
        '确认 .env 的 TEMPLATES_DIR 指向存在的目录',
        error,
      );
    }

    // 目录序在不同文件系统上不一致（APFS 与 ext4 就不同）。
    // 排序放在加载之前，让列表顺序、失败顺序都确定——否则同一份仓库
    // 在两台机器上的 API 响应字节不同，快照测试就没法写。
    const dirNames = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort(compareCodePoints);

    const templates: LoadedTemplate[] = [];
    const failures: TemplateLoadFailure[] = [];
    const seenIds = new Map<string, string>();

    for (const dirName of dirNames) {
      const templateDir = path.join(root, dirName);
      const sourcePath = path.join(templateDir, TEMPLATE_FILE_NAME);
      try {
        const loaded = await loadTemplate(templateDir, this.#options);
        // 目录名即 ID（§2.1 的 `templates/zhihu-chapter/template.yaml`）。
        // 不强制的话，同一个 ID 可以藏在两个目录里，而「按 ID 找模板」
        // 会随扫描顺序返回不同的那一个——一个只在别人机器上复现的 bug。
        if (loaded.compiled.id !== dirName) {
          throw new ForgeError(
            'TEMPLATE_INVALID',
            `模板目录名 ${dirName} 与 template.yaml 的 id ${loaded.compiled.id} 不一致`,
            `template:${dirName}`,
            '把目录名改成与 id 相同',
          );
        }
        const previous = seenIds.get(loaded.compiled.id);
        if (previous !== undefined) {
          throw new ForgeError(
            'TEMPLATE_INVALID',
            `模板 ID ${loaded.compiled.id} 与目录 ${previous} 重复`,
            `template:${dirName}`,
          );
        }
        seenIds.set(loaded.compiled.id, dirName);
        templates.push(loaded);
      } catch (error) {
        failures.push({ dirName, sourcePath, error: toPublicError(error) });
      }
    }

    this.#snapshot = { templates, failures };
    return this.#snapshot;
  }

  /** 首次调用触发扫描，之后走缓存。所有读取入口都经过它，避免「忘了先 load」 */
  async ensureLoaded(): Promise<TemplateCatalogSnapshot> {
    return this.#snapshot ?? (await this.reload());
  }

  /** 列表页数据源。按 ID 码点序返回，与 reload 的扫描序一致 */
  async list(filter: TemplateListFilter = {}): Promise<readonly LoadedTemplate[]> {
    const { templates } = await this.ensureLoaded();
    if (filter.status === undefined) return templates;
    const allowed = typeof filter.status === 'string' ? [filter.status] : filter.status;
    return templates.filter((t) => allowed.includes(t.compiled.status));
  }

  /** 加载失败的模板。列表页应当把它们显示成不可用行，而不是当作不存在 */
  async failures(): Promise<readonly TemplateLoadFailure[]> {
    const { failures } = await this.ensureLoaded();
    return failures;
  }

  /** 模板详情页数据源。draft / archived 同样可查——它们的详情页要能打开 */
  async get(id: string): Promise<LoadedTemplate> {
    const { templates } = await this.ensureLoaded();
    const found = templates.find((t) => t.compiled.id === id);
    if (found === undefined) {
      throw new ForgeError('TEMPLATE_NOT_FOUND', `模板不存在：${id}`, `template:${id}`, '返回模板列表重新选择');
    }
    return found;
  }

  /**
   * 创建任务时的入口（D-08）。
   *
   * 与 `get` 分开的理由见文件头注释：状态不对要报 TEMPLATE_NOT_PUBLISHED，
   * 不能借 TEMPLATE_NOT_FOUND 顶替。
   */
  async requireUsable(id: string): Promise<LoadedTemplate> {
    const template = await this.get(id);
    if (template.compiled.status !== 'published') {
      throw new ForgeError(
        'TEMPLATE_NOT_PUBLISHED',
        `模板 ${id} 当前状态为 ${template.compiled.status}，不可用于创建新任务`,
        `template:${id}`,
        '该模板不可用于新任务，请选择已发布模板',
      );
    }
    return template;
  }
}

export function createTemplateCatalog(options: TemplateCatalogOptions): TemplateCatalog {
  return new TemplateCatalog(options);
}

/**
 * 按 .env 装配（`TEMPLATES_DIR` / `SKILLS_DIR`），并从 providers.yaml 取
 * D-06 回退链的最后一级。
 *
 * 默认值与 `.env.example` 逐字对齐——两处漂移会让「照着 .env.example 配」
 * 得到一个行为不同的系统。
 */
export async function createTemplateCatalogFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  providerConfigPath: string = DEFAULT_PROVIDER_CONFIG_PATH,
): Promise<TemplateCatalog> {
  const providers = await loadProviderConfig(providerConfigPath);
  return createTemplateCatalog({
    templatesDir: env['TEMPLATES_DIR'] ?? './templates',
    skillsDir: env['SKILLS_DIR'] ?? './skills',
    defaults: { timeoutMs: providers.defaults.timeoutMs, maxRetries: providers.defaults.maxRetries },
    // D-19：既然 providers.yaml 已经读进来了，别名打错字就该在这里炸，
    // 而不是等任务跑起来烧掉一次 Assignment 才炸。
    // 运行期的 MODEL_ALIAS_UNRESOLVED 仍保留——它防的是 providers.yaml 事后被改瘦。
    knownAliases: new Set(Object.keys(providers.aliases)),
  });
}
