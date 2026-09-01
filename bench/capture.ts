#!/usr/bin/env node
/**
 * S1 fixture capture：从历史库只读取真实任务输入，用当前模板与 Skill 完整重跑，
 * 把带 ReplayInput 的新 execution 写入独立 benchmark SQLite。
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import { buildApp } from '@server/application/composition.ts';
import { loadProviderConfig } from '@server/application/provider-config.ts';
import type { ProviderConfig } from '@server/application/provider-config.ts';
import { sha256Hex } from '@server/domain/canonical.ts';
import { openDatabase } from '@server/infrastructure/database/db.ts';
import { runMigrations } from '@server/infrastructure/database/migrate.ts';

interface Args {
  sourceDb: string;
  outDb: string;
  manifest: string;
  providerId: string;
  limit: number;
  templateId: string;
  providerConfig: string;
  templatesDir: string;
  skillsDir: string;
}

interface SourceCandidate {
  sourceTaskId: string;
  input: Record<string, string>;
  inputHash: string;
}

function parseArgs(argv: readonly string[]): Args {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === undefined || !token.startsWith('--')) continue;
    const [rawKey, inline] = token.slice(2).split(/=(.*)/s, 2);
    const next = argv[i + 1];
    if (inline !== undefined) flags.set(rawKey ?? '', inline);
    else if (next !== undefined && !next.startsWith('--')) {
      flags.set(rawKey ?? '', next);
      i += 1;
    } else flags.set(rawKey ?? '', 'true');
  }
  const outDb = flags.get('out-db');
  if (outDb === undefined) throw new Error('用法：capture.ts --out-db <独立.sqlite> [--limit 3] [--provider-id deepseek]');
  const resolvedOut = path.resolve(outDb);
  const manifest = flags.get('manifest') ?? `${resolvedOut}.selection.json`;
  const limit = Number(flags.get('limit') ?? '3');
  if (!Number.isInteger(limit) || limit < 1) throw new Error('--limit 必须是正整数');
  return {
    sourceDb: path.resolve(flags.get('source-db') ?? 'data/forge-core.sqlite'),
    outDb: resolvedOut,
    manifest: path.resolve(manifest),
    providerId: flags.get('provider-id') ?? 'deepseek',
    limit,
    templateId: flags.get('template') ?? 'zhihu-chapter',
    providerConfig: path.resolve(flags.get('provider-config') ?? 'config/providers.yaml'),
    templatesDir: path.resolve(flags.get('templates-dir') ?? 'templates'),
    skillsDir: path.resolve(flags.get('skills-dir') ?? 'skills'),
  };
}

function selectedProviderConfig(config: ProviderConfig, providerId: string): ProviderConfig {
  const provider = config.providers.find((entry) => entry.id === providerId);
  if (provider === undefined) throw new Error(`Provider 配置里没有 ${providerId}`);
  const aliases: Record<string, { provider: string; model: string; paid?: boolean | undefined }[]> = {};
  for (const [alias, chain] of Object.entries(config.aliases)) {
    const entry = chain.find((candidate) => candidate.provider === providerId);
    if (entry === undefined) throw new Error(`别名 ${alias} 的链里没有 Provider ${providerId}`);
    aliases[alias] = [{ ...entry }];
  }
  return { providers: [provider], aliases, defaults: config.defaults };
}

function sourceCandidates(sourceDb: string, templateId: string, limit: number): SourceCandidate[] {
  const db = new Database(sourceDb, { readonly: true, fileMustExist: true });
  try {
    const rows = db.prepare(
      `SELECT t.id, t.input_json
         FROM tasks t
         JOIN task_snapshots s ON s.id = t.snapshot_id
        WHERE s.template_id = ? AND t.status = 'completed'
        ORDER BY t.created_at, t.id`,
    ).all(templateId) as { id: string; input_json: string }[];
    const unique = new Map<string, SourceCandidate>();
    for (const row of rows) {
      const input = JSON.parse(row.input_json) as Record<string, string>;
      const inputHash = sha256Hex(row.input_json);
      if (!unique.has(inputHash)) unique.set(inputHash, { sourceTaskId: row.id, input, inputHash });
    }
    return [...unique.values()]
      .sort((a, b) => sha256Hex(`s2-r0:${a.inputHash}`).localeCompare(sha256Hex(`s2-r0:${b.inputHash}`)))
      .slice(0, limit);
  } finally {
    db.close();
  }
}

function executionSummary(db: Database.Database, taskId: string): {
  executions: number;
  bySkill: Record<string, number>;
  usage: { inputTokens: number; outputTokens: number };
} {
  const rows = db.prepare(
    `SELECT skill_id, input_tokens, output_tokens FROM executions WHERE task_id = ? ORDER BY created_at, id`,
  ).all(taskId) as { skill_id: string; input_tokens: number | null; output_tokens: number | null }[];
  const bySkill: Record<string, number> = {};
  let inputTokens = 0;
  let outputTokens = 0;
  for (const row of rows) {
    bySkill[row.skill_id] = (bySkill[row.skill_id] ?? 0) + 1;
    inputTokens += row.input_tokens ?? 0;
    outputTokens += row.output_tokens ?? 0;
  }
  return { executions: rows.length, bySkill, usage: { inputTokens, outputTokens } };
}

export async function capture(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);
  if (args.sourceDb === args.outDb) throw new Error('源数据库与 benchmark 输出数据库不能是同一路径');
  if (fs.existsSync(args.outDb)) throw new Error(`输出数据库已存在，拒绝覆盖：${args.outDb}`);
  if (fs.existsSync(args.manifest)) throw new Error(`selection manifest 已存在，拒绝覆盖：${args.manifest}`);
  const sourceBefore = fs.statSync(args.sourceDb).mtimeMs;
  const candidates = sourceCandidates(args.sourceDb, args.templateId, args.limit);
  if (candidates.length === 0) throw new Error(`源数据库没有已完成的 ${args.templateId} 任务`);

  fs.mkdirSync(path.dirname(args.outDb), { recursive: true });
  fs.mkdirSync(path.dirname(args.manifest), { recursive: true });
  const providerConfig = selectedProviderConfig(await loadProviderConfig(args.providerConfig), args.providerId);
  const db = openDatabase(args.outDb);
  runMigrations(db);
  const app = buildApp({
    db,
    providers: providerConfig,
    templatesDir: args.templatesDir,
    skillsDir: args.skillsDir,
  });
  await app.catalog.requireUsable(args.templateId);

  const runs: Array<Record<string, unknown>> = [];
  try {
    for (const candidate of candidates) {
      const created = await app.snapshots.createTask({
        templateId: args.templateId,
        name: `S2 r0 capture ${candidate.inputHash.slice(0, 12)}`,
        input: candidate.input,
      });
      let thrown: string | null = null;
      try {
        await app.lifecycle.start(created.task.id);
      } catch (error) {
        thrown = error instanceof Error ? error.message : String(error);
      }
      const task = app.uow.repositories.tasks.getOrThrow(created.task.id);
      runs.push({
        sourceTaskId: candidate.sourceTaskId,
        taskId: created.task.id,
        inputHash: candidate.inputHash,
        status: task.status,
        phase: task.phase,
        errorCode: task.errorCode,
        errorMessage: task.errorMessage ?? thrown,
        ...executionSummary(db, created.task.id),
      });
      console.log(`${candidate.inputHash.slice(0, 12)}  ${task.status}  ${created.task.id}`);
    }
  } finally {
    db.close();
  }

  const sourceAfter = fs.statSync(args.sourceDb).mtimeMs;
  if (sourceAfter !== sourceBefore) throw new Error('源数据库 mtime 发生变化：只读边界失效');
  const manifest = {
    schemaVersion: 1,
    selectionSeed: 's2-r0',
    templateId: args.templateId,
    providerId: args.providerId,
    sourceDbHash: sha256Hex(fs.readFileSync(args.sourceDb).toString('base64')),
    sourceMtimeUnchanged: true,
    selected: candidates.length,
    runs,
  };
  fs.writeFileSync(args.manifest, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`selection manifest → ${args.manifest}`);
  return runs.every((run) => run['status'] === 'completed') ? 0 : 1;
}

async function main(): Promise<void> {
  try {
    process.exitCode = await capture(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
