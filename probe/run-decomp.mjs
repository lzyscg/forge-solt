/**
 * R0.5 追加实验之二：给判据三/四**加一个强制的对账步骤**，看 0/3 是不是能救回来。
 *
 * 起因：run-split.mjs 已经证明拆开单问救不回 D3/D4（对口判据仍 0/3），
 * 排除了「捆绑判决被最显眼的判据支配」这个解释。但还剩一个混淆没排除：
 *
 *   `review-skill.md` 的四条判据是**照抄写作 SKILL** 的（计划 §2.3 的纪律：
 *   测模型能不能 judge，不测两份标准的分歧）。而写作 SKILL 里，
 *     判据二有「摄像机拍不拍得到」这种可判定的规则 + 差/好例子；
 *     判据三只有一句「别和别的场次撞设定」；
 *     判据四只有「停在哪里要兑现」。
 *   后两条是**写给写作者的指令**，不是**写给审核者的检查步骤**。
 *   所以 0/3 可能是「模型看不见」，也可能是「判据没告诉它去查什么」。
 *
 * 这一版把三/四改写成强制对账：先把要核对的东西**原样抄出来**，再判决。
 * 三/四之外不动。产品里的审核 Skill 本来就不必是写作 Skill 的副本，
 * 所以这是合法的下一步——但报告里必须写明**判据文本已改**，
 * 与 run.mjs / run-split.mjs 的判据文本不再可比。
 *
 * 同样必须测误打回：强制对账很可能把模型逼成「鸡蛋里挑骨头」，
 * 那 16 条正例上的 0/16 就会塌掉。那才是这个改法的真实代价。
 */
import { readFileSync, writeFileSync } from 'node:fs';

const envText = readFileSync(new URL('../.env', import.meta.url), 'utf8');
const API_KEY = Object.fromEntries(
  envText.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
    .map((l) => l.split(/=(.*)/s).slice(0, 2)),
).DEEPSEEK_API_KEY;
if (!API_KEY) throw new Error('.env 里没有 DEEPSEEK_API_KEY');

const MODEL = 'deepseek-chat';
const TEMPERATURE = 0.2;
const CONCURRENCY = 6;
const SEED = 20260826;

const cases = JSON.parse(readFileSync(new URL('./cases.json', import.meta.url), 'utf8'));

// ---------- 改写后的两条判据：把「判断」拆成「先对账、再判决」 ----------
const CRITERIA = [
  {
    key: '判据三',
    name: '判据三：不与骨架/别的场次撞设定',
    system: [
      '你是内容审核员。本次只做一件事：**核对设定一致性**。',
      '',
      '按顺序执行，不要跳步：',
      '1. 通读【章节骨架】和【待审正文】，列出正文里出现的关键实体——',
      '   人物称呼、关键物件（文件/信物/器具等）、时间点、地点、金额。',
      '2. 对每一个实体，逐一核对两件事：',
      '   a) 它在【待审正文】内部前后的叫法与属性是否一致（同一样东西有没有被换成另一个名字）；',
      '   b) 它与【章节骨架】【上一场景正文】里的说法是否一致。',
      '3. 只要有任何一个实体在 a 或 b 上对不上，就判 REVISE，并在 findings 里给出正文原句。',
      '   全部对得上才判 PASS。',
      '',
      '只返回一个 JSON 对象：',
      '{"inventory":[{"entity":"实体名","正文里的说法":"...","骨架里的说法":"...","一致":true|false}],',
      ' "verdict":"PASS"|"REVISE",',
      ' "findings":[{"quote":"待审正文中的原句","problem":"它和什么对不上"}]}',
      'quote 必须逐字出自【待审正文】。',
    ].join('\n'),
  },
  {
    key: '判据四',
    name: '判据四：「停在哪里」必须兑现',
    system: [
      '你是内容审核员。本次只做一件事：**核对本场是否停在了指定的位置**。',
      '',
      '按顺序执行，不要跳步：',
      '1. 从【本槽位目标】里，把关于「停在哪里」的要求**原样抄出来**（逐字，不要转述）。',
      '2. 把【待审正文】的**最后两段原样抄出来**（逐字，不要转述）。',
      '3. 逐项比对：第 1 步要求的那个结束状态——人在哪、手上有什么、',
      '   刚发生了什么、留给下一场的抓手是什么——在第 2 步的文字里**是否都出现了**。',
      '4. 只要有任何一项没有出现，就判 REVISE。全部出现才判 PASS。',
      '',
      '只返回一个 JSON 对象：',
      '{"要求原文":"第1步抄出的要求","结尾原文":"第2步抄出的最后两段",',
      ' "逐项比对":[{"要求项":"...","正文是否兑现":true|false,"依据":"..."}],',
      ' "verdict":"PASS"|"REVISE",',
      ' "findings":[{"quote":"待审正文中的原句","problem":"哪一项没兑现"}]}',
      'quote 必须逐字出自【待审正文】。',
    ].join('\n'),
  },
];

// 与 run.mjs / run-split.mjs 逐字一致——上下文不动，只动判据文本。
function buildUserText(c) {
  return [
    '【章节执行包】', c.chapterPacket, '',
    '【章节骨架】', c.outline, '',
    '【上一场景正文】', c.prevSceneContent ?? '（本场景是第一场，没有上一场景。）', '',
    '【本槽位目标】', c.instruction, '',
    '【待审正文】', c.content, '',
    '请按上面的步骤执行，返回 JSON。',
  ].join('\n');
}

const LEAK_PATTERNS = ['label', 'defectKind', 'defectNote', 'caseId', 'pos-', 'neg-', 'ctl-', 'CONTROL', '修改过', '动过手脚', '注入'];
const jobs = [];
for (const c of cases) for (const cr of CRITERIA) {
  const text = cr.system + buildUserText(c);
  for (const p of LEAK_PATTERNS) if (text.includes(p)) throw new Error(`盲测泄漏：${c.caseId}/${cr.key} 含「${p}」`);
  jobs.push({ c, cr });
}
console.log(`盲测断言通过：${jobs.length} 次调用`);

function shuffled(arr) {
  let s = SEED;
  const rand = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; }
  return out;
}

async function callOnce(system, user) {
  const body = { model: MODEL, temperature: TEMPERATURE, response_format: { type: 'json_object' }, max_tokens: 3000,
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }] };
  const started = Date.now();
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch('https://api.deepseek.com/v1/chat/completions', {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${API_KEY}` }, body: JSON.stringify(body) });
      if (res.status === 429 || res.status >= 500) { lastError = new Error(`HTTP ${res.status}`); await new Promise((r) => setTimeout(r, 3000 * (attempt + 1))); continue; }
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const json = await res.json();
      return { elapsedMs: Date.now() - started, usage: json.usage ?? null, raw: json.choices?.[0]?.message?.content ?? '' };
    } catch (error) {
      if (error.message?.startsWith('HTTP 4')) throw error;
      lastError = error; await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
    }
  }
  throw lastError;
}

function parseVerdict(raw) {
  const start = raw.indexOf('{'), end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) return { verdict: 'PARSE_ERROR', findings: [], work: null };
  try {
    const o = JSON.parse(raw.slice(start, end + 1));
    return {
      verdict: o.verdict === 'REVISE' ? 'REVISE' : o.verdict === 'PASS' ? 'PASS' : 'PARSE_ERROR',
      findings: Array.isArray(o.findings) ? o.findings.filter((f) => f && typeof f === 'object')
        .map((f) => ({ quote: String(f.quote ?? ''), problem: String(f.problem ?? '') })) : [],
      work: { inventory: o.inventory ?? null, 要求原文: o.要求原文 ?? null, 结尾原文: o.结尾原文 ?? null, 逐项比对: o.逐项比对 ?? null },
    };
  } catch { return { verdict: 'PARSE_ERROR', findings: [], work: null }; }
}

const storyOf = (c) => c.chapterPacket.includes('沈家') ? '沈家分家会' : c.chapterPacket.includes('林昭') ? '深夜来电' : '林越雨夜';

const order = shuffled(jobs);
const out = [];
let done = 0, next = 0;
await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
  for (;;) {
    const i = next++;
    if (i >= order.length) return;
    const { c, cr } = order[i];
    const base = { caseId: c.caseId, criterion: cr.name, criterionKey: cr.key, label: c.label, defectKind: c.defectKind, story: storyOf(c), taskName: c.taskName, slotId: c.slotId };
    try {
      const { elapsedMs, usage, raw } = await callOnce(cr.system, buildUserText(c));
      out.push({ ...base, ...parseVerdict(raw), elapsedMs, usage, raw });
    } catch (error) {
      console.error(`  ${c.caseId}/${cr.key} 失败：${error.message}`);
      out.push({ ...base, verdict: 'ERROR', findings: [], work: null, elapsedMs: null, usage: null, raw: String(error.message) });
    }
    done++;
    if (done % 10 === 0 || done === order.length) console.log(`  [${done}/${order.length}]`);
  }
}));

writeFileSync(new URL('./results-decomp.json', import.meta.url), JSON.stringify(out, null, 2));
let tok = 0; for (const r of out) tok += r.usage?.total_tokens ?? 0;
console.log(`完成：${out.length} 次，ERROR/PARSE ${out.filter((r) => r.verdict === 'ERROR' || r.verdict === 'PARSE_ERROR').length}，${tok} token → results-decomp.json`);
