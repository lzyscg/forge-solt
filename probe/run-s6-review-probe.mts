#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { parseSkill } from '@server/application/skill-loader.ts';
import { verifyFindings } from '@server/domain/review-evidence.ts';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const CASES_PATH = path.join(ROOT, 'probe/s6-cases.json');
const SKILL_PATH = path.join(ROOT, 'skills-variants/s6/scene-review/SKILL.md');

interface ProbeCase {
  caseId: string;
  label: 'NO_FINDING' | 'REVISE';
  instruction: string;
  content: string;
}

interface Finding { quote: string; problem: string }
interface ProbeRow {
  caseId: string;
  repeat: number;
  expected: ProbeCase['label'];
  verdict: 'NO_FINDING' | 'REVISE' | 'ERROR';
  findings: Finding[];
  keptFindings: Finding[];
  error: string | null;
}

function parseArgs(argv: readonly string[]) {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--dry-run') values.set(flag, 'true');
    else if (flag?.startsWith('--')) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`缺少 ${flag} 的值`);
      values.set(flag, value);
      index += 1;
    }
  }
  const repeats = Number(values.get('--repeats') ?? '3');
  if (!Number.isInteger(repeats) || repeats < 1) throw new Error('--repeats 必须是正整数');
  return {
    dryRun: values.get('--dry-run') === 'true',
    repeats,
    outPath: path.resolve(values.get('--out') ?? 'bench/runs/s6-review-probe.json'),
    model: values.get('--model') ?? 'deepseek-chat',
  };
}

function loadCriterion() {
  const raw = fs.readFileSync(SKILL_PATH, 'utf8');
  const skill = parseSkill(raw, SKILL_PATH);
  const criterion = skill.sectionIndex['S5'];
  if (criterion === undefined) throw new Error('S6 scene-review 变体缺少 S5 判据');
  return criterion;
}

function systemPrompt(criterion: { id: string; title: string; content: string }): string {
  return [
    '你是内容审核员。本次只审核给出的这一条判据，不评价其他方面。',
    '违反则返回 REVISE，并逐条给出逐字出自待审正文的 quote 与具体 problem；否则返回 NO_FINDING。',
    '只返回 JSON：{"verdict":"NO_FINDING"|"REVISE","findings":[{"quote":"逐字引文","problem":"违反原因"}]}',
    '',
    `## ${criterion.id}. ${criterion.title}`,
    criterion.content,
  ].join('\n');
}

function userPrompt(item: ProbeCase): string {
  return ['【本槽位目标】', item.instruction, '', '【待审正文】', item.content].join('\n');
}

function assertBlind(cases: readonly ProbeCase[], system: string): void {
  const leaks = ['caseId', 'label', 'NO_FINDING', 'REVISE', 'clean-', 'redundant-', 'emotion-'];
  for (const item of cases) {
    const prompt = `${system}\n${userPrompt(item)}`;
    const leaked = leaks.filter((token) => prompt.includes(token) && !system.includes(token));
    if (leaked.length > 0) throw new Error(`${item.caseId} Prompt 泄漏：${leaked.join(', ')}`);
  }
}

function apiKey(): string {
  const envPath = path.join(ROOT, '.env');
  const env = fs.readFileSync(envPath, 'utf8');
  const row = env.split(/\r?\n/u).find((line) => line.startsWith('DEEPSEEK_API_KEY='));
  const value = row?.slice('DEEPSEEK_API_KEY='.length).trim();
  if (!value) throw new Error('.env 缺少 DEEPSEEK_API_KEY');
  return value;
}

async function callModel(model: string, key: string, system: string, user: string): Promise<string> {
  const response = await fetch('https://api.deepseek.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      response_format: { type: 'json_object' },
      max_tokens: 1200,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    }),
  });
  if (!response.ok) throw new Error(`DeepSeek HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
  const json = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
  return json.choices?.[0]?.message?.content ?? '';
}

function parseResult(raw: string): { verdict: 'NO_FINDING' | 'REVISE'; findings: Finding[] } {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('模型输出没有 JSON 对象');
  const value = JSON.parse(raw.slice(start, end + 1)) as { verdict?: unknown; findings?: unknown };
  if (value.verdict !== 'NO_FINDING' && value.verdict !== 'REVISE') throw new Error('模型 verdict 非法');
  const findings = Array.isArray(value.findings)
    ? value.findings.flatMap((item) => {
        if (typeof item !== 'object' || item === null) return [];
        const row = item as Record<string, unknown>;
        return typeof row['quote'] === 'string' && typeof row['problem'] === 'string'
          ? [{ quote: row['quote'], problem: row['problem'] }]
          : [];
      })
    : [];
  return { verdict: value.verdict, findings };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const cases = JSON.parse(fs.readFileSync(CASES_PATH, 'utf8')) as ProbeCase[];
  const criterion = loadCriterion();
  const system = systemPrompt(criterion);
  assertBlind(cases, system);
  if (args.dryRun) {
    process.stdout.write(`S6 probe dry-run：${cases.length} cases × ${args.repeats} repeats；网络调用 0\n`);
    return;
  }
  if (fs.existsSync(args.outPath)) throw new Error(`输出已存在，拒绝覆盖：${args.outPath}`);
  fs.mkdirSync(path.dirname(args.outPath), { recursive: true });
  const key = apiKey();
  const rows: ProbeRow[] = [];
  for (const item of cases) {
    for (let repeat = 1; repeat <= args.repeats; repeat += 1) {
      try {
        const parsed = parseResult(await callModel(args.model, key, system, userPrompt(item)));
        const verified = verifyFindings(
          item.content,
          parsed.findings.map((finding) => ({ criterionId: 'S5', ...finding })),
        );
        rows.push({
          caseId: item.caseId,
          repeat,
          expected: item.label,
          verdict: parsed.verdict,
          findings: parsed.findings,
          keptFindings: verified.kept.map(({ quote, problem }) => ({ quote, problem })),
          error: null,
        });
      } catch (error) {
        rows.push({ caseId: item.caseId, repeat, expected: item.label, verdict: 'ERROR', findings: [], keptFindings: [], error: error instanceof Error ? error.message : String(error) });
      }
      fs.writeFileSync(`${args.outPath}.partial`, `${JSON.stringify({ schemaVersion: 1, criterionId: 'S5', rows }, null, 2)}\n`);
    }
  }
  const summary = cases.map((item) => {
    const selected = rows.filter((row) => row.caseId === item.caseId);
    const accepted = selected.filter((row) => row.verdict === item.label && (row.verdict !== 'REVISE' || row.keptFindings.length > 0)).length;
    return { caseId: item.caseId, expected: item.label, accepted, total: selected.length };
  });
  fs.writeFileSync(args.outPath, `${JSON.stringify({ schemaVersion: 1, criterionId: 'S5', model: args.model, repeats: args.repeats, summary, rows }, null, 2)}\n`, { flag: 'wx' });
  fs.rmSync(`${args.outPath}.partial`, { force: true });
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  if (summary.some((item) => item.accepted !== item.total)) process.exitCode = 1;
}

await main();
