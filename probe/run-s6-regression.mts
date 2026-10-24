#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { parseSkill } from '../src/server/application/skill-loader.ts';

const source = new URL('../skills-variants/s6/scene-review/SKILL.md', import.meta.url);
const loaded = parseSkill(readFileSync(source, 'utf8'), source.pathname);
const criterion = loaded.sectionIndex['S5'];
if (criterion === undefined) throw new Error('S6 reviewer 变体缺少 S5');
const cases = JSON.parse(readFileSync(new URL('./s6-cases.json', import.meta.url), 'utf8')) as Array<{
  caseId: string;
  label: string;
  instruction: string;
  content: string;
}>;
const leakPatterns = ['caseId', 'label', 'NO_FINDING', 'REVISE', 'clean-', 'redundant-', 'emotion-'];
for (const item of cases) {
  const prompt = [
    `## ${criterion.id}. ${criterion.title}`,
    criterion.content,
    '【本槽位目标】',
    item.instruction,
    '【待审正文】',
    item.content,
  ].join('\n\n');
  const leaked = leakPatterns.filter((pattern) => prompt.includes(pattern));
  if (leaked.length > 0) throw new Error(`${item.caseId} prompt 泄漏答案字段：${leaked.join(',')}`);
}
process.stdout.write(`S6 reviewer dry-run：${cases.length} cases × S5；盲测泄漏 0；网络调用 0\n`);
