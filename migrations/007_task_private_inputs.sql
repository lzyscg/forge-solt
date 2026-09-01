-- S2.5：系统私有任务输入。
--
-- 私有输入供确定性校验使用，但不进入 tasks.input_json / Prompt / read_task_input / API。
CREATE TABLE task_private_inputs (
  task_id      TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  field_id     TEXT NOT NULL,
  content_text TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  PRIMARY KEY (task_id, field_id)
);
