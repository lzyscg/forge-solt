#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { compileNarrativePlan, type NarrativeExpansion } from '../src/server/domain/narrative-plan.ts';
import { profileFidelityText } from '../src/server/domain/imitation-fidelity.ts';
import { compareI1Distribution } from '../src/server/bench/i1-distribution.ts';
import { sourceContainment } from '../src/server/domain/source-overlap.ts';
import { loadPrivateTaskInputManifest } from './private-task-inputs.ts';

const I1RunSchema = z.object({
  experiment_identity: z.object({
    contracts: z.array(z.object({
      contractHash: z.string().nullable(),
      storyBudget: z.object({
        minHan: z.number().int().positive(),
        targetHan: z.number().int().positive(),
        maxHan: z.number().int().positive(),
      }).strict().nullable(),
    }).passthrough()),
  }).passthrough().optional(),
  samples: z.array(z.object({
    id: z.string().min(1),
    case_id: z.string().min(1),
    variant: z.enum(['baseline', 'variant']),
    status: z.string().min(1),
    output: z.string(),
  }).passthrough()),
}).passthrough();

const MAX_SOURCE_CONTAINMENT = 0.05;

export interface I1AuditArgs {
  readonly runPath: string;
  readonly manifestPath: string;
  readonly privateOut: string;
  readonly publicOut: string;
}

function expectedExpansions(lengths: readonly number[]): NarrativeExpansion[] {
  const ordered = [...lengths].sort((left, right) => left - right);
  const at = (q: number) => ordered[Math.floor((ordered.length - 1) * q)] ?? 0;
  const q30 = at(0.3), q70 = at(0.7);
  return lengths.map((value) => value <= q30 ? 'light' : value >= q70 ? 'detailed' : 'standard');
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const ordered = [...values].sort((left, right) => left - right);
  const middle = ordered.length >> 1;
  return ordered.length % 2 ? ordered[middle]! : (ordered[middle - 1]! + ordered[middle]!) / 2;
}

export function runI1Audit(args: I1AuditArgs): void {
  const { runPath, manifestPath, privateOut, publicOut } = args;
  const absolutePrivateOut = path.resolve(privateOut);
  const absolutePublicOut = path.resolve(publicOut);
  if (absolutePrivateOut === absolutePublicOut) {
    throw new Error('私有与公开 audit 输出路径必须不同');
  }
  const run = I1RunSchema.parse(
    JSON.parse(fs.readFileSync(path.resolve(runPath), 'utf8')),
  );
  const manifest = loadPrivateTaskInputManifest(manifestPath);
  const contractBudget = run.experiment_identity?.contracts.find((contract) => contract.contractHash !== null)?.storyBudget;
  const auditBudget = contractBudget ?? { minHan: 7876, targetHan: 10128, maxHan: 15850 };
  const sources = new Map(
    manifest.cases.map((entry) => [entry.caseId, fs.readFileSync(entry.sourcePath, 'utf8')]),
  );
  const privateRows = run.samples.map((sample) => {
    const source = sources.get(sample.case_id);
    if (source === undefined) throw new Error(`manifest 缺 ${sample.case_id}`);
    const lengths = profileFidelityText(source).sectionHan;
    const expected = expectedExpansions(lengths);
    const sourceOverlap = sourceContainment(sample.output, source);
    const v2 = run.experiment_identity?.contracts.some((contract) => contract.contractHash !== null) ?? false;
    if (sample.variant === 'baseline' && !v2) {
      return {
        id: sample.id, caseId: sample.case_id, condition: sample.variant, status: sample.status,
        sourceSections: lengths.length, outlineSections: (sample.output.match(/^\s*\d{1,3}[.．、]\s*\S/gmu) ?? []).length,
        sourceOverlap,
        sourceOverlapPassed: sample.status === 'success'
          ? sourceOverlap <= MAX_SOURCE_CONTAINMENT
          : null,
        planCompiled: false, note: 'baseline 是 outline v1，不具备 I1 字段',
      };
    }
    if (sample.status !== 'success') {
      return {
        id: sample.id, caseId: sample.case_id, condition: sample.variant, status: sample.status,
        sourceSections: lengths.length, outlineSections: 0, sourceOverlap, sourceOverlapPassed: null,
        planCompiled: false,
        violations: [{ rule: 'sample_status', message: '样本未成功提交，不进入 NarrativePlan 编译' }],
      };
    }
    if (sourceOverlap > MAX_SOURCE_CONTAINMENT) {
      return {
        id: sample.id, caseId: sample.case_id, condition: sample.variant, status: sample.status,
        sourceSections: lengths.length,
        outlineSections: (sample.output.match(/^\s*\d{1,3}[.．、]\s*\S/gmu) ?? []).length,
        sourceOverlap,
        sourceOverlapPassed: false,
        planCompiled: false,
        violations: [{ rule: 'source_overlap', message: `与私有原文重合度 ${sourceOverlap.toFixed(4)} 超过 ${MAX_SOURCE_CONTAINMENT}` }],
      };
    }
    const compiled = compileNarrativePlan({
      outlineMarkdown: sample.output,
      storyBudget: auditBudget,
    });
    if (!compiled.ok) {
      return {
        id: sample.id, caseId: sample.case_id, condition: sample.variant, status: sample.status,
        sourceSections: lengths.length, outlineSections: (sample.output.match(/^\s*\d{1,3}[.．、]\s*\S/gmu) ?? []).length,
        sourceOverlap, sourceOverlapPassed: true,
        planCompiled: false, violations: compiled.violations,
      };
    }
    const actual = compiled.plan.units.map((unit) => unit.expansion);
    const comparable = actual.length > 0 && actual.length === expected.length;
    const agreement = comparable
      ? actual.filter((value, index) => value === expected[index]).length / actual.length
      : null;
    const targetHan = compiled.plan.units.map((unit) => unit.budget.targetHan);
    const comparison = comparable
      ? compareI1Distribution({ sourceHan: lengths, variantTargetHan: targetHan })
      : null;
    return {
      id: sample.id, caseId: sample.case_id, condition: sample.variant, status: sample.status,
      sourceSections: lengths.length, outlineSections: actual.length,
      sourceOverlap, sourceOverlapPassed: true, planCompiled: true,
      expectedExpansions: expected, actualExpansions: actual,
      expansionKinds: [...new Set(actual)], agreement,
      baselineShareAbsoluteError: comparison?.baseline.shareAbsoluteError ?? null,
      variantShareAbsoluteError: comparison?.variant.shareAbsoluteError ?? null,
      baselineRankError: comparison?.baseline.rankError ?? null,
      variantRankError: comparison?.variant.rankError ?? null,
      shareImproved: comparison?.shareImproved ?? null,
      rankImproved: comparison?.rankImproved ?? null,
      targetHan,
    };
  });

  const publicRows = privateRows.map((row) => ({
    id: row.id,
    caseId: row.caseId,
    condition: row.condition,
    status: row.status,
    sourceSections: row.sourceSections,
    outlineSections: row.outlineSections,
    sourceOverlap: row.sourceOverlap,
    sourceOverlapPassed: row.sourceOverlapPassed,
    planCompiled: row.planCompiled,
    violationRules: 'violations' in row ? row.violations.map((item) => item.rule) : [],
    expansionKinds: 'expansionKinds' in row ? row.expansionKinds : [],
    agreement: 'agreement' in row ? row.agreement : null,
    baselineShareAbsoluteError: 'baselineShareAbsoluteError' in row ? row.baselineShareAbsoluteError : null,
    variantShareAbsoluteError: 'variantShareAbsoluteError' in row ? row.variantShareAbsoluteError : null,
    baselineRankError: 'baselineRankError' in row ? row.baselineRankError : null,
    variantRankError: 'variantRankError' in row ? row.variantRankError : null,
    shareImproved: 'shareImproved' in row ? row.shareImproved : null,
    rankImproved: 'rankImproved' in row ? row.rankImproved : null,
  }));
  const variants = publicRows.filter((row) => row.condition === 'variant');
  const evaluated = publicRows.filter((row) => row.condition === 'variant' || row.condition === 'baseline');
  const summary = {
    schemaVersion: 2,
    gate: 'mechanical_privacy_gate',
    qualityClaim: 'not_evaluated',
    cases: [...new Set(publicRows.map((row) => row.caseId))],
    baselineSamples: publicRows.filter((row) => row.condition === 'baseline').length,
    baselineSuccessful: publicRows.filter((row) => row.condition === 'baseline' && row.status === 'success').length,
    variantSamples: variants.length,
    variantSuccessful: variants.filter((row) => row.status === 'success').length,
    variantFailed: variants.filter((row) => row.status !== 'success').length,
    evaluatedSamples: evaluated.length,
    evaluatedSuccessful: evaluated.filter((row) => row.status === 'success').length,
    evaluatedCompiled: evaluated.filter((row) => row.planCompiled).length,
    evaluatedCompileRate: evaluated.length === 0
      ? null
      : evaluated.filter((row) => row.planCompiled).length / evaluated.length,
    sourceOverlapThreshold: MAX_SOURCE_CONTAINMENT,
    baselineSourceOverlapPassed: publicRows.filter(
      (row) => row.condition === 'baseline' && row.sourceOverlapPassed === true,
    ).length,
    variantSourceOverlapPassed: variants.filter((row) => row.sourceOverlapPassed === true).length,
    variantCompiled: variants.filter((row) => row.planCompiled).length,
    variantCompileRate: variants.length === 0
      ? null
      : variants.filter((row) => row.planCompiled).length / variants.length,
    exactSectionCount: variants.filter(
      (row) => row.status === 'success'
        && row.planCompiled
        && row.sourceSections === row.outlineSections,
    ).length,
    medianExpansionAgreement: median(variants.map((row) => row.agreement).filter((value): value is number => value !== null)),
    medianBaselineShareAbsoluteError: median(variants.map((row) => row.baselineShareAbsoluteError).filter((value): value is number => value !== null)),
    medianVariantShareAbsoluteError: median(variants.map((row) => row.variantShareAbsoluteError).filter((value): value is number => value !== null)),
    medianBaselineRankError: median(variants.map((row) => row.baselineRankError).filter((value): value is number => value !== null)),
    medianVariantRankError: median(variants.map((row) => row.variantRankError).filter((value): value is number => value !== null)),
    shareImprovedSamples: variants.filter((row) => row.shareImproved === true).length,
    rankImprovedSamples: variants.filter((row) => row.rankImproved === true).length,
    draftSaturation: { status: 'not_evaluated', reason: 'I1 outline run 不含按 unit policy 生成的完整 draft' },
    fidelityCoverage: { status: 'requires_private_review', required: ['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'D1', 'D2', 'D3'] },
    rows: publicRows,
  };
  const publicPayload = `${JSON.stringify(summary, null, 2)}\n`;
  for (const [caseId, source] of sources) {
    if (sourceContainment(publicPayload, source) > 0) {
      throw new Error(`${caseId}: 公开 I1 audit 命中私有原文 14 字片段，拒绝写入`);
    }
  }
  for (const target of [absolutePrivateOut, absolutePublicOut]) {
    if (fs.existsSync(target)) throw new Error(`输出已存在：${target}`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
  }
  fs.writeFileSync(absolutePrivateOut, `${JSON.stringify({ schemaVersion: 1, rows: privateRows }, null, 2)}\n`, { flag: 'wx' });
  fs.writeFileSync(absolutePublicOut, publicPayload, { flag: 'wx' });
}

const executablePath = process.argv[1];
if (
  executablePath !== undefined
  && import.meta.url === pathToFileURL(executablePath).href
) {
  const [runPath, manifestPath, privateOut, publicOut] = process.argv.slice(2);
  if (!runPath || !manifestPath || !privateOut || !publicOut) {
    throw new Error('用法：npx tsx bench/i1-audit.ts <run> <manifest> <private-out> <public-out>');
  }
  runI1Audit({ runPath, manifestPath, privateOut, publicOut });
}
