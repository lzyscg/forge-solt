/**
 * R0.5 预研：把 cases.json 逐例送 DeepSeek 盲测，产出 results.json。
 *
 * 纪律（§4.1 / §5）：
 * - 直连 /chat/completions，不走 src/ 的适配器（预研不耦合产品代码）。
 * - 盲测：label / defectKind / defectNote / caseId 绝不进 prompt，跑前断言。
 * - 问法是「按判据审核」，不是「找出被动过手脚的地方」。
 * - 顺序用固定种子打乱（可复现），不让正例反例扎堆。
 * - 每例跑 1 次（§5.5：样本靠用例数不靠重复数）。
 * - 每例记 verdict / findings / 耗时 / token，finding 原文留存（§5.6）。
 * - 密钥只从 .env 读，不打印、不写进任何产出。
 */
import { readFileSync, writeFileSync } from 'node:fs';

// ---------- 配置 ----------
const envText = readFileSync(new URL('../.env', import.meta.url), 'utf8');
const API_KEY = Object.fromEntries(
  envText
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => l.split(/=(.*)/s).slice(0, 2)),
).DEEPSEEK_API_KEY;
if (!API_KEY) throw new Error('.env 里没有 DEEPSEEK_API_KEY');

const MODEL = 'deepseek-chat'; // 与产线写作同档（§1 的问题就是「这一档能不能 judge」）
const TEMPERATURE = 0.2; // 单跑不重跑，低温压采样方差；报告里声明
const CONCURRENCY = 4;
const SEED = 20260826;

const cases = JSON.parse(readFileSync(new URL('./cases.json', import.meta.url), 'utf8'));
const reviewSkill = readFileSync(new URL('./review-skill.md', import.meta.url), 'utf8');

// ---------- 盲测断言：答案字段一个词都不许进 prompt ----------
const SYSTEM_TEXT = [
  '你是一个结构槽写作平台的内容审核员。写作 Agent 提交的正文必须遵守【审核判据】里的工作规范。',
  '你会拿到：章节执行包、章节骨架、上一场景正文（可能没有）、本槽位目标、待审正文。',
  '按判据审核：逐条核对。违反任何一条判 REVISE，并给出 findings；四条都满足判 PASS，findings 为空数组。',
  '每条 finding 的 quote 必须逐字出自待审正文，problem 要说明它违反了哪条判据、为什么。',
  '只返回一个 JSON 对象，形如：',
  '{"verdict":"PASS"|"REVISE","findings":[{"criterion":"判据名","quote":"待审正文中的原句","problem":"问题说明"}]}',
  '',
  '【审核判据】',
  reviewSkill,
].join('\n');

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
    '请按判据逐条审核，返回 JSON。',
  ].join('\n');
}

const LEAK_PATTERNS = ['label', 'defectKind', 'defectNote', 'caseId', 'pos-', 'neg-', 'ctl-', 'CONTROL', '修改过', '动过手脚', '注入'];
for (const c of cases) {
  const text = SYSTEM_TEXT + buildUserText(c);
  for (const p of LEAK_PATTERNS) {
    if (text.includes(p)) throw new Error(`盲测泄漏：${c.caseId} 的 prompt 含「${p}」`);
  }
}
console.log(`盲测断言通过：${cases.length} 例的 prompt 均不含答案字段`);

// ---------- 固定种子乱序 ----------
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

// ---------- 单例调用 ----------
async function callOnce(c) {
  const body = {
    model: MODEL,
    temperature: TEMPERATURE,
    response_format: { type: 'json_object' },
    max_tokens: 2000,
    messages: [
      { role: 'system', content: SYSTEM_TEXT },
      { role: 'user', content: buildUserText(c) },
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
      if (error.message?.startsWith('HTTP 4')) throw error; // 4xx 不重试
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
          .map((f) => ({
            criterion: String(f.criterion ?? ''),
            quote: String(f.quote ?? ''),
            problem: String(f.problem ?? ''),
          }))
      : [];
    return { verdict, findings };
  } catch {
    return { verdict: 'PARSE_ERROR', findings: [] };
  }
}

// ---------- 并发池 ----------
async function runAll() {
  const order = shuffled(cases);
  const results = new Map();
  let done = 0;
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= order.length) return;
      const c = order[i];
      try {
        const { elapsedMs, usage, raw } = await callOnce(c);
        const { verdict, findings } = parseVerdict(raw);
        results.set(c.caseId, {
          caseId: c.caseId,
          label: c.label,
          defectKind: c.defectKind,
          defectNote: c.defectNote,
          story: c.chapterPacket.includes('沈家')
            ? '沈家分家会'
            : c.chapterPacket.includes('林昭')
              ? '深夜来电'
              : '林越雨夜',
          taskName: c.taskName,
          slotId: c.slotId,
          verdict,
          findings,
          elapsedMs,
          usage,
          raw,
        });
        done++;
        console.log(`[${done}/${order.length}] ${c.caseId} → ${verdict} (${(elapsedMs / 1000).toFixed(1)}s)`);
      } catch (error) {
        done++;
        console.error(`[${done}/${order.length}] ${c.caseId} 失败：${error.message}`);
        results.set(c.caseId, {
          caseId: c.caseId,
          label: c.label,
          defectKind: c.defectKind,
          defectNote: c.defectNote,
          story: c.chapterPacket.includes('沈家')
            ? '沈家分家会'
            : c.chapterPacket.includes('林昭')
              ? '深夜来电'
              : '林越雨夜',
          taskName: c.taskName,
          slotId: c.slotId,
          verdict: 'ERROR',
          findings: [],
          elapsedMs: null,
          usage: null,
          raw: String(error.message),
        });
      }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return cases.map((c) => results.get(c.caseId));
}

const results = await runAll();
writeFileSync(new URL('./results.json', import.meta.url), JSON.stringify(results, null, 2));
const fails = results.filter((r) => r.verdict === 'ERROR' || r.verdict === 'PARSE_ERROR');
console.log(`完成：${results.length} 例，其中 ERROR/PARSE_ERROR ${fails.length} 例 → results.json`);
