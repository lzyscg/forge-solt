#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { parseReplayInput } from '@server/application/context-builder.ts';

interface ExportedCase {
  caseId: string;
  execution: {
    id: string;
    taskId: string;
    operation: 'create_structure' | 'fill_slot' | 'review_slot';
    targetSlotId: string | null;
    agentId: string;
    skillId: string;
    skillVersion: string;
    modelAlias: string;
    provider: string;
    model: string;
    attemptNumber: number;
  };
  replayInputJson: string;
  replayInputHash: string;
  expected: { contextHash: string; promptHash: string };
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export function exportComparisonCase(dbPath: string, skillId: string): ExportedCase {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const row = db
      .prepare(
        `SELECT id, task_id, operation, target_slot_id, agent_id, skill_id, skill_version,
                model_alias, provider, model, attempt_number, context_hash, prompt_hash,
                replay_input_json, replay_input_hash
           FROM executions
          WHERE skill_id = ? AND status = 'succeeded' AND replay_input_json IS NOT NULL
          ORDER BY attempt_number, created_at, id
          LIMIT 1`,
      )
      .get(skillId) as Record<string, string | number | null> | undefined;
    if (row === undefined) throw new Error(`没有找到 ${skillId} 的成功 ReplayInput execution`);
    const replayInputJson = String(row['replay_input_json']);
    const replayInputHash = String(row['replay_input_hash']);
    parseReplayInput(replayInputJson, replayInputHash);
    return {
      caseId: `${skillId}-${sha256(replayInputJson).slice(0, 12)}`,
      execution: {
        id: String(row['id']),
        taskId: String(row['task_id']),
        operation: String(row['operation']) as ExportedCase['execution']['operation'],
        targetSlotId: row['target_slot_id'] === null ? null : String(row['target_slot_id']),
        agentId: String(row['agent_id']),
        skillId: String(row['skill_id']),
        skillVersion: String(row['skill_version']),
        modelAlias: String(row['model_alias']),
        provider: String(row['provider']),
        model: String(row['model']),
        attemptNumber: Number(row['attempt_number']),
      },
      replayInputJson,
      replayInputHash,
      expected: { contextHash: String(row['context_hash']), promptHash: String(row['prompt_hash']) },
    };
  } finally {
    db.close();
  }
}

function main(): void {
  const [dbPath, skillId, outPath] = process.argv.slice(2);
  if (dbPath === undefined || skillId === undefined || outPath === undefined) {
    throw new Error('用法：npx tsx bench/export-case.ts <db> <skill-id> <out.json>');
  }
  const output = path.resolve(outPath);
  if (fs.existsSync(output)) throw new Error(`目标已存在，拒绝覆盖：${output}`);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify({ version: 1, cases: [exportComparisonCase(path.resolve(dbPath), skillId)] }, null, 2)}\n`);
}

try {
  if (process.argv[1]?.endsWith('export-case.ts') === true) main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
