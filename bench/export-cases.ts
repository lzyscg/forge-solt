#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import Database from 'better-sqlite3';
import { parseReplayInput } from '@server/application/context-builder.ts';

const [dbPath, skillId, targetsText, outPath] = process.argv.slice(2);
if (dbPath === undefined || skillId === undefined || targetsText === undefined || outPath === undefined) {
  throw new Error('用法：npx tsx bench/export-cases.ts <db> <skill> <slot1,slot2> <out.json>');
}
const targets = targetsText.split(',').map((item) => item.trim()).filter(Boolean);
const db = new Database(path.resolve(dbPath), { readonly: true, fileMustExist: true });
try {
  const cases = targets.map((target) => {
    const row = db.prepare(
      `SELECT id, task_id, operation, target_slot_id, agent_id, skill_id, skill_version,
              model_alias, provider, model, attempt_number, context_hash, prompt_hash,
              replay_input_json, replay_input_hash
         FROM executions
        WHERE skill_id = ? AND target_slot_id = ? AND status = 'succeeded' AND replay_input_json IS NOT NULL
        ORDER BY attempt_number, created_at, id LIMIT 1`,
    ).get(skillId, target) as Record<string, string | number | null> | undefined;
    if (row === undefined) throw new Error(`没有找到 ${skillId}/${target}`);
    const replayInputJson = String(row['replay_input_json']);
    const replayInputHash = String(row['replay_input_hash']);
    parseReplayInput(replayInputJson, replayInputHash);
    return {
      caseId: `${skillId}-${target}`,
      execution: {
        id: String(row['id']), taskId: String(row['task_id']), operation: String(row['operation']),
        targetSlotId: String(row['target_slot_id']), agentId: String(row['agent_id']), skillId: String(row['skill_id']),
        skillVersion: String(row['skill_version']), modelAlias: String(row['model_alias']), provider: String(row['provider']),
        model: String(row['model']), attemptNumber: Number(row['attempt_number']),
      },
      replayInputJson, replayInputHash,
      expected: { contextHash: String(row['context_hash']), promptHash: String(row['prompt_hash']) },
    };
  });
  const output = path.resolve(outPath);
  if (fs.existsSync(output)) throw new Error(`目标已存在：${output}`);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify({ version: 1, cases }, null, 2)}\n`);
} finally {
  db.close();
}
