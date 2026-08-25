-- Forge Core vNext —— 索引
-- 权威来源：《Forge Core vNext 可执行技术实现方案 V1.0》§5.3（逐字对应）

CREATE INDEX idx_slots_task_status   ON slots(task_id, status);
CREATE INDEX idx_slots_task_parent   ON slots(task_id, parent_id, sort_order);
CREATE INDEX idx_exec_task_created   ON executions(task_id, created_at DESC);
CREATE INDEX idx_exec_target         ON executions(task_id, target_slot_id);
CREATE INDEX idx_trace_task_seq      ON trace_events(task_id, sequence);
CREATE INDEX idx_trace_exec_seq      ON trace_events(execution_id, sequence);
CREATE INDEX idx_tasks_status_upd    ON tasks(status, updated_at DESC);
CREATE INDEX idx_snapshots_template  ON task_snapshots(template_id);  -- D-08 runCount

-- §8.6 重启恢复要扫「status IN ('created','running') 但其 task 已非 running」的孤儿 execution。
-- 这是**启动路径上的必经查询**，全表扫会随历史数据线性变慢，而恢复慢 == 崩溃后恢复慢。
CREATE INDEX idx_executions_status   ON executions(status);
