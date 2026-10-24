#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { auditImitation, toPublicFidelitySummary } from '../src/server/domain/imitation-fidelity.ts';

interface Args {
  source: string;
  outline: string | null;
  draft: string | null;
  privateOut: string;
  publicOut: string;
}

function parseArgs(argv: readonly string[]): Args {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index], value = argv[index + 1];
    if (flag === undefined || value === undefined || !flag.startsWith('--')) throw new Error('参数必须成对给出');
    values.set(flag, value);
  }
  const required = (flag: string): string => {
    const value = values.get(flag);
    if (!value) throw new Error(`缺少 ${flag}`);
    return path.resolve(value);
  };
  return {
    source: required('--source'),
    outline: values.has('--outline') ? required('--outline') : null,
    draft: values.has('--draft') ? required('--draft') : null,
    privateOut: required('--private-out'),
    publicOut: required('--public-out'),
  };
}

function readOptional(file: string | null): string | null {
  return file === null ? null : fs.readFileSync(file, 'utf8');
}

export function sourceShingleHits(source: string, candidate: string, size = 14): string[] {
  const normalizedSource = source.normalize('NFC').replace(/\s/gu, '');
  const normalizedCandidate = candidate.normalize('NFC').replace(/\s/gu, '');
  const hits: string[] = [];
  for (let index = 0; index + size <= normalizedCandidate.length; index += 1) {
    const shingle = normalizedCandidate.slice(index, index + size);
    if (normalizedSource.includes(shingle)) hits.push(shingle);
  }
  return [...new Set(hits)];
}

export function runImitationAudit(args: Args): void {
  const source = fs.readFileSync(args.source, 'utf8');
  const audit = auditImitation({
    source,
    outline: readOptional(args.outline),
    draft: readOptional(args.draft),
  });
  const privatePayload = `${JSON.stringify({ schemaVersion: 1, audit }, null, 2)}\n`;
  const publicPayload = `${JSON.stringify({ schemaVersion: 1, summary: toPublicFidelitySummary(audit) }, null, 2)}\n`;
  const hits = sourceShingleHits(source, publicPayload);
  if (hits.length > 0) throw new Error(`公开 summary 命中 ${hits.length} 个原文 14 字片段，拒绝写入`);

  for (const target of [args.privateOut, args.publicOut]) {
    if (fs.existsSync(target)) throw new Error(`目标已存在，拒绝覆盖：${target}`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
  }
  fs.writeFileSync(args.privateOut, privatePayload, { flag: 'wx' });
  fs.writeFileSync(args.publicOut, publicPayload, { flag: 'wx' });
}

if (process.argv[1]?.endsWith('imitation-audit.ts') === true) {
  try {
    runImitationAudit(parseArgs(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
