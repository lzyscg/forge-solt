import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  loadPrivateTaskInputManifest,
  loadPrivateTaskInputReader,
} from '../../../bench/private-task-inputs.ts';

const temporaries: string[] = [];
afterEach(() => {
  for (const dir of temporaries.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('private task input manifest paths', () => {
  it('pathBase=manifest-directory makes relative paths independent from process cwd', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-private-manifest-'));
    temporaries.push(dir);
    fs.writeFileSync(path.join(dir, 'source.txt'), 'runtime-private-source');
    const manifestPath = path.join(dir, 'manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify({
      pathBase: 'manifest-directory',
      cases: [{ caseId: 'case-1', sourcePath: 'source.txt' }],
    }));

    const read = loadPrivateTaskInputReader(manifestPath);

    expect(read('case-1', 'source_text')).toBe('runtime-private-source');
    expect(read('case-1', 'other')).toBeNull();
  });

  it('exposes manifest entries resolved with the same pathBase semantics', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-private-manifest-'));
    temporaries.push(dir);
    const sourcePath = path.join(dir, 'source.txt');
    fs.writeFileSync(sourcePath, 'private-source-for-audit');
    const manifestPath = path.join(dir, 'manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify({
      pathBase: 'manifest-directory',
      cases: [{ caseId: 'case-audit', sourcePath: 'source.txt', mode: 'fast-summary' }],
    }));

    expect(loadPrivateTaskInputManifest(manifestPath)).toEqual({
      pathBase: 'manifest-directory',
      cases: [{
        caseId: 'case-audit',
        sourcePath,
        mode: 'fast-summary',
      }],
    });
  });

  it('absolute source paths are used unchanged', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-private-manifest-'));
    temporaries.push(dir);
    const sourcePath = path.join(dir, 'source.txt');
    fs.writeFileSync(sourcePath, 'absolute-private-source');
    const manifestPath = path.join(dir, 'manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify({
      cases: [{ caseId: 'case-absolute', sourcePath }],
    }));

    const read = loadPrivateTaskInputReader(manifestPath);

    expect(read('case-absolute', 'source_text')).toBe('absolute-private-source');
  });
});
