/**
 * R0.5 追加实验：把四条判据**拆开单问**，与 run.mjs 的捆绑提问对照。
 *
 * 起因（见 R0.5 报告复核）：捆绑提问下 6 条 REVISE 里有 5 条是「每条判据恰好
 * 填一条 finding」——模型在填表，不是在逐条判。所以 D3/D4 的 0 分有两种解释：
 *   (a) 这一档模型看不见「事实矛盾 / 停点未兑现」；
 *   (b) 捆绑判决被最显眼的那条判据支配，另外两条根本没被认真执行。
 * 拆开问能把 (a) 和 (b) 分开。
 *
 * 唯一变量纪律：除了「一次只问一条判据」，其余全部与 run.mjs 保持一致——
 * 同模型、同 temperature、同种子、同上下文（执行包/骨架/上一场/槽位目标/正文
 * 一字不删）。**上下文绝不按判据裁剪**，否则就同时动了两个变量，对照作废。
 *
 * 必须同时测两件事：
 *   1. 召回是否回来（D3 的判据三、D4 的判据四是否点火）；
 *   2. **误打回是否炸掉**——场景级判决是四条的 OR，捆绑版是 0/16，
 *      拆开后每条判据各自的假阳会叠加。这是拆开的代价，不测就是自欺。
 */
import { readFileSync, writeFileSync } from 'node:fs';

const envText = readFileSync(new URL('../.env', import.meta.url), 'utf8');
const API_KEY = Object.fromEntries(
  envText
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => l.split(/=(.*)/s).slice(0, 2)),
).DEEPSEEK_API_KEY;
if (!API_KEY) throw new Error('.env 里没有 DEEPSEEK_API_KEY');

const MODEL = 'deepseek-chat';
const TEMPERATURE = 0.2;
const CONCURRENCY = 6;
const SEED = 20260826;

const cases = JSON.parse(readFileSync(new URL('./cases.json', import.meta.url), 'utf8'));
const skillText = readFileSync(new URL('./review-skill.md', import.meta.url), 'utf8');

// ---------- 把判据切成四段（照抄原文，不改写） ----------
const CRITERIA = skillText
  .split(/^## /m)
  .slice(1)
  .map((block) => {
    const nl = block.indexOf('\n');
    return { name: block.slice(0, nl).trim(), body: block.slice(nl + 1).trim() };
  });
if (CRITERIA.length !== 4) throw new Error(`判据切分出 ${CRITERIA.length} 条，应为 4`);
console.log('判据：', CRITERIA.map((c) => c.name).join(' / '));

// ---------- prompt ----------
// 只讲这一条判据，不提「还有别的判据」——否则模型会去推别的条目。
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
    `## ${criterion.name}`,
    criterion.body,
  ].join('\n');
}

// 与 run.mjs 逐字一致。
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

// ---------- 盲测断言 ----------
const LEAK_PATTERNS = ['label', 'defectKind', 'defectNote', 'caseId', 'pos-', 'neg-', 'ctl-', 'CONTROL', '修改过', '动过手脚', '注入'];
const jobs = [];
for (const c of cases) {
  for (const criterion of CRITERIA) {
    const text = systemFor(criterion) + buildUserText(c);
    for (const p of LEAK_PATTERNS) {
      if (text.includes(p)) throw new Error(`盲测泄漏：${c.caseId}/${criterion.name} 含「${p}」`);
    }
    jobs.push({ c, criterion });
  }
}
console.log(`盲测断言通过：${jobs.length} 次调用的 prompt 均不含答案字段`);

// ---------- 固定种子乱序（与 run.mjs 同算法） ----------
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
        criterion: criterion.name,
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
        console.error(`  [${done}/${order.length}] ${c.caseId}/${criterion.name} 失败：${error.message}`);
        out.push({ ...base, verdict: 'ERROR', findings: [], elapsedMs: null, usage: null, raw: String(error.message) });
      }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return out;
}

console.log(`开始：${jobs.length} 次调用，并发 ${CONCURRENCY}`);
const results = await runAll();
writeFileSync(new URL('./results-split.json', import.meta.url), JSON.stringify(results, null, 2));
const bad = results.filter((r) => r.verdict === 'ERROR' || r.verdict === 'PARSE_ERROR');
let tok = 0;
for (const r of results) tok += (r.usage?.total_tokens ?? 0);
console.log(`完成：${results.length} 次调用，ERROR/PARSE ${bad.length}，合计 ${tok} token → results-split.json`);
