/**
 * M4 的量化闸门：连续跑 N 次真实任务，算出 §12.2 那张表的五个指标。
 *
 * ```
 * npx tsx --env-file=.env src/server/cli/measure-runs.ts \
 *    --template zhihu-chapter --input-file fixtures/chapter-packet.txt \
 *    --runs 20 --db ./data/m4-measure.sqlite
 *
 * npx tsx src/server/cli/measure-runs.ts --db ./data/m4-measure.sqlite --report-only
 * ```
 *
 * **统计与执行是分开的两件事**，`--report-only` 就是为此存在的：
 * 20 次真实调用要花十几分钟和真金白银，而口径几乎一定要改几次。
 * 把统计钉死在执行里，每改一次口径就得重跑一次——那笔钱会让人倾向于
 * 「凑合用现在这个口径」，而 M4 的整个价值就在这个数字准不准。
 *
 * ## 口径（改动口径必须同时改这段注释）
 *
 * 一个「提交」= 一条 `assignment_submitted` trace。注意它**不等于**一次 Execution：
 * D-20 规定被校验拒绝不收敛 execution，所以模型可以在同一次 Assignment 里
 * 改完再交，一次 execution 可能有多条提交。「首次通过」问的是
 * **第一条提交就过了没有**，因此按 trace 数而不是 execution 数统计才对得上题意。
 *
 * - 结构提案首次通过率：分母是「至少提交过一次结构」的任务。
 *   一次都没提交到（Provider 400、超时、模型只说话不调工具）不算进分母，
 *   但会单独报出来——把它们算作「未通过」会把 Provider 故障记到 Skill 文本头上。
 * - 槽位内容首次通过率：分母是「至少提交过一次」的槽位，同上。
 * - 端到端成功率与耗时：分母是本次实际跑的任务数，不做任何剔除。
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { openDatabase, type ForgeDb } from '@server/infrastructure/database/db.ts';
import { runMigrations } from '@server/infrastructure/database/migrate.ts';
import { buildApp } from '@server/application/composition.ts';
import { loadProviderConfig } from '@server/application/provider-config.ts';
import { loadServerConfig } from '@server/config/env.ts';

interface MeasureArgs {
  dbPath: string;
  template: string;
  inputFile: string | null;
  runs: number;
  reportOnly: boolean;
  templatesDir: string;
  skillsDir: string;
  providerConfig: string;
}

const USAGE = `用法：measure-runs.ts --db <path> [--template <id> --input-file <path> --runs <n>]
  --report-only    只对已有的库出统计，不发起任何模型调用`;

function parseArgs(argv: readonly string[]): MeasureArgs {
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
  if (dbPath === undefined) throw new Error(USAGE);
  const reportOnly = flags.get('report-only') === 'true';
  const template = flags.get('template') ?? 'zhihu-chapter';
  const inputFile = flags.get('input-file') ?? null;
  if (!reportOnly && inputFile === null) throw new Error(USAGE);

  const rawRuns = flags.get('runs') ?? '20';
  const runs = Number.parseInt(rawRuns, 10);
  if (!Number.isInteger(runs) || runs <= 0) throw new Error(`--runs 需要正整数，收到「${rawRuns}」`);

  const envConfig = loadServerConfig();

  return {
    dbPath,
    template,
    inputFile,
    runs,
    reportOnly,
    // 命令行标志 > 环境配置（统一解析，含默认值）。
    // CLI 自己再写一遍 `?? './templates'` 就会有第二份默认值。
    templatesDir: flags.get('templates-dir') ?? envConfig.templatesDir,
    skillsDir: flags.get('skills-dir') ?? envConfig.skillsDir,
    providerConfig: flags.get('provider-config') ?? './config/providers.yaml',
  };
}

// ---------------------------------------------------------------------------
// 统计
// ---------------------------------------------------------------------------

/** 一次提交序列的结果。`attempts` 是提交条数，`passed` 是最终有没有过 */
interface SubmissionSeries {
  attempts: number;
  passedAtAttempt: number | null;
}

export interface Metrics {
  totalTasks: number;
  completedTasks: number;
  /**
   * 还在跑的任务（`--report-only` 打在一个正在写入的库上时会遇到）。
   * 单列出来而不是算进失败：一个跑到一半的任务不是「失败的任务」，
   * 把它算进分母会让端到端成功率随着你什么时候按回车而变——
   * 那个数字看起来完全正常，只是不对。
   */
  inFlightTasks: number;
  /** 一次结构都没提交到的任务（Provider 故障 / 只说话不提交），不进通过率分母 */
  tasksWithoutStructureSubmission: number;
  structureFirstPass: { passed: number; total: number };
  structureWithinThree: { passed: number; total: number };
  slotFirstPass: { passed: number; total: number };
  /**
   * 有过「一次 complete_assignment 都没调」的 attempt 的槽位数。
   *
   * 这一项是 20 次实测**之后**补的，因为不补的话报告会说谎：那一批里
   * 槽位首次通过率是 100/100，而实际上有一个场景槽位的第一次 attempt
   * 模型只说话没提交，重试后才成功。按口径它确实不进分母（没有提交，
   * 就谈不上「提交没通过」），但只把它悄悄剔掉，读报告的人会以为
   * 槽位这一侧一次意外都没有过——而「模型没听懂要调工具」正是
   * D-17 要观察的失败模式之一，只是它的修法是改 Skill 措辞而不是改校验规则。
   */
  slotsWithNoSubmissionAttempt: number;
  /** 每个任务从第一条到最后一条 trace 的墙钟耗时（毫秒） */
  durationsMs: number[];
  failures: { taskId: string; message: string }[];
}

interface TraceRow {
  task_id: string;
  execution_id: string | null;
  kind: string;
  created_at: string;
}

/**
 * 从库里算指标。
 *
 * 只读 trace 与 tasks 两张表，不依赖任何内存状态——这样 `--report-only`
 * 与「跑完立即出数」走的是**同一段代码**，不会出现两个口径。
 */
export function computeMetrics(db: ForgeDb, taskIds: readonly string[] | null): Metrics {
  const tasks = (
    taskIds === null
      ? db.prepare('SELECT id, status, error_message FROM tasks ORDER BY created_at').all()
      : db
          .prepare(
            `SELECT id, status, error_message FROM tasks WHERE id IN (${taskIds.map(() => '?').join(',')}) ORDER BY created_at`,
          )
          .all(...taskIds)
  ) as { id: string; status: string; error_message: string | null }[];

  const metrics: Metrics = {
    totalTasks: tasks.length,
    completedTasks: 0,
    inFlightTasks: 0,
    tasksWithoutStructureSubmission: 0,
    structureFirstPass: { passed: 0, total: 0 },
    structureWithinThree: { passed: 0, total: 0 },
    slotFirstPass: { passed: 0, total: 0 },
    slotsWithNoSubmissionAttempt: 0,
    durationsMs: [],
    failures: [],
  };

  const traceStmt = db.prepare(
    `SELECT task_id, execution_id, kind, created_at FROM trace_events
      WHERE task_id = ? ORDER BY sequence`,
  );
  const opStmt = db.prepare('SELECT id, operation, target_slot_id FROM executions WHERE task_id = ?');

  for (const task of tasks) {
    if (task.status === 'completed') metrics.completedTasks += 1;
    else if (task.status === 'running' || task.status === 'queued') metrics.inFlightTasks += 1;
    else metrics.failures.push({ taskId: task.id, message: task.error_message ?? `status=${task.status}` });

    const traces = traceStmt.all(task.id) as TraceRow[];
    if (traces.length >= 2) {
      const first = Date.parse(traces[0]!.created_at);
      const last = Date.parse(traces[traces.length - 1]!.created_at);
      if (Number.isFinite(first) && Number.isFinite(last)) metrics.durationsMs.push(last - first);
    }

    const executions = opStmt.all(task.id) as {
      id: string;
      operation: string;
      target_slot_id: string | null;
    }[];
    const opById = new Map(executions.map((e) => [e.id, e]));

    // 结构：整个任务的所有结构提交合成**一条**序列。跨 execution 的重试
    // （超时后重来）在题意上仍是「这个任务的第几次结构提案」。
    const structure = collectSeries(traces, (execId) => opById.get(execId)?.operation === 'create_structure');
    if (structure.attempts === 0) {
      metrics.tasksWithoutStructureSubmission += 1;
    } else {
      metrics.structureFirstPass.total += 1;
      metrics.structureWithinThree.total += 1;
      if (structure.passedAtAttempt === 1) metrics.structureFirstPass.passed += 1;
      if (structure.passedAtAttempt !== null && structure.passedAtAttempt <= 3) {
        metrics.structureWithinThree.passed += 1;
      }
    }

    // 槽位：按 target_slot_id 分组，每个槽位一条序列
    const slotExecutions = executions.filter((e) => e.operation === 'fill_slot' && e.target_slot_id !== null);
    const slotIds = new Set(slotExecutions.map((e) => e.target_slot_id!));
    for (const slotId of slotIds) {
      const series = collectSeries(traces, (execId) => opById.get(execId)?.target_slot_id === slotId);

      // 「这个槽位跑了几个 attempt」与「提交了几次」是两个数。前者大于后者，
      // 说明有 attempt 从头到尾没调过 complete_assignment——那不是校验失败，
      // 但它同样是一次失败，不该在报告里消失。
      const attemptCount = slotExecutions.filter((e) => e.target_slot_id === slotId).length;
      if (attemptCount > series.attempts) metrics.slotsWithNoSubmissionAttempt += 1;

      if (series.attempts === 0) continue;
      metrics.slotFirstPass.total += 1;
      if (series.passedAtAttempt === 1) metrics.slotFirstPass.passed += 1;
    }
  }

  return metrics;
}

/**
 * 把一串 trace 压成「第几次提交过的」。
 *
 * 只认 `assignment_submitted` → 随后的第一条 `validation_passed` / `validation_failed`。
 * 中间夹着的工具调用、输出分片一律跳过：它们与「过没过」无关，
 * 而按下标做窗口匹配会让统计随着 trace 种类的增删而漂移。
 */
function collectSeries(traces: readonly TraceRow[], belongs: (executionId: string) => boolean): SubmissionSeries {
  let attempts = 0;
  let pending = false;
  for (const trace of traces) {
    if (trace.execution_id === null || !belongs(trace.execution_id)) continue;
    if (trace.kind === 'assignment_submitted') {
      attempts += 1;
      pending = true;
      continue;
    }
    if (!pending) continue;
    if (trace.kind === 'validation_passed') return { attempts, passedAtAttempt: attempts };
    if (trace.kind === 'validation_failed') pending = false;
  }
  return { attempts, passedAtAttempt: null };
}

// ---------------------------------------------------------------------------
// 报告
// ---------------------------------------------------------------------------

const TARGETS: Record<string, number> = {
  结构提案首次通过率: 0.8,
  结构提案三次内通过率: 0.98,
  槽位内容首次通过率: 0.9,
  单章端到端成功率: 0.9,
};

export function formatReport(metrics: Metrics): string {
  const lines: string[] = [];
  const rate = (passed: number, total: number): string =>
    total === 0 ? '—（分母为 0）' : `${((passed / total) * 100).toFixed(1)}%  (${passed}/${total})`;

  const row = (name: string, passed: number, total: number): void => {
    const target = TARGETS[name];
    const value = total === 0 ? null : passed / total;
    const verdict =
      value === null || target === undefined ? '' : value >= target ? '  ✓ 达标' : `  ✗ 未达标（目标 ${target * 100}%）`;
    lines.push(`${name.padEnd(12, '　')}  ${rate(passed, total)}${verdict}`);
  };

  lines.push(`本次统计 ${metrics.totalTasks} 个任务`);
  lines.push('');
  row('结构提案首次通过率', metrics.structureFirstPass.passed, metrics.structureFirstPass.total);
  row('结构提案三次内通过率', metrics.structureWithinThree.passed, metrics.structureWithinThree.total);
  row('槽位内容首次通过率', metrics.slotFirstPass.passed, metrics.slotFirstPass.total);
  // 分母扣掉在跑的：见 `inFlightTasks` 的注释
  const settled = metrics.totalTasks - metrics.inFlightTasks;
  row('单章端到端成功率', metrics.completedTasks, settled);

  const durations = [...metrics.durationsMs].sort((a, b) => a - b);
  if (durations.length > 0) {
    const mean = durations.reduce((a, b) => a + b, 0) / durations.length;
    // 中位数与最大值一起报：平均耗时被一个 180s 超时拉高时，
    // 只看均值会以为「整体变慢了」，而实际是有一次卡住了
    lines.push('');
    lines.push(
      `单章耗时  平均 ${(mean / 1000).toFixed(1)}s · 中位 ${(durations[durations.length >> 1]! / 1000).toFixed(1)}s` +
        ` · 最长 ${(durations[durations.length - 1]! / 1000).toFixed(1)}s`,
    );
  }

  if (metrics.inFlightTasks > 0) {
    lines.push('');
    lines.push(
      `注：${metrics.inFlightTasks} 个任务还在跑，已从端到端成功率的分母里扣除。` +
        '（在一个正在写入的库上跑 --report-only 会这样。等跑完再算一次。）',
    );
  }

  if (metrics.slotsWithNoSubmissionAttempt > 0) {
    lines.push('');
    lines.push(
      `注：${metrics.slotsWithNoSubmissionAttempt} 个槽位有过「模型只说话、没调 complete_assignment」的 attempt（重试后可能已成功）。` +
        '它不进首次通过率的分母——没有提交就谈不上提交没通过——但它是一类真实的失败，修法是改 Skill 措辞。',
    );
  }

  if (metrics.tasksWithoutStructureSubmission > 0) {
    lines.push('');
    lines.push(
      `注：${metrics.tasksWithoutStructureSubmission} 个任务一次结构都没提交到（Provider 故障或模型未调用工具），` +
        '不计入结构通过率的分母——把它们算作「未通过」会把链路故障记到 Skill 文本头上。',
    );
  }

  if (metrics.failures.length > 0) {
    lines.push('');
    lines.push(`未完成的任务 ${metrics.failures.length} 个：`);
    for (const failure of metrics.failures) {
      lines.push(`  ${failure.taskId.slice(0, 8)}  ${failure.message}`);
    }
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// 执行
// ---------------------------------------------------------------------------

export async function measureRuns(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);
  const db = openDatabase(path.resolve(args.dbPath));
  try {
    runMigrations(db);

    let taskIds: string[] | null = null;
    if (!args.reportOnly) {
      taskIds = await executeRuns(db, args);
    }

    const metrics = computeMetrics(db, taskIds);
    process.stdout.write(`\n${formatReport(metrics)}\n`);

    // 退出码只看那条硬闸门（§12.2：低于 80% 不进入 M5）。
    // 其余指标未达标同样重要，但它们不是「不许往下走」的那一条，
    // 让退出码同时代表四件事，CI 里就分不清是哪一条红了。
    const { passed, total } = metrics.structureFirstPass;
    return total > 0 && passed / total >= 0.8 ? 0 : 1;
  } finally {
    db.close();
  }
}

async function executeRuns(db: ForgeDb, args: MeasureArgs): Promise<string[]> {
  const packet = readFileSync(path.resolve(args.inputFile!), 'utf8');
  const providers = await loadProviderConfig(args.providerConfig);
  const app = buildApp({
    db,
    providers,
    templatesDir: args.templatesDir,
    skillsDir: args.skillsDir,
  });

  const loaded = await app.catalog.requireUsable(args.template);
  const required = loaded.compiled.inputFields.filter((f) => f.required === true);
  if (required.length !== 1) {
    throw new Error(`本脚本只支持恰好一个必填输入字段的模板，${args.template} 有 ${required.length} 个`);
  }

  const taskIds: string[] = [];
  for (let i = 0; i < args.runs; i += 1) {
    const started = Date.now();
    const created = await app.snapshots.createTask({
      templateId: args.template,
      name: `M4 实测 #${i + 1}`,
      input: { [required[0]!.id]: packet },
    });
    taskIds.push(created.task.id);

    // 单次失败不中断整轮：20 次里有 2 次挂掉，恰恰是要测的东西。
    // 让它抛出去会把剩下 18 次的样本一起丢掉，而重跑要再花一次钱。
    try {
      await app.lifecycle.start(created.task.id);
    } catch (error: unknown) {
      process.stderr.write(`#${i + 1} 抛出异常：${error instanceof Error ? error.message : String(error)}\n`);
    }

    const task = app.uow.repositories.tasks.getOrThrow(created.task.id);
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    process.stdout.write(`#${String(i + 1).padStart(2, ' ')}  ${task.status.padEnd(9)} ${seconds}s\n`);
  }
  return taskIds;
}

if (process.argv[1] !== undefined && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  measureRuns(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
