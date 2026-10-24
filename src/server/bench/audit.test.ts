import { describe, expect, it } from 'vitest';
import { applyAudit, validateAudit } from '../../../bench/audit.ts';

const samples = [{ id: 's1', output: '我把杯子放下。她没有回头。' }];

describe('quality audit', () => {
  it('逐字引文存在时保留 reject，样本不从报告消失', () => {
    const output = applyAudit(
      { run_id: 's4', samples },
      {
        schemaVersion: 1,
        findings: [
          { sampleId: 's1', criterionId: 'density', verdict: 'reject', quote: '她没有回头。', reason: '重复表达' },
        ],
      },
    );
    expect((output['samples'] as unknown[]).length).toBe(1);
    expect(JSON.stringify(output)).toContain('reject');
  });

  it('编造引文与不存在样本都明确失败', () => {
    expect(
      validateAudit(samples, {
        schemaVersion: 1,
        findings: [
          { sampleId: 's1', criterionId: 'density', verdict: 'reject', quote: '不存在', reason: '理由' },
          { sampleId: 's2', criterionId: 'density', verdict: 'accept', quote: '任意', reason: '理由' },
        ],
      }),
    ).toEqual([
      's1/density: quote 不逐字存在于样本输出',
      's2/density: 样本不存在',
    ]);
  });
});
