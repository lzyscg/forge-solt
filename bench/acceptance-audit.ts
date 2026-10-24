#!/usr/bin/env node
import Database from 'better-sqlite3';
import { fingerprintStory } from '../src/server/domain/output-validation.ts';
import { sourceContainment } from '../src/server/domain/source-overlap.ts';

const dbPath = process.argv[2];
if (dbPath === undefined) throw new Error('需要 sqlite 路径');
const db = new Database(dbPath, { readonly: true, fileMustExist: true });
try {
  const task = db.prepare('SELECT id FROM tasks LIMIT 1').get() as { id: string };
  const artifact = db.prepare('SELECT CAST(content_blob AS TEXT) content FROM artifacts WHERE task_id=?').get(task.id) as { content: string };
  const source = db.prepare("SELECT content_text content FROM task_private_inputs WHERE task_id=? AND field_id='source_text'").get(task.id) as { content: string };
  const sections = db.prepare("SELECT content_text content FROM slots WHERE task_id=? AND type='section' ORDER BY sort_order").all(task.id) as { content: string }[];
  const fp = fingerprintStory(artifact.content);
  const overlaps = sections.map((row) => sourceContainment(row.content, source.content));
  const marker = source.content.slice(0, 200);
  const tables = ['tasks', 'task_snapshots', 'task_skill_snapshots', 'slots', 'executions', 'trace_events', 'artifacts', 'slot_reviews'];
  let outsideHits = 0;
  for (const table of tables) {
    const rows = db.prepare(`SELECT * FROM ${table}`).all();
    if (JSON.stringify(rows).includes(marker)) outsideHits += 1;
  }
  process.stdout.write(`${JSON.stringify({
    fingerprint: fp,
    overlap: { max: Math.max(...overlaps), mean: overlaps.reduce((a, b) => a + b, 0) / overlaps.length, sections: overlaps.length },
    privacy: { sourceMarkerTablesOutsidePrivate: outsideHits },
  }, null, 2)}\n`);
} finally {
  db.close();
}
