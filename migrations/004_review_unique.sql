-- ============ 审核返修 R2：executions UNIQUE 重建 ============
--
-- 业主已批准的迁移 004。
--
-- 背景：003 把 executions 的 UNIQUE 改成了 (task_id, target_slot_id, operation, attempt_number)，
-- 本意是让 fill_slot 与 review_slot 的 attempt 1 不撞键。但多判据场景下仍然会撞：
-- 同一槽位判据一与判据二的 review_slot attempt 1 同键必撞；停止恢复后重跑同判据也撞。
--
-- 解法：去掉表级 UNIQUE，改建部分唯一索引：
--   CREATE UNIQUE INDEX idx_exec_fill_attempt ON executions(task_id, target_slot_id, attempt_number)
--     WHERE operation = 'fill_slot'
-- m2 的 fill_slot 重复拒绝测试仍然通过（同槽位同 attempt 的 fill_slot 仍被拒）。
-- create_structure 的 attempt 唯一性维持 001 注释现状（应用层负责）。
-- review_slot 行的唯一性由 slot_reviews 主键保证（设计原文）。
--
-- 重建手法：沿用 003 的事务内重建手法（临时名 + RENAME 回填 + 重建索引）。
-- 003 已重建过 executions 一次，本迁移在 003 之后的表定义上再做一次同样手法的重建。
--
-- 与 003 的差别：本迁移不重建 slots 表。
-- slots.producer_execution_id REFERENCES executions(id) DEFERRABLE INITIALLY DEFERRED。
-- 003 重建 slots 时把 FK 指向 executions_new，避开了 DROP TABLE executions 的 deferred FK 违规。
-- 本迁移不重建 slots，故需 save/restore slots.producer_execution_id。
-- 但 slots 有 CHECK 约束：completed/reviewing + content_bearing → 四列非 NULL。
-- 解法：先把受影响槽位的 status 暂存并改为 'pending'（pending 不触发 CHECK），null
-- producer_execution_id，重建 executions，恢复 producer_execution_id，恢复 status。

-- ============ 1. 建 executions_new 并拷数据 ============
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
  context_hash   TEXT NOT NULL,
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
  created_at     TEXT NOT NULL
  -- 不再有表级 UNIQUE 约束。fill_slot 的 attempt 唯一性由部分唯一索引保证；
  -- review_slot 的唯一性由 slot_reviews 主键保证。
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

-- ============ 2. 暂存 tasks.active_execution_id 并置 NULL ============
CREATE TABLE _temp_active_exec_004 AS
  SELECT id, active_execution_id FROM tasks WHERE active_execution_id IS NOT NULL;
UPDATE tasks SET active_execution_id = NULL;

-- ============ 2b. 暂存 slots.status + producer_execution_id，改 status 为 pending 再 null producer ============
-- CHECK 约束：completed/reviewing + content_bearing → 四列非 NULL。
-- 先把 status 改为 pending（不触发 CHECK），再 null producer_execution_id。
CREATE TABLE _temp_slot_producer_004 AS
  SELECT task_id, slot_id, status, producer_execution_id
  FROM slots
  WHERE producer_execution_id IS NOT NULL
    AND status IN ('completed', 'reviewing')
    AND content_bearing = 1;

UPDATE slots
  SET status = 'pending'
  WHERE (task_id, slot_id) IN (SELECT task_id, slot_id FROM _temp_slot_producer_004);

UPDATE slots
  SET producer_execution_id = NULL
  WHERE producer_execution_id IS NOT NULL;

-- ============ 3. 重建 executions ============
DROP TABLE executions;
ALTER TABLE executions_new RENAME TO executions;

-- 恢复 tasks.active_execution_id
UPDATE tasks
  SET active_execution_id = (
    SELECT active_execution_id FROM _temp_active_exec_004
    WHERE _temp_active_exec_004.id = tasks.id
  )
  WHERE id IN (SELECT id FROM _temp_active_exec_004);
DROP TABLE _temp_active_exec_004;

-- 恢复 slots.producer_execution_id（status 还是 pending，不触发 CHECK）
UPDATE slots
  SET producer_execution_id = (
    SELECT producer_execution_id FROM _temp_slot_producer_004
    WHERE _temp_slot_producer_004.task_id = slots.task_id
      AND _temp_slot_producer_004.slot_id = slots.slot_id
  )
  WHERE (task_id, slot_id) IN (SELECT task_id, slot_id FROM _temp_slot_producer_004);

-- 恢复 slots.status（producer 已恢复，CHECK 通过）
UPDATE slots
  SET status = (
    SELECT status FROM _temp_slot_producer_004
    WHERE _temp_slot_producer_004.task_id = slots.task_id
      AND _temp_slot_producer_004.slot_id = slots.slot_id
  )
  WHERE (task_id, slot_id) IN (SELECT task_id, slot_id FROM _temp_slot_producer_004);
DROP TABLE _temp_slot_producer_004;

-- ============ 4. 重建索引 ============
-- 002/003 原有三个索引
CREATE INDEX idx_exec_task_created   ON executions(task_id, created_at DESC);
CREATE INDEX idx_exec_target         ON executions(task_id, target_slot_id);
CREATE INDEX idx_executions_status   ON executions(status);

-- 新的部分唯一索引：只对 fill_slot 行强制 (task_id, target_slot_id, attempt_number) 唯一。
-- review_slot 行不受此约束（其唯一性由 slot_reviews 主键保证）。
CREATE UNIQUE INDEX idx_exec_fill_attempt ON executions(task_id, target_slot_id, attempt_number)
  WHERE operation = 'fill_slot';
