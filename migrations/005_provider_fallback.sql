-- Provider 降级链（D-66…D-70，notes/PROVIDER-FALLBACK-DESIGN-V0.1.md）
--
-- 两件事：
--   1. 让 provider_health 从死表变成活表，并加上「耗尽」这一档；
--   2. 给 tasks 加 pin，把「任务中途不换 Provider」变成构造性保证。

-- ── 1. provider_health ──────────────────────────────────────────────
--
-- 这张表在 001_initial 里就建了，但至今**没有任何代码读写它**——
-- 健康状态一直活在 ProviderRegistry 的内存 Map 里，进程一重启就失忆。
-- 降级判断不能这样：重启后所有「已耗尽」的记忆全没了，
-- 于是每次重启都要拿一次真实调用去把已经知道的事再撞一遍。
--
-- SQLite 不支持修改 CHECK 约束，因此重建表。原表无人读写、必然为空，
-- 不需要搬数据（真有数据也只是缓存，丢了会在下次探测时重建）。
DROP TABLE IF EXISTS provider_health;

CREATE TABLE provider_health (
  provider_id      TEXT PRIMARY KEY,
  -- exhausted：额度耗尽，降级链应跳过它（D-68）
  -- 与 rate_limited 的区别是**该不该等**：限流等一会儿还能用，耗尽等不回来。
  status           TEXT NOT NULL CHECK (status IN ('ok','rate_limited','exhausted','down')),
  latency_ms       INTEGER NULL,
  note             TEXT NULL,
  rate_limit_count INTEGER NOT NULL DEFAULT 0,  -- 滚动 10 分钟内 429 次数

  -- 判定为耗尽的时刻。冷却窗口从这里算起。
  -- 订阅额度按月重置而我们无从得知重置时刻，所以只能靠冷却后重试来自动爬回
  -- 高优先级档；没有它，一次耗尽会把那一档永久拉黑。
  exhausted_at     TEXT NULL,
  -- 判定依据的原文（上游返回的 status + body 片段）。
  -- 这一列是 D-68 L2 特征表的**唯一数据来源**：我们至今不知道各家耗尽时回什么，
  -- 只能等真撞上时从这里抄。没有它，撞上了也是白撞。
  exhausted_reason TEXT NULL,

  checked_at       TEXT NOT NULL
);

-- ── 2. tasks.pinned_providers_json ──────────────────────────────────
--
-- 形如 {"main":"volcengine-ark-coding","structure":"volcengine-ark-coding"}：
-- 别名 → 本任务定住的那一档的 provider id（D-67）。
--
-- 为什么要落库，而不是靠「反正耗尽会让任务失败所以不会换」：
-- 不落库时「中途不换」只是一个**涌现属性**，它成立仅因为失败语义碰巧如此。
-- 并发跑第二个任务、或哪天改了失败语义，它就静默失效了。
-- 落库之后 resolve() 只认这个 pin，没有第二条路径可走。
--
-- NULL 表示「本任务创建于降级链之前」——历史任务照旧走链首，不受影响。
ALTER TABLE tasks ADD COLUMN pinned_providers_json TEXT NULL;
