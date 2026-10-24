import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseReplayInput, rebuildContextFromReplay } from '@server/application/context-builder.ts';
import { loadProviderConfig } from '@server/application/provider-config.ts';
import { loadTemplate } from '@server/application/template-loader.ts';
import { FakeProvider } from '@server/runtime/provider/fake.ts';
import { runComparisonBenchmark, type BenchmarkSample } from '@server/bench/runner.ts';
import type { FrozenSkill } from '@server/application/snapshot-service.ts';
import { exportOutlineFixtures } from '../../../bench/export-outline-fixtures.ts';

const ROOT = path.resolve(import.meta.dirname, '../../..');
const temporaries: string[] = [];

afterEach(() => {
  for (const dir of temporaries.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function syntheticSource(marker: string): string {
  return Array.from({ length: 8 }, (_, index) => [
    `${String(index + 1).padStart(2, '0')}、合成分节${index + 1}`,
    `${marker}-${index + 1}。${'记录员核对虚构档案并更新下一步计划。'.repeat(index + 1)}`,
  ].join('\n')).join('\n');
}

function frozenSkill(loaded: Awaited<ReturnType<typeof loadTemplate>>, id: string): FrozenSkill {
  const skill = loaded.skills[id];
  if (skill === undefined) throw new Error(`missing ${id}`);
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

describe('exportOutlineFixtures', () => {
  it('从 runtime-only 私有 source 导出可重建且不含正文的 ReplayInput v2', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-outline-export-'));
    temporaries.push(dir);
    const marker = 'SYNTHETIC-PRIVATE-EXPORT-MARKER';
    const source = syntheticSource(marker);
    fs.writeFileSync(path.join(dir, 'source.txt'), source);
    const manifestPath = path.join(dir, 'manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify({
      pathBase: 'manifest-directory',
      cases: [{ caseId: 'synthetic-v2', sourcePath: 'source.txt' }],
    }));
    const outPath = path.join(dir, 'fixtures.json');
    const templateDir = path.join(ROOT, 'templates-variants/i1-answer-contract-v2');
    const skillsDir = path.join(ROOT, 'skills-variants/i1-answer-contract-v2');

    await exportOutlineFixtures({
      manifestPath,
      outPath,
      templateDir,
      skillsDir,
      templateId: 'zhihu-outline-v2-candidate',
    });

    const raw = fs.readFileSync(outPath, 'utf8');
    expect(raw).not.toContain(marker);
    expect(raw).not.toContain('source.txt');
    const fixture = JSON.parse(raw) as {
      cases: Array<{ replayInputJson: string; replayInputHash: string }>;
    };
    const first = fixture.cases[0]!;
    const replay = parseReplayInput(first.replayInputJson, first.replayInputHash);
    expect(replay.version).toBe(2);
    expect(replay.version === 2 ? replay.answerContract.version : null).toBe(2);
    const loaded = await loadTemplate(path.join(templateDir, 'zhihu-outline-v2-candidate'), {
      skillsDir,
      defaults: { timeoutMs: 180000, maxRetries: 2 },
      knownAliases: new Set(['main', 'structure']),
    });
    expect(() => rebuildContextFromReplay(
      first.replayInputJson,
      first.replayInputHash,
      frozenSkill(loaded, 'outline-writing'),
      { readPrivateInput: () => source },
    )).not.toThrow();
    expect(() => rebuildContextFromReplay(
      first.replayInputJson,
      first.replayInputHash,
      frozenSkill(loaded, 'outline-writing'),
      { readPrivateInput: () => `${source}已改变` },
    )).toThrow(/hash 不一致/);

    const answer = {
      units: Array.from({ length: 8 }, (_, index) => ({
        sourceSectionRef: `source-section-${String(index + 1).padStart(2, '0')}`,
        title: `合成变化${index + 1}`,
        change: { from: `状态${index}`, to: `状态${index + 1}` },
        priority: index === 7 || index === 2 ? 'P0' : index % 2 === 0 ? 'P1' : 'bridge',
        mode: index % 2 === 0 ? 'conflict-scene' : 'fast-summary',
        capacity: { dialogueTurns: 1, actionFeedbackLoops: 1, cognitionTurns: 0, aftermathBeats: index === 7 ? 1 : 0 },
        cast: ['记录员'],
        objective: `核对第${index + 1}项记录并推进后续行动`,
        conflict: `第${index + 1}项记录与现有结论不一致`,
        endState: `第${index + 1}项记录已被核实`,
        informationControl: null,
      })),
    };
    const provider = new FakeProvider({
      turns: Array.from({ length: 3 }, () => ({
        callTools: [{ name: 'submit_answer', args: answer }],
      })),
    });
    const providerConfig = await loadProviderConfig(path.join(ROOT, 'config/providers.yaml'));
    const runPath = path.join(dir, 'run.json');
    const report = await runComparisonBenchmark({
      fixturesPath: outPath,
      outPath: runPath,
      repeats: 3,
      providerId: 'volcengine-ark-coding',
      baselineSkillsDir: skillsDir,
      skillId: 'outline-writing',
      runId: 'synthetic-v2-r0',
      conditions: ['baseline'],
      modelServiceResolution: 'synthetic-test',
      runnerBundleHash: 'a'.repeat(64),
      providerConfig,
    }, {
      adapterFactory: () => provider,
      env: { ARK_API_KEY: 'test-only' },
      readPrivateTaskInput: (caseId, fieldId) =>
        caseId === 'synthetic-v2' && fieldId === 'source_text' ? source : null,
    });
    const samples = report['samples'] as BenchmarkSample[];
    expect(samples).toHaveLength(3);
    expect(samples.every((sample) => sample.status === 'success')).toBe(true);
    expect(samples.every((sample) => sample.stream_diagnostics?.timeoutPolicy === 'stream-idle-v1')).toBe(true);
    expect(provider.observations.every((observation) =>
      observation.toolNames.includes('submit_answer') && !observation.toolNames.includes('complete_assignment'),
    )).toBe(true);
    expect(report['experiment_identity']).toMatchObject({
      conditions: ['baseline'],
      variantHash: null,
      modelServiceResolution: 'synthetic-test',
      runnerBundleHash: 'a'.repeat(64),
      timeoutPolicy: {
        id: 'stream-idle-v1',
        idleTimeouts: [expect.objectContaining({
          caseId: 'synthetic-v2',
          idleTimeoutMs: 180000,
          totalDeadlineMs: 1800000,
          toolExecutionTimeoutMs: 30000,
        })],
      },
      contracts: [expect.objectContaining({
        templateId: 'zhihu-outline-v2-candidate',
        contractHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
        answerSchemaHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      })],
    });
  });
});
