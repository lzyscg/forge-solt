/**
 * R0.5 预研：从 results.json + cases.json 计算 §4.2 的全部指标。
 *
 * 口径：
 * - 召回率按缺陷类型分开报；CONTROL 不计入召回也不计入误打回，单独报。
 * - 误打回率 = 正例中判 REVISE 的比例（被打回的正例列出 caseId 供人工判读）。
 * - 目标定位准确率 = 判 REVISE 的反例中，finding 指向注入缺陷的比例。
 *   「指向」用每类缺陷的关键词做机械匹配，finding 原文另存 results.json 供人读核对。
 * - 证据有效率 = quote 非空且逐字出现在待审正文里的 finding 比例。
 * - 全部指标再按故事拆一遍（§2.1 / §5.4：不合并）。
 */
import { readFileSync } from 'node:fs';

const results = JSON.parse(readFileSync(new URL('./results.json', import.meta.url), 'utf8'));
const cases = JSON.parse(readFileSync(new URL('./cases.json', import.meta.url), 'utf8'));
const contentByCase = new Map(cases.map((c) => [c.caseId, c.content]));

const pct = (n, d) => (d === 0 ? 'n/a' : `${Math.round((n / d) * 100)}% (${n}/${d})`);

// 每类缺陷「指向注入缺陷」的关键词（criterion+problem+quote 全文匹配）
const TARGET_KEYWORDS = {
  'D1-承接断裂': ['开头', '首段', '衔接', '上一场', '结尾', '承接', '状态'],
  'D2-心理解释': ['心理', '解释', '内心', '事件', '行动', '摄像机', '可见'],
  'D3-事实矛盾': ['凭证', '欠条', '布包', '信封', '矛盾', '不一致', '骨架', '冲突'],
  'D4-停错地方': ['停', '结尾', '兑现', '收束', '目标'],
};

function targetHit(r) {
  const kws = TARGET_KEYWORDS[r.defectKind];
  if (!kws) return false;
  return r.findings.some((f) => {
    const text = `${f.criterion} ${f.problem} ${f.quote}`;
    return kws.some((k) => text.includes(k));
  });
}

function evidenceStats(rs) {
  let total = 0;
  let valid = 0;
  for (const r of rs) {
    const content = contentByCase.get(r.caseId) ?? '';
    for (const f of r.findings) {
      if (f.quote === '') continue;
      total++;
      if (content.includes(f.quote)) valid++;
    }
  }
  return { total, valid };
}

function block(title, rs) {
  const pos = rs.filter((r) => r.label === 'PASS');
  const neg = rs.filter((r) => r.label === 'REVISE');
  const ctl = rs.filter((r) => r.label === 'CONTROL');
  const revisePos = pos.filter((r) => r.verdict === 'REVISE');
  const reviseNeg = neg.filter((r) => r.verdict === 'REVISE');

  console.log(`\n===== ${title} =====`);
  console.log(`样本：正例 ${pos.length} · 反例 ${neg.length} · 对照 ${ctl.length}`);
  console.log(`误打回率（正例被判 REVISE）：${pct(revisePos.length, pos.length)}`);
  for (const r of revisePos) console.log(`    被打回正例 ${r.caseId}（${r.taskName}/${r.slotId}）→ 需人工判读`);
  console.log(`应打回召回率（反例被判 REVISE）：${pct(reviseNeg.length, neg.length)}`);
  const byKind = {};
  for (const r of neg) (byKind[r.defectKind] ??= []).push(r);
  for (const [kind, list] of Object.entries(byKind)) {
    const hit = list.filter((r) => r.verdict === 'REVISE');
    const located = hit.filter(targetHit);
    console.log(`  ${kind}：召回 ${pct(hit.length, list.length)}，其中目标定位 ${pct(located.length, hit.length)}`);
    for (const r of hit) {
      console.log(`    ${r.caseId} ${r.verdict}${targetHit(r) ? '·定位命中' : '·定位未命中'}`);
    }
  }
  const ev = evidenceStats(rs);
  console.log(`证据有效率（quote 逐字在正文中）：${pct(ev.valid, ev.total)}`);
  const timed = rs.filter((r) => r.elapsedMs !== null);
  const avgMs = timed.reduce((s, r) => s + r.elapsedMs, 0) / Math.max(1, timed.length);
  const tokens = rs.reduce(
    (s, r) => s + (r.usage ? (r.usage.prompt_tokens ?? 0) + (r.usage.completion_tokens ?? 0) : 0),
    0,
  );
  const promptTokens = rs.reduce((s, r) => s + (r.usage?.prompt_tokens ?? 0), 0);
  const completionTokens = rs.reduce((s, r) => s + (r.usage?.completion_tokens ?? 0), 0);
  console.log(`平均耗时 ${(avgMs / 1000).toFixed(1)}s · token 合计 ${tokens}（输入 ${promptTokens} / 输出 ${completionTokens}）`);
  if (ctl.length > 0) {
    console.log(`对照（句序倒置，不应被打回）：${ctl.map((r) => r.verdict).join(', ')}`);
  }
  const bad = rs.filter((r) => r.verdict === 'ERROR' || r.verdict === 'PARSE_ERROR');
  if (bad.length > 0) console.log(`⚠ ERROR/PARSE_ERROR：${bad.map((r) => r.caseId).join(', ')}`);
}

block('总体', results);
for (const story of ['林越雨夜', '沈家分家会', '深夜来电']) {
  block(`故事：${story}`, results.filter((r) => r.story === story));
}

// 被打回反例的 finding 原文（§5.6：只报数字不留证据 = 假绿）
console.log('\n===== 判 REVISE 的反例 finding 原文 =====');
for (const r of results.filter((x) => x.label === 'REVISE' && x.verdict === 'REVISE')) {
  console.log(`\n--- ${r.caseId} ${r.defectKind}（注入：${r.defectNote}）`);
  for (const f of r.findings) {
    console.log(`  [${f.criterion}] ${f.problem}\n    quote: ${f.quote.slice(0, 80)}`);
  }
}
console.log('\n===== 被打回的正例 finding 原文（人工判读用） =====');
for (const r of results.filter((x) => x.label === 'PASS' && x.verdict === 'REVISE')) {
  console.log(`\n--- ${r.caseId}（${r.taskName}/${r.slotId}）`);
  for (const f of r.findings) {
    console.log(`  [${f.criterion}] ${f.problem}\n    quote: ${f.quote.slice(0, 80)}`);
  }
}
