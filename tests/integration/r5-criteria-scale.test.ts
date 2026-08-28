/**
 * 判据数量可变性验收：审核 Skill 从 4 条改到 10 条，产品链路能不能跟上。
 *
 * 这条测试回答的是一个产品问题——「以后把审核维度改成 10 个，界面上还对吗」。
 * 光读代码不算数：`slot-scheduler` 用 `skill.sections.map(s => s.id)` 看起来是
 * 数据驱动的，但整条链路上还有落库、排序、返修上下文三处能把它拧断。
 * 这里用一份**运行时生成的 10 判据 Skill** 把整条链路真跑一遍。
 *
 * 已知并在此钉死的一处缺陷：`slot_reviews` 的 `ORDER BY criterion_id` 是
 * **字符串排序**，10 条判据时读回来是 S1, S10, S2, …。调度不受影响
 * （scheduler 只拿它建 Set），但返修上下文里喂给写作 Agent 的 findings 会乱序。
 */

import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createEngineHarness,
  sceneText,
  outlineText,
  TITLE_TEXT,
  VALID_STRUCTURE,
  type EngineHarness,
} from '../fixtures/engine.ts';
import { FakeProvider, type FakeProviderScript } from '@server/runtime/provider/fake.ts';

const INPUT = { chapter_packet: '主角在雨夜与债主对峙，本章需完成摊牌。' };
const N = 10;

/** S1 … S10 —— 刻意跨过 10，两位数正是字符串排序会翻车的地方 */
const IDS = Array.from({ length: N }, (_, i) => `S${i + 1}`);

let skillsDir = '';
let harness: EngineHarness | null = null;

afterEach(() => {
  harness?.close();
  harness = null;
});

/**
 * 把 fixture 的 skills 目录整份复制到临时目录，只把 scene-review 换成 10 判据版。
 * 不改仓库里的 fixture：那份是 R2 一串用例的地基，动它会连带影响无关测试。
 */
beforeAll(() => {
  const src = path.join(import.meta.dirname, '../fixtures/skills');
  /*
   * 目录名必须正好是 `skills`：模板里写的是 `source: skills/scene-review/SKILL.md`，
   * 而 `resolveSkillPath` 把它相对 **skillsDir 的父目录** 解析，再校验结果落在
   * skillsDir 之内。临时目录随便取名会让这一步判定为「指向了 SKILLS_DIR 之外」，
   * 模板加载失败，最后表现成一句与真实原因毫不相干的「模板不存在：review-chapter」。
   */
  skillsDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-10-')), 'skills');
  fs.cpSync(src, skillsDir, { recursive: true });

  const sections = IDS.map(
    (id, i) => `## ${id}. 第 ${i + 1} 条判据的标题\n\n判据 ${id}：这是第 ${i + 1} 条判据的正文，用来占位。\n`,
  ).join('\n');
  fs.writeFileSync(
    path.join(skillsDir, 'scene-review', 'SKILL.md'),
    `---
id: scene-review
version: 1.0.0
operation: review_slot
slotTypes: [scene]
summary: 按判据审核场景正文
requiredSections: [S1]
---

# 场景审核 Skill

你是场景审核 Agent。只审被指定的判据，不审其他判据。

${sections}`,
  );
});

function createHarness(scripts: readonly FakeProviderScript[]): EngineHarness {
  harness = createEngineHarness({ provider: new FakeProvider({ turns: scripts }), skillsDir });
  return harness;
}

function scriptTo(reviews: readonly FakeProviderScript[]): readonly FakeProviderScript[] {
  return [
    { submitStructure: VALID_STRUCTURE },
    { submitContent: { slotId: 'outline', content: outlineText() } },
    { submitContent: { slotId: 'title', content: TITLE_TEXT } },
    { submitContent: { slotId: 'scene_01', content: sceneText('第一场') } },
    ...reviews,
  ];
}

describe('判据数量从 4 条改到 10 条', () => {
  it('10 条判据全部被调度、全部落库，没有一条被吞掉', async () => {
    const h = createHarness(
      scriptTo(IDS.map(() => ({ submitReview: { slotId: 'scene_01', verdict: 'no_finding' as const } }))),
    );
    const created = await h.snapshots.createTask({ templateId: 'review-chapter', name: '十判据', input: INPUT });
    h.lifecycle.dispatch('start', created.task.id);
    await h.engine.drain();
    const taskId = created.task.id;

    const rows = h.uow.repositories.slotReviews.listByRound(taskId, 'scene_01', 0);
    expect(rows).toHaveLength(N);
    // 不是「有 10 行就行」：必须正好是这 10 个 ID，一个不多一个不少
    expect([...rows.map((r) => r.criterionId)].sort()).toEqual([...IDS].sort());

    // 反证：槽位真的走完了审核，而不是卡在 reviewing 上凑够了行数
    expect(h.uow.repositories.slots.getOrThrow(taskId, 'scene_01').status).toBe('completed');
  });

  it('调度顺序是 SKILL.md 的书写顺序，S10 排在 S9 之后而不是 S1 之后', async () => {
    const h = createHarness(
      scriptTo(IDS.map(() => ({ submitReview: { slotId: 'scene_01', verdict: 'no_finding' as const } }))),
    );
    const created = await h.snapshots.createTask({ templateId: 'review-chapter', name: '十判据', input: INPUT });
    h.lifecycle.dispatch('start', created.task.id);
    await h.engine.drain();

    /*
     * 必须先把审核 prompt 挑出来再找判据号。写作与结构 Skill 自己也用
     * `## S1.` `## S2.` 这套编号（fixture 里 chapter-structure-design 有 S1–S3），
     * 直接在全部 observation 里搜 `## Sn.` 会把结构 Agent 的 prompt 当成审核
     * ——第一版就是这么写的，测试红了，红的是测试不是产品。
     */
    const dispatched = h.provider.observations
      .filter((obs) => obs.system.includes('你是场景审核 Agent'))
      .map((obs) => {
        const hit = IDS.filter((id) => obs.system.includes(`## ${id}.`));
        expect(hit).toHaveLength(1); // D-23：一次调用的 prompt 里只能出现一条判据
        return hit[0];
      });

    expect(dispatched).toEqual(IDS);
  });

  /*
   * 曾经的缺陷：`ORDER BY criterion_id` 是字符串比较，'S10' < 'S2'，
   * 十条判据读回来是 S1, S10, S2, …。已改为按写入顺序排（见仓储注释）。
   *
   * 它只有一个顺序敏感的消费者：`revision-source` 把 findings 按这个顺序
   * 喂回写作 Agent。调度不受影响（scheduler 只拿它建 Set），
   * 结算也不受影响（settleReview 只看有没有 revise）。
   */
  it('listByRound 按书写顺序读回，S10 排在 S9 之后而不是 S1 之后', async () => {
    const h = createHarness(
      scriptTo(IDS.map(() => ({ submitReview: { slotId: 'scene_01', verdict: 'no_finding' as const } }))),
    );
    const created = await h.snapshots.createTask({ templateId: 'review-chapter', name: '十判据', input: INPUT });
    h.lifecycle.dispatch('start', created.task.id);
    await h.engine.drain();

    const read = h.uow.repositories.slotReviews
      .listByRound(created.task.id, 'scene_01', 0)
      .map((r) => r.criterionId);

    expect(read).toEqual(IDS);
    // 反面：字符串排序会是这个样子
    expect(read).not.toEqual(['S1', 'S10', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'S9']);
  });

  /*
   * 排的是**书写顺序**，不是数字顺序。两者在上一条用例里恰好重合，所以那条
   * 单独立不住——按数字排（`CAST(SUBSTR(criterion_id,2) AS INTEGER)`）同样能让它绿。
   *
   * SKILL.md 没有任何地方要求判据按数字递增书写，而 §4.3 明确「保持文件中的
   * 出现顺序——注入顺序对模型的理解有影响」。所以这里用一份**故意打乱数字顺序**
   * 的 Skill：文件里写作 S3、S1、S10、S2，模型就该按这个顺序被问，
   * findings 也该按这个顺序喂回去。
   */
  it('排的是书写顺序而非数字顺序：乱序书写的 Skill 按原样读回', async () => {
    const written = ['S3', 'S1', 'S10', 'S2'];
    const scrambled = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-scr-')), 'skills');
    fs.cpSync(path.join(import.meta.dirname, '../fixtures/skills'), scrambled, { recursive: true });
    fs.writeFileSync(
      path.join(scrambled, 'scene-review', 'SKILL.md'),
      `---
id: scene-review
version: 1.0.0
operation: review_slot
slotTypes: [scene]
summary: 按判据审核场景正文
requiredSections: [S1]
---

# 场景审核 Skill

你是场景审核 Agent。只审被指定的判据，不审其他判据。

${written.map((id) => `## ${id}. 判据 ${id} 的标题\n\n判据 ${id} 的正文，用来占位。\n`).join('\n')}`,
    );

    harness = createEngineHarness({
      provider: new FakeProvider({
        turns: [
          ...scriptTo([]),
          ...written.map(() => ({ submitReview: { slotId: 'scene_01', verdict: 'no_finding' as const } })),
        ],
      }),
      skillsDir: scrambled,
    });
    const created = await harness.snapshots.createTask({
      templateId: 'review-chapter',
      name: '乱序判据',
      input: INPUT,
    });
    harness.lifecycle.dispatch('start', created.task.id);
    await harness.engine.drain();

    const read = harness.uow.repositories.slotReviews
      .listByRound(created.task.id, 'scene_01', 0)
      .map((r) => r.criterionId);

    expect(read).toEqual(written);
    // 反面：按数字排会是这个样子，那就与注入模型的顺序对不上了
    expect(read).not.toEqual(['S1', 'S2', 'S3', 'S10']);
  });
});
