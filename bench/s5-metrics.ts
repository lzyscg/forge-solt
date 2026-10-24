#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fingerprint } from './fingerprint.mjs';

interface Sample { id: string; case_id: string; variant: string; status: string; output: string }

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function summarize(samples: readonly Sample[]) {
  const metrics = samples.map((sample) => ({ sample, fp: fingerprint(sample.output) }));
  return {
    n: samples.length,
    success: samples.filter((sample) => sample.status === 'success').length,
    medianParagraph: median(metrics.map(({ fp }) => fp.pmed).filter((value): value is number => value !== null)),
    medianSentence: median(metrics.map(({ fp }) => fp.smed).filter((value): value is number => value !== null)),
    medianHan: median(metrics.map(({ fp }) => fp.han)),
    paragraphRange: metrics.length === 0
      ? null
      : [Math.min(...metrics.map(({ fp }) => fp.pmed ?? Number.POSITIVE_INFINITY)), Math.max(...metrics.map(({ fp }) => fp.pmed ?? Number.NEGATIVE_INFINITY))],
  };
}

const [runPath, outPath] = process.argv.slice(2);
if (runPath === undefined) throw new Error('用法：npx tsx bench/s5-metrics.ts <run.json> [out.json]');
const run = JSON.parse(fs.readFileSync(path.resolve(runPath), 'utf8')) as { samples: Sample[] };
const cases = [...new Set(run.samples.map((sample) => sample.case_id))].sort();
const result = {
  overall: Object.fromEntries(['baseline', 'variant'].map((condition) => [condition, summarize(run.samples.filter((sample) => sample.variant === condition))])),
  byCase: Object.fromEntries(cases.map((caseId) => [caseId, Object.fromEntries(['baseline', 'variant'].map((condition) => [condition, summarize(run.samples.filter((sample) => sample.case_id === caseId && sample.variant === condition))]))])),
};
const json = `${JSON.stringify(result, null, 2)}\n`;
if (outPath === undefined) process.stdout.write(json);
else fs.writeFileSync(path.resolve(outPath), json);
