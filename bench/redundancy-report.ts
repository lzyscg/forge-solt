#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import Database from 'better-sqlite3';
import { redundancyMetrics } from './redundancy.ts';

interface Row { label: string; uniqueBigramRate: number; repeatedFourgramRate: number; gzipRatio: number }

function collectDatabases(directory: string): Row[] {
  const rows: Row[] = [];
  for (const file of fs.readdirSync(directory).filter((name) => name.endsWith('.sqlite')).sort()) {
    const db = new Database(path.join(directory, file), { readonly: true, fileMustExist: true });
    try {
      const artifacts = db.prepare('SELECT id, CAST(content_blob AS TEXT) AS content FROM artifacts ORDER BY id').all() as { id: string; content: string }[];
      for (const artifact of artifacts) {
        const metrics = redundancyMetrics(artifact.content);
        if (metrics !== null) rows.push({ label: `${file}:${artifact.id}`, ...metrics });
      }
    } catch {
      // 不是 Forge schema 的 sqlite 文件明确跳过。
    } finally {
      db.close();
    }
  }
  return rows;
}

function collectCorpus(directory: string): Row[] {
  const rows: Row[] = [];
  const files = fs.readdirSync(directory, { recursive: true })
    .filter((name): name is string => typeof name === 'string' && name.endsWith('.txt'))
    .sort();
  for (const relative of files) {
    const content = fs.readFileSync(path.join(directory, relative), 'utf8');
    const metrics = redundancyMetrics(content);
    if (metrics !== null) rows.push({ label: relative, ...metrics });
  }
  return rows;
}

function mean(rows: readonly Row[], key: keyof Omit<Row, 'label'>): number {
  return rows.reduce((sum, row) => sum + row[key], 0) / rows.length;
}

function summary(rows: readonly Row[]) {
  return {
    n: rows.length,
    uniqueBigramRate: mean(rows, 'uniqueBigramRate'),
    repeatedFourgramRate: mean(rows, 'repeatedFourgramRate'),
    gzipRatio: mean(rows, 'gzipRatio'),
  };
}

const [mode, directory] = process.argv.slice(2);
if ((mode !== '--db-dir' && mode !== '--corpus-dir') || directory === undefined) {
  throw new Error('用法：npx tsx bench/redundancy-report.ts (--db-dir|--corpus-dir) <目录>');
}
const rows = mode === '--db-dir' ? collectDatabases(path.resolve(directory)) : collectCorpus(path.resolve(directory));
process.stdout.write(`${JSON.stringify({ formulaVersion: 1, windowHan: 2000, summary: summary(rows), rows }, null, 2)}\n`);
