import { describe, expect, it } from 'vitest';
import { canonicalHash, canonicalJson, compareCodePoints, sha256Hex } from './canonical.ts';

describe('canonicalJson', () => {
  it('key 顺序不同的两个等价对象产出相同字符串（文档 §6.6 强制要求的断言）', () => {
    const a = { b: 1, a: 2, c: { z: 3, y: 4 } };
    const b = { c: { y: 4, z: 3 }, a: 2, b: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(canonicalJson(a)).toBe('{"a":2,"b":1,"c":{"y":4,"z":3}}');
  });

  it('key 顺序不同的等价对象产出相同 hash', () => {
    expect(canonicalHash({ x: 1, y: [1, 2] })).toBe(canonicalHash({ y: [1, 2], x: 1 }));
  });

  it('数组顺序不同产出不同 hash（数组序是语义的一部分，不得排序）', () => {
    expect(canonicalHash({ deps: ['a', 'b'] })).not.toBe(canonicalHash({ deps: ['b', 'a'] }));
    expect(canonicalJson([1, 2, 3])).toBe('[1,2,3]');
  });

  it('key 按 Unicode 码点升序，而非 UTF-16 码元序', () => {
    // '\u{20000}'（CJK 扩展 B）码点 > '＀'，但 UTF-16 首码元 0xD840 < 0xFF00
    const json = canonicalJson({ '\u{20000}': 1, '＀': 2 });
    expect(json.indexOf('＀')).toBeLessThan(json.indexOf('\u{20000}'));
  });

  it('对象里的 undefined / 函数 / symbol 值被剔除', () => {
    expect(canonicalJson({ a: 1, b: undefined, c: () => 0, d: Symbol('s') })).toBe('{"a":1}');
  });

  it('数组里的 undefined / 函数按 JSON 惯例变成 null', () => {
    expect(canonicalJson([1, undefined, () => 0])).toBe('[1,null,null]');
  });

  it('不加任何空白', () => {
    expect(canonicalJson({ a: { b: [1, { c: 2 }] } })).toBe('{"a":{"b":[1,{"c":2}]}}');
  });

  it('Unicode 表示唯一：NFD 与 NFC 的同一文本产出相同 hash', () => {
    const nfc = '\u00e9';
    const nfd = 'e\u0301';
    expect(nfc).not.toBe(nfd);
    expect(canonicalHash({ k: nfc })).toBe(canonicalHash({ k: nfd }));
    expect(canonicalHash({ [nfc]: 1 })).toBe(canonicalHash({ [nfd]: 1 }));
  });

  it('非有限数按 JSON 惯例落到 null，null 与 boolean 正常', () => {
    expect(canonicalJson({ a: NaN, b: Infinity, c: null, d: true })).toBe(
      '{"a":null,"b":null,"c":null,"d":true}',
    );
  });

  it('false 序列化成 false 而不是被当作空值丢掉', () => {
    // `includeInArtifact: false` 正是 D-16 的语义所在：若 false 与「字段不存在」
    // 产出同一个 canonical 串，工作槽位与普通槽位就会算出相同的 hash。
    expect(canonicalJson({ includeInArtifact: false })).toBe('{"includeInArtifact":false}');
    expect(canonicalHash({ includeInArtifact: false })).not.toBe(
      canonicalHash({ includeInArtifact: true }),
    );
  });

  it('数字用 JSON.stringify 默认表示', () => {
    expect(canonicalJson({ n: 1.5, m: 1e21, z: -0 })).toBe('{"m":1e+21,"n":1.5,"z":0}');
  });

  it('bigint 显式拒绝而不是静默丢弃', () => {
    expect(() => canonicalJson({ n: 1n })).toThrow(TypeError);
  });

  it('嵌套结构的确定性：结构克隆后 hash 不变', () => {
    const input = { a: [{ z: 1, y: [3, 2] }], b: 'x' };
    expect(canonicalHash(input)).toBe(canonicalHash(structuredClone(input)));
  });

  // ---------- D-19：循环引用 ----------

  it('循环引用抛 TypeError 而不是栈溢出，且报错带定位路径', () => {
    // 没有检测时抛的是不带任何字段信息的 RangeError，
    // 而本函数的调用点分散在快照冻结 / 上下文组装多处，事后反推极难。
    const node: Record<string, unknown> = { id: 'scene_01' };
    const root = { context: { slots: [{ parent: node }] } };
    node['back'] = root;

    expect(() => canonicalJson(root)).toThrow(TypeError);
    expect(() => canonicalJson(root)).toThrow(/\$\.context\.slots\[0\]\.parent\.back/);
  });

  it('自引用数组同样被拦截', () => {
    const arr: unknown[] = [1];
    arr.push(arr);
    expect(() => canonicalJson(arr)).toThrow(/循环引用/);
  });

  it('同一对象在树上出现两次（DAG）是合法输入，不误报', () => {
    // 只沿当前路径判重，不是全局 Set——否则模板里被多处引用的同一份配置会被误杀
    const shared = { tone: 'ok' };
    expect(canonicalJson({ a: shared, b: shared })).toBe('{"a":{"tone":"ok"},"b":{"tone":"ok"}}');
  });
});

describe('sha256Hex', () => {
  it('是标准 sha256 十六进制摘要', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('空串有稳定摘要', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });
});

describe('compareCodePoints', () => {
  it('相等、前缀、码点大小三种情形都正确', () => {
    expect(compareCodePoints('a', 'a')).toBe(0);
    expect(compareCodePoints('a', 'ab')).toBeLessThan(0);
    expect(compareCodePoints('ab', 'a')).toBeGreaterThan(0);
    expect(compareCodePoints('a', 'b')).toBeLessThan(0);
    expect(compareCodePoints('\u{20000}', '＀')).toBeGreaterThan(0);
  });
});
