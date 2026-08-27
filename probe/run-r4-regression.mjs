/**
 * R4 端到端回归（实施文档 §6.4）。
 *
 * 它要证明的**只有一件事**：仓库里那份会被真正加载的 `skills/scene-review/SKILL.md`，
 * 和 R0.5 实测出那批数字的东西是同一个。所以：
 *
 * - 判据文本**必须**读 `skills/scene-review/SKILL.md`，**不读** `probe/review-skill.md`。
 *   读旧那份证明的是「那份旧提示词还好使」，而不是「我实现的东西和实测的东西是同一个」——
 *   后者才是这条回归存在的唯一理由。
 * - 判据切分与 `probe/run-split.mjs` 同口径：**一条判据一次调用**（D-23）。
 *   切分规则照 `src/server/application/skill-loader.ts` 的 `parseSections`
 *   （`## S<n>` 才是判据），而不是 run-split 那句朴素的 `split(/^## /m)`——
 *   后者会把非 `S<n>` 的二级标题也数成一条判据。
 * - 除判据来源外，其余全部与 `run-split.mjs` 保持一致：同模型、同 temperature、
 *   同种子、同并发、同上下文（执行包/骨架/上一场/槽位目标/正文一字不删）、
 *   同盲测断言、同 JSON 契约。只动一个变量，对照才成立。
 *
 * 指标分两类，**含义完全不同，不许合并成一个数**：
 *
 *   门槛（不达标不能发）：判据一召回 3/3、判据二召回 3/3、四条合起来对 16 条正例误报 0。
 *   基线（只记录，不设门槛）：判据三 0/3、判据四 0/3 —— D-28 的落点。
 *     把测不出来的判据留在线上，它的 0/3 就成了一条可跟踪的基线；
 *     判据若被裁掉，这条基线就不存在，日后的改进也就无从证明。
 *
 * 不覆盖 `probe/` 下任何既有文件：结果写 `probe/results-r4.json`。
 *
 * 用法：
 *   node probe/run-r4-regression.mjs --dry-run   # 只装配 prompt，不发任何请求
 *   node probe/run-r4-regression.mjs             # 真跑，116 次调用，花钱
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import process from 'node:process';

const DRY_RUN = process.argv.includes('--dry-run');

const MODEL = 'deepseek-chat';
const TEMPERATURE = 0.2;
const CONCURRENCY = 6;
const SEED = 20260826;
const OUT_URL = new URL('./results-r4.json', import.meta.url);

// ---------- 判据：读产品那份 SKILL.md，按 skill-loader 的规则切 ----------
const SKILL_URL = new URL('../skills/scene-review/SKILL.md', import.meta.url);
const skillRaw = readFileSync(SKILL_URL, 'utf8').replace(/^﻿/, '').replace(/\r\n/g, '\n');
if (!skillRaw.startsWith('---\n')) throw new Error('scene-review/SKILL.md 缺 frontmatter');
const fmEnd = skillRaw.indexOf('\n---', 3);
const skillBody = skillRaw.slice(skillRaw.indexOf('\n', fmEnd + 1) + 1);

// 与 skill-loader.ts 的 SECTION_HEADING_PATTERN / ANY_HEADING_PATTERN 同规则：
// `## S<n>` 起一条判据，任何其他一级/二级标题终止当前判据。
const SECTION_HEADING = /^##\s+(S\d+)\.?(?:\s+(.*))?$/;
const ANY_HEADING = /^#{1,2}\s/;
const CRITERIA = [];
let current = null;
for (const line of skillBody.split('\n')) {
  const heading = SECTION_HEADING.exec(line);
  if (heading !== null) {
    if (current !== null) CRITERIA.push(current);
    current = { id: heading[1], title: (heading[2] ?? '').trim(), lines: [] };
    continue;
  }
  if (ANY_HEADING.test(line) && current !== null) {
    CRITERIA.push(current);
    current = null;
    continue;
  }
  if (current !== null) current.lines.push(line);
}
if (current !== null) CRITERIA.push(current);
for (const c of CRITERIA) c.body = c.lines.join('\n').trim();

const EXPECTED_IDS = ['S1', 'S2', 'S3', 'S4'];
if (CRITERIA.map((c) => c.id).join(',') !== EXPECTED_IDS.join(',')) {
  // 四条判据全部上线是 D-28 的定案。少一条就说明有人为了「反正测不出来」把它摘了，
  // 而摘掉之后这份回归报出来的数字与历史基线不再可比。
  throw new Error(`判据应为 ${EXPECTED_IDS.join('/')}，实际切出 ${CRITERIA.map((c) => c.id).join('/') || '（空）'}`);
}

/** 判据 → 它对口的注入缺陷类型。召回只按对口判据算（附录 §1 的口径） */
const CRITERION_TARGET = {
  S1: 'D1-承接断裂',
  S2: 'D2-心理解释',
  S3: 'D3-事实矛盾',
  S4: 'D4-停错地方',
};
/** 门槛判据 vs 基线判据（§6.4 的两类指标，不许合并） */
const GATE_CRITERIA = ['S1', 'S2'];
const BASELINE_CRITERIA = ['S3', 'S4'];

// ---------- prompt ----------
// 判据块的渲染与 context-builder.ts 的 criterionBlock 同形（`## S1. 标题` + 正文）。
// 只讲这一条判据，不提「还有别的判据」（D-23 / AC-R-002）。
function criterionBlock(criterion) {
  return `## ${criterion.id}${criterion.title === '' ? '' : `. ${criterion.title}`}\n${criterion.body}`;
}

// 这几行与 run-split.mjs 逐字一致——除判据来源外不动第二个变量。
function systemFor(criterion) {
  return [
    '你是一个结构槽写作平台的内容审核员。写作 Agent 提交的正文必须遵守【审核判据】里的工作规范。',
    '你会拿到：章节执行包、章节骨架、上一场景正文（可能没有）、本槽位目标、待审正文。',
    '本次只审【审核判据】这一条，不要评价它没有涵盖的方面。',
    '违反这一条判 REVISE 并给出 findings；满足这一条判 PASS，findings 为空数组。',
    '每条 finding 的 quote 必须逐字出自待审正文，problem 要说明它为什么违反这条判据。',
    '只返回一个 JSON 对象，形如：',
    '{"verdict":"PASS"|"REVISE","findings":[{"quote":"待审正文中的原句","problem":"问题说明"}]}',
    '',
    '【审核判据】',
    criterionBlock(criterion),
  ].join('\n');
}

// 与 run.mjs / run-split.mjs 逐字一致。
function buildUserText(c) {
  return [
    '【章节执行包】',
    c.chapterPacket,
    '',
    '【章节骨架】',
    c.outline,
    '',
    '【上一场景正文】',
    c.prevSceneContent ?? '（本场景是第一场，没有上一场景。）',
    '',
    '【本槽位目标】',
    c.instruction,
    '',
    '【待审正文】',
    c.content,
    '',
    '请按这条判据审核，返回 JSON。',
  ].join('\n');
}

// ---------- 用例与盲测断言 ----------
const cases = JSON.parse(readFileSync(new URL('./cases.json', import.meta.url), 'utf8'));
const LEAK_PATTERNS = ['label', 'defectKind', 'defectNote', 'caseId', 'pos-', 'neg-', 'ctl-', 'CONTROL', '修改过', '动过手脚', '注入'];
const jobs = [];
for (const c of cases) {
  for (const criterion of CRITERIA) {
    const text = systemFor(criterion) + buildUserText(c);
    for (const p of LEAK_PATTERNS) {
      if (text.includes(p)) throw new Error(`盲测泄漏：${c.caseId}/${criterion.id} 含「${p}」`);
    }
    jobs.push({ c, criterion });
  }
}

const positives = cases.filter((c) => c.label === 'PASS');
const negativesByKind = {};
for (const c of cases.filter((x) => x.label === 'REVISE')) (negativesByKind[c.defectKind] ??= []).push(c);
const controls = cases.filter((c) => c.label === 'CONTROL');

console.log(`判据来源：skills/scene-review/SKILL.md（不是 probe/review-skill.md）`);
console.log(`判据：${CRITERIA.map((c) => `${c.id}. ${c.title}`).join(' | ')}`);
console.log(`用例：${cases.length} 条 = 正例 ${positives.length} · 反例 ${cases.length - positives.length - controls.length} · 对照 ${controls.length}`);
for (const [kind, list] of Object.entries(negativesByKind)) console.log(`  反例 ${kind}：${list.length} 条`);
console.log(`调用规模：${cases.length} × ${CRITERIA.length} = ${jobs.length} 次`);
console.log(`盲测断言通过：${jobs.length} 次调用的 prompt 均不含答案字段`);

if (DRY_RUN) {
  console.log('\n================ DRY RUN：只装配 prompt，不发任何请求 ================');
  for (const criterion of CRITERIA) {
    const target = CRITERION_TARGET[criterion.id];
    const targetCount = (negativesByKind[target] ?? []).length;
    const role = GATE_CRITERIA.includes(criterion.id) ? '门槛（召回 3/3）' : '基线（记录 0/3，不设门槛）';
    console.log(`\n──────── ${criterion.id} · ${criterion.title}`);
    console.log(`对口缺陷：${target}（反例 ${targetCount} 条） · 角色：${role}`);
    console.log(`本条判据的调用数：${cases.length}（每条用例一次）`);
    console.log('--- system prompt（逐字，正文部分随用例变化的只有 user message）---');
    console.log(systemFor(criterion));
  }
  const sample = cases[0];
  console.log(`\n──────── user message 样例（${sample.caseId} 一条，其余同形）`);
  const userSample = buildUserText(sample);
  console.log(`长度 ${userSample.length} 字符；结构：`);
  console.log(userSample.split('\n').filter((l) => l.startsWith('【')).join(' / '));
  const approxChars = jobs.reduce((s, j) => s + systemFor(j.criterion).length + buildUserText(j.c).length, 0);
  console.log(`\n全部 ${jobs.length} 次调用的 prompt 合计约 ${approxChars} 字符（不含输出）。`);
  console.log('真跑请去掉 --dry-run。');
  process.exit(0);
}

// ---------- 以下只有真跑才会执行 ----------
if (existsSync(OUT_URL)) {
  // probe/ 下既有的结果文件是回归基线，覆盖了就再没有可比性。
  throw new Error('probe/results-r4.json 已存在。先把它挪走或改名，本脚本不覆盖任何结果文件。');
}

const envText = readFileSync(new URL('../.env', import.meta.url), 'utf8');
const API_KEY = Object.fromEntries(
  envText
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => l.split(/=(.*)/s).slice(0, 2)),
).DEEPSEEK_API_KEY;
if (!API_KEY) throw new Error('.env 里没有 DEEPSEEK_API_KEY');

/** 固定种子乱序（与 run.mjs / run-split.mjs 同算法） */
function shuffled(arr) {
  let s = SEED;
  const rand = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

async function callOnce(system, user) {
  const body = {
    model: MODEL,
    temperature: TEMPERATURE,
    response_format: { type: 'json_object' },
    max_tokens: 2000,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  };
  const started = Date.now();
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch('https://api.deepseek.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${API_KEY}` },
        body: JSON.stringify(body),
      });
      if (res.status === 429 || res.status >= 500) {
        lastError = new Error(`HTTP ${res.status}`);
        await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const json = await res.json();
      return {
        elapsedMs: Date.now() - started,
        usage: json.usage ?? null,
        raw: json.choices?.[0]?.message?.content ?? '',
      };
    } catch (error) {
      if (error.message?.startsWith('HTTP 4')) throw error;
      lastError = error;
      await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
    }
  }
  throw lastError;
}

function parseVerdict(raw) {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) return { verdict: 'PARSE_ERROR', findings: [] };
  try {
    const obj = JSON.parse(raw.slice(start, end + 1));
    const verdict = obj.verdict === 'REVISE' ? 'REVISE' : obj.verdict === 'PASS' ? 'PASS' : 'PARSE_ERROR';
    const findings = Array.isArray(obj.findings)
      ? obj.findings
          .filter((f) => f && typeof f === 'object')
          .map((f) => ({ quote: String(f.quote ?? ''), problem: String(f.problem ?? '') }))
      : [];
    return { verdict, findings };
  } catch {
    return { verdict: 'PARSE_ERROR', findings: [] };
  }
}

const storyOf = (c) =>
  c.chapterPacket.includes('沈家') ? '沈家分家会' : c.chapterPacket.includes('林昭') ? '深夜来电' : '林越雨夜';

async function runAll() {
  const order = shuffled(jobs);
  const out = [];
  let done = 0;
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= order.length) return;
      const { c, criterion } = order[i];
      const base = {
        caseId: c.caseId,
        criterionId: criterion.id,
        criterionTitle: criterion.title,
        label: c.label,
        defectKind: c.defectKind,
        story: storyOf(c),
        taskName: c.taskName,
        slotId: c.slotId,
      };
      try {
        const { elapsedMs, usage, raw } = await callOnce(systemFor(criterion), buildUserText(c));
        const { verdict, findings } = parseVerdict(raw);
        out.push({ ...base, verdict, findings, elapsedMs, usage, raw });
        done++;
        if (done % 10 === 0 || done === order.length) console.log(`  [${done}/${order.length}]`);
      } catch (error) {
        done++;
        console.error(`  [${done}/${order.length}] ${c.caseId}/${criterion.id} 失败：${error.message}`);
        out.push({ ...base, verdict: 'ERROR', findings: [], elapsedMs: null, usage: null, raw: String(error.message) });
      }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return out;
}

console.log(`\n开始：${jobs.length} 次调用，并发 ${CONCURRENCY}`);
const results = await runAll();
writeFileSync(OUT_URL, JSON.stringify(results, null, 2));

// ---------- 报表：门槛与基线分开报 ----------
const at = (criterionId, caseId) => results.find((r) => r.criterionId === criterionId && r.caseId === caseId);
const fired = (criterionId, caseId) => at(criterionId, caseId)?.verdict === 'REVISE';

const recall = {};
for (const criterion of CRITERIA) {
  const target = CRITERION_TARGET[criterion.id];
  const list = negativesByKind[target] ?? [];
  const hit = list.filter((c) => fired(criterion.id, c.caseId));
  recall[criterion.id] = { target, hit: hit.length, total: list.length, hitIds: hit.map((c) => c.caseId) };
}

// 误报按**场景级**算：四条判据里任意一条打回，这条正例就算被误打回。
// 拆开单问的代价正是「每条判据的假阳会叠加」，只报各自的数会把这件事藏起来。
const falsePositives = positives.filter((c) => CRITERIA.some((k) => fired(k.id, c.caseId)));
const fpByCriterion = Object.fromEntries(
  CRITERIA.map((k) => [k.id, positives.filter((c) => fired(k.id, c.caseId)).map((c) => c.caseId)]),
);
const controlFired = controls.filter((c) => CRITERIA.some((k) => fired(k.id, c.caseId)));
const bad = results.filter((r) => r.verdict === 'ERROR' || r.verdict === 'PARSE_ERROR');
const tokens = results.reduce((s, r) => s + (r.usage?.total_tokens ?? 0), 0);

console.log('\n================ 门槛（不达标不能发） ================');
let gateOk = true;
for (const id of GATE_CRITERIA) {
  const r = recall[id];
  const ok = r.hit === r.total && r.total > 0;
  gateOk &&= ok;
  console.log(`${ok ? '✅' : '❌'} 判据 ${id} 对 ${r.target} 召回 ${r.hit}/${r.total}${r.hitIds.length ? `（${r.hitIds.join(', ')}）` : ''}`);
}
const fpOk = falsePositives.length === 0;
gateOk &&= fpOk;
console.log(`${fpOk ? '✅' : '❌'} 四条判据合起来对 ${positives.length} 条正例误报 ${falsePositives.length}${falsePositives.length ? `（${falsePositives.map((c) => c.caseId).join(', ')}）` : ''}`);
for (const [id, ids] of Object.entries(fpByCriterion)) console.log(`      其中判据 ${id}：${ids.length}/${positives.length}${ids.length ? `（${ids.join(', ')}）` : ''}`);
const parseOk = bad.length === 0;
gateOk &&= parseOk;
console.log(`${parseOk ? '✅' : '❌'} ERROR/PARSE_ERROR ${bad.length} 次${bad.length ? `（${bad.map((r) => `${r.caseId}/${r.criterionId}`).join(', ')}）` : ''}`);

console.log('\n================ 基线（只记录，不设门槛 · D-28） ================');
for (const id of BASELINE_CRITERIA) {
  const r = recall[id];
  console.log(`   判据 ${id} 对 ${r.target} 召回 ${r.hit}/${r.total}${r.hitIds.length ? `（${r.hitIds.join(', ')}）` : ''} —— R0.5 基线 0/3`);
}
console.log('   这两个数字动了（往上），说明换模型/改判据起了作用；没动，说明还在能力边界内。');
console.log('   它们**不是**发布闸门：判据三/四误报为 0，不添乱，留在线上正是为了让这条基线存在。');

console.log('\n================ 其他 ================');
console.log(`对照 ctl-29（句序倒置，不应被打回）：${controlFired.length === 0 ? '未被打回' : `被打回（${controlFired.map((c) => c.caseId).join(', ')}）`}`);
console.log(`合计 ${results.length} 次调用，${tokens} token → probe/results-r4.json`);
console.log(`\n${gateOk ? '门槛达标。' : '门槛未达标——不能发。'}`);
process.exit(gateOk ? 0 : 1);
