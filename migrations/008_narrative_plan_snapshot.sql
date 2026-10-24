-- I1：冻结编译后的 NarrativePlan，独立于既有模板 snapshot hash。
-- 旧任务和未启用计划的任务保持双 NULL；应用层把单边 NULL 视为存储损坏。
ALTER TABLE task_snapshots ADD COLUMN narrative_plan_json TEXT NULL;
ALTER TABLE task_snapshots ADD COLUMN narrative_plan_hash TEXT NULL;
