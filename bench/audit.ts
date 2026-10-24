#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { z } from 'zod';

const FindingSchema = z
  .object({
    sampleId: z.string().min(1),
    criterionId: z.string().min(1),
    verdict: z.enum(['accept', 'reject']),
    quote: z.string().min(1),
    reason: z.string().min(1),
  })
  .strict();

const AuditSchema = z
  .object({
    schemaVersion: z.literal(1),
    findings: z.array(FindingSchema),
  })
  .strict();

interface Sample { id: string; output: string }

export function validateAudit(
  samples: readonly Sample[],
  audit: z.infer<typeof AuditSchema>,
): string[] {
  const errors: string[] = [];
  const byId = new Map(samples.map((sample) => [sample.id, sample]));
  for (const finding of audit.findings) {
    const sample = byId.get(finding.sampleId);
    if (sample === undefined) {
      errors.push(`${finding.sampleId}/${finding.criterionId}: 样本不存在`);
      continue;
    }
    if (!sample.output.includes(finding.quote)) {
      errors.push(`${finding.sampleId}/${finding.criterionId}: quote 不逐字存在于样本输出`);
    }
  }
  return errors;
}

export function applyAudit(run: Record<string, unknown>, auditValue: unknown): Record<string, unknown> {
  const samples = z
    .array(z.object({ id: z.string(), output: z.string() }).passthrough())
    .parse(run['samples']);
  const audit = AuditSchema.parse(auditValue);
  const errors = validateAudit(samples, audit);
  if (errors.length > 0) throw new Error(errors.join('\n'));
  const bySample = new Map<string, z.infer<typeof FindingSchema>[]>();
  for (const finding of audit.findings) {
    const list = bySample.get(finding.sampleId) ?? [];
    list.push(finding);
    bySample.set(finding.sampleId, list);
  }
  return {
    ...run,
    quality_audit: audit,
    samples: samples.map((sample) => ({ ...sample, quality_audit: bySample.get(sample.id) ?? [] })),
  };
}

function main(): void {
  const [runPath, auditPath, outPath] = process.argv.slice(2);
  if (runPath === undefined || auditPath === undefined || outPath === undefined) {
    throw new Error('用法：npx tsx bench/audit.ts <run.json> <audit.json> <out.json>');
  }
  const output = path.resolve(outPath);
  if (fs.existsSync(output)) throw new Error(`目标已存在，拒绝覆盖：${output}`);
  const run = JSON.parse(fs.readFileSync(path.resolve(runPath), 'utf8')) as Record<string, unknown>;
  const audit = JSON.parse(fs.readFileSync(path.resolve(auditPath), 'utf8')) as unknown;
  fs.writeFileSync(output, `${JSON.stringify(applyAudit(run, audit), null, 2)}\n`);
}

if (process.argv[1]?.endsWith('audit.ts') === true) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
