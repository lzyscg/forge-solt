import { describe, expect, it } from 'vitest';
import type { RawFinding } from './review-evidence.ts';
import { verifyFindings } from './review-evidence.ts';

describe('引文校验（D-25）', () => {
  // 行为表第 1 行：逐字命中 → kept
  it('逐字命中 → kept', () => {
    const content = '他走出了房间。';
    const findings: RawFinding[] = [
      { criterionId: 'S1', quote: '他走出了房间', problem: '首段未承接上一场结尾' },
    ];
    const result = verifyFindings(content, findings);
    expect(result.kept).toHaveLength(1);
    expect(result.kept[0]!.criterionId).toBe('S1');
    expect(result.discardedCount).toBe(0);
  });

  // 行为表第 2 行：仅在归一化后命中 → kept
  it('仅在归一化后命中 → kept（模型把弯引号写成直引号，定位是准的）', () => {
    // 正文用弯引号“”，模型给的 quote 用直单引号''
    const content = '他说“你好”。';
    const findings: RawFinding[] = [
      { criterionId: 'S1', quote: "他说'你好'", problem: '问题说明' },
    ];
    const result = verifyFindings(content, findings);
    expect(result.kept).toHaveLength(1);
    expect(result.discardedCount).toBe(0);
  });

  // 行为表第 3 行：归一化后仍不命中 → discarded
  it('归一化后仍不命中 → discarded', () => {
    const content = '天气晴朗。';
    const findings: RawFinding[] = [
      { criterionId: 'S1', quote: '下雨了', problem: '问题说明' },
    ];
    const result = verifyFindings(content, findings);
    expect(result.kept).toHaveLength(0);
    expect(result.discardedCount).toBe(1);
  });

  // 行为表第 4 行：空串 quote → discarded
  it('空串 quote → discarded（空串 includes 恒真，必须显式拦）', () => {
    const content = '任何内容。';
    const findings: RawFinding[] = [
      { criterionId: 'S1', quote: '', problem: '问题说明' },
    ];
    const result = verifyFindings(content, findings);
    expect(result.kept).toHaveLength(0);
    expect(result.discardedCount).toBe(1);
  });

  // 补 1：全空白 quote 归一化后也是空串，同样必须丢弃。
  // 钉死「判空在归一化之后」这个语义：若有人把判空移到归一化之前，
  // 全空白 quote 会绕过拦截，includes('') 恒真，静默进 kept。
  it('全空白 quote → discarded（归一化后为空串，includes 同样恒真）', () => {
    const content = '任何内容。';
    const findings: RawFinding[] = [
      { criterionId: 'S1', quote: '  \n\t ', problem: '问题说明' },
    ];
    const result = verifyFindings(content, findings);
    expect(result.kept).toHaveLength(0);
    expect(result.discardedCount).toBe(1);
  });

  // 行为表第 5 行：空数组 → kept=[], discardedCount=0
  it('空数组 → kept=[], discardedCount=0', () => {
    const result = verifyFindings('任何内容。', []);
    expect(result.kept).toEqual([]);
    expect(result.discardedCount).toBe(0);
  });

  // 反证第 5 条：kept 必须存模型原文，不存归一化后的串
  it('kept 里存模型原文，不存归一化后的串', () => {
    // 正文用弯引号“”，模型给的 quote 用直单引号''
    // 归一化后都变成 " 所以命中
    // 但 kept 里必须存原文（带 '），不能存归一化后的（带 "）
    const content = '他说“你好”。';
    const findings: RawFinding[] = [
      { criterionId: 'S1', quote: "他说'你好'", problem: '问题说明' },
    ];
    const result = verifyFindings(content, findings);
    expect(result.kept).toHaveLength(1);
    expect(result.kept[0]!.quote).toBe("他说'你好'");
  });

  it('混合：部分命中部分丢弃，discardedCount 正确', () => {
    const content = '他走了出门。天气晴朗。';
    const findings: RawFinding[] = [
      { criterionId: 'S1', quote: '他走了出门', problem: '问题一' },
      { criterionId: 'S2', quote: '下雨了', problem: '问题二' },
      { criterionId: 'S3', quote: '', problem: '问题三' },
    ];
    const result = verifyFindings(content, findings);
    expect(result.kept).toHaveLength(1);
    expect(result.kept[0]!.criterionId).toBe('S1');
    expect(result.discardedCount).toBe(2);
  });

  it('空白折叠为空（删除，不是替换成空格）：quote 带空白，正文不带', () => {
    const content = '他说你好。';
    const findings: RawFinding[] = [
      { criterionId: 'S1', quote: '他 说\n你好', problem: '问题说明' },
    ];
    const result = verifyFindings(content, findings);
    expect(result.kept).toHaveLength(1);
  });

  it('空白折叠为空：正文带空白，quote 不带', () => {
    const content = '他 说\n你好。';
    const findings: RawFinding[] = [
      { criterionId: 'S1', quote: '他说你好', problem: '问题说明' },
    ];
    const result = verifyFindings(content, findings);
    expect(result.kept).toHaveLength(1);
  });
});
