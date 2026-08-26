-- ============ 审核返修 R0：数据模型迁移 ============
--
-- 本迁移由 §2.1 规定，重建 slots 与 executions 两张表（SQLite 不支持改 CHECK 约束），
-- 并新建 slot_reviews 表。
--
-- 执行顺序：先建 executions_new（拷数据），再重建 slots，再重建 executions，最后建 slot_reviews。
-- slot_reviews 对 slots 与 executions 都有外键，最后建可以整类地绕开建表顺序的疑问。
--
-- 为何不用 PRAGMA foreign_keys=OFF：
--   migrate.ts 把每个迁移文件包在 db.transaction(() => db.exec(sql)) 里，
--   而 SQLite 的 PRAGMA foreign_keys 在事务内是 no-op，写了也不生效。
--   不需要关：指向被重建表的外键（tasks.active_execution_id、slots.producer_execution_id、
--   slots 的 parent 自引用）全是 DEFERRABLE INITIALLY DEFERRED，
--   违反只在 COMMIT 时检查，那时新表已就位。
--
-- 重命名方向是死规矩：CREATE 新表(临时别名) → 拷数据 → DROP 原表 → RENAME 新表为原名。
--   绝不能先把原表 rename 走——SQLite >=3.25 在 rename 时会回填其他表 schema 里指向它的引用，
--   把 tasks.active_execution_id REFERENCES executions 改写成指向改名后的表。
--   按上面的方向做则没有任何表引用那个临时别名，不会触发回填。
--
-- 自引用外键的临时名写法：slots_new 的 parent 自引用 FK 写成 REFERENCES slots_new
--   而非 REFERENCES slots。若写成 REFERENCES slots，DROP TABLE slots 的隐式 DELETE 会
--   在 DEFERRED 队列里留一条指向已删除表 'slots' 的违规，COMMIT 时即使新表已 RENAME 回来
--   也不清除（SQLite 的 deferred FK 不因后续 RENAME 而重新解析表名引用）。
--   写成 REFERENCES slots_new 时，FK 指向新表自身，DROP 旧表不影响它；
--   RENAME 时 SQLite >=3.25 自动把 FK 回填为 REFERENCES slots（新名），结果与 001 一致。
--
-- 跨表外键的临时名写法：slots_new 的 producer_execution_id FK 写成 REFERENCES executions_new
--   而非 REFERENCES executions。原因与自引用相同：DROP TABLE executions 的隐式 DELETE
--   会在 DEFERRED 队列里留下指向已删除表 'executions' 的违规，COMMIT 时不清除。
--   写成 REFERENCES executions_new 时，FK 指向尚未 RENAME 的新表，DROP 旧表不影响它；
--   RENAME executions_new TO executions 时 SQLite 自动回填为 REFERENCES executions。
--
-- tasks.active_execution_id 的 save/restore：tasks 表不在本迁移重建范围，
--   它的 active_execution_id REFERENCES executions(id) DEFERRABLE 在 DROP TABLE executions
--   的隐式 DELETE 时会留下 DEFERRED 违规。尽管新表 RENAME 回来后数据一致，SQLite 的 deferred FK
--   不因后续 RENAME 而清除违规。故在重建 executions 前先把 active_execution_id 暂存到
--   临时表并置 NULL，重建后恢复。
--
-- 重建后必须重建索引：DROP 原表会连带删除依附于它的全部索引。
--   002_indexes.sql 在 slots 上建了 idx_slots_task_status、idx_slots_task_parent，
--   在 executions 上建了 idx_exec_task_created、idx_exec_target、idx_executions_status。
--   文档 §2.1 的 SQL 片段未提及这一步，但重建后这 5 个索引必须照 002 的原样重建。

-- ============ 1. 建 executions_new 并拷数据（先于 slots 重建，供 slots_new 的 FK 指向） ============
CREATE TABLE executions_new (
  id             TEXT PRIMARY KEY,
  task_id        TEXT NOT NULL REFERENCES tasks(id),
  operation      TEXT NOT NULL CHECK (operation IN
                   ('create_structure','fill_slot','review_slot')),
  target_slot_id TEXT NULL,
  agent_id       TEXT NOT NULL,
  skill_id       TEXT NOT NULL,
  skill_version  TEXT NOT NULL,
  token_hash     TEXT NOT NULL,
  context_json   TEXT NOT NULL,
  context_hash  TEXT NOT NULL,
  prompt_hash   TEXT NOT NULL,
  model_alias    TEXT NOT NULL,
  provider       TEXT NOT NULL,
  model          TEXT NOT NULL,
  attempt_number INTEGER NOT NULL,
  status         TEXT NOT NULL CHECK (status IN
                   ('created','running','succeeded','failed','cancelled','stale')),
  input_tokens   INTEGER NULL,
  output_tokens  INTEGER NULL,
  error_code     TEXT NULL,
  error_message  TEXT NULL,
  started_at     TEXT NULL,
  finished_at    TEXT NULL,
  created_at     TEXT NOT NULL,

  -- 新 UNIQUE：含 operation。review_slot 的 target_slot_id 就是被审槽位，
  -- 与 fill_slot 撞主键，故必须按 operation 分开。
  UNIQUE (task_id, target_slot_id, operation, attempt_number)
);

INSERT INTO executions_new
  (id, task_id, operation, target_slot_id, agent_id, skill_id, skill_version,
   token_hash, context_json, context_hash, prompt_hash,
   model_alias, provider, model, attempt_number, status,
   input_tokens, output_tokens, error_code, error_message,
   started_at, finished_at, created_at)
SELECT
  id, task_id, operation, target_slot_id, agent_id, skill_id, skill_version,
  token_hash, context_json, context_hash, prompt_hash,
  model_alias, provider, model, attempt_number, status,
  input_tokens, output_tokens, error_code, error_message,
  started_at, finished_at, created_at
FROM executions;

-- ============ 2. 重建 slots ============
CREATE TABLE slots_new (
  task_id                TEXT NOT NULL REFERENCES tasks(id),
  slot_id                TEXT NOT NULL,
  type                   TEXT NOT NULL,
  parent_id              TEXT NULL,
  sort_order             INTEGER NOT NULL,
  instruction            TEXT NOT NULL,
  depends_on_json        TEXT NOT NULL DEFAULT '[]',
  content_bearing        INTEGER NOT NULL CHECK (content_bearing IN (0,1)),
  include_in_artifact    INTEGER NOT NULL DEFAULT 1
                           CHECK (include_in_artifact IN (0,1)),
  status                 TEXT NOT NULL CHECK (status IN
                           ('pending','running','reviewing','completed','failed')),
  revision_round         INTEGER NOT NULL DEFAULT 0,
  review_exhausted       INTEGER NOT NULL DEFAULT 0
                           CHECK (review_exhausted IN (0,1)),
  content_text           TEXT NULL,
  producer_agent_id      TEXT NULL,
  producer_skill_id      TEXT NULL,
  producer_skill_version TEXT NULL,
  producer_execution_id  TEXT NULL
                           REFERENCES executions_new(id) DEFERRABLE INITIALLY DEFERRED,
  error_code             TEXT NULL,
  error_message          TEXT NULL,
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL,
  PRIMARY KEY (task_id, slot_id),

  FOREIGN KEY (task_id, parent_id) REFERENCES slots_new(task_id, slot_id)
    DEFERRABLE INITIALLY DEFERRED,

  -- AC-009 加固：reviewing 与 completed 一样，内容槽位必须有正文与 producer
  CHECK (
    NOT (status IN ('completed','reviewing') AND content_bearing = 1)
    OR (content_text IS NOT NULL
        AND producer_agent_id IS NOT NULL
        AND producer_skill_id IS NOT NULL
        AND producer_execution_id IS NOT NULL)
  ),
  -- 容器槽位不得有正文
  CHECK (NOT (content_bearing = 0) OR content_text IS NULL)
);

INSERT INTO slots_new
  (task_id, slot_id, type, parent_id, sort_order, instruction, depends_on_json,
   content_bearing, include_in_artifact, status, revision_round, review_exhausted,
   content_text, producer_agent_id, producer_skill_id, producer_skill_version,
   producer_execution_id, error_code, error_message, created_at, updated_at)
SELECT
  task_id, slot_id, type, parent_id, sort_order, instruction, depends_on_json,
  content_bearing, include_in_artifact, status, 0, 0,
  content_text, producer_agent_id, producer_skill_id, producer_skill_version,
  producer_execution_id, error_code, error_message, created_at, updated_at
FROM slots;

DROP TABLE slots;
ALTER TABLE slots_new RENAME TO slots;

-- ============ 3. 重建 executions ============
-- 暂存 tasks.active_execution_id 并置 NULL，避免 DROP TABLE executions
--   留下不可清除的 DEFERRED FK 违规。
CREATE TABLE _temp_active_exec AS
  SELECT id, active_execution_id FROM tasks WHERE active_execution_id IS NOT NULL;
UPDATE tasks SET active_execution_id = NULL;

DROP TABLE executions;
ALTER TABLE executions_new RENAME TO executions;

-- 恢复 tasks.active_execution_id
UPDATE tasks
  SET active_execution_id = (
    SELECT active_execution_id FROM _temp_active_exec
    WHERE _temp_active_exec.id = tasks.id
  )
  WHERE id IN (SELECT id FROM _temp_active_exec);
DROP TABLE _temp_active_exec;

-- ============ 4. 重建 5 个索引（照抄 002） ============
CREATE INDEX idx_slots_task_status   ON slots(task_id, status);
CREATE INDEX idx_slots_task_parent   ON slots(task_id, parent_id, sort_order);
CREATE INDEX idx_exec_task_created   ON executions(task_id, created_at DESC);
CREATE INDEX idx_exec_target         ON executions(task_id, target_slot_id);
CREATE INDEX idx_executions_status   ON executions(status);

-- ============ 5. 审核结果表（最后建，对 slots 与 executions 都有外键） ============
CREATE TABLE slot_reviews (
  task_id       TEXT NOT NULL REFERENCES tasks(id),
  slot_id       TEXT NOT NULL,
  round         INTEGER NOT NULL,           -- 第几轮，从 0 起
  criterion_id  TEXT NOT NULL,              -- 判据 ID，来自冻结的审核 Skill
  execution_id  TEXT NOT NULL REFERENCES executions(id),
  verdict       TEXT NOT NULL CHECK (verdict IN ('no_finding','revise','discarded')),
  findings_json TEXT NOT NULL DEFAULT '[]', -- 只存通过引文校验的 finding
  created_at    TEXT NOT NULL,

  -- 判据 ID 是主键的一部分：模板校验保证它在 Skill 内唯一（FR-TPL-003），
  -- 否则两条判据的结果会互相覆盖。
  PRIMARY KEY (task_id, slot_id, round, criterion_id),
  FOREIGN KEY (task_id, slot_id) REFERENCES slots(task_id, slot_id)
);

CREATE INDEX idx_slot_reviews_slot ON slot_reviews(task_id, slot_id, round);
