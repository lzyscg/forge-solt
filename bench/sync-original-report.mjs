#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fingerprint } from './fingerprint.mjs';
import { formatSentenceParagraphsV1 } from '../src/server/domain/assembly.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const PAGE = path.join(ROOT, 'bench/reports/original-skill-workbench.html');

function readJson(file) { return JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8')); }
function readText(file) { return fs.readFileSync(path.join(ROOT, file), 'utf8'); }
function sample(run, id) { const value = run.samples.find((item) => item.id === id); if (!value) throw new Error(`${id} 不存在`); return value; }
function diffLines(beforePath, afterPath, label) {
  const before = readText(beforePath).split('\n');
  const after = readText(afterPath).split('\n');
  const beforeSet = new Set(before), afterSet = new Set(after);
  const removed = before.filter((line) => line.trim() !== '' && !afterSet.has(line)).slice(0, 12).map((line) => `- ${line}`);
  const added = after.filter((line) => line.trim() !== '' && !beforeSet.has(line)).slice(0, 18).map((line) => `+ ${line}`);
  return [`@@ ${label} · 关键改动（完整文件 hash 见 run）`, ...removed, ...added];
}

function outlineCount(text) { return (text.match(/^\s*\d{1,3}[.．、]\s*\S.*$/gmu) ?? []).length; }

const page = readText('bench/reports/original-skill-workbench.html');
const dataMatch = page.match(/<script id="bench-data" type="application\/json">\s*([\s\S]*?)\s*<\/script>/u);
if (!dataMatch) throw new Error('原页面缺 bench-data');
const data = JSON.parse(dataMatch[1]);

data.corpus.note = '知乎盐选已签约短故事 · 去近重复 · 限 6k–20k 汉字 · 2026-09-02';
data.dims.binary = [
  { key:'person', dim:'叙述人称', expect:'第一人称', refText:'第一人称 150/153', evid:'例外 3 篇 · 2.0% · 95% 上界 5.0% → 可硬拒', hard:true },
  { key:'quote', dim:'引号形式', expect:'「」', refText:'双引号风格 0/153', evid:'双引号风格例外 0 篇 · 95% 上界 1.9% → 可硬拒', hard:true },
  { key:'section', dim:'是否分小节', expect:'有分节', refText:'分节 152/153', evid:'例外 1 篇 · 0.7% · 95% 上界 3.1% → 可硬拒', hard:true },
];
data.dims.scale = [
  { key:'pmed', dim:'中位段长', unit:'汉字/段', lo:10, hi:21, axis:55, why:'排版惯例:范文一个 beat 一行' },
  { key:'smed', dim:'中位句长', unit:'汉字/句', lo:10, hi:20, axis:28, why:'真实行文密度,与分段无关' },
  { key:'secavg', dim:'节均字数', unit:'汉字/节', lo:348.2, hi:1121, axis:1500, why:'小节生产单位的真实尺度' },
  { key:'han', dim:'整篇规模', unit:'汉字', lo:7970.6, hi:15738.6, axis:19000, why:'一篇完整短故事' },
];

const s4r1 = readJson('bench/runs/s4-outline-writing.json');
const s4r3 = readJson('bench/runs/s4-outline-writing-r3.json');
const s4Base = sample(s4r1, 'outline-writing-b2589be0f81f-baseline-r2');
const s4Var = sample(s4r3, 'outline-writing-b2589be0f81f-variant-r2');
const s4Summary = readJson('fixtures/s4-summary.json');

const s5 = readJson('bench/runs/s5-combined-r3.json');
const s5Base = sample(s5, 'scene-writing-section_13-baseline-r1');
const s5Var = sample(s5, 'scene-writing-section_13-variant-r1');
const s5BaseFp = fingerprint(s5Base.output);
const s5Formatted = formatSentenceParagraphsV1(s5Var.output);
const s5VarFp = fingerprint(s5Formatted);

const s6 = readJson('bench/runs/s6-scene-writing.json');
const s6Base = sample(s6, 'scene-writing-section_13-baseline-r1');
const s6Var = sample(s6, 'scene-writing-section_13-variant-r1');
const s6BaseFormatted = formatSentenceParagraphsV1(s6Base.output);
const s6VarFormatted = formatSentenceParagraphsV1(s6Var.output);
const s6BaseFp = fingerprint(s6BaseFormatted), s6VarFp = fingerprint(s6VarFormatted);
const s6Summary = readJson('fixtures/s6-summary.json');

const i0 = readJson('fixtures/i0-summary.json');
const i0Fast = i0.cases.find((entry) => entry.caseId === 'i0-fast-summary');
const i0Conflict = i0.cases.find((entry) => entry.caseId === 'i0-conflict-dialogue');
const i0Emotion = i0.cases.find((entry) => entry.caseId === 'i0-emotional-reality');
if (!i0Fast || !i0Conflict || !i0Emotion) throw new Error('I0 summary 缺少三故事');

data.runs.push(
  {
    id:'i0', label:'I0 · 三故事真人差距基线', date:'2026-09-02', kind:'baseline', sampleUnit:'private-summary',
    skill:'零模型私有审计 · 原文正文不进入页面', scaleKeys:[],
    summary:'三种阅读动力的原文分布差异显著；已知 AI 成稿的均匀铺开、长度膨胀和未授权机制均被检出。',
    gates:[
      {dim:'三故事模式覆盖',value:'3 / 3',arrow:'快叙·强冲突·现实情感',evid:'开发集已冻结;正文私有',state:'in'},
      {dim:'均匀铺开反证',value:'已检出',arrow:`CV ${i0Conflict.sectionVariation.toFixed(3)} → ${i0Conflict.currentDraft.sectionVariation.toFixed(3)}`,evid:`小节中位扩张 ${i0Conflict.currentDraft.sectionMedianExpansionRatio.toFixed(2)} 倍`,state:'out'},
      {dim:'公开隐私',value:'0 命中',arrow:'14 字源片段扫描',evid:'公开 summary 只含 hash/数字/计数',state:'in'},
    ],
    assert:null,
    conditions:[
      {name:'快叙原文轮廓',meta:`${i0Fast.sections}节 · 中位${i0Fast.sectionMedianHan}汉字`,pmed:null,smed:null,secavg:null,han:null},
      {name:'现实情感原文轮廓',meta:`${i0Emotion.sections}节 · 中位${i0Emotion.sectionMedianHan}汉字`,pmed:null,smed:null,secavg:null,han:null},
    ],
    variance:`小节长度离散度:快叙 ${i0Fast.sectionVariation.toFixed(3)}；强冲突 ${i0Conflict.sectionVariation.toFixed(3)}；现实情感 ${i0Emotion.sectionVariation.toFixed(3)}。预算必须按模式×展开等级路由。`,
    caveat:'<b>I0 完成,网络调用 0。</b> 同一故事当前 AI 约膨胀 2.15 倍,小节长度离散度塌缩;最早责任在 outline/plan/integrity,不是统一归正文。',
    texts:null,
    diff:null,
  },
);

data.runs.push(
  {
    id:'s4', label:'S4 · 分节粒度', date:'2026-09-02', kind:'ab', sampleUnit:'outline',
    skill:'outline-writing 1.1.0 → 1.2.0', scaleKeys:[],
    summary:'真实 ReplayInput 单变量 A/B。前两轮各 2/3,第三轮 3/3 后提升生产。自动粒度审核因正常样本 1/3 误报未上线。',
    gates:[
      {dim:'变体稳定性',value:'3 / 3',arrow:'← r1/r2 均 2/3',evid:'第三轮 3 份全部可接受',state:'in'},
      {dim:'字段完整性',value:'3 / 3',arrow:'出场·目标·冲突·结束状态',evid:'21–24 节,每节四字段齐全',state:'in'},
      {dim:'自动粒度审核',value:'未上线',arrow:'正常样本误报 1/3',evid:'误报会触发整纲重写,保留在实验区',state:'out'},
    ],
    assert:{contextEqual:true,promptDiffer:true},
    conditions:[
      {name:'生产基线 1.1.0',meta:'n=3 · 可接受 2/3',pmed:null,smed:null,secavg:null,han:null},
      {name:'最终变体 1.2.0',meta:`n=3 · 可接受 3/3 · ${outlineCount(s4Var.output)} 节`,pmed:null,smed:null,secavg:null,han:null},
    ],
    variance:'同一真实 outline fixture,baseline 与每轮变体均 n=3。失败样本不隐藏、不 best-of。',
    caveat:`<b>S4 写作侧完成。</b> r3 3/3；自动审核召回虽为过粗/过细 3/3,但正常拆分误报 1/3,因此没有上线。`,
    texts:[{fixture:'真实故事大纲 · 代表样本',a:s4Base.output,b:s4Var.output}],
    diff:diffLines('bench/runs/s4-outline-writing-baseline-skill.md','skills/outline-writing/SKILL.md','outline-writing'),
    audit:s4Summary,
  },
  {
    id:'s5', label:'S5 · 正文取舍与段落颗粒', date:'2026-09-02', kind:'ab', sampleUnit:'section',
    skill:'scene-writing 1.1.0 → 1.2.0 ＋ sentence paragraphs assembler', scaleKeys:['pmed','smed'],
    summary:'纯 Skill 两轮未稳定改变中后段颗粒,改为 Skill 管信息主次、系统只增加句末空行。',
    gates:[
      {dim:'确定性提交',value:'18 / 18',arrow:'← baseline 17/18',evid:'变体无超预算提交失败',state:'in'},
      {dim:'段长组中位',value:'20',arrow:'← 原始 44.5',evid:'进入范文 p5–p95 10–21',state:'in'},
      {dim:'文字保真',value:'18 / 18',arrow:'去空白逐字一致',evid:'只加空行,不删字、不改字、不拆句',state:'in'},
    ],
    assert:{contextEqual:true,promptDiffer:true},
    conditions:[
      {name:'生产基线',meta:'n=18 · 成功 17/18',pmed:s5BaseFp.pmed,smed:s5BaseFp.smed,secavg:null,han:s5BaseFp.han},
      {name:'S5 生产版',meta:'n=18 · 成功 18/18 · 装配后',pmed:s5VarFp.pmed,smed:s5VarFp.smed,secavg:null,han:s5VarFp.han},
    ],
    variance:'固定首/中/尾 3 case × 每条件 n=6。段长总体 44.5→20；开篇16、中段18.5、结尾25.75。',
    caveat:'<b>S5 完成。</b> assembler 识别未闭合引号,不在引号内部断段。结尾少数完整长句仍可到 31.5,系统不越权拆句。',
    texts:[{fixture:'section_13 · 代表样本',a:s5Base.output,b:s5Formatted}],
    diff:diffLines('skills/scene-writing/SKILL.md','skills-variants/s5/scene-writing/SKILL.md','scene-writing'),
  },
  {
    id:'s6', label:'S6 · 有效信息密度实验', date:'2026-09-02', kind:'ab', sampleUnit:'section',
    skill:'S5 生产基线 vs S6 删除测试变体', scaleKeys:['pmed','smed'],
    summary:'写作 A/B 36/36 完成;局部审核探针第二版 9/9,但写作变体未证明跨 case 稳定改善,未提升生产。',
    gates:[
      {dim:'写作执行',value:'36 / 36',arrow:'全部成功',evid:'baseline / variant 各 18 份',state:'in'},
      {dim:'局部审核探针',value:'9 / 9',arrow:'干净·重复·必要情绪',evid:'第一版重复召回 0/3,第二版修至 3/3',state:'in'},
      {dim:'生产提升',value:'未提升',arrow:'写作改善不稳定',evid:'开篇变差;2000汉字趋势窗口不足',state:'out'},
    ],
    assert:{contextEqual:true,promptDiffer:true},
    conditions:[
      {name:'S5 生产基线',meta:'n=18 · 成功 18/18',pmed:s6BaseFp.pmed,smed:s6BaseFp.smed,secavg:null,han:s6BaseFp.han},
      {name:'S6 实验变体',meta:'n=18 · 成功 18/18',pmed:s6VarFp.pmed,smed:s6VarFp.smed,secavg:null,han:s6VarFp.han},
    ],
    variance:'固定 3 case × 每条件 n=6。两侧均按同一生产 assembler 排版后比较；写作内容层中段/结尾改善,开篇未同向。',
    caveat:'<b>S6 未达生产提升门槛。</b> 三节合计约1460–1660汉字,不足固定2000汉字冗余窗口;不缩短窗口伪造趋势。缺口转入多故事整篇仿写验收。',
    texts:[{fixture:'section_13 · 代表样本（两侧均按生产 assembler 排版）',a:s6BaseFormatted,b:s6VarFormatted}],
    diff:diffLines('skills/scene-writing/SKILL.md','skills-variants/s6/scene-writing/SKILL.md','S6 scene-writing'),
    audit:s6Summary,
  },
);

const next = page.replace(dataMatch[0], `<script id="bench-data" type="application/json">\n${JSON.stringify(data, null, 2)}\n</script>`);
const out = process.argv[2] ? path.resolve(process.argv[2]) : PAGE;
fs.writeFileSync(out, next);
process.stdout.write(`已同步 ${data.runs.length} 个 run → ${out}\n`);
