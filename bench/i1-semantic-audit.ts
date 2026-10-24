#!/usr/bin/env node
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { sourceContainment } from '../src/server/domain/source-overlap.ts';
import { loadPrivateTaskInputManifest } from './private-task-inputs.ts';

const CRITERIA = ['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'D1', 'D2', 'D3'] as const;
const CriterionSchema = z.enum(CRITERIA);
const EvidenceSchema = z.object({
  sourceSectionRef: z.string().min(1),
  sourceQuote: z.string().min(1),
  unitId: z.string().min(1),
  outlineQuote: z.string().min(1),
}).strict();
const ReviewSchema = z.object({
  criterion: CriterionSchema,
  verdict: z.enum(['pass', 'fail', 'uncertain']),
  severity: z.enum(['critical', 'major', 'minor', 'none']),
  reasonCode: z.enum([
    'NO_ISSUE',
    'UNSUPPORTED_FACT',
    'CAUSAL_GAP',
    'RELATIONSHIP_SHIFT_MISSING',
    'REVERSAL_SETUP_MISSING',
    'INFORMATION_LEAK',
    'ENDING_OR_AFTERMATH_MISSING',
    'SECTION_DISCONTINUITY',
    'PRIORITY_OR_CAPACITY_MISJUDGED',
    'FIELD_REDUNDANCY',
    'GENERIC_OR_EMPTY',
    'OVER_EXPLANATION',
    'NECESSARY_FUNCTION_MISSING',
    'NEEDS_HUMAN_JUDGMENT',
  ]),
  reason: z.string().min(1),
  evidence: z.array(EvidenceSchema),
}).strict().superRefine((review, ctx) => {
  if (review.verdict !== 'pass' && review.evidence.length === 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['evidence'], message: 'fail/uncertain 必须提供证据' });
  }
  if (review.verdict === 'pass' && review.severity !== 'none') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['severity'], message: 'pass severity 必须是 none' });
  }
});
const AuditInputSchema = z.object({
  schemaVersion: z.literal(1),
  samples: z.array(z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('technical_failure'),
      sampleId: z.string().min(1),
      errorCode: z.string().min(1),
    }).strict(),
    z.object({
      kind: z.literal('content_review'),
      sampleId: z.string().min(1),
      reviews: z.array(ReviewSchema),
    }).strict(),
  ])),
}).strict();
const RunSchema = z.object({
  samples: z.array(z.object({
    id: z.string().min(1),
    case_id: z.string().min(1),
    status: z.enum(['success', 'failure']),
    output: z.string(),
  }).passthrough()),
}).passthrough();

export interface SemanticAuditArgs {
  readonly runPath: string;
  readonly manifestPath: string;
  readonly auditInputPath: string;
  readonly publicOut: string;
}

export function validateAndProjectSemanticAudit(args: SemanticAuditArgs): void {
  const run = RunSchema.parse(JSON.parse(fs.readFileSync(path.resolve(args.runPath), 'utf8')));
  const auditRaw = fs.readFileSync(path.resolve(args.auditInputPath), 'utf8');
  const audit = AuditInputSchema.parse(JSON.parse(auditRaw));
  const manifest = loadPrivateTaskInputManifest(args.manifestPath);
  const sources = new Map(manifest.cases.map((entry) => [entry.caseId, fs.readFileSync(entry.sourcePath, 'utf8')]));
  const runById = new Map(run.samples.map((sample) => [sample.id, sample]));
  const seen = new Set<string>();
  for (const item of audit.samples) {
    if (seen.has(item.sampleId)) throw new Error(`语义审核 sample 重复：${item.sampleId}`);
    seen.add(item.sampleId);
    const sample = runById.get(item.sampleId);
    if (sample === undefined) throw new Error(`语义审核包含未知 sample：${item.sampleId}`);
    if (sample.status === 'failure') {
      if (item.kind !== 'technical_failure') throw new Error(`${item.sampleId}: 技术失败样本不得伪造内容审核`);
      continue;
    }
    if (item.kind !== 'content_review') throw new Error(`${item.sampleId}: 成功样本必须有内容审核`);
    const criterionIds = item.reviews.map((review) => review.criterion);
    if (new Set(criterionIds).size !== CRITERIA.length || CRITERIA.some((criterion) => !criterionIds.includes(criterion))) {
      throw new Error(`${item.sampleId}: criterion 覆盖不完整或重复`);
    }
    const source = sources.get(sample.case_id);
    if (source === undefined) throw new Error(`manifest 缺 ${sample.case_id}`);
    for (const review of item.reviews) {
      for (const evidence of review.evidence) {
        if (!source.includes(evidence.sourceQuote)) throw new Error(`${item.sampleId}/${review.criterion}: source quote 不匹配`);
        if (!sample.output.includes(evidence.outlineQuote)) throw new Error(`${item.sampleId}/${review.criterion}: outline quote 不匹配`);
      }
    }
  }
  if (run.samples.some((sample) => !seen.has(sample.id))) throw new Error('语义审核没有覆盖全部正式 sample');

  const privateAuditHash = createHash('sha256').update(auditRaw).digest('hex');
  const publicPayload = {
    schemaVersion: 1,
    gate: 'auditable_private_semantic_review',
    qualityClaim: 'requires_human_review',
    privateAuditHash,
    samples: audit.samples.map((item) => item.kind === 'technical_failure'
      ? { sampleId: item.sampleId, kind: item.kind, errorCode: item.errorCode }
      : {
          sampleId: item.sampleId,
          kind: item.kind,
          reviews: item.reviews.map((review) => ({
            criterion: review.criterion,
            verdict: review.verdict,
            severity: review.severity,
            reasonCode: review.reasonCode,
            evidenceCount: review.evidence.length,
          })),
        }),
  };
  const serialized = `${JSON.stringify(publicPayload, null, 2)}\n`;
  for (const [caseId, source] of sources) {
    if (sourceContainment(serialized, source) > 0) {
      throw new Error(`${caseId}: 公开语义审核命中私有原文 14 字片段，拒绝写入`);
    }
  }
  const output = path.resolve(args.publicOut);
  if (fs.existsSync(output)) throw new Error(`输出已存在：${output}`);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, serialized, { flag: 'wx' });
}

const executablePath = process.argv[1];
if (executablePath !== undefined && import.meta.url === pathToFileURL(executablePath).href) {
  const [runPath, manifestPath, auditInputPath, publicOut] = process.argv.slice(2);
  if (!runPath || !manifestPath || !auditInputPath || !publicOut) {
    throw new Error('用法：npx tsx bench/i1-semantic-audit.ts <run> <manifest> <private-audit> <public-out>');
  }
  validateAndProjectSemanticAudit({ runPath, manifestPath, auditInputPath, publicOut });
}
