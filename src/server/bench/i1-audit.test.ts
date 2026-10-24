import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runI1Audit } from '../../../bench/i1-audit.ts';

const temporaries: string[] = [];
afterEach(() => {
  for (const dir of temporaries.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('I1 audit', () => {
  it('rejects public audit content that overlaps a private source before writing either output', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-i1-audit-'));
    temporaries.push(dir);
    const leakedCaseId = '私有原文连续十四个汉字不能出现在公开报告';
    fs.writeFileSync(path.join(dir, 'source.txt'), `1\n${leakedCaseId}。\n2\n结局。\n`);
    const manifestPath = path.join(dir, 'manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify({
      pathBase: 'manifest-directory',
      cases: [{ caseId: leakedCaseId, sourcePath: 'source.txt' }],
    }));
    const runPath = path.join(dir, 'run.json');
    fs.writeFileSync(runPath, JSON.stringify({
      samples: [{
        id: 'sample-1',
        case_id: leakedCaseId,
        variant: 'baseline',
        status: 'success',
        output: '1. 规划',
      }],
    }));
    const privateOut = path.join(dir, 'audit.private.json');
    const publicOut = path.join(dir, 'audit.public.json');

    expect(() => runI1Audit({ runPath, manifestPath, privateOut, publicOut }))
      .toThrow(/公开 I1 audit.*私有原文/);
    expect(fs.existsSync(privateOut)).toBe(false);
    expect(fs.existsSync(publicOut)).toBe(false);
  });

  it('fails closed when a successful variant exceeds the private-source overlap limit', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-i1-audit-'));
    temporaries.push(dir);
    const copied = '这是私有原文中不能复制到公开大纲的连续内容';
    fs.writeFileSync(path.join(dir, 'source.txt'), `1\n${copied.repeat(8)}\n2\n结局。\n`);
    const manifestPath = path.join(dir, 'manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify({
      pathBase: 'manifest-directory',
      cases: [{ caseId: 'case-overlap', sourcePath: 'source.txt' }],
    }));
    const runPath = path.join(dir, 'run.json');
    fs.writeFileSync(runPath, JSON.stringify({
      samples: [{
        id: 'case-overlap-variant-r1',
        case_id: 'case-overlap',
        variant: 'variant',
        status: 'success',
        output: copied.repeat(8),
      }],
    }));
    const privateOut = path.join(dir, 'audit.private.json');
    const publicOut = path.join(dir, 'audit.public.json');

    runI1Audit({ runPath, manifestPath, privateOut, publicOut });

    const privateAudit = JSON.parse(fs.readFileSync(privateOut, 'utf8')) as {
      rows: { sourceOverlapPassed: boolean; planCompiled: boolean; violations: { rule: string }[] }[];
    };
    const publicAudit = JSON.parse(fs.readFileSync(publicOut, 'utf8')) as {
      variantSourceOverlapPassed: number;
      variantCompiled: number;
      variantCompileRate: number;
    };
    expect(privateAudit.rows[0]).toMatchObject({
      sourceOverlapPassed: false,
      planCompiled: false,
      violations: [{ rule: 'source_overlap' }],
    });
    expect(publicAudit).toMatchObject({
      variantSourceOverlapPassed: 0,
      variantCompiled: 0,
      variantCompileRate: 0,
    });
  });

  it('counts failed variant samples in the compile-rate denominator', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-i1-audit-'));
    temporaries.push(dir);
    fs.writeFileSync(path.join(dir, 'source.txt'), '1\n起因。\n2\n结局。\n');
    const manifestPath = path.join(dir, 'manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify({
      pathBase: 'manifest-directory',
      cases: [{ caseId: 'case-failed', sourcePath: 'source.txt' }],
    }));
    const runPath = path.join(dir, 'run.json');
    fs.writeFileSync(runPath, JSON.stringify({
      samples: [{
        id: 'case-failed-variant-r1',
        case_id: 'case-failed',
        variant: 'variant',
        status: 'failure',
        output: 'partial output must not count as compiled',
      }],
    }));
    const privateOut = path.join(dir, 'audit.private.json');
    const publicOut = path.join(dir, 'audit.public.json');

    runI1Audit({ runPath, manifestPath, privateOut, publicOut });

    const privateAudit = JSON.parse(fs.readFileSync(privateOut, 'utf8')) as {
      rows: { planCompiled: boolean; violations: { rule: string }[] }[];
    };
    const publicAudit = JSON.parse(fs.readFileSync(publicOut, 'utf8')) as {
      variantSamples: number;
      variantSuccessful: number;
      variantFailed: number;
      variantCompiled: number;
      variantCompileRate: number;
    };
    expect(privateAudit.rows[0]).toMatchObject({
      planCompiled: false,
      violations: [{ rule: 'sample_status' }],
    });
    expect(publicAudit).toMatchObject({
      variantSamples: 1,
      variantSuccessful: 0,
      variantFailed: 1,
      variantCompiled: 0,
      variantCompileRate: 0,
    });
  });

  it('rejects colliding private and public output paths before writing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-i1-audit-'));
    temporaries.push(dir);
    fs.writeFileSync(path.join(dir, 'source.txt'), '1\n起因。\n2\n结局。\n');
    const manifestPath = path.join(dir, 'manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify({
      pathBase: 'manifest-directory',
      cases: [{ caseId: 'case-same-path', sourcePath: 'source.txt' }],
    }));
    const runPath = path.join(dir, 'run.json');
    fs.writeFileSync(runPath, JSON.stringify({
      samples: [{
        id: 'case-same-path-baseline-r1',
        case_id: 'case-same-path',
        variant: 'baseline',
        status: 'success',
        output: '1. 规划',
      }],
    }));
    const sharedOut = path.join(dir, 'audit.json');

    expect(() => runI1Audit({
      runPath,
      manifestPath,
      privateOut: sharedOut,
      publicOut: sharedOut,
    })).toThrow(/私有与公开.*不同/);
    expect(fs.existsSync(sharedOut)).toBe(false);
  });

  it('rejects samples outside the baseline and variant conditions', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-i1-audit-'));
    temporaries.push(dir);
    fs.writeFileSync(path.join(dir, 'source.txt'), '1\n起因。\n2\n结局。\n');
    const manifestPath = path.join(dir, 'manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify({
      pathBase: 'manifest-directory',
      cases: [{ caseId: 'case-r0', sourcePath: 'source.txt' }],
    }));
    const runPath = path.join(dir, 'run.json');
    fs.writeFileSync(runPath, JSON.stringify({
      samples: [{
        id: 'case-r0-r1',
        case_id: 'case-r0',
        variant: 'r0',
        status: 'success',
        output: '1. 规划',
      }],
    }));
    const privateOut = path.join(dir, 'audit.private.json');
    const publicOut = path.join(dir, 'audit.public.json');

    expect(() => runI1Audit({ runPath, manifestPath, privateOut, publicOut }))
      .toThrow(/baseline|variant/);
    expect(fs.existsSync(privateOut)).toBe(false);
    expect(fs.existsSync(publicOut)).toBe(false);
  });

  it('recognizes numbered source headings with titles', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-i1-audit-'));
    temporaries.push(dir);
    fs.writeFileSync(
      path.join(dir, 'source.txt'),
      '1. 起因\n第一节内容。\n2、结局\n第二节内容。\n',
    );
    const manifestPath = path.join(dir, 'manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify({
      pathBase: 'manifest-directory',
      cases: [{ caseId: 'case-titled-headings', sourcePath: 'source.txt' }],
    }));
    const runPath = path.join(dir, 'run.json');
    fs.writeFileSync(runPath, JSON.stringify({
      samples: [{
        id: 'case-titled-headings-baseline-r1',
        case_id: 'case-titled-headings',
        variant: 'baseline',
        status: 'success',
        output: '1. 规划',
      }],
    }));
    const privateOut = path.join(dir, 'audit.private.json');
    const publicOut = path.join(dir, 'audit.public.json');

    runI1Audit({ runPath, manifestPath, privateOut, publicOut });

    const privateAudit = JSON.parse(fs.readFileSync(privateOut, 'utf8')) as {
      rows: { sourceSections: number }[];
    };
    expect(privateAudit.rows[0]?.sourceSections).toBe(2);
  });

  it('audits a baseline-only v2 run as the evaluated condition', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-i1-audit-'));
    temporaries.push(dir);
    const source = Array.from({ length: 8 }, (_, index) =>
      `${index + 1}、合成${index + 1}\n${'记录员核对虚构条目。'.repeat(index + 1)}`,
    ).join('\n');
    fs.writeFileSync(path.join(dir, 'source.txt'), source);
    const manifestPath = path.join(dir, 'manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify({
      pathBase: 'manifest-directory',
      cases: [{ caseId: 'case-v2', sourcePath: 'source.txt' }],
    }));
    let priorityId = 0;
    const outline = Array.from({ length: 8 }, (_, index) => {
      const priorityKind = index === 2 || index === 7 ? 'P0' : index % 2 === 0 ? 'P1' : 'bridge';
      const priority = priorityKind === 'bridge'
        ? 'bridge'
        : `${priorityKind} P${String(++priorityId).padStart(3, '0')}`;
      const expansion = index < 3 ? '轻过渡' : index > 4 ? '细写' : '标准';
      return `${index + 1}. 合成变化${index + 1}\n变化：状态${index} → 状态${index + 1}\n重点：${priority}\n展开：${expansion}\n模式：自定义\n容量：对白轮次 1；动作反馈闭环 1；认知转折 0；事后余波 ${index === 7 ? 1 : 0}\n出场：记录员\n目标：核对条目\n冲突：记录不一致\n结束状态：完成核对`;
    }).join('\n\n');
    const runPath = path.join(dir, 'run.json');
    fs.writeFileSync(runPath, JSON.stringify({
      experiment_identity: { contracts: [{ contractHash: 'a'.repeat(64), storyBudget: { minHan: 8000, targetHan: 10000, maxHan: 12000 } }] },
      samples: [{ id: 'case-v2-baseline-r1', case_id: 'case-v2', variant: 'baseline', status: 'success', output: outline }],
    }));
    const privateOut = path.join(dir, 'audit.private.json');
    const publicOut = path.join(dir, 'audit.public.json');

    runI1Audit({ runPath, manifestPath, privateOut, publicOut });

    const publicAudit = JSON.parse(fs.readFileSync(publicOut, 'utf8')) as Record<string, unknown>;
    expect(publicAudit).toMatchObject({
      schemaVersion: 2,
      gate: 'mechanical_privacy_gate',
      qualityClaim: 'not_evaluated',
      evaluatedSamples: 1,
      evaluatedSuccessful: 1,
      evaluatedCompiled: 1,
      evaluatedCompileRate: 1,
    });
  });

  it('does not count failed zero-section samples as exact section matches', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-i1-audit-'));
    temporaries.push(dir);
    fs.writeFileSync(path.join(dir, 'source.txt'), '没有数字分节的输入。');
    const manifestPath = path.join(dir, 'manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify({
      pathBase: 'manifest-directory',
      cases: [{ caseId: 'case-no-sections', sourcePath: 'source.txt' }],
    }));
    const runPath = path.join(dir, 'run.json');
    fs.writeFileSync(runPath, JSON.stringify({
      samples: [{
        id: 'case-no-sections-variant-r1',
        case_id: 'case-no-sections',
        variant: 'variant',
        status: 'failure',
        output: '',
      }],
    }));
    const privateOut = path.join(dir, 'audit.private.json');
    const publicOut = path.join(dir, 'audit.public.json');

    runI1Audit({ runPath, manifestPath, privateOut, publicOut });

    const publicAudit = JSON.parse(fs.readFileSync(publicOut, 'utf8')) as {
      exactSectionCount: number;
    };
    expect(publicAudit.exactSectionCount).toBe(0);
  });
});
