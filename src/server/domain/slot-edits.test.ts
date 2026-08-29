/**
 * `applySlotEdits` 的用例。
 *
 * 每一条都对应设计文档里的一条决议或一次实测观察，不是为覆盖率凑的：
 * 归一化与引文闸门同源（D-62）、唯一性、半篇上限（D-65 配套）、
 * 全有或全无、以及「不写进清单的段落逐字不变」——最后这条是整个特性
 * 存在的理由（构造性保证），必须有一条测试直接钉住它。
 */

import { describe, expect, it } from 'vitest';
import { applySlotEdits } from './slot-edits.ts';
import { verifyFindings } from './review-evidence.ts';

const DRAFT = [
  '赵敏蹲在老人面前那一会儿，配药间里的灯光斜着照出来。',
  '她起身时把那只袋子往老人怀里又拢了拢，转身走回处置台。',
  '走廊尽头的呼铃换了个调子，也没人去理。',
].join('\n');

describe('applySlotEdits', () => {
  it('只改被点名的那一句，其余逐字不变', () => {
    const result = applySlotEdits(DRAFT, [
      { oldText: '往老人怀里又拢了拢', newText: '在老人手心里按了按' },
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.content).toContain('在老人手心里按了按');
    // 这三条是整个特性的全部意义：没进清单的段落**在机械上**不可能被改
    expect(result.content).toContain('赵敏蹲在老人面前那一会儿，配药间里的灯光斜着照出来。');
    expect(result.content).toContain('走廊尽头的呼铃换了个调子，也没人去理。');
    expect(result.content.split('\n')).toHaveLength(3);
  });

  it('多条编辑按原文位置应用，互不干扰', () => {
    const result = applySlotEdits(DRAFT, [
      // 刻意乱序给：应用顺序由原文位置决定，不由清单顺序决定
      { oldText: '走廊尽头的呼铃换了个调子', newText: '呼铃从干响变成低哑' },
      { oldText: '配药间里的灯光斜着照出来', newText: '配药间的灯斜切进来' },
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.content).toContain('配药间的灯斜切进来');
    expect(result.content).toContain('呼铃从干响变成低哑');
    expect(result.content).toContain('她起身时把那只袋子往老人怀里又拢了拢');
  });

  /**
   * D-62：归一化与 `review-evidence.ts` 同源。
   *
   * 这条用同一段文本**同时**过引文闸门和编辑清单：审核认得的引文，
   * 返修就必须也认得。两边一旦漂移，症状是「审核引了这句、返修说找不到」，
   * 而模型对着一条自相矛盾的反馈无从修起。
   */
  it('引号与空白的归一化与引文闸门认的是同一套', () => {
    // 正文要够长：否则半篇上限会先拦下来，测不到归一化那一层
    const draft =
      '周医生站在处置台后面没动。\n他说“我没有这么说过”，然后把门带上。\n走廊里那声铃还在响，谁都没去关它。';
    const quoted = '他说"我没有这么说过"，   然后把门带上'; // 直角引号 + 多余空白

    const verified = verifyFindings(draft, [
      { criterionId: 'S1', quote: quoted, problem: '示例' },
    ]);
    expect(verified.kept).toHaveLength(1);

    const result = applySlotEdits(draft, [{ oldText: quoted, newText: '他没接话，把门带上' }]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.content).toContain('他没接话，把门带上。');
    expect(result.content).toContain('周医生站在处置台后面没动。');
  });

  it('oldText 找不到 → 整份拒绝，并告诉模型要原样复制', () => {
    const result = applySlotEdits(DRAFT, [
      { oldText: '往老人怀里又拢了拢', newText: 'A' },
      { oldText: '这句话原文里根本没有', newText: 'B' },
    ]);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]?.rule).toBe('edit_old_text_not_found');
    expect(result.violations[0]?.editIndex).toBe(2);
    expect(result.violations[0]?.agentHint).toContain('原样复制');
  });

  it('全有或全无：一条不合格，合格的那条也不生效', () => {
    const result = applySlotEdits(DRAFT, [
      { oldText: '往老人怀里又拢了拢', newText: '改好的' },
      { oldText: '不存在的句子', newText: 'B' },
    ]);
    expect(result.ok).toBe(false);
  });

  it('oldText 不唯一 → 拒绝，要求加长到唯一', () => {
    const draft = '他停下来。他停下来。';
    const result = applySlotEdits(draft, [{ oldText: '他停下来', newText: '他站住' }]);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.violations[0]?.rule).toBe('edit_old_text_ambiguous');
    expect(result.violations[0]?.agentHint).toContain('唯一');
  });

  /**
   * D-65 配套。不设这条上限，模型可以把整篇塞进一条 oldText 里假装是定点修改——
   * 那比诚实地整篇提交更糟，因为它伪装成了定点修改，在轨迹上看不出来。
   */
  it('一条编辑覆盖过半 → 拒绝，并指路 slot_content', () => {
    const result = applySlotEdits(DRAFT, [{ oldText: DRAFT.slice(0, 40), newText: '短' }]);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.violations[0]?.rule).toBe('edit_old_text_oversized');
    expect(result.violations[0]?.agentHint).toContain('slot_content');
  });

  it('两条编辑指向重叠的原文 → 拒绝（先后顺序会决定结果，那不可预期）', () => {
    const result = applySlotEdits(DRAFT, [
      { oldText: '往老人怀里又拢了拢', newText: 'A' },
      { oldText: '怀里又拢了拢，转身走回处置台', newText: 'B' },
    ]);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.violations[0]?.rule).toBe('edit_old_text_ambiguous');
  });

  it('空清单 → 拒绝（schema 也拦，这里是域层的第二道）', () => {
    const result = applySlotEdits(DRAFT, []);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.violations[0]?.rule).toBe('edit_list_empty');
  });

  it('newText 可以为空 —— 那是「删掉这一句」', () => {
    const result = applySlotEdits(DRAFT, [
      { oldText: '走廊尽头的呼铃换了个调子，也没人去理。', newText: '' },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.content).not.toContain('呼铃');
    expect(result.content).toContain('她起身时把那只袋子往老人怀里又拢了拢');
  });

  it('touchedChars 数的是归一化后被覆盖的字数，用于 D-64 的轨迹', () => {
    const result = applySlotEdits(DRAFT, [{ oldText: '往老人怀里又拢了拢', newText: 'x' }]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.touchedChars).toBe(9);
  });
});
