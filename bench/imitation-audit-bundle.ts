#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { auditImitation, toPublicFidelitySummary } from '../src/server/domain/imitation-fidelity.ts';
import { sourceShingleHits } from './imitation-audit.ts';

interface CaseEntry {
  caseId: string;
  mode: string;
  role: 'development' | 'holdout';
  sourcePath: string;
  outlinePath: string | null;
  draftPath: string | null;
}

interface Manifest { schemaVersion: 1; date: string; cases: CaseEntry[] }

function readOptional(file: string | null): string | null {
  return file === null ? null : fs.readFileSync(path.resolve(file), 'utf8');
}

function main(): void {
  const [manifestPath, privateDir, publicOut] = process.argv.slice(2);
  if (!manifestPath || !privateDir || !publicOut) {
    throw new Error('用法：npx tsx bench/imitation-audit-bundle.ts <manifest.json> <private-dir> <public.json>');
  }
  const manifest = JSON.parse(fs.readFileSync(path.resolve(manifestPath), 'utf8')) as Manifest;
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.cases) || manifest.cases.length === 0) {
    throw new Error('manifest 非法');
  }
  const privateRoot = path.resolve(privateDir);
  const publicPath = path.resolve(publicOut);
  if (fs.existsSync(publicPath)) throw new Error(`公开输出已存在：${publicPath}`);
  fs.mkdirSync(privateRoot, { recursive: true });

  const publicCases = manifest.cases.map((entry) => {
    const source = fs.readFileSync(path.resolve(entry.sourcePath), 'utf8');
    const audit = auditImitation({
      source,
      outline: readOptional(entry.outlinePath),
      draft: readOptional(entry.draftPath),
    });
    const privatePath = path.join(privateRoot, `${entry.caseId}.private.json`);
    if (fs.existsSync(privatePath)) throw new Error(`私有输出已存在：${privatePath}`);
    fs.writeFileSync(privatePath, `${JSON.stringify({ schemaVersion: 1, case: entry, audit }, null, 2)}\n`, { flag: 'wx' });
    return {
      caseId: entry.caseId,
      mode: entry.mode,
      role: entry.role,
      hasOutline: entry.outlinePath !== null,
      hasDraft: entry.draftPath !== null,
      summary: toPublicFidelitySummary(audit),
      source,
    };
  });

  const publicPayload = {
    schemaVersion: 1,
    date: manifest.date,
    cases: publicCases.map(({ source: _source, ...entry }) => entry),
  };
  const encoded = `${JSON.stringify(publicPayload, null, 2)}\n`;
  for (const entry of publicCases) {
    const hits = sourceShingleHits(entry.source, encoded);
    if (hits.length > 0) throw new Error(`${entry.caseId} 公开 bundle 命中 ${hits.length} 个原文 14 字片段`);
  }
  fs.mkdirSync(path.dirname(publicPath), { recursive: true });
  fs.writeFileSync(publicPath, encoded, { flag: 'wx' });
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
