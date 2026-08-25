/**
 * 把一个任务的 Trace 打印成人能读的时间线（文档 §12.2 的 M4 产出）。
 *
 * ```
 * npx tsx src/server/cli/dump-trace.ts --db ./data/forge-core.sqlite --task <id>
 * npx tsx src/server/cli/dump-trace.ts --db ./data/forge-core.sqlite --latest --group system
 * ```
 *
 * 它服务的是 M4 那件唯一重要的事：**结构提案为什么没过。**
 * 通过率是个数字，而数字不能告诉你改哪一句 Skill 文本；能告诉你的是
 * 「模型提交了什么、19 条校验里哪一条响了、`agentHint` 当时说的是什么」。
 * 这三样都在 trace 里，只是原始行太密（一次任务几百条），得有个东西把它摊平。
 *
 * ## 脱敏不在这一层做
 *
 * REQ §13 要求 trace 不含 API Key / Authorization / 环境变量值 / 模型隐藏推理。
 * 这条保证由 `shared/trace.ts` 的 `FORBIDDEN_PAYLOAD_KEY_PATTERN` 在**写入时**
 * 强制——命中即解析失败，脏数据根本进不了库。所以本文件直接打印 payload 是安全的，
 * 而且**必须**这么做：如果这里再过一遍过滤，就等于承认库里可能有脏数据，
 * 那么真正该修的是写入侧。读取侧的二次过滤只会把问题藏起来。
 */

import path from 'node:path';
import process from 'node:process';
import { openDatabase } from '@server/infrastructure/database/db.ts';
import { buildRepositories } from '@server/infrastructure/database/repositories/index.ts';
import { TRACE_FILTER_GROUPS, type TraceEvent, type TraceFilterGroup } from '@shared/trace.ts';

interface DumpArgs {
  dbPath: string;
  taskId: string | null;
  latest: boolean;
  group: TraceFilterGroup;
  payload: boolean;
  limit: number;
}

const USAGE = `用法：dump-trace.ts --db <path> (--task <id> | --latest) [选项]
  --group <name>   筛选分组，可选 ${Object.keys(TRACE_FILTER_GROUPS).join(' / ')}（默认 all）
  --payload        展开 payload（默认只印标题与摘要）
  --limit <n>      最多打印多少条（默认 500）`;

function parseArgs(argv: readonly string[]): DumpArgs {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === undefined || !token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
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

  const dbPath = flags.get('db');
  const taskId = flags.get('task') ?? null;
  const latest = flags.get('latest') === 'true';
  if (dbPath === undefined || (taskId === null && !latest)) throw new Error(USAGE);

  const group = flags.get('group') ?? 'all';
  if (!(group in TRACE_FILTER_GROUPS)) {
    throw new Error(`--group 只能是 ${Object.keys(TRACE_FILTER_GROUPS).join(' / ')}，收到「${group}」`);
  }

  const rawLimit = flags.get('limit');
  const limit = rawLimit === undefined ? 500 : Number.parseInt(rawLimit, 10);
  if (!Number.isInteger(limit) || limit <= 0) throw new Error(`--limit 需要正整数，收到「${rawLimit}」`);

  return {
    dbPath,
    taskId,
    latest,
    group: group as TraceFilterGroup,
    payload: flags.get('payload') === 'true',
    limit,
  };
}

export function dumpTrace(argv: readonly string[]): number {
  const args = parseArgs(argv);
  const db = openDatabase(path.resolve(args.dbPath));
  try {
    const repos = buildRepositories(db);

    const taskId = args.taskId ?? latestTaskId(db);
    if (taskId === null) {
      log('库里一个任务都没有', 'error');
      return 1;
    }

    const task = repos.tasks.get(taskId);
    if (task === null) {
      log(`任务 ${taskId} 不存在`, 'error');
      return 1;
    }

    const kinds = new Set<string>(TRACE_FILTER_GROUPS[args.group]);
    // 一次取够再筛：仓储的 limit 作用在筛选**之前**，先筛后取会让
    // `--group system --limit 50` 变成「前 50 条里的 system 事件」——
    // 那个结果看起来正常，实际漏掉了后面所有内容
    const all = repos.traces.listByTask(taskId, { limit: Number.MAX_SAFE_INTEGER });
    const events = all.filter((e) => kinds.has(e.kind));

    log(`任务 ${task.id}`);
    log(`  ${task.name} · status=${task.status} phase=${task.phase}`);
    if (task.errorMessage !== null) log(`  失败原因：${task.errorMessage}`);
    log(`  trace ${all.length} 条，本次筛出 ${events.length} 条（分组 ${args.group}）`);
    log('');

    for (const event of events.slice(0, args.limit)) {
      printEvent(event, args.payload);
    }
    if (events.length > args.limit) {
      log(`… 还有 ${events.length - args.limit} 条被 --limit 截断`);
    }
    return 0;
  } finally {
    db.close();
  }
}

/**
 * 事件一行，payload 缩进跟在后面。
 *
 * 不做终端色彩：这个命令的输出经常被重定向进文件或管道给 grep，
 * ANSI 转义序列在那两种用法里是纯噪声，而「好看」只在直接看的时候有价值。
 */
function printEvent(event: TraceEvent, showPayload: boolean): void {
  const seq = String(event.sequence).padStart(4, ' ');
  const exec = event.executionId === null ? '        ' : event.executionId.slice(0, 8);
  log(`${seq} ${event.createdAt} ${exec} [${event.actor}] ${event.kind}`);
  log(`      ${event.title}${event.summary === '' ? '' : ` — ${event.summary}`}`);
  if (showPayload && event.payload !== null) {
    for (const line of JSON.stringify(event.payload, null, 2).split('\n')) {
      log(`      │ ${line}`);
    }
  }
}

/** `--latest`：调试时几乎总是想看刚跑完的那个，而任务 id 是 uuid，手抄很痛苦 */
function latestTaskId(db: ReturnType<typeof openDatabase>): string | null {
  const row = db.prepare('SELECT id FROM tasks ORDER BY created_at DESC, id DESC LIMIT 1').get() as
    | { id: string }
    | undefined;
  return row?.id ?? null;
}

function log(message: string, level: 'info' | 'error' = 'info'): void {
  const stream = level === 'error' ? process.stderr : process.stdout;
  stream.write(`${message}\n`);
}

if (process.argv[1] !== undefined && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  try {
    process.exitCode = dumpTrace(process.argv.slice(2));
  } catch (error: unknown) {
    log(error instanceof Error ? error.message : String(error), 'error');
    process.exitCode = 1;
  }
}
