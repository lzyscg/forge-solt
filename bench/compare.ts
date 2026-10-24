#!/usr/bin/env node
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { loadProviderConfig } from '../src/server/application/provider-config.ts';
import { runComparisonBenchmark } from '../src/server/bench/runner.ts';
import { loadPrivateTaskInputReader } from './private-task-inputs.ts';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

function argsOf(argv: readonly string[]): Map<string, string> {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === undefined || value === undefined || !flag.startsWith('--')) throw new Error('参数必须成对给出');
    values.set(flag, value);
  }
  return values;
}

function required(values: ReadonlyMap<string, string>, flag: string): string {
  const value = values.get(flag);
  if (value === undefined || value.trim() === '') throw new Error(`缺少 ${flag}`);
  return value;
}

function runnerBundleHash(): string {
  const files = [
    path.join(ROOT, 'src/server/bench/runner.ts'),
    path.join(ROOT, 'bench/compare.ts'),
    path.join(ROOT, 'bench/export-outline-fixtures.ts'),
  ];
  const digest = createHash('sha256');
  for (const file of files) digest.update(createHash('sha256').update(fs.readFileSync(file)).digest('hex'));
  return digest.digest('hex');
}

async function main(): Promise<void> {
  const values = argsOf(process.argv.slice(2));
  const providerId = values.get('--provider-id') ?? 'volcengine-ark-coding';
  if (providerId !== 'volcengine-ark-coding') {
    throw new Error('--provider-id 当前只允许 volcengine-ark-coding');
  }
  const providerConfig = await loadProviderConfig(path.join(ROOT, 'config/providers.yaml'));
  const conditionsText = values.get('--conditions') ?? 'baseline,variant';
  const conditions = conditionsText.split(',').map((item) => item.trim());
  if (conditions.some((item) => item !== 'baseline' && item !== 'variant')) {
    throw new Error('--conditions 只能是 baseline、variant 或逗号组合');
  }
  const caseIds = values.get('--case-ids')?.split(',').map((item) => item.trim()).filter(Boolean);
  const privateManifest = values.get('--private-manifest');
  const variantSkillsDir = values.get('--variant-skills-dir');
  const suppliedRunnerBundleHash = values.get('--runner-bundle-hash');
  const modelServiceResolution = values.get('--model-service-resolution');
  if (modelServiceResolution === undefined || modelServiceResolution.trim() === '') {
    throw new Error('缺少 --model-service-resolution');
  }
  if (suppliedRunnerBundleHash === undefined || !/^[a-f0-9]{64}$/u.test(suppliedRunnerBundleHash)) {
    throw new Error('--runner-bundle-hash 必须是 64 位 sha256');
  }
  if (suppliedRunnerBundleHash !== runnerBundleHash()) {
    throw new Error('--runner-bundle-hash 与当前 runner bundle 不一致');
  }
  const report = await runComparisonBenchmark({
    fixturesPath: path.resolve(required(values, '--fixtures')),
    outPath: path.resolve(required(values, '--out')),
    repeats: Number(required(values, '--repeats')),
    providerId,
    baselineSkillsDir: path.resolve(required(values, '--baseline-skills-dir')),
    ...(variantSkillsDir === undefined ? {} : { variantSkillsDir: path.resolve(variantSkillsDir) }),
    skillId: required(values, '--skill'),
    runId: required(values, '--run-id'),
    modelServiceResolution,
    runnerBundleHash: suppliedRunnerBundleHash,
    conditions: conditions as ('baseline' | 'variant')[],
    ...(caseIds === undefined ? {} : { caseIds }),
    providerConfig,
  }, privateManifest === undefined
    ? {}
    : { readPrivateTaskInput: loadPrivateTaskInputReader(path.resolve(privateManifest)) });
  process.stdout.write(`A/B 完成：${String(report['run_id'])}，${(report['samples'] as unknown[]).length} 个样本\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
