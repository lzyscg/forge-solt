import { describe, expect, it } from 'vitest';
import type { Slot } from './types.ts';
import { assembleMarkdownConcatV1, assemblyOrder, computeArtifactChecksum } from './assembly.ts';
import { documentOrder } from './readiness.ts';

/** 造一个槽位。默认是「普通内容槽位」，各用例只覆盖它关心的字段。 */
function slot(partial: Partial<Slot> & Pick<Slot, 'slotId'>): Slot {
  return {
    taskId: 'task_1',
    type: 'scene',
    parentId: null,
    sortOrder: 0,
    instruction: '',
    dependsOn: [],
    contentBearing: true,
    includeInArtifact: true,
    status: 'completed',
    contentText: null,
    producer: null,
    errorCode: null,
    errorMessage: null,
    createdAt: '2026-08-20T00:00:00.000Z',
    updatedAt: '2026-08-20T00:00:00.000Z',
    ...partial,
  };
}

/**
 * 参考树：
 *   chapter（容器）
 *     ├ working_notes（容器，includeInArtifact=false）
 *     │    ├ outline（内容）
 *     │    └ cast（内容）
 *     ├ scene_01（内容）
 *     └ scene_02（内容）
 */
function fixtureSlots(): Slot[] {
  return [
    slot({ slotId: 'chapter', type: 'chapter', contentBearing: false, sortOrder: 0 }),
    slot({
      slotId: 'working_notes',
      type: 'notes',
      contentBearing: false,
      includeInArtifact: false,
      parentId: 'chapter',
      sortOrder: 0,
    }),
    slot({ slotId: 'outline', parentId: 'working_notes', sortOrder: 0, contentText: '大纲正文' }),
    slot({ slotId: 'cast', parentId: 'working_notes', sortOrder: 1, contentText: '人物卡正文' }),
    slot({ slotId: 'scene_01', parentId: 'chapter', sortOrder: 1, contentText: '第一场' }),
    slot({ slotId: 'scene_02', parentId: 'chapter', sortOrder: 2, contentText: '第二场' }),
  ];
}

describe('遍历顺序与 readiness.documentOrder 一致', () => {
  it('深度优先前序，同级按 (sortOrder, slotId) 升序', () => {
    expect(documentOrder(fixtureSlots()).map((s) => s.slotId)).toEqual([
      'chapter',
      'working_notes',
      'outline',
      'cast',
      'scene_01',
      'scene_02',
    ]);
  });

  it('组装顺序是文档序的子序列——产物顺序与生产顺序不得分叉', () => {
    const order = documentOrder(fixtureSlots()).map((s) => s.slotId);
    const assembled = assemblyOrder(fixtureSlots());
    expect(assembled).toEqual(order.filter((id) => assembled.includes(id)));
  });
});

describe('assembleMarkdownConcatV1', () => {
  it('按文档序用空行连接内容槽位，末尾补一个换行', () => {
    expect(assembleMarkdownConcatV1(fixtureSlots())).toBe('第一场\n\n第二场\n');
  });

  it('子树跳过：容器标 includeInArtifact=false，其下所有内容槽位都不进产物（D-16/D-18）', () => {
    const out = assembleMarkdownConcatV1(fixtureSlots());
    expect(out).not.toContain('大纲正文');
    expect(out).not.toContain('人物卡正文');
    expect(out).toContain('第一场');
  });

  it('叶子工作槽位标 includeInArtifact=false 时只跳自己', () => {
    const slots = [
      slot({ slotId: 'outline', sortOrder: 0, includeInArtifact: false, contentText: '大纲' }),
      slot({ slotId: 'scene_01', sortOrder: 1, contentText: '正文' }),
    ];
    expect(assembleMarkdownConcatV1(slots)).toBe('正文\n');
  });

  it('容器槽位本身不产出内容，但会继续下钻子节点', () => {
    const slots = [
      slot({ slotId: 'chapter', contentBearing: false, contentText: '不该出现' }),
      slot({ slotId: 'scene_01', parentId: 'chapter', contentText: '正文' }),
    ];
    expect(assembleMarkdownConcatV1(slots)).toBe('正文\n');
  });

  it('\\r\\n 与孤立 \\r 归一化为 \\n（AC-013：不归一化会导致同内容不同字节）', () => {
    const slots = [slot({ slotId: 's', contentText: '第一行\r\n第二行\r第三行' })];
    expect(assembleMarkdownConcatV1(slots)).toBe('第一行\n第二行\n第三行\n');
  });

  it('每个槽位内容做 trim，槽位内部格式原样保留', () => {
    const slots = [
      slot({ slotId: 'a', sortOrder: 0, contentText: '  上段\n\n  缩进保留  \n\n' }),
      slot({ slotId: 'b', sortOrder: 1, contentText: '\n下段\n' }),
    ];
    expect(assembleMarkdownConcatV1(slots)).toBe('上段\n\n  缩进保留\n\n下段\n');
  });

  it('contentText 为 null 或 trim 后为空的槽位不产生空段', () => {
    const slots = [
      slot({ slotId: 'a', sortOrder: 0, contentText: null }),
      slot({ slotId: 'b', sortOrder: 1, contentText: '   \n  ' }),
      slot({ slotId: 'c', sortOrder: 2, contentText: '唯一正文' }),
    ];
    expect(assembleMarkdownConcatV1(slots)).toBe('唯一正文\n');
  });

  it('没有任何可组装内容时返回空串，而不是一个孤零零的换行', () => {
    expect(assembleMarkdownConcatV1([])).toBe('');
    expect(assembleMarkdownConcatV1([slot({ slotId: 'c', contentBearing: false })])).toBe('');
  });

  it('父节点悬空的槽位当作根处理，内容不会凭空丢失', () => {
    const slots = [slot({ slotId: 'orphan', parentId: 'ghost', contentText: '孤儿正文' })];
    expect(assembleMarkdownConcatV1(slots)).toBe('孤儿正文\n');
  });

  it('父子成环时不栈溢出（组装是只读路径，坏数据必须能安全终止）', () => {
    const slots = [
      slot({ slotId: 'a', parentId: 'b', contentText: 'A' }),
      slot({ slotId: 'b', parentId: 'a', contentText: 'B' }),
    ];
    expect(() => assembleMarkdownConcatV1(slots)).not.toThrow();
    expect(assembleMarkdownConcatV1(slots)).toBe('');
  });

  it('AC-013 逐字节确定性：同输入两次组装完全一致', () => {
    const a = assembleMarkdownConcatV1(fixtureSlots());
    const b = assembleMarkdownConcatV1(fixtureSlots());
    expect(a).toBe(b);
    expect(computeArtifactChecksum(a)).toBe(computeArtifactChecksum(b));
  });

  it('AC-013 输入数组顺序无关：打乱后产出逐字节相同（§11.4）', () => {
    const ordered = fixtureSlots();
    const shuffled = [...fixtureSlots()].reverse();
    const a = assembleMarkdownConcatV1(ordered);
    const b = assembleMarkdownConcatV1(shuffled);
    expect(a).toBe(b);
    expect(computeArtifactChecksum(a)).toMatchInlineSnapshot(
      `"sha256:22d9c99912dff93ed0d62fef0f3aaf43d88a98b77ed848766d393fc01dbd76bf"`,
    );
  });
});

describe('computeArtifactChecksum', () => {
  it('带 sha256: 前缀，值是内容的 UTF-8 摘要', () => {
    expect(computeArtifactChecksum('abc')).toBe(
      'sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});

describe('assemblyOrder', () => {
  it('只列进入产物的内容槽位，工作槽位与其子树都不出现（D-16 影响面第 7 条）', () => {
    expect(assemblyOrder(fixtureSlots())).toEqual(['scene_01', 'scene_02']);
  });

  it('父节点悬空的槽位当作根，仍然列进组装顺序（不因祖先查不到而被整段吞掉）', () => {
    // 祖先链的排除判定沿 parentId 上行，遇到查不到的父节点必须停下来按「无祖先」处理；
    // 若把「查不到」当成「被排除」，一条历史脏数据就会让整段正文从产物里静默消失。
    const slots = [
      slot({ slotId: 'chapter', type: 'chapter', contentBearing: false }),
      slot({ slotId: 'scene_01', parentId: 'chapter', sortOrder: 0, contentText: '第一场' }),
      slot({ slotId: 'orphan', parentId: 'ghost', sortOrder: 1, contentText: '孤儿正文' }),
    ];
    expect(assemblyOrder(slots)).toEqual(['scene_01', 'orphan']);
    expect(assembleMarkdownConcatV1(slots)).toBe('第一场\n\n孤儿正文\n');
  });
});

describe('组装对脏数据的确定性（历史数据不受今天的结构校验保护）', () => {
  it('同级 sortOrder 相同时按 slotId 码点序定序，而不是听凭输入数组顺序', () => {
    // 规则 10 本该拦下重复 order，但库里的历史数据不受它保护。
    // 少了这层 tiebreaker，同一份数据换个读取顺序就会产出另一份产物，AC-013 直接失守。
    const build = (ids: readonly string[]): Slot[] =>
      ids.map((id) => slot({ slotId: id, sortOrder: 0, contentText: `${id} 的正文` }));
    expect(assembleMarkdownConcatV1(build(['b', 'a']))).toBe('a 的正文\n\nb 的正文\n');
    expect(assembleMarkdownConcatV1(build(['a', 'b']))).toBe(
      assembleMarkdownConcatV1(build(['b', 'a'])),
    );
  });

  it('slotId 重复时同一槽位只进产物一次，不会把同一段正文写两遍', () => {
    const slots = [
      slot({ slotId: 'scene_01', contentText: '第一场' }),
      slot({ slotId: 'scene_01', contentText: '第一场（另一行）' }),
    ];
    expect(assembleMarkdownConcatV1(slots)).toBe('第一场\n');
  });
});
