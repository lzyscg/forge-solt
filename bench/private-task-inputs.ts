import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

const PrivateInputManifestSchema = z
  .object({
    pathBase: z.enum(['repository-root', 'manifest-directory']).default('repository-root'),
    cases: z.array(
      z
        .object({
          caseId: z.string().min(1),
          sourcePath: z.string().min(1),
          mode: z.string().min(1).optional(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

export interface PrivateTaskInputManifest {
  readonly pathBase: 'repository-root' | 'manifest-directory';
  readonly cases: readonly {
    readonly caseId: string;
    readonly sourcePath: string;
    readonly mode?: string;
  }[];
}

export type PrivateTaskInputReader = (caseId: string, fieldId: string) => string | null;

export function loadPrivateTaskInputManifest(manifestPath: string): PrivateTaskInputManifest {
  const absoluteManifest = path.resolve(manifestPath);
  const manifest = PrivateInputManifestSchema.parse(
    JSON.parse(fs.readFileSync(absoluteManifest, 'utf8')),
  );
  const baseDirectory = manifest.pathBase === 'manifest-directory'
    ? path.dirname(absoluteManifest)
    : ROOT;
  const caseIds = new Set<string>();
  const cases = manifest.cases.map((entry) => {
    if (caseIds.has(entry.caseId)) {
      throw new Error(`私有输入 manifest 存在重复 caseId：${entry.caseId}`);
    }
    caseIds.add(entry.caseId);
    return {
      caseId: entry.caseId,
      sourcePath: path.isAbsolute(entry.sourcePath)
        ? entry.sourcePath
        : path.resolve(baseDirectory, entry.sourcePath),
      ...(entry.mode === undefined ? {} : { mode: entry.mode }),
    };
  });
  return { pathBase: manifest.pathBase, cases };
}

/**
 * Loads paid/private sources into process memory only. Callers pass the returned
 * resolver to BenchmarkDeps; neither paths nor contents enter Replay or reports.
 */
export function loadPrivateTaskInputReader(manifestPath: string): PrivateTaskInputReader {
  const manifest = loadPrivateTaskInputManifest(manifestPath);
  const byCase = new Map<string, string>();
  for (const entry of manifest.cases) {
    byCase.set(entry.caseId, fs.readFileSync(entry.sourcePath, 'utf8'));
  }
  return (caseId, fieldId) => fieldId === 'source_text' ? byCase.get(caseId) ?? null : null;
}
