import type { ForgeDb } from '../db.ts';
import type { Clock } from './types.ts';

export interface InsertTaskPrivateInput {
  taskId: string;
  fieldId: string;
  content: string;
  contentHash: string;
}

export interface TaskPrivateInputRepo {
  insertMany(inputs: readonly InsertTaskPrivateInput[]): void;
  get(taskId: string, fieldId: string): { content: string; contentHash: string } | null;
}

export function createTaskPrivateInputRepo(db: ForgeDb, clock: Clock): TaskPrivateInputRepo {
  const insert = db.prepare(
    `INSERT INTO task_private_inputs
       (task_id, field_id, content_text, content_hash, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  );
  const get = db.prepare(
    'SELECT content_text, content_hash FROM task_private_inputs WHERE task_id = ? AND field_id = ?',
  );
  return {
    insertMany(inputs) {
      const now = clock();
      for (const input of inputs) {
        insert.run(input.taskId, input.fieldId, input.content, input.contentHash, now);
      }
    },
    get(taskId, fieldId) {
      const row = get.get(taskId, fieldId) as { content_text: string; content_hash: string } | undefined;
      return row === undefined ? null : { content: row.content_text, contentHash: row.content_hash };
    },
  };
}
