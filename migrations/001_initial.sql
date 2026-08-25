-- Forge Core vNext —— 初始 Schema
-- 权威来源：《Forge Core vNext 可执行技术实现方案 V1.0》§5.2
-- 本文件的 DDL 逐字对应文档 §5.2，仅有的增量是 slots.include_in_artifact（D-16），已就地标注。
--
-- 注意：D-09「Assignment 不建独立表」——Assignment 的全部持久化内容由 executions 表承载，
-- 且 AgentAssignment.id === execution.id。因此本文件中没有 assignments 表。

-- ============ 快照 ============
-- task_snapshots 与 tasks 互相引用（tasks.snapshot_id → task_snapshots.id，
-- task_snapshots.task_id → tasks.id）。用 DEFERRABLE INITIALLY DEFERRED 打破环：
-- 外键在 COMMIT 时才校验，§5.5「创建 Task」事务内的插入顺序因此不再是约束。
-- ⚠️ 延迟外键在 PRAGMA foreign_keys = OFF 时**静默失效**，db.ts 的 applyPragmas 必须保持 ON。
CREATE TABLE task_snapshots (
  id               TEXT PRIMARY KEY,
  task_id          TEXT NOT NULL UNIQUE
                     REFERENCES tasks(id) ON DELETE CASCADE
                     DEFERRABLE INITIALLY DEFERRED,
  template_id      TEXT NOT NULL,
  template_version TEXT NOT NULL,
  compiled_json    TEXT NOT NULL,      -- CompiledTemplate（已剥离 presentation）
  snapshot_hash    TEXT NOT NULL,
  created_at       TEXT NOT NULL
);

CREATE TABLE task_skill_snapshots (
  task_id            TEXT NOT NULL,
  skill_id           TEXT NOT NULL,
  skill_version      TEXT NOT NULL,
  content_markdown   TEXT NOT NULL,
  section_index_json TEXT NOT NULL,
  content_hash       TEXT NOT NULL,
  PRIMARY KEY (task_id, skill_id)
);

-- ============ 任务 ============
CREATE TABLE tasks (
  id                  TEXT PRIMARY KEY,
  name                TEXT NOT NULL,
  snapshot_id         TEXT NOT NULL REFERENCES task_snapshots(id),
  input_json          TEXT NOT NULL,
  status              TEXT NOT NULL CHECK (status IN
                        ('ready','running','stopped','completed','failed')),
  phase               TEXT NOT NULL CHECK (phase IN
                        ('structure','slots','assembly','done')),
  -- D-10 的 token 校验整个压在 WHERE ... AND t.active_execution_id = e.id 上，
  -- 该语句的正确性直接建立在这一列指向真实 execution 之上，因此必须由库层保证，
  -- 不能只靠应用层自觉。与 executions.task_id 构成环，故延迟到 COMMIT 校验。
  active_execution_id TEXT NULL
                        REFERENCES executions(id) DEFERRABLE INITIALLY DEFERRED,
  artifact_id         TEXT NULL,
  error_code          TEXT NULL,
  error_message       TEXT NULL,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

-- ============ 槽位 ============
CREATE TABLE slots (
  task_id                TEXT NOT NULL REFERENCES tasks(id),
  slot_id                TEXT NOT NULL,
  type                   TEXT NOT NULL,
  parent_id              TEXT NULL,
  sort_order             INTEGER NOT NULL,
  instruction            TEXT NOT NULL,
  depends_on_json        TEXT NOT NULL DEFAULT '[]',
  content_bearing        INTEGER NOT NULL CHECK (content_bearing IN (0,1)),
  -- D-16：工作槽位（contentBearing=true 且 includeInArtifact=false）产出内容供下游 read_slot，
  -- 但不进入最终产物组装。值来自冻结快照的 SlotTypeDefinition.includeInArtifact，默认 1。
  -- D-18 子树语义：0 表示【以该槽位为根的整棵子树】都不进产物。因此这一列对容器槽位
  -- 同样有意义（标 0 可一次性排除整节工作区），默认值也因此必须是 1——
  -- 容器默认 0 会让整棵树都装配不出东西。
  include_in_artifact    INTEGER NOT NULL DEFAULT 1
                           CHECK (include_in_artifact IN (0,1)),  -- D-16
  status                 TEXT NOT NULL CHECK (status IN
                           ('pending','running','completed','failed')),
  content_text           TEXT NULL,
  producer_agent_id      TEXT NULL,
  producer_skill_id      TEXT NULL,
  producer_skill_version TEXT NULL,
  producer_execution_id  TEXT NULL
                           REFERENCES executions(id) DEFERRABLE INITIALLY DEFERRED,
  error_code             TEXT NULL,
  error_message          TEXT NULL,
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL,
  PRIMARY KEY (task_id, slot_id),

  -- 父槽位自引用。slots 的主键是复合键 (task_id, slot_id)，不存在 slots(id)，
  -- 因此必须写成复合外键；它同时保证父子槽位不会跨任务。
  -- 用 DEFERRED：§5.5「提交 Structure」在一个事务内一次性 INSERT n 个槽位，
  -- 无法保证父槽位一定排在子槽位之前。
  -- SQLite 的复合外键遵循 MATCH SIMPLE：parent_id IS NULL 时整条外键不校验，
  -- 根槽位因此天然豁免。
  FOREIGN KEY (task_id, parent_id) REFERENCES slots(task_id, slot_id)
    DEFERRABLE INITIALLY DEFERRED,

  -- REQ AC-009：完成的内容槽必须同时具备 content 与 producer，杜绝部分状态
  CHECK (
    NOT (status = 'completed' AND content_bearing = 1)
    OR (content_text IS NOT NULL
        AND producer_agent_id IS NOT NULL
        AND producer_skill_id IS NOT NULL
        AND producer_execution_id IS NOT NULL)
  ),
  -- 容器槽位不得有正文
  CHECK (NOT (content_bearing = 0) OR content_text IS NULL)
);

-- ============ 执行 ============
CREATE TABLE executions (
  id             TEXT PRIMARY KEY,
  task_id        TEXT NOT NULL REFERENCES tasks(id),
  operation      TEXT NOT NULL CHECK (operation IN
                   ('create_structure','fill_slot')),
  target_slot_id TEXT NULL,
  agent_id       TEXT NOT NULL,
  skill_id       TEXT NOT NULL,
  skill_version  TEXT NOT NULL,
  token_hash     TEXT NOT NULL,
  context_json   TEXT NOT NULL,
  context_hash   TEXT NOT NULL,
  prompt_hash    TEXT NOT NULL,        -- D-12
  model_alias    TEXT NOT NULL,        -- D-03：冻结的别名
  provider       TEXT NOT NULL,        -- D-03：解析后的实际 provider
  model          TEXT NOT NULL,        -- D-03：解析后的实际 model
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

  -- §8.7 retry 与 D-06 maxRetries 都以 attempt_number 为准，重复 attempt 号必须被拒。
  -- ⚠️ NULL 语义：SQLite 的 UNIQUE 中 NULL 互不相等，因此
  -- target_slot_id IS NULL 的 create_structure execution **不受本约束保护**——
  -- 同一任务可以插入多条 (task_id, NULL, 1)。本约束只锁住 fill_slot 这条槽位生产主路径。
  -- 结构 execution 的 attempt 唯一性目前由应用层负责。
  UNIQUE (task_id, target_slot_id, attempt_number)
);

-- ============ 轨迹 ============
-- ⚠️ 留给 M2 的合同：sequence **没有库层生成机制**（不是自增列，也没有序列表）。
-- Repository 实现必须在**与业务写入同一个事务内**执行 `SELECT MAX(sequence) + 1
-- FROM trace_events WHERE task_id = ?` 来分配序号；跨事务或事务外取号会产生重号。
-- 下面的 UNIQUE (task_id, sequence) 是这条约定的**唯一兜底**——它只能让错误立刻炸掉，
-- 不能替你分配序号。§5.5 要求 trace 写在事务内，正是这条约定成立的前提。
CREATE TABLE trace_events (
  id           TEXT PRIMARY KEY,
  task_id      TEXT NOT NULL REFERENCES tasks(id),
  execution_id TEXT NULL,
  sequence     INTEGER NOT NULL,
  actor        TEXT NOT NULL,
  kind         TEXT NOT NULL,
  title        TEXT NOT NULL,
  summary      TEXT NOT NULL,
  payload_json TEXT NULL,
  created_at   TEXT NOT NULL,
  UNIQUE (task_id, sequence)
);

-- ============ 产物 ============
CREATE TABLE artifacts (
  id           TEXT PRIMARY KEY,
  task_id      TEXT NOT NULL UNIQUE REFERENCES tasks(id),
  file_name    TEXT NOT NULL,
  media_type   TEXT NOT NULL,
  content_blob BLOB NOT NULL,
  checksum     TEXT NOT NULL,
  byte_size    INTEGER NOT NULL,
  created_at   TEXT NOT NULL
);

-- ============ Provider 健康（D-03） ============
CREATE TABLE provider_health (
  provider_id      TEXT PRIMARY KEY,
  status           TEXT NOT NULL CHECK (status IN ('ok','rate_limited','down')),
  latency_ms       INTEGER NULL,
  note             TEXT NULL,
  rate_limit_count INTEGER NOT NULL DEFAULT 0,  -- 滚动 10 分钟内 429 次数
  checked_at       TEXT NOT NULL
);
