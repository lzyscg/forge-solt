#!/usr/bin/env node
import path from 'node:path';
import process from 'node:process';

import { fileURLToPath } from 'node:url';

import { loadProviderConfig } from '../src/server/application/provider-config.ts';
import { runBenchmark } from '../src/server/bench/runner.ts';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

interface CliArgs {
  fixturesPath: string;
  outPath: string;
  repeats: number;
  providerId: 'deepseek';
  skillsDir: string;
}

function usage(): string {
  return `S2 单槽位 benchmark runner

用法：
  npx tsx --env-file-if-exists=.env bench/run.ts \\
    --fixtures bench/fixtures/export \\
    --out bench/runs/r0.json \\
    --repeats 3 \\
    --provider-id deepseek \\
    --skills-dir skills

必填参数：
  --fixtures <文件或目录>   含 execution metadata、ReplayInput JSON/hash、expected hashes 的 fixture
  --out <JSON 路径>         report.mjs 可读取的 run JSON；为防覆盖，目标必须尚不存在
  --repeats <n>             每 case 的独立重复次数，整数且 >= 3
  --provider-id deepseek    固定使用 DeepSeek 官方配置；provider/model 漂移直接失败
  --skills-dir <目录>       当前磁盘 r0 Skill 根目录

环境：
  DEEPSEEK_API_KEY          由 config/providers.yaml 的 DeepSeek 条目读取

runner 不接受 temperature，也不会把 temperature 写进 Provider 请求。`;
}

function parseArgs(argv: readonly string[]): CliArgs {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(usage());
    process.exit(0);
  }

  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === undefined || !flag.startsWith('--') || value === undefined || value.startsWith('--')) {
      throw new Error(`参数必须成对给出：${flag ?? '(空)'}`);
    }
    if (values.has(flag)) throw new Error(`参数重复：${flag}`);
    values.set(flag, value);
  }

  const allowed = new Set(['--fixtures', '--out', '--repeats', '--provider-id', '--skills-dir']);
  for (const flag of values.keys()) {
    if (!allowed.has(flag)) throw new Error(`未知参数：${flag}`);
  }
  const requireValue = (flag: string): string => {
    const value = values.get(flag);
    if (value === undefined || value.trim() === '') throw new Error(`缺少必填参数 ${flag}`);
    return value;
  };
  const providerId = requireValue('--provider-id');
  if (providerId !== 'deepseek') throw new Error('--provider-id 当前只允许 deepseek');
  const repeatsText = requireValue('--repeats');
  if (!/^\d+$/.test(repeatsText)) throw new Error('--repeats 必须是 >= 3 的整数');

  return {
    fixturesPath: path.resolve(requireValue('--fixtures')),
    outPath: path.resolve(requireValue('--out')),
    repeats: Number(repeatsText),
    providerId,
    skillsDir: path.resolve(requireValue('--skills-dir')),
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const providerConfig = await loadProviderConfig(path.join(ROOT, 'config/providers.yaml'));
  const report = await runBenchmark({ ...args, providerConfig });
  const succeeded = report.samples.filter((sample) => sample.status === 'success').length;
  console.log(
    `S2 r0 完成：${report.selection.fixture_cases} cases × ${report.selection.repeats} repeats = ` +
      `${report.selection.samples} samples；成功 ${succeeded}，失败 ${report.samples.length - succeeded}`,
  );
  console.log(`Provider/Model：${report.provider}/${report.model}`);
  console.log(`Run JSON：${args.outPath}`);
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  console.error(`\n${usage()}`);
  process.exitCode = 1;
}
