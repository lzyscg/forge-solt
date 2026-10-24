#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { loadProviderConfig } from '../src/server/application/provider-config.ts';
import { loadTemplate } from '../src/server/application/template-loader.ts';
import {
  buildContext,
  rebuildContextFromReplay,
  serializeReplayInput,
  type ContextBuilderInput,
} from '../src/server/application/context-builder.ts';
import type { FrozenSkill, FrozenTaskSnapshot } from '../src/server/application/snapshot-service.ts';
import { canonicalJson, sha256Hex } from '../src/server/domain/canonical.ts';
import { sourceContainment } from '../src/server/domain/source-overlap.ts';
import type { Slot } from '../src/server/domain/types.ts';
import { loadPrivateTaskInputManifest } from './private-task-inputs.ts';

export interface ExportOutlineFixturesArgs {
  readonly manifestPath: string;
  readonly outPath: string;
  readonly templateDir: string;
  readonly skillsDir: string;
  readonly templateId: string;
}

function freezeSkill(skill: Awaited<ReturnType<typeof loadTemplate>>['skills'][string]): FrozenSkill {
  return {
    id: skill.id,
    version: skill.version,
    contentMarkdown: skill.raw,
    contentHash: skill.contentHash,
    operation: skill.operation,
    slotTypes: skill.slotTypes,
    readsSlotTypes: skill.readsSlotTypes,
    status: skill.status,
    summary: skill.summary,
    preamble: skill.preamble,
    requiredSections: skill.requiredSections,
    sections: skill.sections,
    sectionIndex: skill.sectionIndex,
  };
}

export async function exportOutlineFixtures(args: ExportOutlineFixturesArgs): Promise<void> {
  const output = path.resolve(args.outPath);
  if (fs.existsSync(output)) throw new Error(`输出已存在：${output}`);
  const manifest = loadPrivateTaskInputManifest(args.manifestPath);
  const sources = new Map(
    manifest.cases.map((entry) => [entry.caseId, fs.readFileSync(entry.sourcePath, 'utf8')]),
  );
  const providerConfig = await loadProviderConfig(path.resolve('config/providers.yaml'));
  const loaded = await loadTemplate(path.resolve(args.templateDir, args.templateId), {
    skillsDir: path.resolve(args.skillsDir),
    defaults: providerConfig.defaults,
    knownAliases: new Set(Object.keys(providerConfig.aliases)),
  });
  if (loaded.compiled.id !== args.templateId) throw new Error('候选模板 ID 与请求不一致');
  const binding = loaded.compiled.bindings.fillSlotByType['story_outline'];
  if (binding === undefined) throw new Error(`${args.templateId} 缺 story_outline binding`);
  const agent = loaded.compiled.agents.find((item) => item.id === binding.agentId);
  const skill = loaded.skills[binding.skillId];
  const slotType = loaded.compiled.slotTypes.find((item) => item.id === 'story_outline');
  if (agent === undefined || skill === undefined || slotType === undefined) {
    throw new Error('outline fixture binding 不完整');
  }
  const frozenSkill = freezeSkill(skill);
  const cases = manifest.cases.map((entry) => {
    const source = sources.get(entry.caseId);
    if (source === undefined || source.trim() === '') throw new Error(`${entry.caseId}: source_text 缺失或为空`);
    const taskId = `bench-${entry.caseId}`;
    const at = '2026-09-05T00:00:00.000Z';
    const slots: Slot[] = [
      {
        taskId, slotId: 'outline_document', type: 'outline_document', parentId: null, sortOrder: 0,
        instruction: '大纲文档容器', dependsOn: [], contentBearing: false, includeInArtifact: true,
        narrativeUnitId: null,
        status: 'completed', revisionRound: 0, reviewExhausted: false, contentText: null, producer: null,
        errorCode: null, errorMessage: null, createdAt: at, updatedAt: at,
      },
      {
        taskId, slotId: 'story_outline', type: 'story_outline', parentId: 'outline_document', sortOrder: 1,
        instruction: '从完整原文逐节回答叙事业务问题，由系统编译执行大纲', dependsOn: [],
        contentBearing: true, includeInArtifact: true, narrativeUnitId: null,
        status: 'pending', revisionRound: 0, reviewExhausted: false, contentText: null, producer: null,
        errorCode: null, errorMessage: null, createdAt: at, updatedAt: at,
      },
    ];
    const compiledJson = canonicalJson(loaded.compiled);
    const snapshot: FrozenTaskSnapshot = {
      taskId,
      snapshotId: `snapshot-${entry.caseId}`,
      templateId: loaded.compiled.id,
      templateVersion: loaded.compiled.version,
      compiled: loaded.compiled,
      snapshotHash: sha256Hex(compiledJson),
      skills: Object.fromEntries(Object.values(loaded.skills).map((item) => [item.id, freezeSkill(item)])),
      input: {},
    };
    const contextInput: ContextBuilderInput = {
      operation: 'fill_slot', snapshot, agent, skill: frozenSkill, attemptNumber: 1,
      maxAttempts: binding.maxRetries + 1, slots, targetSlot: slots[1]!, slotType,
      effectiveHanRange: null, dependencies: [], retry: null, revision: null,
    };
    const context = buildContext(contextInput);
    const replay = slotType.answerContract == null
      ? serializeReplayInput(contextInput)
      : serializeReplayInput(contextInput, {
          readPrivateInput: (fieldId) => fieldId === slotType.answerContract?.sourceField ? source : null,
        });
    rebuildContextFromReplay(
      replay.replayInputJson,
      replay.replayInputHash,
      frozenSkill,
      { readPrivateInput: (fieldId) => fieldId === slotType.answerContract?.sourceField ? source : null },
    );
    return {
      caseId: entry.caseId,
      execution: {
        id: `fixture-${entry.caseId}`, taskId, operation: 'fill_slot', targetSlotId: 'story_outline',
        agentId: agent.id, skillId: skill.id, skillVersion: skill.version, modelAlias: binding.modelAlias,
        provider: 'volcengine-ark-coding', model: 'deepseek-v4-flash', attemptNumber: 1,
      },
      replayInputJson: replay.replayInputJson,
      replayInputHash: replay.replayInputHash,
      expected: { contextHash: context.contextHash, promptHash: context.promptHash },
    };
  });
  const payload = `${JSON.stringify({ version: 1, cases }, null, 2)}\n`;
  for (const [caseId, source] of sources) {
    if (sourceContainment(payload, source) > 0) {
      throw new Error(`${caseId}: fixture 命中私有原文 14 字片段，拒绝写入`);
    }
  }
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, payload, { flag: 'wx' });
}

function argsOf(argv: readonly string[]): Map<string, string> {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === undefined || value === undefined || !flag.startsWith('--')) throw new Error('参数必须成对给出');
    if (values.has(flag)) throw new Error(`参数重复：${flag}`);
    values.set(flag, value);
  }
  return values;
}

function required(values: ReadonlyMap<string, string>, flag: string): string {
  const value = values.get(flag);
  if (value === undefined || value.trim() === '') throw new Error(`缺少 ${flag}`);
  return value;
}

async function main(): Promise<void> {
  const values = argsOf(process.argv.slice(2));
  await exportOutlineFixtures({
    manifestPath: path.resolve(required(values, '--manifest')),
    outPath: path.resolve(required(values, '--out')),
    templateDir: path.resolve(required(values, '--template-dir')),
    skillsDir: path.resolve(required(values, '--skills-dir')),
    templateId: required(values, '--template-id'),
  });
}

const executablePath = process.argv[1];
if (executablePath !== undefined && import.meta.url === pathToFileURL(executablePath).href) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
