import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readBlindStoryRegistry, reserveBlindStory, transitionBlindStory } from '../../../bench/blind-story-registry.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function workspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-blind-registry-'));
  dirs.push(dir);
  const registryPath = path.join(dir, 'registry.json');
  const sourceA = path.join(dir, 'a.txt');
  const sourceCopy = path.join(dir, 'copy.txt');
  fs.writeFileSync(sourceA, '合成故事甲，不包含任何私有语料。');
  fs.writeFileSync(sourceCopy, '合成故事甲，不包含任何私有语料。');
  return { dir, registryPath, sourceA, sourceCopy };
}

describe('blind story registry', () => {
  it('按 path 和 content hash 拒绝重复故事，并永久保留使用状态', () => {
    const ws = workspace();
    reserveBlindStory({ registryPath: ws.registryPath, storyId: 'story-a', sourcePath: ws.sourceA, batchId: 'batch-1' });
    expect(() => reserveBlindStory({
      registryPath: ws.registryPath,
      storyId: 'same-path',
      sourcePath: ws.sourceA,
      batchId: 'batch-2',
    })).toThrow(/已被使用或预留/);
    expect(() => reserveBlindStory({
      registryPath: ws.registryPath,
      storyId: 'same-hash',
      sourcePath: ws.sourceCopy,
      batchId: 'batch-2',
    })).toThrow(/已被使用或预留/);

    transitionBlindStory(ws.registryPath, 'story-a', 'shown');
    expect(readBlindStoryRegistry(ws.registryPath).entries[0]?.status).toBe('shown');
    expect(() => transitionBlindStory(ws.registryPath, 'story-a', 'development')).toThrow(/不得改为/);
  });

  it('失败后仍保留 reserved，不允许释放后挑选替代故事', () => {
    const ws = workspace();
    reserveBlindStory({ registryPath: ws.registryPath, storyId: 'story-a', sourcePath: ws.sourceA, batchId: 'failed-batch' });

    expect(readBlindStoryRegistry(ws.registryPath).entries[0]).toMatchObject({
      storyId: 'story-a',
      firstBatchId: 'failed-batch',
      status: 'reserved',
    });
  });
});
