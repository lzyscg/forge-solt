#!/usr/bin/env node
/**
 * S2 静态 HTML 报告模块。零外部依赖，复用 bench/fingerprint.mjs 的指标口径。
 *
 * 用法：
 *   node bench/report.mjs --out bench/report.html bench/fixtures/report-synthetic-run.json
 *   node bench/report.mjs --selftest
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fingerprint, judge, loadManifest } from './fingerprint.mjs';

const SCRIPT_OPEN = '<script id="bench-data" type="application/json">';
const SCRIPT_CLOSE = '</script>';
const SCHEMA_VERSION = 1;
const NON_COMPARABLE_METRICS = new Set(['han', 'secs', 'secavg']);

function usage() {
  return `S2 静态 HTML 报告模块

用法：
  node bench/report.mjs --out <报告.html> <run.json> [run2.json ...]
  node bench/report.mjs --selftest

约定：
  - 已存在报告会只替换 ${SCRIPT_OPEN} 内的 JSON，并向 runs 追加新 run。
  - run.json 可包含单个 run 对象，或 { "runs": [...] }。
  - 样本字段建议：id / skill / story / variant / status / output / excluded_reason / usage / elapsed_ms。
`;
}

function stableJson(value) {
  return JSON.stringify(value, null, 2).replace(/</g, '\\u003c');
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function safeId(value, fallback) {
  const s = String(value ?? '').trim();
  return s || fallback;
}

function normalizeStatus(value) {
  if (value === 'failure' || value === 'failed' || value === 'error') return 'failure';
  if (value === 'excluded' || value === 'exclude' || value === 'skipped') return 'excluded';
  return 'success';
}

function sumUsage(samples) {
  const total = {};
  for (const sample of samples) {
    for (const [key, value] of Object.entries(sample.usage ?? {})) {
      if (typeof value === 'number' && Number.isFinite(value)) total[key] = (total[key] ?? 0) + value;
    }
  }
  return total;
}

function variance(values) {
  if (values.length < 2) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
}

function varianceByGroup(samples, distributionKeys) {
  const groups = new Map();
  for (const sample of samples.filter((s) => s.included && s.fingerprint)) {
    const groupId = [sample.skill, sample.story, sample.variant].join(' / ');
    if (!groups.has(groupId)) groups.set(groupId, []);
    groups.get(groupId).push(sample);
  }
  return [...groups.entries()].map(([group, rows]) => {
    const metrics = {};
    for (const key of distributionKeys) {
      const values = rows.map((row) => row.fingerprint[key]).filter((value) => typeof value === 'number' && Number.isFinite(value));
      metrics[key] = { n: values.length, variance: Number(variance(values).toFixed(3)) };
    }
    return { group, n: rows.length, metrics };
  });
}

function exclusionReasons(samples) {
  const reasons = new Map();
  for (const sample of samples) {
    if (sample.status !== 'excluded') continue;
    const reason = sample.excluded_reason || sample.exclusion_reason || sample.reason || '未说明';
    reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
  }
  return [...reasons.entries()].map(([reason, count]) => ({ reason, count }));
}

function normalizeSkillDiff(rawRun, samples) {
  const rawSkills = Array.isArray(rawRun.skills) ? rawRun.skills : [];
  const byId = new Map();
  for (const skill of rawSkills) {
    const id = safeId(skill.id ?? skill.skill, 'unknown-skill');
    byId.set(id, {
      id,
      name: skill.name ?? id,
      baseline: normalizeBaseline(skill.baseline, skill.hash),
      variants: normalizeVariants(skill.variants),
    });
  }

  for (const sample of samples) {
    if (!byId.has(sample.skill)) {
      byId.set(sample.skill, {
        id: sample.skill,
        name: sample.skill,
        baseline: normalizeBaseline({ ref: 'r0', hash: sample.skill_hash ?? sample.hash ?? '未提供', label: '基线' }),
        variants: [],
      });
    }
  }

  return [...byId.values()].map((skill) => ({
    ...skill,
    baseline: { ...skill.baseline, label: skill.baseline.label || '基线', ref: skill.baseline.ref || 'r0' },
    variants: skill.variants.map((variant) => ({ ...variant, label: variant.label || variant.id })),
  }));
}

function normalizeBaseline(value, fallbackHash) {
  if (value && typeof value === 'object') {
    return {
      ref: value.ref ?? value.id ?? 'r0',
      hash: value.hash ?? fallbackHash ?? '未提供',
      label: value.label ?? '基线',
    };
  }
  return { ref: 'r0', hash: fallbackHash ?? '未提供', label: '基线' };
}

function normalizeVariants(value) {
  if (!Array.isArray(value)) return [];
  return value.map((variant, index) => ({
    id: variant.id ?? variant.ref ?? `v${index + 1}`,
    hash: variant.hash ?? '未提供',
    label: variant.label ?? variant.name ?? variant.id ?? `v${index + 1}`,
  }));
}

function normalizeSamples(rawRun, manifest) {
  const source = Array.isArray(rawRun.samples) ? rawRun.samples
    : Array.isArray(rawRun.outputs) ? rawRun.outputs
      : Array.isArray(rawRun.results) ? rawRun.results
        : [];

  return source.map((raw, index) => {
    const status = normalizeStatus(raw.status);
    const output = String(raw.output ?? raw.text ?? raw.content ?? '');
    const fp = output.trim() ? fingerprint(output) : null;
    return {
      id: safeId(raw.id ?? raw.sample_id, `s${index + 1}`),
      skill: safeId(raw.skill ?? raw.skill_id, 'unknown-skill'),
      story: safeId(raw.story ?? raw.story_id ?? raw.case, 'unknown-story'),
      variant: safeId(raw.variant ?? raw.variant_id ?? raw.ref, 'r0'),
      status,
      included: status === 'success',
      excluded_reason: raw.excluded_reason ?? raw.exclusion_reason ?? raw.reason ?? null,
      error: raw.error ?? null,
      usage: raw.usage ?? {},
      elapsed_ms: typeof raw.elapsed_ms === 'number' ? raw.elapsed_ms : raw.elapsedMs ?? null,
      output,
      fingerprint: fp,
      judgement: fp ? judge(fp, manifest) : null,
    };
  });
}

function normalizeRun(rawRun, sourceFile, manifest) {
  const distributionKeys = Object.keys(manifest.分布维度 ?? {});
  const samples = normalizeSamples(rawRun, manifest);
  const stories = new Set(samples.map((sample) => sample.story));
  const variants = new Set(samples.map((sample) => sample.variant));
  const candidates = samples.length;
  const included = samples.filter((sample) => sample.included).length;
  const excluded = samples.filter((sample) => sample.status === 'excluded').length;
  const elapsedValues = samples.map((sample) => sample.elapsed_ms).filter((value) => typeof value === 'number' && Number.isFinite(value));
  const elapsedTotal = elapsedValues.reduce((sum, value) => sum + value, 0);

  return {
    run_id: safeId(rawRun.run_id ?? rawRun.id, path.basename(sourceFile, path.extname(sourceFile))),
    label: rawRun.label ?? rawRun.name ?? null,
    created_at: rawRun.created_at ?? rawRun.createdAt ?? new Date().toISOString(),
    provider: rawRun.provider ?? rawRun.vendor ?? '未提供',
    model: rawRun.model ?? '未提供',
    baseline_conditions: rawRun.baseline_conditions ?? rawRun.baselineConditions ?? {},
    candidates,
    included,
    excluded,
    failures: samples.filter((sample) => sample.status === 'failure').length,
    exclusion_reasons: exclusionReasons(samples),
    n_cross: { stories: stories.size, variants: variants.size, label: `${stories.size}×${variants.size}` },
    usage: rawRun.usage ?? sumUsage(samples),
    elapsed_ms: typeof rawRun.elapsed_ms === 'number' ? rawRun.elapsed_ms : elapsedTotal,
    within_group_variance: varianceByGroup(samples, distributionKeys),
    skills: normalizeSkillDiff(rawRun, samples),
    samples,
  };
}

function manifestForReport(manifest) {
  return {
    n: manifest.n,
    generated_at: manifest._生成日期 ?? null,
    distribution: manifest.分布维度,
    binary: manifest.二值维度,
    non_comparable_metrics: [...NON_COMPARABLE_METRICS],
  };
}

function emptyData(manifest) {
  return {
    schema_version: SCHEMA_VERSION,
    generated_at: new Date().toISOString(),
    manifest: manifestForReport(manifest),
    runs: [],
  };
}

function extractData(html) {
  const start = html.indexOf(SCRIPT_OPEN);
  if (start < 0) throw new Error(`报告缺少 ${SCRIPT_OPEN}`);
  const dataStart = start + SCRIPT_OPEN.length;
  const end = html.indexOf(SCRIPT_CLOSE, dataStart);
  if (end < 0) throw new Error(`报告缺少 ${SCRIPT_CLOSE}`);
  return {
    before: html.slice(0, dataStart),
    json: html.slice(dataStart, end).trim(),
    after: html.slice(end),
  };
}

function replaceData(html, data) {
  const parts = extractData(html);
  return `${parts.before}\n${stableJson(data)}\n${parts.after}`;
}

function loadExistingReport(file, manifest) {
  if (!fs.existsSync(file)) return { html: template(emptyData(manifest)), data: emptyData(manifest) };
  const html = fs.readFileSync(file, 'utf8');
  const parts = extractData(html);
  return { html, data: JSON.parse(parts.json) };
}

function readRuns(files, manifest) {
  return files.flatMap((file) => {
    const raw = readJson(file);
    const rawRuns = Array.isArray(raw.runs) ? raw.runs : [raw];
    return rawRuns.map((run, index) => normalizeRun(run, rawRuns.length > 1 ? `${file}#${index + 1}` : file, manifest));
  });
}

function writeReport({ outFile, runFiles }) {
  const manifest = loadManifest();
  const existing = loadExistingReport(outFile, manifest);
  const newRuns = readRuns(runFiles, manifest);
  const data = {
    ...existing.data,
    schema_version: SCHEMA_VERSION,
    generated_at: new Date().toISOString(),
    manifest: manifestForReport(manifest),
    runs: [...(existing.data.runs ?? []), ...newRuns],
  };
  const html = replaceData(existing.html, data);
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, html);
  return { data, appended: newRuns.length };
}

function stripMutableRegion(html) {
  const parts = extractData(html);
  return `${parts.before}${SCRIPT_CLOSE}${parts.after.slice(SCRIPT_CLOSE.length)}`;
}

function assertSelf(name, condition, detail = '') {
  if (!condition) throw new Error(`${name}${detail ? `: ${detail}` : ''}`);
  console.log(`PASS ${name}`);
}

function cmdSelftest() {
  const fixture = path.join(import.meta.dirname, 'fixtures/report-synthetic-run.json');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-report-'));
  const out = path.join(tmp, 'report.html');

  writeReport({ outFile: out, runFiles: [fixture] });
  const first = fs.readFileSync(out, 'utf8');
  writeReport({ outFile: out, runFiles: [fixture] });
  const second = fs.readFileSync(out, 'utf8');
  const data = JSON.parse(extractData(second).json);

  assertSelf('只有一个 bench-data JSON 脚本', (second.match(/<script id="bench-data" type="application\/json">/g) ?? []).length === 1);
  assertSelf('追加 runs 不改模板区域', stripMutableRegion(first) === stripMutableRegion(second));
  assertSelf('runs 追加两次', data.runs.length === 2, `得到 ${data.runs.length}`);
  assertSelf('复用指纹与判定结果', Boolean(data.runs[0].samples[0].fingerprint && data.runs[0].samples[0].judgement));
  assertSelf('成功/失败/排除样本都在数据中', ['success', 'failure', 'excluded'].every((status) => data.runs[0].samples.some((sample) => sample.status === status)));
  assertSelf('单槽位标记不可比', data.manifest.non_comparable_metrics.includes('han') && second.includes('不可比'));
  assertSelf('不输出总分', !second.includes('总分'));
  assertSelf('r0 无变体仍显示基线与 hash', second.includes('基线') && second.includes('sha256:base-review-0001'));
  assertSelf('显示 baseline_conditions', second.includes('baseline_conditions'));
  console.log(`SELFTEST OK ${out}`);
}

function parseArgs(argv) {
  if (argv.includes('--help') || argv.includes('-h')) return { help: true };
  if (argv.includes('--selftest')) return { selftest: true };
  const outIndex = argv.indexOf('--out');
  if (outIndex < 0 || !argv[outIndex + 1]) throw new Error('缺少 --out <报告.html>');
  const outFile = path.resolve(process.cwd(), argv[outIndex + 1]);
  const runFiles = argv.filter((arg, index) => index !== outIndex && index !== outIndex + 1 && !arg.startsWith('--')).map((file) => path.resolve(process.cwd(), file));
  if (!runFiles.length) throw new Error('至少提供一个 run.json');
  return { outFile, runFiles };
}

function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) { console.log(usage()); return; }
    if (args.selftest) { cmdSelftest(); return; }
    const result = writeReport(args);
    console.log(`已追加 ${result.appended} 个 run，当前共 ${result.data.runs.length} 个 run：${args.outFile}`);
  } catch (error) {
    console.error(error.message);
    console.error('\n' + usage());
    process.exit(1);
  }
}

function template(initialData) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>S2 Benchmark Report</title>
<style>
:root { color-scheme: light dark; --bg:#f7f8fb; --panel:#ffffff; --ink:#172033; --muted:#667085; --line:#d9dee8; --soft:#eef2f7; --accent:#2764d8; --accent-2:#8b5cf6; --ok:#16835b; --warn:#a16207; --bad:#b42318; --skip:#475467; }
@media (prefers-color-scheme: dark) { :root { --bg:#111827; --panel:#182230; --ink:#eef2f7; --muted:#a7b0c0; --line:#344054; --soft:#243143; --accent:#7ba7ff; --accent-2:#c4b5fd; --ok:#58c99a; --warn:#f0b75a; --bad:#ff8a80; --skip:#c3cad5; } }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--ink); font:14px/1.55 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
header { padding:24px clamp(16px, 4vw, 40px) 16px; border-bottom:1px solid var(--line); background:var(--panel); position:sticky; top:0; z-index:10; }
h1 { margin:0 0 6px; font-size:clamp(20px, 4vw, 30px); }
.subtitle { color:var(--muted); margin:0; }
main { padding:20px clamp(12px, 3vw, 32px) 40px; max-width:1480px; margin:0 auto; }
.controls { display:grid; grid-template-columns:repeat(3, minmax(0, 1fr)); gap:12px; margin:18px 0; }
label { display:grid; gap:5px; font-weight:650; }
select { width:100%; padding:9px 10px; border:1px solid var(--line); border-radius:10px; background:var(--panel); color:var(--ink); }
section { background:var(--panel); border:1px solid var(--line); border-radius:16px; padding:16px; margin:16px 0; box-shadow:0 1px 2px rgba(16,24,40,.05); }
h2 { margin:0 0 12px; font-size:20px; }
h3 { margin:16px 0 8px; font-size:16px; }
.grid { display:grid; grid-template-columns:repeat(4, minmax(0, 1fr)); gap:10px; }
.card { border:1px solid var(--line); border-radius:12px; padding:12px; background:linear-gradient(180deg, var(--panel), var(--soft)); min-width:0; }
.k { color:var(--muted); font-size:12px; }
.v { font-size:19px; font-weight:760; overflow-wrap:anywhere; }
.badge { display:inline-flex; align-items:center; gap:6px; border:1px solid var(--line); border-radius:999px; padding:2px 8px; margin:2px 4px 2px 0; color:var(--muted); background:var(--panel); }
.badge::before { content:""; width:8px; height:8px; border-radius:50%; background:var(--skip); }
.badge.success::before { background:var(--ok); }
.badge.failure::before { background:var(--bad); }
.badge.excluded::before { background:var(--skip); }
.badge.warn::before { background:var(--warn); }
.legend { display:flex; flex-wrap:wrap; gap:8px; margin:8px 0; color:var(--muted); }
.chart-grid { display:grid; grid-template-columns:repeat(2, minmax(0, 1fr)); gap:14px; }
.metric { border:1px solid var(--line); border-radius:12px; padding:10px; }
.metric-title { display:flex; align-items:center; justify-content:space-between; gap:8px; font-weight:720; }
.note { color:var(--muted); font-size:12px; }
svg { max-width:100%; height:auto; display:block; overflow:visible; }
.axis text { fill:var(--muted); font-size:11px; }
.axis line, .axis path { stroke:var(--line); }
.band-full { fill:var(--soft); }
.band-p95 { fill:rgba(39,100,216,.20); }
.dot.success { fill:var(--ok); stroke:var(--panel); stroke-width:2; }
.dot.failure { fill:var(--bad); stroke:var(--panel); stroke-width:2; }
.dot.excluded { fill:var(--skip); stroke:var(--panel); stroke-width:2; stroke-dasharray:2 2; }
.tooltip { position:fixed; pointer-events:none; z-index:20; max-width:320px; padding:8px 10px; border:1px solid var(--line); border-radius:10px; background:var(--panel); color:var(--ink); box-shadow:0 8px 20px rgba(16,24,40,.18); display:none; white-space:pre-wrap; }
.outputs { display:grid; grid-template-columns:repeat(2, minmax(0, 1fr)); gap:12px; }
.sample { border:1px solid var(--line); border-radius:12px; padding:12px; min-width:0; }
.sample-head { display:flex; align-items:center; justify-content:space-between; gap:8px; flex-wrap:wrap; }
pre { white-space:pre-wrap; overflow:auto; max-height:420px; margin:10px 0 0; padding:12px; border-radius:10px; background:var(--soft); color:var(--ink); }
table { width:100%; border-collapse:collapse; margin-top:8px; }
th, td { border-bottom:1px solid var(--line); text-align:left; vertical-align:top; padding:8px; }
th { color:var(--muted); font-size:12px; }
code { background:var(--soft); border-radius:6px; padding:1px 5px; }
.diff-grid { display:grid; grid-template-columns:repeat(2, minmax(0, 1fr)); gap:12px; }
.empty { color:var(--muted); padding:16px; border:1px dashed var(--line); border-radius:12px; }
@media (max-width: 860px) { header { position:static; } .controls, .grid, .chart-grid, .outputs, .diff-grid { grid-template-columns:1fr; } section { padding:12px; border-radius:12px; } .v { font-size:17px; } }
@media (forced-colors: active) { .dot { stroke:CanvasText; } .band-p95 { fill:Canvas; stroke:CanvasText; } }
</style>
</head>
<body>
<header>
  <h1>S2 静态 HTML 报告</h1>
  <p class="subtitle">指纹是闸门，不是分数；页面变量数据仅来自 <code>script#bench-data</code>。</p>
  <div class="controls" aria-label="报告筛选">
    <label>Run<select id="run-select"></select></label>
    <label>Skill<select id="skill-filter"></select></label>
    <label>Story<select id="story-filter"></select></label>
  </div>
</header>
<main>
  <section id="overview"></section>
  <section id="fingerprint-gates"></section>
  <section id="outputs"></section>
  <section id="skill-diff"></section>
</main>
<div id="tooltip" class="tooltip" role="status" aria-live="polite"></div>
${SCRIPT_OPEN}
${stableJson(initialData)}
${SCRIPT_CLOSE}
<script>
(() => {
  'use strict';
  const data = JSON.parse(document.getElementById('bench-data').textContent);
  const state = { runIndex: Math.max(0, data.runs.length - 1), skill: '全部', story: '全部' };
  const statusLabels = {"success":"成功","failure":"失败","excluded":"排除"};
  const nonComparable = new Set(data.manifest.non_comparable_metrics || []);
  const $ = (id) => document.getElementById(id);
  const tooltip = $('tooltip');

  function text(value) { return value == null || value === '' ? '未提供' : String(value); }
  function fmt(value) { return typeof value === 'number' ? new Intl.NumberFormat('zh-CN').format(value) : text(value); }
  function ms(value) { return typeof value === 'number' ? (value >= 1000 ? (value / 1000).toFixed(2) + 's' : value + 'ms') : '未提供'; }
  function el(tag, attrs = {}, children = []) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value;
      else node.setAttribute(key, value);
    }
    for (const child of [].concat(children)) node.append(child && child.nodeType ? child : document.createTextNode(String(child ?? '')));
    return node;
  }
  function clear(node) { node.replaceChildren(); }
  function uniq(values) { return [...new Set(values.filter(Boolean))].sort((a, b) => String(a).localeCompare(String(b), 'zh-CN')); }

  function currentRun() { return data.runs[state.runIndex] || null; }
  function filteredSamples(run) {
    return (run?.samples || []).filter((sample) => (state.skill === '全部' || sample.skill === state.skill) && (state.story === '全部' || sample.story === state.story));
  }

  function fillSelect(select, options, value) {
    select.replaceChildren(...options.map((option) => el('option', { value: option, text: option })));
    select.value = options.includes(value) ? value : '全部';
  }

  function renderControls() {
    const runSelect = $('run-select');
    runSelect.replaceChildren(...data.runs.map((run, index) => el('option', { value: String(index), text: \`\${run.run_id}\${run.label ? ' · ' + run.label : ''}\` })));
    runSelect.value = String(state.runIndex);
    const run = currentRun();
    fillSelect($('skill-filter'), ['全部', ...uniq((run?.samples || []).map((sample) => sample.skill))], state.skill);
    fillSelect($('story-filter'), ['全部', ...uniq((run?.samples || []).map((sample) => sample.story))], state.story);
  }

  function card(label, value, hint = '') {
    const node = el('div', { class: 'card' });
    node.append(el('div', { class: 'k', text: label }), el('div', { class: 'v', text: value }), el('div', { class: 'note', text: hint }));
    return node;
  }

  function renderOverview(run, samples) {
    const root = $('overview');
    clear(root);
    if (!run) { root.append(el('div', { class: 'empty', text: '暂无 run。' })); return; }
    root.append(el('h2', { text: '运行概览' }));
    const grid = el('div', { class: 'grid' });
    grid.append(
      card('候选 / 纳入 / 排除', \`\${fmt(run.candidates)} / \${fmt(run.included)} / \${fmt(run.excluded)}\`, \`当前筛选显示 \${samples.length} 条\`),
      card('N×n', run.n_cross?.label || '未提供', 'story 数 × variant 数'),
      card('Provider / Model', \`\${text(run.provider)} / \${text(run.model)}\`),
      card('Usage', Object.entries(run.usage || {}).map(([k, v]) => \`\${k}=\${fmt(v)}\`).join(' · ') || '未提供'),
      card('Elapsed', ms(run.elapsed_ms), '样本 elapsed 汇总或 run elapsed'),
      card('Run 时间', text(run.created_at)),
      card('失败', fmt(run.failures || 0)),
      card('组内方差', \`\${(run.within_group_variance || []).length} 组\`, '见下方表格')
    );
    root.append(grid);
    root.append(el('h3', { text: '排除原因' }));
    const reasons = run.exclusion_reasons || [];
    root.append(reasons.length ? el('div', {}, reasons.map((item) => el('span', { class: 'badge excluded', text: \`\${item.reason} × \${item.count}\` }))) : el('div', { class: 'empty', text: '无排除样本。' }));
    root.append(el('h3', { text: 'baseline_conditions' }));
    root.append(el('pre', { text: JSON.stringify(run.baseline_conditions || {}, null, 2) }));
    root.append(el('h3', { text: '组内方差' }));
    root.append(varianceTable(run.within_group_variance || []));
  }

  function varianceTable(rows) {
    if (!rows.length) return el('div', { class: 'empty', text: '当前 run 没有可计算的组内方差。' });
    const table = el('table');
    table.append(el('thead', {}, [el('tr', {}, ['组', 'n', 'metrics'].map((h) => el('th', { text: h }))) ]));
    table.append(el('tbody', {}, rows.map((row) => el('tr', {}, [
      el('td', { text: row.group }),
      el('td', { text: row.n }),
      el('td', { text: Object.entries(row.metrics || {}).map(([k, v]) => \`\${k}: n=\${v.n}, var=\${v.variance}\`).join('；') }),
    ]))));
    return table;
  }

  function renderGates(_run, samples) {
    const root = $('fingerprint-gates');
    clear(root);
    root.append(el('h2', { text: '1) 指纹闸门区间 + 样本散点' }));
    root.append(el('p', { class: 'note', text: \`参考语料 n=\${data.manifest.n}。这里只显示闸门位置，不计算、不展示聚合分。han / secs / secavg 是单槽位体量指标，跨故事不可比。\` }));
    root.append(el('div', { class: 'legend' }, [
      el('span', { class: 'badge success', text: '成功' }),
      el('span', { class: 'badge failure', text: '失败' }),
      el('span', { class: 'badge excluded', text: '排除' }),
      el('span', { class: 'badge warn', text: 'p5–p95 区间 / 全距' }),
    ]));
    const grid = el('div', { class: 'chart-grid' });
    for (const [metric, band] of Object.entries(data.manifest.distribution || {})) grid.append(metricChart(metric, band, samples));
    root.append(grid);
    root.append(el('h3', { text: '表格视图' }));
    root.append(fingerprintTable(samples));
  }

  function metricChart(metric, band, samples) {
    const width = 620, height = 150, left = 50, right = 18, top = 24, bottom = 34;
    const min = Number.isFinite(band.min) ? band.min : 0;
    const max = Number.isFinite(band.max) && band.max > min ? band.max : min + 1;
    const x = (value) => left + ((Math.max(min, Math.min(max, value)) - min) / (max - min)) * (width - left - right);
    const node = el('div', { class: 'metric' });
    node.append(el('div', { class: 'metric-title' }, [el('span', { text: metric }), el('span', { class: 'note', text: nonComparable.has(metric) ? '单槽位：不可比' : '可按语料区间看位置' })]));
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', \`0 0 \${width} \${height}\`);
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', \`\${metric} 闸门散点\`);
    addRect(svg, x(min), top + 26, x(max) - x(min), 32, 'band-full');
    addRect(svg, x(band.p5), top + 32, x(band.p95) - x(band.p5), 20, 'band-p95');
    addLine(svg, x(min), top + 70, x(max), top + 70, 'axis');
    for (const tick of [min, band.p5, band.median, band.p95, max]) addTick(svg, x(tick), top + 70, fmt(tick));
    const rows = samples.filter((sample) => sample.fingerprint && typeof sample.fingerprint[metric] === 'number');
    rows.forEach((sample, index) => {
      const cx = x(sample.fingerprint[metric]);
      const cy = top + 88 + (index % 3) * 14;
      const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      dot.setAttribute('cx', cx); dot.setAttribute('cy', cy); dot.setAttribute('r', 6);
      dot.setAttribute('class', \`dot \${sample.status}\`);
      dot.setAttribute('tabindex', '0');
      const tip = \`\${sample.id} · \${sample.skill} · \${sample.story}\n\${metric}: \${sample.fingerprint[metric]}\n状态: \${statusLabels[sample.status] || sample.status}\`;
      dot.addEventListener('mousemove', (event) => showTip(event, tip));
      dot.addEventListener('focus', (event) => showTip(event, tip));
      dot.addEventListener('mouseleave', hideTip);
      dot.addEventListener('blur', hideTip);
      svg.append(dot);
    });
    node.append(svg);
    node.append(el('div', { class: 'note', text: \`全距 \${fmt(band.min)}–\${fmt(band.max)}；p5–p95 \${fmt(band.p5)}–\${fmt(band.p95)}；中位 \${fmt(band.median)}\` }));
    return node;
  }

  function addRect(svg, x, y, w, h, cls) {
    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rect.setAttribute('x', x); rect.setAttribute('y', y); rect.setAttribute('width', Math.max(1, w)); rect.setAttribute('height', h); rect.setAttribute('rx', 4); rect.setAttribute('class', cls);
    svg.append(rect);
  }
  function addLine(svg, x1, y1, x2, y2, cls) {
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', x1); line.setAttribute('y1', y1); line.setAttribute('x2', x2); line.setAttribute('y2', y2); line.setAttribute('class', cls);
    svg.append(line);
  }
  function addTick(svg, x, y, label) {
    addLine(svg, x, y - 4, x, y + 4, 'axis');
    const t = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    t.setAttribute('x', x); t.setAttribute('y', y + 20); t.setAttribute('text-anchor', 'middle'); t.setAttribute('class', 'axis'); t.textContent = label;
    svg.append(t);
  }
  function showTip(event, content) {
    tooltip.textContent = content;
    tooltip.style.display = 'block';
    tooltip.style.left = Math.min(window.innerWidth - 340, event.clientX + 14) + 'px';
    tooltip.style.top = Math.min(window.innerHeight - 160, event.clientY + 14) + 'px';
  }
  function hideTip() { tooltip.style.display = 'none'; }

  function fingerprintTable(samples) {
    const metrics = Object.keys(data.manifest.distribution || {});
    const table = el('table');
    table.append(el('thead', {}, [el('tr', {}, ['样本', '状态', ...metrics, '硬拒 / 告警'].map((h) => el('th', { text: h }))) ]));
    table.append(el('tbody', {}, samples.map((sample) => el('tr', {}, [
      el('td', { text: \`\${sample.id} · \${sample.skill} · \${sample.story} · \${sample.variant}\` }),
      el('td', { text: statusLabels[sample.status] || sample.status }),
      ...metrics.map((metric) => el('td', { text: sample.fingerprint ? \`\${sample.fingerprint[metric] ?? '—'} · \${sample.judgement?.分布?.[metric]?.位置 ?? '—'}\` : '—' })),
      el('td', { text: sample.judgement ? [...sample.judgement.硬拒, ...sample.judgement.告警].join('；') || '无' : text(sample.error || sample.excluded_reason) }),
    ]))));
    return table;
  }

  function renderOutputs(_run, samples) {
    const root = $('outputs');
    clear(root);
    root.append(el('h2', { text: '2) 产出并排' }));
    root.append(el('p', { class: 'note', text: '当前筛选下的成功、失败、排除样本全部可查看；失败与排除样本保留错误/排除原因和原始输出。' }));
    if (!samples.length) { root.append(el('div', { class: 'empty', text: '当前筛选无样本。' })); return; }
    const wrap = el('div', { class: 'outputs' });
    for (const sample of samples) {
      const article = el('article', { class: 'sample' });
      article.append(el('div', { class: 'sample-head' }, [
        el('strong', { text: \`\${sample.id} · \${sample.skill} · \${sample.story}\` }),
        el('span', { class: \`badge \${sample.status}\`, text: \`\${statusLabels[sample.status] || sample.status} · \${sample.variant}\` }),
      ]));
      const meta = [\`elapsed=\${ms(sample.elapsed_ms)}\`, ...Object.entries(sample.usage || {}).map(([k, v]) => \`\${k}=\${fmt(v)}\`)];
      article.append(el('div', { class: 'note', text: meta.join(' · ') }));
      if (sample.error) article.append(el('div', { class: 'badge failure', text: sample.error }));
      if (sample.excluded_reason) article.append(el('div', { class: 'badge excluded', text: sample.excluded_reason }));
      article.append(el('pre', { text: sample.output || '（无输出）' }));
      wrap.append(article);
    }
    root.append(wrap);
  }

  function renderSkillDiff(run) {
    const root = $('skill-diff');
    clear(root);
    root.append(el('h2', { text: '3) Skill diff' }));
    if (!run || !run.skills?.length) { root.append(el('div', { class: 'empty', text: '当前 run 没有 Skill 元数据。' })); return; }
    const grid = el('div', { class: 'diff-grid' });
    for (const skill of run.skills) {
      const cardNode = el('div', { class: 'card' });
      cardNode.append(el('h3', { text: \`\${skill.name || skill.id} (\${skill.id})\` }));
      cardNode.append(el('div', { class: 'badge success', text: \`\${skill.baseline?.ref || 'r0'} · \${skill.baseline?.label || '基线'} · \${skill.baseline?.hash || '未提供'}\` }));
      if (skill.variants?.length) {
        const list = el('ul');
        for (const variant of skill.variants) list.append(el('li', { text: \`\${variant.id} · \${variant.label || variant.id} · \${variant.hash || '未提供'}\` }));
        cardNode.append(list);
      } else {
        cardNode.append(el('p', { class: 'note', text: '无变体；仍显示 r0 hash 与“基线”。' }));
      }
      grid.append(cardNode);
    }
    root.append(grid);
  }

  function render() {
    renderControls();
    const run = currentRun();
    const samples = filteredSamples(run);
    renderOverview(run, samples);
    renderGates(run, samples);
    renderOutputs(run, samples);
    renderSkillDiff(run);
  }

  $('run-select').addEventListener('change', (event) => { state.runIndex = Number(event.target.value); state.skill = '全部'; state.story = '全部'; render(); });
  $('skill-filter').addEventListener('change', (event) => { state.skill = event.target.value; render(); });
  $('story-filter').addEventListener('change', (event) => { state.story = event.target.value; render(); });
  render();
})();
</script>
</body>
</html>
`;
}

if (process.argv[1] === import.meta.filename) main();
