import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

const RegistryEntrySchema = z.object({
  storyId: z.string().min(1),
  sourcePath: z.string().min(1),
  sourceSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  firstBatchId: z.string().min(1),
  status: z.enum(['reserved', 'shown', 'development']),
}).strict();

const RegistrySchema = z.object({
  schemaVersion: z.literal(1),
  entries: z.array(RegistryEntrySchema),
}).strict();

export type BlindStoryStatus = z.infer<typeof RegistryEntrySchema>['status'];

export interface ReserveBlindStoryInput {
  readonly registryPath: string;
  readonly storyId: string;
  readonly sourcePath: string;
  readonly batchId: string;
}

export function sourceSha256(sourcePath: string): string {
  return createHash('sha256').update(fs.readFileSync(path.resolve(sourcePath))).digest('hex');
}

export function reserveBlindStory(input: ReserveBlindStoryInput): void {
  const registryPath = path.resolve(input.registryPath);
  const registry = readRegistry(registryPath);
  const absoluteSource = path.resolve(input.sourcePath);
  const sha256 = sourceSha256(absoluteSource);
  const conflict = registry.entries.find((entry) =>
    path.resolve(entry.sourcePath) === absoluteSource || entry.sourceSha256 === sha256,
  );
  if (conflict !== undefined) {
    throw new Error(`盲评故事已被使用或预留：${conflict.storyId}/${conflict.status}`);
  }
  if (registry.entries.some((entry) => entry.storyId === input.storyId)) {
    throw new Error(`盲评 storyId 已存在：${input.storyId}`);
  }
  writeRegistry(registryPath, {
    schemaVersion: 1,
    entries: [...registry.entries, {
      storyId: input.storyId,
      sourcePath: absoluteSource,
      sourceSha256: sha256,
      firstBatchId: input.batchId,
      status: 'reserved',
    }],
  });
}

export function transitionBlindStory(
  registryPath: string,
  storyId: string,
  status: Exclude<BlindStoryStatus, 'reserved'>,
): void {
  const absolute = path.resolve(registryPath);
  const registry = readRegistry(absolute);
  const current = registry.entries.find((entry) => entry.storyId === storyId);
  if (current === undefined) throw new Error(`盲评 storyId 不存在：${storyId}`);
  if (current.status !== 'reserved' && current.status !== status) {
    throw new Error(`盲评故事 ${storyId} 已是 ${current.status}，不得改为 ${status}`);
  }
  writeRegistry(absolute, {
    schemaVersion: 1,
    entries: registry.entries.map((entry) => entry.storyId === storyId ? { ...entry, status } : entry),
  });
}

export function readBlindStoryRegistry(registryPath: string): z.infer<typeof RegistrySchema> {
  return readRegistry(path.resolve(registryPath));
}

function readRegistry(registryPath: string): z.infer<typeof RegistrySchema> {
  try {
    return RegistrySchema.parse(JSON.parse(fs.readFileSync(registryPath, 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { schemaVersion: 1, entries: [] };
    throw error;
  }
}

function writeRegistry(registryPath: string, registry: z.infer<typeof RegistrySchema>): void {
  fs.mkdirSync(path.dirname(registryPath), { recursive: true });
  const temporary = `${registryPath}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(RegistrySchema.parse(registry), null, 2)}\n`, { flag: 'wx' });
  fs.renameSync(temporary, registryPath);
}
