/**
 * 规范化 JSON 与哈希（文档 §6.6 / D-12）。
 *
 * 这个文件是 `templateHash` / `snapshotHash` / `contextHash` 的共同地基，
 * 也是 AC-013「确定性」的地基：只要 canonicalJson 对同一语义输入产出同一字符串，
 * 上层所有 hash 的稳定性就都成立；反之，任何一处不确定都会在几个月后
 * 表现为「上下文莫名其妙变了」这种最难查的问题。
 *
 * 规则（TECH-V0.1 §6.2）：
 * - 对象 key 按 **Unicode 码点**升序（不是 UTF-16 码元序，见 compareCodePoints）
 * - 数组保持原顺序（顺序是语义的一部分，排序会抹掉「依赖顺序」这类信息）
 * - `undefined` / 函数 / symbol 值在对象里剔除，在数组里按 JSON 惯例变成 `null`
 * - 数字用 `JSON.stringify` 的默认表示；非有限数按 JSON 惯例为 `null`
 * - 不加任何空白
 * - 字符串与 key 统一做 NFC 规范化，保证「同一文本的不同 Unicode 表示」哈希一致
 *
 * 例外说明：本文件 import 了 `node:crypto` 的 `createHash`。这是纯计算，
 * 不触碰文件系统 / 网络 / 数据库，不违反 REQ §29 对 domain 层「零 IO」的要求。
 */

import { createHash } from 'node:crypto';

/**
 * 按 Unicode 码点比较两个字符串。
 *
 * 不用默认的 `a < b`：JS 字符串比较走 UTF-16 码元序，
 * 对 BMP 外字符（emoji、部分 CJK 扩展区汉字）与码点序不一致。
 * 模板作者完全可能把这类字符写进 key 或 slot id，届时排序结果会随实现漂移。
 */
export function compareCodePoints(a: string, b: string): number {
  const ia = a[Symbol.iterator]();
  const ib = b[Symbol.iterator]();
  for (;;) {
    const na = ia.next();
    const nb = ib.next();
    if (na.done === true && nb.done === true) return 0;
    if (na.done === true) return -1;
    if (nb.done === true) return 1;
    // `na.value` 是字符串迭代器吐出的**一个完整码点**，不可能是空串，
    // 因此 `codePointAt(0)` 永远有值；`?? 0` 只是为了满足它
    // `number | undefined` 的签名，运行期到不了，也就无法被测试覆盖。
    /* v8 ignore next 2 -- 见上：字符串迭代器不产生空串，两处 `?? 0` 均不可达 */
    const ca = na.value.codePointAt(0) ?? 0;
    const cb = nb.value.codePointAt(0) ?? 0;
    if (ca !== cb) return ca < cb ? -1 : 1;
  }
}

/** 这些类型没有 JSON 表示：静默丢弃会让 hash 悄悄失去区分度，因此显式拒绝 */
function rejectUnrepresentable(value: unknown): void {
  if (typeof value === 'bigint') {
    throw new TypeError('canonicalJson 不支持 bigint —— 请在调用前显式转成 string');
  }
}

/** 对象成员里应当被整体剔除的值（与 JSON.stringify 的对象语义一致） */
function isDroppedInObject(value: unknown): boolean {
  return value === undefined || typeof value === 'function' || typeof value === 'symbol';
}

/**
 * 循环引用检测（D-19）。
 *
 * 没有它，`canonicalJson(x)` 遇到自引用对象会栈溢出，抛出的 `RangeError`
 * 不带任何指向出问题字段的信息——而这个函数是所有 hash 的入口，
 * 调用点分散在快照冻结、上下文组装等好几处，事后从调用栈里反推极其困难。
 * `path` 逐层累积，报错时直接给出 `$.context.slots[2].parent` 这样的定位。
 *
 * 用数组而非 Set 记录 seen：只需要沿**当前这条路径**判重（真正的环），
 * 而同一个对象在树上出现两次（DAG）是合法输入，不该被误报。
 */
function serialize(value: unknown, path: string, seen: readonly object[]): string {
  rejectUnrepresentable(value);

  if (value === null) return 'null';

  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      // 非有限数没有 JSON 表示，按 JSON.stringify 的惯例落到 null
      return Number.isFinite(value) ? JSON.stringify(value) : 'null';
    case 'string':
      return JSON.stringify(value.normalize('NFC'));
    case 'undefined':
    case 'function':
    case 'symbol':
      // 顶层/数组元素位置：JSON 惯例为 null（对象成员在下面提前剔除，走不到这里）
      return 'null';
    default:
      break;
  }

  const object = value as object;
  if (seen.includes(object)) {
    throw new TypeError(`canonicalJson 遇到循环引用：${path} 指回了它的某个祖先`);
  }
  const nextSeen = [...seen, object];

  if (Array.isArray(value)) {
    return `[${value.map((item, i) => serialize(item, `${path}[${i}]`, nextSeen)).join(',')}]`;
  }

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((key) => !isDroppedInObject(record[key]))
    .sort(compareCodePoints);

  const parts = keys.map(
    (key) =>
      `${JSON.stringify(key.normalize('NFC'))}:${serialize(record[key], `${path}.${key}`, nextSeen)}`,
  );
  return `{${parts.join(',')}}`;
}

/**
 * 规范化 JSON 序列化。
 *
 * 注意：key 的排序在 NFC 规范化**之前**进行，而输出的是规范化后的 key。
 * 两个仅 Unicode 表示不同的 key 合法地存在于同一对象时（`Object.keys` 会给出两个），
 * 输出会出现重复 key —— 这属于调用方的输入病态，此处不做去重，
 * 因为静默合并会让两份不同的语义输入产出同一个 hash，比重复 key 更危险。
 *
 * @throws {TypeError} 输入含循环引用（报错信息带 `$.a.b[0]` 形式的路径）或 bigint
 */
export function canonicalJson(value: unknown): string {
  return serialize(value, '$', []);
}

/** sha256 十六进制摘要（小写，64 字符）。输入按 UTF-8 编码。 */
export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/** `sha256(canonicalJson(value))` 的便捷组合——D-12 的 `contextHash` 就是这个式子 */
export function canonicalHash(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}
