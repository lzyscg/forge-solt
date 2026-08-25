/**
 * SnapshotRepo —— `task_snapshots` + `task_skill_snapshots`。
 *
 * 权威来源：§5.2、§5.5「创建 Task」、D-08（runCount）、D-18（延迟外键）、REQ AC-002。
 *
 * 两张表放同一个仓储，是因为它们只有一种被使用的方式：
 * 「创建 Task」这一条事务边界里一起写、任务运行期一起读。
 * 拆成两个仓储只会让调用方每次都得同时拿两个，却没有任何一处只需要其中之一。
 *
 * ## 与 tasks 的循环引用
 *
 * `task_snapshots.task_id → tasks.id` 与 `tasks.snapshot_id → task_snapshots.id`
 * 互相引用。D-18 用 `DEFERRABLE INITIALLY DEFERRED` 打破环，外键在 COMMIT 时才校验，
 * 所以本仓储的 insert 与 `TaskRepo.insert` **谁先谁后都行**——前提是两者在同一个事务里，
 * 且 `PRAGMA foreign_keys` 为 ON（OFF 时延迟外键静默失效，不报错也不生效）。
 */

import { ForgeError } from '@shared/errors.ts';
import type { ForgeDb } from '../db.ts';
import type { Clock, TaskSkillSnapshot, TaskSnapshot } from './types.ts';

interface SnapshotRow {
  id: string;
  task_id: string;
  template_id: string;
  template_version: string;
  compiled_json: string;
  snapshot_hash: string;
  created_at: string;
}

interface SkillRow {
  task_id: string;
  skill_id: string;
  skill_version: string;
  content_markdown: string;
  section_index_json: string;
  content_hash: string;
}

export interface InsertSnapshotInput {
  id: string;
  taskId: string;
  templateId: string;
  templateVersion: string;
  /** 已规范化的 CompiledTemplate JSON 文本，snapshotHash 与它逐字对应（见 types.ts） */
  compiledJson: string;
  snapshotHash: string;
}

function toSnapshot(row: SnapshotRow): TaskSnapshot {
  return {
    id: row.id,
    taskId: row.task_id,
    templateId: row.template_id,
    templateVersion: row.template_version,
    compiledJson: row.compiled_json,
    snapshotHash: row.snapshot_hash,
    createdAt: row.created_at,
  };
}

function toSkill(row: SkillRow): TaskSkillSnapshot {
  return {
    taskId: row.task_id,
    skillId: row.skill_id,
    skillVersion: row.skill_version,
    contentMarkdown: row.content_markdown,
    sectionIndexJson: row.section_index_json,
    contentHash: row.content_hash,
  };
}

export interface SnapshotRepo {
  insert(input: InsertSnapshotInput): TaskSnapshot;
  /** n 个 Skill 一次写完；与 insert 必须在同一事务（§5.5「创建 Task」） */
  insertSkills(skills: readonly TaskSkillSnapshot[]): void;
  get(id: string): TaskSnapshot | null;
  getByTask(taskId: string): TaskSnapshot | null;
  getByTaskOrThrow(taskId: string): TaskSnapshot;
  listSkills(taskId: string): TaskSkillSnapshot[];
  /** AC-002 快照隔离的读路径：任务运行期只认这里的内容，不再碰磁盘上的 SKILL.md */
  getSkill(taskId: string, skillId: string): TaskSkillSnapshot | null;
  /** D-08 runCount：引用某模板的任务数 */
  countTasksByTemplate(templateId: string): number;
}

export function createSnapshotRepo(db: ForgeDb, clock: Clock): SnapshotRepo {
  const insertStmt = db.prepare(
    `INSERT INTO task_snapshots
       (id, task_id, template_id, template_version, compiled_json, snapshot_hash, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertSkillStmt = db.prepare(
    `INSERT INTO task_skill_snapshots
       (task_id, skill_id, skill_version, content_markdown, section_index_json, content_hash)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const getStmt = db.prepare('SELECT * FROM task_snapshots WHERE id = ?');
  const byTaskStmt = db.prepare('SELECT * FROM task_snapshots WHERE task_id = ?');
  const listSkillsStmt = db.prepare(
    'SELECT * FROM task_skill_snapshots WHERE task_id = ? ORDER BY skill_id',
  );
  const getSkillStmt = db.prepare(
    'SELECT * FROM task_skill_snapshots WHERE task_id = ? AND skill_id = ?',
  );
  const countStmt = db.prepare('SELECT COUNT(*) AS n FROM task_snapshots WHERE template_id = ?');

  return {
    insert(input) {
      const now = clock();
      insertStmt.run(
        input.id,
        input.taskId,
        input.templateId,
        input.templateVersion,
        input.compiledJson,
        input.snapshotHash,
        now,
      );
      return { ...input, createdAt: now };
    },

    insertSkills(skills) {
      for (const skill of skills) {
        insertSkillStmt.run(
          skill.taskId,
          skill.skillId,
          skill.skillVersion,
          skill.contentMarkdown,
          skill.sectionIndexJson,
          skill.contentHash,
        );
      }
    },

    get(id) {
      const row = getStmt.get(id) as SnapshotRow | undefined;
      return row === undefined ? null : toSnapshot(row);
    },

    getByTask(taskId) {
      const row = byTaskStmt.get(taskId) as SnapshotRow | undefined;
      return row === undefined ? null : toSnapshot(row);
    },

    getByTaskOrThrow(taskId) {
      const row = byTaskStmt.get(taskId) as SnapshotRow | undefined;
      if (row === undefined) {
        // 快照缺失意味着任务的冻结输入没了，任何生产都无法继续，
        // 用 TASK_NOT_FOUND 会误导排查方向，所以走 STORAGE_ERROR。
        throw new ForgeError('STORAGE_ERROR', `任务 ${taskId} 的模板快照缺失`, `task:${taskId}`);
      }
      return toSnapshot(row);
    },

    listSkills(taskId) {
      return (listSkillsStmt.all(taskId) as SkillRow[]).map(toSkill);
    },

    getSkill(taskId, skillId) {
      const row = getSkillStmt.get(taskId, skillId) as SkillRow | undefined;
      return row === undefined ? null : toSkill(row);
    },

    countTasksByTemplate(templateId) {
      return (countStmt.get(templateId) as { n: number }).n;
    },
  };
}
