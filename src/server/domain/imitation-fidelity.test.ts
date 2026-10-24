import { describe, expect, it } from 'vitest';
import { auditImitation, profileFidelityText, toPublicFidelitySummary } from './imitation-fidelity.ts';

const source = [
  '我先用一句话交代处境。',
  '1',
  '我说：「现在走。」',
  '2',
  '她拒绝。',
  '3',
  '这一节承载完整冲突，因此会明显更长。'.repeat(20),
].join('\n');

const uniformDraft = [
  '标题',
  '1.',
  '我在灯下缓缓抬起指尖，盯着窗外。'.repeat(10),
  '2.',
  '我在灯下缓缓抬起指尖，盯着窗外。'.repeat(10),
  '3.',
  '我在灯下缓缓抬起指尖，盯着窗外。警方调取监控，17天后立案。'.repeat(10),
].join('\n');

describe('ImitationFidelityAudit', () => {
  it('计算分节离散度、对白占比和镜头载体，不生成总分', () => {
    const profile = profileFidelityText(source);
    expect(profile.numberedSections).toBe(3);
    expect(profile.prefaceHan).toBeGreaterThan(0);
    expect(profile.sectionHan).toHaveLength(3);
    expect(profile.sectionCoefficientOfVariation).toBeGreaterThan(0.8);
    expect(profile.quotedHan).toBeGreaterThan(0);
    expect(profile.quotedHanShare).toBeGreaterThan(0);
    expect(profile.cameraTermsPer10k['指尖']).toBe(0);
    expect(profile).not.toHaveProperty('score');
  });

  it('同时识别数字独占行和带标题的数字分节', () => {
    const profile = profileFidelityText([
      '引子。',
      '1. 开端',
      '第一节内容。',
      '2、转折',
      '第二节内容。',
      '3',
      '第三节内容。',
    ].join('\n'));

    expect(profile.numberedSections).toBe(3);
    expect(profile.sectionHan).toEqual([5, 5, 5]);
  });

  it('检出均匀铺开、长度膨胀和未授权数字/程序机制，并归到最早责任层', () => {
    const audit = auditImitation({ source, draft: uniformDraft });
    expect(audit.findings.map((finding) => finding.kind)).toEqual(expect.arrayContaining([
      'uniform-expansion', 'length-expansion', 'novel-number', 'novel-procedure',
    ]));
    expect(audit.findings.find((finding) => finding.kind === 'uniform-expansion')?.responsibility).toBe('outline');
    expect(audit.findings.find((finding) => finding.kind === 'length-expansion')?.responsibility).toBe('plan');
    expect(audit.findings.filter((finding) => finding.kind === 'novel-procedure').every((finding) => finding.responsibility === 'integrity')).toBe(true);
  });

  it('公开投影删除私有逐字证据和镜头词明细，只保留 hash 与聚合计数', () => {
    const audit = auditImitation({ source, outline: '1. 规划\n目标：推进', draft: uniformDraft });
    const summary = toPublicFidelitySummary(audit);
    const encoded = JSON.stringify(summary);
    expect(summary.sourceHash).toHaveLength(64);
    expect(summary.draftHash).toHaveLength(64);
    expect(encoded).not.toContain('17天');
    expect(encoded).not.toContain('警方');
    expect(encoded).not.toContain('指尖');
    expect(encoded).not.toContain('draftEvidence');
    expect(summary.findingCounts['novel-procedure']).toBeGreaterThan(0);
  });

  it('没有 draft 时仍可建立 source/outline 基线', () => {
    const audit = auditImitation({ source, outline: '1. 起点\n目标：建立状态' });
    expect(audit.draft).toBeNull();
    expect(audit.comparison.expansionRatio).toBeNull();
    expect(audit.findings).toEqual([]);
  });
});
