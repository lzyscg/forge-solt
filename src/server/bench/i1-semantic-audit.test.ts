import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { validateAndProjectSemanticAudit } from '../../../bench/i1-semantic-audit.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const CRITERIA = ['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'D1', 'D2', 'D3'];

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-semantic-audit-'));
  dirs.push(dir);
  const source = '1、合成起因\n记录员打开虚构档案并发现编号错误。\n2、合成结局\n记录员修正编号并归档。';
  fs.writeFileSync(path.join(dir, 'source.txt'), source);
  const manifestPath = path.join(dir, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify({
    pathBase: 'manifest-directory',
    cases: [{ caseId: 'case-a', sourcePath: 'source.txt' }],
  }));
  const runPath = path.join(dir, 'run.json');
  fs.writeFileSync(runPath, JSON.stringify({
    samples: [{
      id: 'case-a-baseline-r1', case_id: 'case-a', status: 'success',
      output: '1. 合成变化\n变化：记录有误 → 编号修正\n结束状态：记录员完成归档',
    }],
  }));
  return { dir, source, manifestPath, runPath };
}

function validReviews() {
  return CRITERIA.map((criterion) => ({
    criterion,
    verdict: criterion === 'D2' ? 'fail' : 'pass',
    severity: criterion === 'D2' ? 'minor' : 'none',
    reasonCode: criterion === 'D2' ? 'FIELD_REDUNDANCY' : 'NO_ISSUE',
    reason: criterion === 'D2' ? '变化和结束状态局部重复。' : '未发现明确违反。',
    evidence: criterion === 'D2' ? [{
      sourceSectionRef: 'source-section-02',
      sourceQuote: '记录员修正编号并归档',
      unitId: 'unit_02',
      outlineQuote: '结束状态：记录员完成归档',
    }] : [],
  }));
}

describe('i1 semantic audit', () => {
  it('验证双侧引文与 criterion 覆盖，并只公开枚举摘要', () => {
    const { dir, manifestPath, runPath } = setup();
    const auditInputPath = path.join(dir, 'private-audit.json');
    fs.writeFileSync(auditInputPath, JSON.stringify({
      schemaVersion: 1,
      samples: [{ kind: 'content_review', sampleId: 'case-a-baseline-r1', reviews: validReviews() }],
    }));
    const publicOut = path.join(dir, 'public.json');

    validateAndProjectSemanticAudit({ runPath, manifestPath, auditInputPath, publicOut });

    const output = fs.readFileSync(publicOut, 'utf8');
    expect(output).toContain('FIELD_REDUNDANCY');
    expect(output).toContain('privateAuditHash');
    expect(output).not.toContain('记录员修正编号并归档');
    expect(output).not.toContain('变化和结束状态局部重复');
  });

  it('引文不匹配或 criterion 缺失时拒绝且不写公开文件', () => {
    const { dir, manifestPath, runPath } = setup();
    const auditInputPath = path.join(dir, 'invalid-audit.json');
    const reviews = validReviews().slice(0, -1);
    reviews.find((review) => review.criterion === 'D2')!.evidence[0]!.sourceQuote = '原文里不存在的引文';
    fs.writeFileSync(auditInputPath, JSON.stringify({
      schemaVersion: 1,
      samples: [{ kind: 'content_review', sampleId: 'case-a-baseline-r1', reviews }],
    }));
    const publicOut = path.join(dir, 'public.json');

    expect(() => validateAndProjectSemanticAudit({ runPath, manifestPath, auditInputPath, publicOut }))
      .toThrow(/criterion|quote/);
    expect(fs.existsSync(publicOut)).toBe(false);
  });
});
