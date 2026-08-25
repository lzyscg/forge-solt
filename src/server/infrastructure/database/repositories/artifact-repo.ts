/**
 * ArtifactRepo —— `artifacts` 表。
 *
 * 权威来源：§5.2、§5.5「完成 Artifact」。
 *
 * `task_id` 上有 UNIQUE：一个任务只有一份产物。重跑组装必须先 `deleteByTask`
 * 再 insert，而不是 UPSERT——UPSERT 会让「产物被替换过」这件事不留痕迹，
 * 而 ASSEMBLY_FAILED 之后的重试恰恰需要能看出产物换过一次。
 */

import { ForgeError } from '@shared/errors.ts';
import type { ForgeDb } from '../db.ts';
import type { Artifact, Clock } from './types.ts';

interface ArtifactRow {
  id: string;
  task_id: string;
  file_name: string;
  media_type: string;
  content_blob: Buffer;
  checksum: string;
  byte_size: number;
  created_at: string;
}

export interface InsertArtifactInput {
  id: string;
  taskId: string;
  fileName: string;
  mediaType: string;
  content: string;
  /** 由 `domain/assembly.ts` 的 computeArtifactChecksum 算出，仓储不自己算 */
  checksum: string;
}

function toDomain(row: ArtifactRow): Artifact {
  return {
    id: row.id,
    taskId: row.task_id,
    fileName: row.file_name,
    mediaType: row.media_type,
    content: row.content_blob.toString('utf8'),
    checksum: row.checksum,
    byteSize: row.byte_size,
    createdAt: row.created_at,
  };
}

export interface ArtifactRepo {
  insert(input: InsertArtifactInput): Artifact;
  get(id: string): Artifact | null;
  getByTask(taskId: string): Artifact | null;
  getByTaskOrThrow(taskId: string): Artifact;
  deleteByTask(taskId: string): number;
}

export function createArtifactRepo(db: ForgeDb, clock: Clock): ArtifactRepo {
  const insertStmt = db.prepare(
    `INSERT INTO artifacts (id, task_id, file_name, media_type, content_blob, checksum, byte_size, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const getStmt = db.prepare('SELECT * FROM artifacts WHERE id = ?');
  const byTaskStmt = db.prepare('SELECT * FROM artifacts WHERE task_id = ?');

  return {
    insert(input) {
      const now = clock();
      const blob = Buffer.from(input.content, 'utf8');
      // byteSize 用 Buffer.byteLength 而不是 content.length：
      // 中文正文里两者永远不等，前端显示的文件大小会差三倍。
      insertStmt.run(
        input.id,
        input.taskId,
        input.fileName,
        input.mediaType,
        blob,
        input.checksum,
        blob.byteLength,
        now,
      );
      return {
        id: input.id,
        taskId: input.taskId,
        fileName: input.fileName,
        mediaType: input.mediaType,
        content: input.content,
        checksum: input.checksum,
        byteSize: blob.byteLength,
        createdAt: now,
      };
    },

    get(id) {
      const row = getStmt.get(id) as ArtifactRow | undefined;
      return row === undefined ? null : toDomain(row);
    },

    getByTask(taskId) {
      const row = byTaskStmt.get(taskId) as ArtifactRow | undefined;
      return row === undefined ? null : toDomain(row);
    },

    getByTaskOrThrow(taskId) {
      const row = byTaskStmt.get(taskId) as ArtifactRow | undefined;
      if (row === undefined) {
        throw new ForgeError('ARTIFACT_NOT_FOUND', `任务 ${taskId} 尚无产物`, `task:${taskId}`);
      }
      return toDomain(row);
    },

    deleteByTask(taskId) {
      return db.prepare('DELETE FROM artifacts WHERE task_id = ?').run(taskId).changes;
    },
  };
}
