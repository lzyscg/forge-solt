/**
 * M4 的指标口径（`cli/measure-runs.ts`）。
 *
 * M4 这个里程碑唯一的产出是**一个数字**，而它决定进不进 M5。
 * 一个算错的通过率比没有通过率更糟：它会让人拿着 92% 的假象往下走，
 * 或者反过来，为了一个虚低的数字去改本来没问题的 Skill 文本。
 * 所以这里用形状**已知**的运行去反推指标，而不是信任肉眼看报告。
 *
 * 夹具全程走 `FakeProvider`：真实模型每次的提交次数都不一样，
 * 而这里要固定的正是「提交了几次、第几次过的」。
 */

import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '@server/infrastructure/database/db.ts';
import { runMigrations } from '@server/infrastructure/database/migrate.ts';
import { FakeProvider } from '@server/runtime/provider/fake.ts';
import { computeMetrics, formatReport } from '@server/cli/measure-runs.ts';
import {
  createEngineHarness,
  createTempDbPath,
  outlineText,
  sceneText,
  TITLE_TEXT,
  VALID_STRUCTURE,
  type EngineHarness,
} from '../fixtures/engine.ts';

const INPUT = { chapter_packet: '主角在雨夜与债主对峙，本章需完成摊牌。' };

let harness: EngineHarness | null = null;
const cleanups: Array<() => void> = [];

afterEach(() => {
  harness?.close();
  harness = null;
  while (cleanups.length > 0) cleanups.pop()?.();
});

const FILL_ALL = [
  { submitContent: { slotId: 'outline', content: outlineText() } },
  { submitContent: { slotId: 'title', content: TITLE_TEXT } },
  { submitContent: { slotId: 'scene_01', content: sceneText('第一场') } },
  { submitContent: { slotId: 'scene_02', content: sceneText('第二场') } },
];

/** 在真文件库上跑一遍，返回 (dbPath, taskId)——统计只认库，不认内存 */
async function runOnDisk(turns: readonly unknown[]): Promise<{ dbPath: string; taskId: string }> {
  const { dbPath, cleanup } = createTempDbPath();
  cleanups.push(cleanup);
  harness = createEngineHarness({
    dbPath,
    provider: new FakeProvider({ turns: turns as never }),
  });
  const created = await harness.snapshots.createTask({
    templateId: 'zhihu-chapter',
    name: '指标夹具',
    input: INPUT,
  });
  await harness.lifecycle.start(created.task.id).catch(() => undefined);
  harness.close();
  harness = null;
  return { dbPath, taskId: created.task.id };
}

function metricsOf(dbPath: string): ReturnType<typeof computeMetrics> {
  const db = openDatabase(dbPath);
  try {
    runMigrations(db);
    return computeMetrics(db, null);
  } finally {
    db.close();
  }
}

describe('computeMetrics 的口径', () => {
  it('一次过的任务：结构与全部槽位都记 100%', async () => {
    const { dbPath } = await runOnDisk([{ submitStructure: VALID_STRUCTURE }, ...FILL_ALL]);
    const m = metricsOf(dbPath);

    expect(m.totalTasks).toBe(1);
    expect(m.completedTasks).toBe(1);
    expect(m.structureFirstPass).toEqual({ passed: 1, total: 1 });
    expect(m.slotFirstPass).toEqual({ passed: 4, total: 4 });
    expect(m.tasksWithoutStructureSubmission).toBe(0);
  });

  /**
   * 本文件真正的理由。D-20 让被拒的提交**不收敛 execution**，
   * 于是「错两次再改对」在库里是 1 个 succeeded 的 execution。
   * 按 execution 数统计的话，这种情况会被算成首次通过——
   * 而它恰恰是首次**没**通过，是 M4 要测的那个失败。
   */
  it('同一次 Assignment 里改了两次才对：首次通过率记 0，三次内通过率记 1', async () => {
    const { dbPath } = await runOnDisk([
      { invalidStructure: 'NO_CONTENT_SLOT' },
      { invalidStructure: 'NO_CONTENT_SLOT' },
      { submitStructure: VALID_STRUCTURE },
      ...FILL_ALL,
    ]);
    const m = metricsOf(dbPath);

    expect(m.completedTasks).toBe(1); // 任务本身是成功的
    expect(m.structureFirstPass).toEqual({ passed: 0, total: 1 });
    expect(m.structureWithinThree).toEqual({ passed: 1, total: 1 });
    // 槽位那一侧不受影响：结构的失败不该污染内容指标
    expect(m.slotFirstPass).toEqual({ passed: 4, total: 4 });
  });

  it('结构始终没通过：三次内通过率也记 0，且任务进 failures', async () => {
    const { dbPath } = await runOnDisk([
      { invalidStructure: 'NO_CONTENT_SLOT' },
      { invalidStructure: 'NO_CONTENT_SLOT' },
      { invalidStructure: 'NO_CONTENT_SLOT' },
      { invalidStructure: 'NO_CONTENT_SLOT' },
      { invalidStructure: 'NO_CONTENT_SLOT' },
      { invalidStructure: 'NO_CONTENT_SLOT' },
    ]);
    const m = metricsOf(dbPath);

    expect(m.completedTasks).toBe(0);
    expect(m.structureFirstPass).toEqual({ passed: 0, total: 1 });
    expect(m.structureWithinThree).toEqual({ passed: 0, total: 1 });
    expect(m.failures).toHaveLength(1);
    expect(m.failures[0]?.message).toBeTruthy();
  });

  /**
   * 分母口径。模型一次工具都没调 → 一条 `assignment_submitted` 都没有。
   * 把它算作「首次未通过」，就等于把「模型没听懂要调工具」和
   * 「模型交了但结构错了」混成同一个数字，而这两者的修法完全不同。
   */
  it('一次都没提交到的任务不进结构通过率的分母，单独计数', async () => {
    const { dbPath } = await runOnDisk([{ text: '我先想一想这一章该怎么安排。' }]);
    const m = metricsOf(dbPath);

    expect(m.structureFirstPass.total).toBe(0);
    expect(m.tasksWithoutStructureSubmission).toBe(1);
    expect(m.completedTasks).toBe(0);
  });

  /**
   * 20 次真实实测里出现过的情况：某个场景槽位第一次 attempt 模型只说话、
   * 没调 `complete_assignment`，重试后成功。按口径它不进首次通过率的分母，
   * 于是报告写着 100/100——**读起来像是槽位这一侧一次意外都没有过**。
   * 剔除是对的，隐瞒不是。
   */
  it('槽位有过「只说话不提交」的 attempt：仍记 100% 首次通过，但必须单独报出来', async () => {
    const { dbPath } = await runOnDisk([
      { submitStructure: VALID_STRUCTURE },
      { submitContent: { slotId: 'outline', content: outlineText() } },
      { submitContent: { slotId: 'title', content: TITLE_TEXT } },
      { text: '让我先想想这一场怎么写。' }, // scene_01 第一次：不提交
      { submitContent: { slotId: 'scene_01', content: sceneText('第一场') } },
      { submitContent: { slotId: 'scene_02', content: sceneText('第二场') } },
    ]);
    const m = metricsOf(dbPath);

    expect(m.completedTasks).toBe(1);
    // 那次 attempt 没有提交，所以「提交过的都一次过」依然成立
    expect(m.slotFirstPass).toEqual({ passed: 4, total: 4 });
    // 但它不能就这么消失
    expect(m.slotsWithNoSubmissionAttempt).toBe(1);
    expect(formatReport(m)).toContain('只说话、没调 complete_assignment');
  });

  /**
   * 在**正在写入**的库上跑 `--report-only` 时踩到的：跑到一半的任务被算成失败，
   * 端到端成功率于是随「你什么时候按回车」而变。那个数字看起来完全正常，只是不对。
   */
  it('还在跑的任务从端到端成功率的分母里扣除，并明说扣了几个', () => {
    const text = formatReport({
      totalTasks: 3,
      completedTasks: 2,
      inFlightTasks: 1,
      tasksWithoutStructureSubmission: 0,
      structureFirstPass: { passed: 3, total: 3 },
      structureWithinThree: { passed: 3, total: 3 },
      slotFirstPass: { passed: 13, total: 13 },
      slotsWithNoSubmissionAttempt: 0,
      durationsMs: [82_000],
      failures: [],
    });
    // 2/2 而不是 2/3——在跑的那个既不算成功也不算失败
    expect(text).toMatch(/单章端到端成功率.*100\.0%.*\(2\/2\)/);
    expect(text).toContain('1 个任务还在跑');
  });

  it('分母为 0 时报告写「—」，不打印 NaN%', () => {
    const text = formatReport({
      totalTasks: 0,
      completedTasks: 0,
      inFlightTasks: 0,
      tasksWithoutStructureSubmission: 0,
      structureFirstPass: { passed: 0, total: 0 },
      structureWithinThree: { passed: 0, total: 0 },
      slotFirstPass: { passed: 0, total: 0 },
      slotsWithNoSubmissionAttempt: 0,
      durationsMs: [],
      failures: [],
    });
    expect(text).toContain('—（分母为 0）');
    expect(text).not.toContain('NaN');
  });

  it('达标与否在报告里明说，不让人自己拿目标值去比', () => {
    const text = formatReport({
      totalTasks: 10,
      completedTasks: 9,
      inFlightTasks: 0,
      tasksWithoutStructureSubmission: 0,
      structureFirstPass: { passed: 7, total: 10 }, // 70% < 80%
      structureWithinThree: { passed: 10, total: 10 },
      slotFirstPass: { passed: 38, total: 40 },
      slotsWithNoSubmissionAttempt: 0,
      durationsMs: [100_000, 120_000, 500_000],
      failures: [],
    });
    expect(text).toMatch(/结构提案首次通过率.*70\.0%.*未达标/);
    expect(text).toMatch(/结构提案三次内通过率.*100\.0%.*达标/);
    // 均值被一次超时拉高时，中位数是判断「整体是否变慢」的那个数
    expect(text).toContain('中位 120.0s');
  });
});
