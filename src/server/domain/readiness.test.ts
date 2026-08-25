/**
 * `readiness.ts` 的单测（AC-005「Ready Slot 正确推进」的落点，文档 §11.3）。
 *
 * 这一层的 bug 不会崩，只会「选错下一个槽位」——表现为产物内容顺序错乱或任务卡住，
 * 极难从日志反推。因此这里的断言全部是**具体到 slotId**的，不用「非空」之类的弱断言。
 */

import { describe, expect, it } from 'vitest';

import type { SlotStatus } from '@shared/contracts.ts';
import type { Slot } from './types.ts';

import {
  allContentSlotsCompleted,
  blockedBy,
  computeDepth,
  deriveReadySlots,
  detectDeadlock,
  documentOrder,
  isSlotReady,
  selectNextReadySlot,
} from './readiness.ts';

// ---------------------------------------------------------------- 夹具

function slot(over: Partial<Slot> & { slotId: string }): Slot {
  return {
    taskId: 'task_1',
    type: 'scene',
    parentId: 'chapter',
    sortOrder: 0,
    instruction: '写这个场景',
    dependsOn: [],
    contentBearing: true,
    includeInArtifact: true,
    status: 'pending',
    contentText: null,
    producer: null,
    errorCode: null,
    errorMessage: null,
    createdAt: '2026-08-20T00:00:00.000Z',
    updatedAt: '2026-08-20T00:00:00.000Z',
    ...over,
  };
}

function container(slotId: string, over: Partial<Slot> = {}): Slot {
  return slot({
    slotId,
    type: 'chapter',
    contentBearing: false,
    instruction: '',
    // 容器在结构提交时即被置为 completed（FR-STR-005 第 2 条）
    status: 'completed',
    ...over,
  });
}

const ROOT = container('chapter', { parentId: null });

/** chapter → [title(0), scene_01(1), scene_02(2 依赖 scene_01)] */
function chain(): Slot[] {
  return [
    ROOT,
    slot({ slotId: 'title', type: 'title', sortOrder: 0 }),
    slot({ slotId: 'scene_01', sortOrder: 1 }),
    slot({ slotId: 'scene_02', sortOrder: 2, dependsOn: ['scene_01'] }),
  ];
}

function withStatus(slots: Slot[], slotId: string, status: SlotStatus): Slot[] {
  return slots.map((s) => (s.slotId === slotId ? { ...s, status } : s));
}

const ids = (slots: readonly Slot[]): string[] => slots.map((s) => s.slotId);

// ---------------------------------------------------------------- computeDepth

describe('computeDepth', () => {
  it('根为 0，逐层加一', () => {
    const slots = [
      ROOT,
      container('sec', { sortOrder: 0 }),
      slot({ slotId: 'scene_01', parentId: 'sec' }),
    ];
    const depths = computeDepth(slots);
    expect(depths.get('chapter')).toBe(0);
    expect(depths.get('sec')).toBe(1);
    expect(depths.get('scene_01')).toBe(2);
  });

  it('复用已算过的祖先深度时不会算错（回填起点是 known + 1）', () => {
    // 先出现深层节点，再出现它的兄弟，触发「命中已知深度」分支
    const slots = [
      slot({ slotId: 'scene_deep', parentId: 'sec' }),
      container('sec', { sortOrder: 0 }),
      ROOT,
      slot({ slotId: 'scene_sib', parentId: 'sec' }),
    ];
    const depths = computeDepth(slots);
    expect(depths.get('scene_deep')).toBe(2);
    expect(depths.get('scene_sib')).toBe(2);
  });

  it('异常数据：parentId 悬空按根处理，父子环不死循环', () => {
    const slots = [
      slot({ slotId: 'orphan', parentId: 'ghost' }),
      slot({ slotId: 'node_a', parentId: 'node_b' }),
      slot({ slotId: 'node_b', parentId: 'node_a' }),
    ];
    const depths = computeDepth(slots);
    expect(depths.get('orphan')).toBe(0);
    expect(depths.size).toBe(3);
  });
});

// ---------------------------------------------------------------- documentOrder

describe('documentOrder（REQ FR-SCH-002）', () => {
  it('深度优先前序：容器的子树紧跟容器之后', () => {
    const slots = [
      ROOT,
      slot({ slotId: 'scene_last', sortOrder: 9 }),
      container('sec', { sortOrder: 1 }),
      slot({ slotId: 'scene_in_sec', parentId: 'sec', sortOrder: 0 }),
      slot({ slotId: 'title', type: 'title', sortOrder: 0 }),
    ];
    expect(ids(documentOrder(slots))).toEqual([
      'chapter',
      'title',
      'sec',
      'scene_in_sec',
      'scene_last',
    ]);
  });

  it('文档序稳定性：sortOrder 相同时按 slotId 字典序兜底', () => {
    const slots = [
      ROOT,
      slot({ slotId: 'scene_c', sortOrder: 1 }),
      slot({ slotId: 'scene_a', sortOrder: 1 }),
      slot({ slotId: 'scene_b', sortOrder: 1 }),
    ];
    expect(ids(documentOrder(slots))).toEqual(['chapter', 'scene_a', 'scene_b', 'scene_c']);
  });

  it('slotId tiebreak 走 Unicode 码点序，不是 UTF-16 码元序', () => {
    // 裸 `a < b` 会把 '\u{20000}'（BMP 外）排在 '＀'（U+FF00）之前，与码点序相反。
    // assembly.ts 用的是码点序，两处一旦分叉，「产物顺序」与「生产顺序」就会不一致——
    // 而这类 bug 只在脏数据或放宽 SLOT_ID_PATTERN 之后才现形，事后极难定位。
    const slots = [
      ROOT,
      slot({ slotId: '\u{20000}', sortOrder: 1 }),
      slot({ slotId: '＀', sortOrder: 1 }),
    ];
    expect(ids(documentOrder(slots))).toEqual(['chapter', '＀', '\u{20000}']);
  });

  it('文档序稳定性：输入数组顺序不影响结果', () => {
    const a = ids(documentOrder(chain()));
    const b = ids(documentOrder([...chain()].reverse()));
    expect(a).toEqual(b);
    expect(a).toEqual(['chapter', 'title', 'scene_01', 'scene_02']);
  });

  it('异常数据：父子环里的槽位仍会出现，且每个槽位只出现一次', () => {
    const slots = [
      ROOT,
      slot({ slotId: 'scene_01', sortOrder: 0 }),
      slot({ slotId: 'node_a', parentId: 'node_b' }),
      slot({ slotId: 'node_b', parentId: 'node_a' }),
    ];
    const ordered = ids(documentOrder(slots));
    expect(ordered).toHaveLength(4);
    expect(new Set(ordered).size).toBe(4);
    expect(ordered.slice(0, 2)).toEqual(['chapter', 'scene_01']);
  });

  it('异常数据：parentId 悬空的槽位当作根参与遍历', () => {
    const slots = [ROOT, slot({ slotId: 'orphan', parentId: 'ghost', sortOrder: 5 })];
    expect(ids(documentOrder(slots))).toEqual(['chapter', 'orphan']);
  });

  it('异常数据：slotId 重复时同一个 ID 只出现一次，调度器不会把它派两遍', () => {
    // (taskId, slotId) 是主键，正常路径上不可能重复；但排序比较器必须对「两个相等的 ID」
    // 给出 0，否则它就不是一个合法的全序，排序结果会随实现细节漂移——
    // 而 REQ FR-SCH-002 要的恰恰是「相同结构必然得到相同顺序」。
    const dirty = [
      ROOT,
      slot({ slotId: 'scene_01', sortOrder: 0, instruction: '先写的那份' }),
      slot({ slotId: 'scene_01', sortOrder: 0, instruction: '重复的那份' }),
    ];
    const ordered = ids(documentOrder(dirty));
    expect(ordered).toEqual(['chapter', 'scene_01']);
    expect(ids(documentOrder([...dirty].reverse()))).toEqual(ordered);
  });
});

// ---------------------------------------------------------------- blockedBy

describe('blockedBy（D-07 的「等待依赖」子行必须点名在等谁）', () => {
  it('返回未完成的依赖，保持 dependsOn 声明顺序', () => {
    const slots = [
      ROOT,
      slot({ slotId: 'scene_01', status: 'completed' }),
      slot({ slotId: 'scene_02', status: 'running' }),
      slot({ slotId: 'scene_03', dependsOn: ['scene_02', 'scene_01'] }),
    ];
    const target = slots[3];
    expect(target).toBeDefined();
    if (target === undefined) return;
    expect(blockedBy(target, slots)).toEqual(['scene_02']);
  });

  it('依赖全部完成时返回空数组', () => {
    const slots = withStatus(chain(), 'scene_01', 'completed');
    const target = slots.find((s) => s.slotId === 'scene_02');
    expect(target).toBeDefined();
    if (target === undefined) return;
    expect(blockedBy(target, slots)).toEqual([]);
  });

  it('不存在的依赖算作未满足并原样返回，不静默忽略', () => {
    const target = slot({ slotId: 'scene_09', dependsOn: ['ghost'] });
    expect(blockedBy(target, [ROOT, target])).toEqual(['ghost']);
  });

  it('重复声明的依赖只返回一次', () => {
    const target = slot({ slotId: 'scene_09', dependsOn: ['ghost', 'ghost'] });
    expect(blockedBy(target, [ROOT, target])).toEqual(['ghost']);
  });
});

// ---------------------------------------------------------------- Ready 判定

describe('isSlotReady / deriveReadySlots（REQ FR-SCH-001）', () => {
  it('容器槽位永远不 Ready：它没有 Assignment', () => {
    expect(isSlotReady(ROOT, [ROOT])).toBe(false);
  });

  it('非 pending 的内容槽位不 Ready', () => {
    const slots = withStatus(chain(), 'title', 'running');
    const target = slots.find((s) => s.slotId === 'title');
    expect(target).toBeDefined();
    if (target === undefined) return;
    expect(isSlotReady(target, slots)).toBe(false);
  });

  it('依赖未完成时不 Ready，依赖完成后转为 Ready', () => {
    const before = chain();
    expect(ids(deriveReadySlots(before))).toEqual(['title', 'scene_01']);

    const after = withStatus(withStatus(before, 'title', 'completed'), 'scene_01', 'completed');
    expect(ids(deriveReadySlots(after))).toEqual(['scene_02']);
  });

  it('工作槽位与普通内容槽位一样参与调度（D-16 影响面第 2 条：本层不变）', () => {
    const slots = [
      ROOT,
      slot({ slotId: 'outline', type: 'chapter_outline', includeInArtifact: false, sortOrder: 0 }),
    ];
    expect(ids(deriveReadySlots(slots))).toEqual(['outline']);
  });

  it('Ready 列表按文档序返回', () => {
    const slots = [
      ROOT,
      slot({ slotId: 'scene_b', sortOrder: 2 }),
      slot({ slotId: 'scene_a', sortOrder: 1 }),
    ];
    expect(ids(deriveReadySlots(slots))).toEqual(['scene_a', 'scene_b']);
  });
});

// ---------------------------------------------------------------- 选择下一个

describe('selectNextReadySlot（REQ FR-SCH-002 / FR-SCH-003）', () => {
  it('按文档序选中第一个 Ready 槽位', () => {
    expect(selectNextReadySlot(chain())?.slotId).toBe('title');
  });

  it('依赖未满足的槽位被跳过，选中文档序靠后的那个', () => {
    // scene_01 尚未完成 → scene_02 不 Ready；scene_03 无依赖，虽然排在最后但可以先做
    const slots = [
      ROOT,
      slot({ slotId: 'scene_01', sortOrder: 1, status: 'running' }),
      slot({ slotId: 'scene_02', sortOrder: 2, dependsOn: ['scene_01'] }),
      slot({ slotId: 'scene_03', sortOrder: 3 }),
    ];
    expect(selectNextReadySlot(slots)?.slotId).toBe('scene_03');
  });

  it('没有 Ready 槽位时返回 null', () => {
    const done = chain().map((s) => ({ ...s, status: 'completed' as SlotStatus }));
    expect(selectNextReadySlot(done)).toBeNull();
  });

  it('确定性：相同结构与相同状态永远给出同一个下一槽位', () => {
    const a = selectNextReadySlot(chain())?.slotId;
    const b = selectNextReadySlot([...chain()].reverse())?.slotId;
    expect(a).toBe(b);
  });
});

// ---------------------------------------------------------------- 完成判定

describe('allContentSlotsCompleted（FR-SCH-004 第 1 条）', () => {
  it('还有内容槽位未完成时为 false', () => {
    expect(allContentSlotsCompleted(chain())).toBe(false);
  });

  it('容器槽位不影响判定', () => {
    const slots = chain()
      .map((s) => (s.contentBearing ? { ...s, status: 'completed' as SlotStatus } : s))
      .map((s) => (s.slotId === 'chapter' ? { ...s, status: 'pending' as SlotStatus } : s));
    expect(allContentSlotsCompleted(slots)).toBe(true);
  });

  it('工作槽位必须完成才算完成（不进产物 ≠ 不用生产）', () => {
    const slots = [
      ROOT,
      slot({ slotId: 'scene_01', status: 'completed' }),
      slot({ slotId: 'outline', type: 'chapter_outline', includeInArtifact: false }),
    ];
    expect(allContentSlotsCompleted(slots)).toBe(false);
  });
});

// ---------------------------------------------------------------- 死锁

describe('detectDeadlock（FR-SCH-004 第 3 条）', () => {
  /** 一个真死锁：两个 pending 内容槽互相依赖，没有 running / failed */
  function deadlocked(): Slot[] {
    return [
      ROOT,
      slot({ slotId: 'scene_01', sortOrder: 1, dependsOn: ['scene_02'] }),
      slot({ slotId: 'scene_02', sortOrder: 2, dependsOn: ['scene_01'] }),
    ];
  }

  it('四个前提同时成立时判定为死锁，并返回涉及的槽位', () => {
    const info = detectDeadlock(deadlocked());
    expect(info).not.toBeNull();
    expect(info?.slotIds).toEqual(['scene_01', 'scene_02']);
    expect(info?.blockedBy).toEqual(['scene_01', 'scene_02']);
  });

  it('前提 1：没有 pending 内容槽位 → 不是死锁（该进 Assembly）', () => {
    const done = chain().map((s) => ({ ...s, status: 'completed' as SlotStatus }));
    expect(detectDeadlock(done)).toBeNull();
  });

  it('前提 2：存在 ready 槽位 → 不是死锁（继续调度）', () => {
    const slots = [...deadlocked(), slot({ slotId: 'scene_free', sortOrder: 3 })];
    expect(detectDeadlock(slots)).toBeNull();
  });

  it('前提 3：存在 running 槽位 → 不是死锁（等它跑完）', () => {
    const slots = [
      ...deadlocked(),
      slot({ slotId: 'scene_running', sortOrder: 3, status: 'running' }),
    ];
    expect(detectDeadlock(slots)).toBeNull();
  });

  it('前提 4：存在 failed 槽位 → 不是死锁（按失败处理，别盖住真原因）', () => {
    const slots = [
      ...deadlocked(),
      slot({ slotId: 'scene_failed', sortOrder: 3, status: 'failed' }),
    ];
    expect(detectDeadlock(slots)).toBeNull();
  });

  it('依赖悬空导致的卡死也能被检出，并点名那个不存在的槽位', () => {
    const slots = [ROOT, slot({ slotId: 'scene_01', dependsOn: ['ghost'] })];
    const info = detectDeadlock(slots);
    expect(info?.slotIds).toEqual(['scene_01']);
    expect(info?.blockedBy).toEqual(['ghost']);
  });

  it('依赖一个永远不会开工的 pending 容器不会被误判为可推进', () => {
    // 结构校验规则 17 本该拦下「依赖容器」，这里守的是历史数据
    const slots = [
      ROOT,
      container('notes', { slotId: 'notes', status: 'pending', sortOrder: 0 }),
      slot({ slotId: 'scene_01', sortOrder: 1, dependsOn: ['notes'] }),
    ];
    const info = detectDeadlock(slots);
    expect(info?.slotIds).toEqual(['scene_01']);
    expect(info?.blockedBy).toEqual(['notes']);
  });
});
