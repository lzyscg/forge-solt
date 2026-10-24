#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { parseSkill } from '@server/application/skill-loader.ts';
import { verifyFindings } from '@server/domain/review-evidence.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const SKILL_PATH = path.join(ROOT, 'skills/outline-review/SKILL.md');
const CASES_PATH = path.join(ROOT, 'probe/s4-outline-review-cases.json');

type Verdict = 'NO_FINDING' | 'REVISE' | 'ERROR';
interface ProbeCase { caseId: string; criterionId: 'S6' | 'S7'; expected: Exclude<Verdict, 'ERROR'>; content: string }
interface Finding { quote: string; problem: string }

function argumentsOf() {
  const values = new Map<string, string>();
  for (let index = 0; index < process.argv.length; index += 1) {
    const flag = process.argv[index];
    if (flag === '--dry-run') values.set(flag, 'true');
    else if (flag?.startsWith('--')) {
      const value = process.argv[index + 1];
      if (value !== undefined && !value.startsWith('--')) values.set(flag, value);
    }
  }
  const repeats = Number(values.get('--repeats') ?? '3');
  return { dryRun: values.get('--dry-run') === 'true', repeats, out: path.resolve(values.get('--out') ?? 'bench/runs/s4-outline-review-probe.json') };
}

function prompt(criterion: { id: string; title: string; content: string }, content: string) {
  const system = [
    '你只审核给出的这一条大纲判据，不评价其他方面。',
    '违反则返回 REVISE，并给出逐字出自待审大纲的 quote；否则返回 NO_FINDING。',
    '只返回 JSON：{"verdict":"NO_FINDING"|"REVISE","findings":[{"quote":"逐字引文","problem":"问题"}]}',
    `## ${criterion.id}. ${criterion.title}`,
    criterion.content,
  ].join('\n\n');
  return { system, user: `【待审大纲】\n${content}` };
}

function key(): string {
  const env = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
  const value = env.split(/\r?\n/u).find((line) => line.startsWith('DEEPSEEK_API_KEY='))?.split('=').slice(1).join('=').trim();
  if (!value) throw new Error('.env 缺少 DEEPSEEK_API_KEY');
  return value;
}

async function call(system: string, user: string, apiKey: string): Promise<string> {
  const response = await fetch('https://api.deepseek.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model: 'deepseek-chat', temperature: 0.2, response_format: { type: 'json_object' }, max_tokens: 1200, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const json = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
  return json.choices?.[0]?.message?.content ?? '';
}

function parse(raw: string): { verdict: Exclude<Verdict, 'ERROR'>; findings: Finding[] } {
  const start = raw.indexOf('{'), end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('无 JSON');
  const value = JSON.parse(raw.slice(start, end + 1)) as { verdict?: unknown; findings?: unknown };
  if (value.verdict !== 'NO_FINDING' && value.verdict !== 'REVISE') throw new Error('verdict 非法');
  const findings = Array.isArray(value.findings) ? value.findings.flatMap((item) => {
    const row = item as Record<string, unknown>;
    return typeof row?.['quote'] === 'string' && typeof row?.['problem'] === 'string' ? [{ quote: row['quote'], problem: row['problem'] }] : [];
  }) : [];
  return { verdict: value.verdict, findings };
}

const args = argumentsOf();
const cases = JSON.parse(fs.readFileSync(CASES_PATH, 'utf8')) as ProbeCase[];
const skill = parseSkill(fs.readFileSync(SKILL_PATH, 'utf8'), SKILL_PATH);
for (const item of cases) if (skill.sectionIndex[item.criterionId] === undefined) throw new Error(`缺判据 ${item.criterionId}`);
if (args.dryRun) {
  process.stdout.write(`S4 review probe dry-run：${cases.length} cases × ${args.repeats}；网络调用 0\n`);
} else {
  if (fs.existsSync(args.out)) throw new Error(`输出已存在：${args.out}`);
  const rows: Array<Record<string, unknown>> = [];
  const apiKey = key();
  for (const item of cases) for (let repeat = 1; repeat <= args.repeats; repeat += 1) {
    try {
      const criterion = skill.sectionIndex[item.criterionId]!;
      const rendered = prompt(criterion, item.content);
      const parsed = parse(await call(rendered.system, rendered.user, apiKey));
      const verified = verifyFindings(item.content, parsed.findings.map((finding) => ({ criterionId: item.criterionId, ...finding })));
      rows.push({ caseId: item.caseId, criterionId: item.criterionId, expected: item.expected, repeat, verdict: parsed.verdict, findings: parsed.findings, keptFindings: verified.kept });
    } catch (error) {
      rows.push({ caseId: item.caseId, criterionId: item.criterionId, expected: item.expected, repeat, verdict: 'ERROR', error: error instanceof Error ? error.message : String(error), findings: [], keptFindings: [] });
    }
    fs.writeFileSync(`${args.out}.partial`, `${JSON.stringify({ schemaVersion: 1, rows }, null, 2)}\n`);
  }
  const summary = cases.map((item) => {
    const selected = rows.filter((row) => row['caseId'] === item.caseId);
    const accepted = selected.filter((row) => row['verdict'] === item.expected && (item.expected !== 'REVISE' || (row['keptFindings'] as unknown[]).length > 0)).length;
    return { caseId: item.caseId, criterionId: item.criterionId, expected: item.expected, accepted, total: selected.length };
  });
  fs.writeFileSync(args.out, `${JSON.stringify({ schemaVersion: 1, repeats: args.repeats, summary, rows }, null, 2)}\n`, { flag: 'wx' });
  fs.rmSync(`${args.out}.partial`, { force: true });
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  if (summary.some((item) => item.accepted !== item.total)) process.exitCode = 1;
}
