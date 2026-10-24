-- I1：系统确定性冻结 Narrative Unit 与正文 section 槽位的一对一绑定。
-- 历史任务与未启用 NarrativePlan 的任务保持 NULL；Agent 无权提交此字段。
ALTER TABLE slots ADD COLUMN narrative_unit_id TEXT NULL;
