/**
 * Repository 层共用的输入类型与小工具。
 *
 * 权威来源：《Forge Core vNext 可执行技术实现方案 V1.0》§5.2、§5.4、§5.5。
 *
 * 这里只放**跨仓储共用**的东西。单个仓储自己的输入形状留在各自文件里，
 * 免得这个文件变成「所有类型的垃圾场」——那样每加一个字段都要动公共文件。
 *
 * ## 为什么写入类型不复用 Domain 实体
 *
 * Domain 的 `Task` / `Slot` / `Execution` 描述的是**读出来之后**的完整状态，
 * 包含 `createdAt` / `updatedAt` / `status` 这些由仓储或状态机负责的字段。
 * 直接拿它当 insert 参数，调用方就得先编造一份 updatedAt 再让仓储覆盖掉，
 * 「谁负责时间戳」这件事会立刻变得没人说得清。所以插入用独立的 Input 类型。
 */

/**
 * 时间源。所有落库时间戳都经过它，测试因此可以注入固定时钟做确定性断言（§11.4）。
 * 返回 ISO-8601 字符串，与 §5.2 中所有 `*_at TEXT` 列的约定一致。
 */
export type Clock = () => string;

/** 默认时钟。 */
export const systemClock: Clock = () => new Date().toISOString();

/** SQLite 没有布尔类型；§5.2 的 CHECK 约束把这几列限定为 0/1。 */
export const toSqlBool = (value: boolean): number => (value ? 1 : 0);
export const fromSqlBool = (value: number): boolean => value === 1;

/**
 * 产物。Domain 层没有对应实体——产物是纯存储物，
 * 组装逻辑（`domain/assembly.ts`）产出的是字符串，落库形态只有仓储关心。
 */
export interface Artifact {
  id: string;
  taskId: string;
  fileName: string;
  mediaType: string;
  /** 组装后的完整正文。列是 BLOB，读出来统一转回字符串（P0 只产出文本产物） */
  content: string;
  checksum: string;
  byteSize: number;
  createdAt: string;
}

/** 冻结的模板快照（§5.2 task_snapshots）。 */
export interface TaskSnapshot {
  id: string;
  taskId: string;
  templateId: string;
  templateVersion: string;
  /**
   * CompiledTemplate 的规范化 JSON 文本。
   * 仓储刻意**不做序列化**：snapshotHash 必须与这段文本逐字对应，
   * 若仓储自己 JSON.stringify 一遍，哈希的输入就成了仓储的实现细节，
   * 快照隔离（M2 判据「创建任务后改 SKILL.md，旧任务读到的仍是旧内容」）
   * 就再也验不出来了。序列化与哈希都由 snapshot-service 用 `domain/canonical.ts` 完成。
   */
  compiledJson: string;
  snapshotHash: string;
  createdAt: string;
}

/** 冻结的 Skill 快照（§5.2 task_skill_snapshots）。主键是 (taskId, skillId)。 */
export interface TaskSkillSnapshot {
  taskId: string;
  skillId: string;
  skillVersion: string;
  contentMarkdown: string;
  /** section id → 位置索引的规范化 JSON，理由同 compiledJson */
  sectionIndexJson: string;
  contentHash: string;
}

/**
 * 把 patch 对象拼成 `SET a = ?, b = ?` 与参数数组。
 *
 * 只收录**显式给出**的键：`undefined` 表示「不改这一列」，`null` 表示「改成 NULL」。
 * 两者必须区分，否则 `activeExecutionId: null`（Stop 的核心动作）会被当成「不改」而静默失效。
 *
 * @param columns 领域字段名 → 列名的映射，同时充当白名单：不在表里的键拼不进 SQL。
 */
export function buildSetClause(
  patch: Readonly<Record<string, unknown>>,
  columns: Readonly<Record<string, string>>,
): { sql: string; params: unknown[] } | null {
  const fragments: string[] = [];
  const params: unknown[] = [];

  for (const [field, column] of Object.entries(columns)) {
    const value = patch[field];
    if (value === undefined) continue;
    fragments.push(`${column} = ?`);
    params.push(value);
  }

  return fragments.length === 0 ? null : { sql: fragments.join(', '), params };
}
