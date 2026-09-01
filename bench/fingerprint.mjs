/**
 * 指纹脚本 —— S0。零模型调用。
 *
 * 对任意文本 / 目录算出范文语料的那套确定性指标，并与
 * `fixtures/reference-corpus.json` 的区间比对，输出「在区间内 / 外」。
 *
 * ⚠️ 这是**闸门，不是分数**（D-75）。
 *    「本轮指纹提升了 12%」是一句无意义的话。指纹只回答「够不够格进下一层」。
 *
 * 用法：
 *   node bench/fingerprint.mjs <文件或目录> [...]     算指纹并对区间
 *   node bench/fingerprint.mjs --json <路径>          输出 JSON（供报告用）
 *   node bench/fingerprint.mjs --corpus [--write]     重算全语料（--write 写回清单）
 *   node bench/fingerprint.mjs --diff-manifest        重算并与已提交清单逐字段对账
 *   node bench/fingerprint.mjs --dedup <目录> [--t N] 两两查重（默认阈值 0.3）
 *   node bench/fingerprint.mjs --selftest             自检三个坑 + 清单往返
 *
 * 依赖：只用 Node 内置模块。不进 tsconfig / vitest，与 probe/ 同属离线分析工具。
 */

import fs from 'node:fs';
import path from 'node:path';

// ─────────────────────────────────────────────────────────────────────────────
// 三个踩过的坑，都在这里一次性挡住
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 坑 1：GB18030。
 * 语料里有文件被 `file --mime-encoding` 报成 iso-8859-1 / unknown-8bit，实为 GBK。
 * 必须用 GB18030 而不是 GBK —— 后者转不了少数字。
 * 判据用 U+FFFD：UTF-8 解码器遇到非法字节序列会插入替换字符。
 */
export function decode(buf) {
  const utf8 = new TextDecoder('utf-8').decode(buf);
  if (!utf8.includes('�')) return utf8;
  return new TextDecoder('gb18030').decode(buf);
}

/**
 * 坑 2：样板剥离。不剥离会污染段长、字数与段落数。
 *
 * 实测语料里的两类样板：
 *   页眉 —— 顶部 ═/= 围栏包起来的「来源来自网络，请于下载后 24 小时内删除」声明
 *   页脚 —— `备案号:` （110/166 篇）、`原文链接：`、`数据：`、`作者：`、`----(已完结)----`
 *
 * ⚠️ 只剥**站点样板**，不剥作者写的东西。`（全文完）`/`（完）`/`-完-` 一律保留：
 *    那是正文的一部分，剥掉就是在替作者做删改。
 */
const FOOTER = [
  /^备案号\s*[:：]/,
  /^原文链接\s*[:：]/,
  /^数据\s*[:：]\s*\d/,
  /^作者\s*[:：]/,
  /^作者署名\s*[:：]/,
  /^[-—─]{3,}\s*[(（]?已完结[)）]?\s*[-—─]{3,}$/,
  /^[(（]已完结[)）]/,
];

export function stripBoilerplate(text) {
  let lines = text.split(/\r?\n/);

  // 页眉：前 15 行内的第一条围栏 → 下一条围栏，整块去掉
  let open = -1;
  for (let i = 0; i < Math.min(lines.length, 15); i++) {
    if (/^[═=]{6,}$/.test(lines[i].trim())) {
      if (open < 0) open = i;
      else { lines = lines.slice(i + 1); open = -2; break; }
    }
  }
  // 有开围栏却没有闭围栏：只去掉围栏那一行，保守，不猜声明有几行
  if (open >= 0) lines = lines.slice(open + 1);

  return lines.filter((l) => !FOOTER.some((re) => re.test(l.trim()))).join('\n');
}

/**
 * 坑 3：查重的 shingle 步长必须是 1。
 * 步长 7 时，两篇文本只要开头样板差个非 7 倍数的字数，切片边界就全错开——
 * 同一个故事算出的 Jaccard 只有 0.124，脚本于是报「0 组重复」而实际有 5 组 13 个文件。
 * 这个 bug 不会报错，只会安静地骗人。所以步长写死 1，不给调。
 */
const SHINGLE = 14;

export function shingles(text) {
  const s = text.replace(/\s+/g, '');
  const out = new Set();
  for (let i = 0; i + SHINGLE <= s.length; i++) out.add(s.slice(i, i + SHINGLE));
  return out;
}

/** 包含度：小集合有多少落在大集合里。比 Jaccard 更适合「长短不一的两篇」 */
export function containment(a, b) {
  const [s, l] = a.size <= b.size ? [a, b] : [b, a];
  if (!s.size) return 0;
  let hit = 0;
  for (const g of s) if (l.has(g)) hit++;
  return hit / s.size;
}

// ─────────────────────────────────────────────────────────────────────────────
// 指标
// ─────────────────────────────────────────────────────────────────────────────

const HAN_RE = /[一-鿿]/g;
const han = (s) => (s.match(HAN_RE) || []).length;

/** 编号小节标记：实测语料里 `1`（2729 处）与 `1.`（219 处）两种形式占绝大多数 */
const SECTION_RE = /^\d{1,3}\s*[.．、]?$/;

/** 句末标点。切句在**整篇**上做，不逐段做——逐段会把没有句末标点的段各算一句 */
const SENT_RE = /[。！？…]+/;

function median(xs) {
  if (!xs.length) return null;
  const a = [...xs].sort((x, y) => x - y);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

/**
 * 违例率的单侧 95% 置信上界（Clopper-Pearson，解 P(X≤k | n,p) = 0.05）。
 *
 * 为什么要它：k=0 不等于「不可能」。0/8 的上界是 31.2%，0/30 才降到 9.5%——
 * 这正是 8 篇语料不够、扩到 153 篇才有判据的原因。
 * k=0 时它退化成 rule of three。全部维度**必须用同一种方法**，否则档位之间不可比。
 */
export function upperBound(k, n) {
  const lgamma = (x) => { let r = 0; for (let i = 2; i < x; i++) r += Math.log(i); return r; };
  const cdf = (p) => {
    let s = 0;
    for (let i = 0; i <= k; i++) {
      s += Math.exp(lgamma(n + 1) - lgamma(i + 1) - lgamma(n - i + 1) + i * Math.log(p) + (n - i) * Math.log(1 - p));
    }
    return s;
  };
  let lo = k / n, hi = 1;
  for (let it = 0; it < 200; it++) { const m = (lo + hi) / 2; if (cdf(m) > 0.05) lo = m; else hi = m; }
  return (lo + hi) / 2;
}

function percentile(xs, p) {
  if (!xs.length) return null;
  const a = [...xs].sort((x, y) => x - y);
  const i = (a.length - 1) * p;
  const lo = Math.floor(i), hi = Math.ceil(i);
  return lo === hi ? a[lo] : a[lo] + (a[hi] - a[lo]) * (i - lo);
}

/**
 * 算一篇的指纹。
 *
 * @returns han 汉字数 / paras 段落数 / pmed 段长中位 / smed 句长中位
 *          secs 编号小节数 / secavg 节均汉字 / person 人称 / quote 引号
 */
export function fingerprint(text) {
  const lines = stripBoilerplate(text).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const paras = lines.filter((l) => !SECTION_RE.test(l));
  const secs = lines.length - paras.length;

  const body = paras.join('\n');
  const H = han(body);

  // 段长只统计**有汉字的段**：纯标点行（「……」「——」）不是一个段落长度样本
  const paraLens = paras.map(han).filter((n) => n > 0);
  const sentLens = body.replace(/\n/g, '').split(SENT_RE).map(han).filter((n) => n > 0);

  const wo = (body.match(/我/g) || []).length;
  const ta = (body.match(/[他她]/g) || []).length;
  const jp = (body.match(/[「」『』]/g) || []).length;
  const dq = (body.match(/["“”]/g) || []).length;

  return {
    han: H,
    paras: paras.length,
    pmed: median(paraLens),
    smed: median(sentLens),
    secs,
    secavg: secs ? Math.floor(H / secs) : null,
    person: wo > ta ? '第一' : '第三',
    // 三态，不是二态。语料里有 1 篇**一个引号都没有**（全篇无对白引号），
    // 二态判法会把它并进「」而看不见——而我们真正要拦的失败模式是用 ""。
    quote: jp === 0 && dq === 0 ? '无' : jp >= dq ? '「」' : '""',
    wo, ta, jp, dq,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 与语料区间比对 —— 闸门，不是分数
// ─────────────────────────────────────────────────────────────────────────────

const ROOT = path.resolve(import.meta.dirname, '..');
const MANIFEST = path.join(ROOT, 'fixtures/reference-corpus.json');

export function loadManifest() {
  return JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
}

/**
 * 对一份指纹判「在不在语料区间内」。
 *
 * 三档，档位来自实测的单侧 95% 置信上界（数字从清单读，不写死在这）：
 *   硬拒 —— 第三人称（3/153）、用 ""（0/153）、无编号小节（1/153）
 *   告警 —— 全篇无对白引号（1/153）。这一档同样罕见，但它不是我们的失败模式，
 *           而且真硬拒会误伤那一篇确实签约了的范文，所以只提示
 *   区间 —— 分布维度报「在 p5–p95 内 / 在全距内 / 全距外」，**不折算成分数**
 *
 * ⚠️ 无分节此前是「告警」，依据是 10/153。那 10 篇里有 9 篇其实是用 `1.` 分的节，
 *    旧脚本只认 `1` 所以漏判。改成 1/153 后这一条够格硬拒了（见清单 _度量口径）。
 */
export function judge(fp, manifest) {
  const D = manifest.分布维度;
  const out = { 硬拒: [], 告警: [], 分布: {} };

  const B = manifest.二值维度;
  const 说明 = (k) => `语料 ${B[k].例外数}/${manifest.n}，95% 上界 ${B[k]['95%上界%']}%`;
  if (fp.person !== '第一') out.硬拒.push(`人称：第三人称（${说明('第三人称')}）`);
  if (fp.quote === '""') out.硬拒.push(`引号：用了 ""（${说明('用双引号')}）`);
  if (fp.quote === '无') out.告警.push(`全篇没有对白引号（${说明('无引号')}）`);
  if (fp.secs === 0) out.硬拒.push(`无编号小节（${说明('无分节')}）`);

  for (const [k, band] of Object.entries(D)) {
    const v = fp[k];
    if (v == null) { out.分布[k] = { v: null, 位置: '不适用' }; continue; }
    const 位置 = v < band.min || v > band.max ? '全距外'
      : v < band.p5 || v > band.p95 ? 'p5–p95 外'
      : '区间内';
    out.分布[k] = { v, 位置, band };
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────────────────────

function collect(target) {
  const st = fs.statSync(target);
  if (st.isFile()) return [target];
  return fs.readdirSync(target)
    .filter((f) => /\.(txt|md)$/i.test(f))
    .map((f) => path.join(target, f))
    .sort();
}

function readFp(file) {
  return { name: path.basename(file).replace(/\.(txt|md)$/i, ''), ...fingerprint(decode(fs.readFileSync(file))) };
}

function corpusFiles() {
  const m = loadManifest();
  const byName = new Map();
  for (const d of ['知乎短故事示例', '知乎短故事示例/短篇文章']) {
    const abs = path.join(ROOT, d);
    if (!fs.existsSync(abs)) continue;
    for (const f of fs.readdirSync(abs).filter((x) => x.endsWith('.txt'))) {
      byName.set(f.replace(/\.txt$/, ''), path.join(abs, f));
    }
  }
  const missing = m.入选.filter((e) => !byName.has(e.name)).map((e) => e.name);
  return { manifest: m, byName, missing };
}

function cmdDiffManifest() {
  const { manifest, byName, missing } = corpusFiles();
  if (missing.length) {
    console.error(`⚠ 语料目录里找不到 ${missing.length} 篇：${missing.slice(0, 5).join('、')}…`);
    console.error('  语料已 gitignore（付费作品，见 PLAN §1.4）。没有本地语料时这条命令跑不了。');
    process.exit(2);
  }
  const KEYS = ['han', 'paras', 'pmed', 'smed', 'secs', 'secavg', 'person', 'quote'];
  const rows = [];
  const diffCount = {};
  for (const want of manifest.入选) {
    const got = readFp(byName.get(want.name));
    const d = KEYS.filter((k) => got[k] !== want[k]);
    for (const k of d) diffCount[k] = (diffCount[k] || 0) + 1;
    rows.push({ want, got, d });
  }
  const bad = rows.filter((r) => r.d.length);
  console.log(`对账：${manifest.入选.length} 篇，${bad.length} 篇有差异`);
  console.log('按字段：', JSON.stringify(diffCount));

  // 差异会不会动结论？只有这三件事进了文档
  const now = {
    第三人称: rows.filter((r) => r.got.person !== '第一').length,
    用双引号: rows.filter((r) => r.got.quote === '""').length,
    无引号: rows.filter((r) => r.got.quote === '无').length,
    无分节: rows.filter((r) => r.got.secs === 0).length,
  };
  console.log('\n二值维度（新算 例外数 / 清单）：');
  for (const [k, v] of Object.entries(now)) {
    console.log(`  ${k.padEnd(5)} ${v} / ${manifest.二值维度[k]?.例外数 ?? '（清单无此项）'}`);
  }

  console.log('\n分布维度（新算 min/p5/中位/p95/max ← 清单）：');
  for (const k of ['pmed', 'smed', 'secavg', 'han', 'secs']) {
    const xs = rows.map((r) => r.got[k]).filter((v) => v != null);
    const b = manifest.分布维度[k];
    const f = (n) => (n == null ? '—' : Math.round(n * 10) / 10);
    console.log(`  ${k.padEnd(7)} ${f(Math.min(...xs))} / ${f(percentile(xs, 0.05))} / ${f(median(xs))} / ${f(percentile(xs, 0.95))} / ${f(Math.max(...xs))}   n=${xs.length}`);
    console.log(`  ${''.padEnd(7)} ${b.min} / ${b.p5} / ${b.median} / ${b.p95} / ${b.max}   n=${b.n}   ← 清单`);
  }
  if (bad.length) {
    console.log('\n差异样例（前 10 篇）：');
    for (const r of bad.slice(0, 10)) {
      console.log(`  ${r.want.name}: ` + r.d.map((k) => `${k} ${r.got[k]}←${r.want[k]}`).join('; '));
    }
  }
}

/**
 * 重算全语料，写回 `fixtures/reference-corpus.json`。
 * 元信息（说明/来源/筛选口径/排除清单）原样保留——那是当初的**筛选决定**，不是度量结果，
 * 重算度量不该悄悄改掉筛选依据。
 */
function cmdCorpus(write) {
  const { manifest, byName, missing } = corpusFiles();
  if (missing.length) { console.error(`⚠ 缺 ${missing.length} 篇语料，跑不了`); process.exit(2); }

  const 入选 = manifest.入选.map((old) => {
    const g = readFp(byName.get(old.name));
    return {
      han: g.han, paras: g.paras, pmed: g.pmed, smed: g.smed,
      secs: g.secs, secavg: g.secavg, person: g.person, quote: g.quote,
      name: old.name, src: old.src,
    };
  });
  const n = 入选.length;
  const r2 = (x) => (x == null ? null : Math.round(x * 10) / 10);
  const band = (k) => {
    const xs = 入选.map((e) => e[k]).filter((v) => v != null);
    return { median: r2(median(xs)), p5: r2(percentile(xs, 0.05)), p95: r2(percentile(xs, 0.95)),
      min: Math.min(...xs), max: Math.max(...xs), n: xs.length };
  };
  const bin = (label, pred) => {
    const k = 入选.filter(pred).length;
    return [label, { 例外数: k, '占比%': r2((k / n) * 100), '95%上界%': r2(upperBound(k, n) * 100) }];
  };

  const out = {
    ...manifest,
    _生成日期: new Date().toISOString().slice(0, 10),
    _度量口径: '见 bench/fingerprint.mjs。2026-09-01 由 S0 脚本重算，修正了三处口径：'
      + '① 编号小节认 `1.` 形式（此前只认 `1`，漏判 9 篇为「无分节」）；'
      + '② 站点样板（备案号/原文链接/作者署名/已完结分隔线）一律剥离，此前只剥了一部分；'
      + '③ 违例率上界统一为单侧 95% Clopper-Pearson（此前 k=0 与 k>0 用了不同方法）。'
      + '正文与作者写的「（全文完）」不剥。',
    n,
    分布维度: Object.fromEntries(['pmed', 'smed', 'secavg', 'han', 'secs'].map((k) => [k, band(k)])),
    二值维度: Object.fromEntries([
      bin('第三人称', (e) => e.person !== '第一'),
      bin('用双引号', (e) => e.quote === '""'),
      bin('无引号', (e) => e.quote === '无'),
      bin('无分节', (e) => e.secs === 0),
    ]),
    入选,
  };
  if (!write) { console.log(JSON.stringify(out.二值维度, null, 1)); console.log(JSON.stringify(out.分布维度, null, 1)); return; }
  fs.writeFileSync(MANIFEST, JSON.stringify(out, null, 1) + '\n');
  console.log(`已重写 ${path.relative(ROOT, MANIFEST)}：${n} 篇`);
}

/**
 * 两两查重。S3.5 的洗稿防抄线用的就是这条（D-85）。
 *
 * 实测（153 篇随机 70 篇，2415 对）：无关范文之间中位 0.000、最大 0.0105；
 * 已知重复文本 > 0.60。**57 倍间隔**，阈值落在 0.05–0.30 任何位置都能干净分开。
 */
function cmdDedup(targets, threshold) {
  const files = targets.flatMap(collect);
  const gs = files.map((f) => ({ f, s: shingles(stripBoilerplate(decode(fs.readFileSync(f)))) }));
  const hits = [];
  const all = [];
  for (let i = 0; i < gs.length; i++) {
    for (let j = i + 1; j < gs.length; j++) {
      const c = containment(gs[i].s, gs[j].s);
      all.push(c);
      if (c >= threshold) hits.push({ a: path.basename(gs[i].f), b: path.basename(gs[j].f), c });
    }
  }
  all.sort((x, y) => x - y);
  const below = all.filter((c) => c < threshold);
  console.log(`${files.length} 篇 → ${all.length} 对，片段长 ${SHINGLE}，步长 1`);
  console.log(`包含度：中位 ${all[all.length >> 1]?.toFixed(4)}  p95 ${percentile(all, 0.95)?.toFixed(4)}  最大 ${all.at(-1)?.toFixed(4)}`);
  // 阈值站不站得住，看的是**间隔**，不是阈值本身
  if (below.length && below.length < all.length) {
    const lo = below.at(-1), hi = all.filter((c) => c >= threshold)[0];
    console.log(`间隔：判「不重复」的最高 ${lo.toFixed(4)} ← → 判「重复」的最低 ${hi.toFixed(4)}   相差 ${(hi / lo).toFixed(0)} 倍`);
  }
  console.log(`\n≥ ${threshold} 的 ${hits.length} 对：`);
  for (const h of hits.sort((x, y) => y.c - x.c)) console.log(`  ${h.c.toFixed(3)}  ${h.a}  ×  ${h.b}`);
  if (!hits.length) console.log('  （无）');
}

/**
 * 自检：三个踩过的坑各一条断言，外加清单往返。
 * 不进 vitest（本文件是 .mjs，tsconfig 不含 bench/），所以自带。跑不过就别信它的数。
 */
function cmdSelftest() {
  const t = [];
  const ok = (name, cond, detail = '') => { t.push({ name, cond, detail }); };

  // 坑 1 GB18030：GBK 编码的「你好」不是合法 UTF-8，必须回落
  const gbk = Buffer.from([0xc4, 0xe3, 0xba, 0xc3]);
  ok('坑1 GB18030 回落', decode(gbk) === '你好', `得到 ${JSON.stringify(decode(gbk))}`);

  // 坑 2 样板剥离：页眉整块去掉，页脚站点行去掉，作者写的「（全文完）」留下
  const s = stripBoilerplate('═══════\n来源来自网络\n═══════\n\n正文一。\n（全文完）\n备案号:ABC\n');
  ok('坑2 页眉剥离', !s.includes('来源来自网络'), s);
  ok('坑2 页脚剥离', !s.includes('备案号'), s);
  ok('坑2 不动作者的字', s.includes('（全文完）'), s);

  // 坑 3 步长必须是 1：同一篇文本前面多 3 个字，步长 7 会算出 0
  // 用**不重复**的文本：周期性文本在步长 7 下本来就会撞上，测不出这个坑（第一版就栽在这）
  let seed = 1;
  const body = Array.from({ length: 600 }, () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return String.fromCharCode(0x4e00 + (seed % 20000));
  }).join('');
  const stride = (x, k) => { const o = new Set(); for (let i = 0; i + SHINGLE <= x.length; i += k) o.add(x.slice(i, i + SHINGLE)); return o; };
  ok('坑3 步长1 认出同一篇', containment(shingles(body), shingles('样板三字' + body)) > 0.95);
  ok('坑3 步长7 会漏（所以写死 1）', containment(stride(body, 7), stride('样板三字' + body, 7)) < 0.05);

  // 小节两种形式都要认
  ok('小节认 `1` 与 `1.`', fingerprint('引子。\n1\n甲乙丙。\n2.\n丁戊己。').secs === 2);
  // 引号三态
  ok('引号三态·无', fingerprint('甲乙丙丁。').quote === '无');
  ok('引号三态·""', fingerprint('他说："甲乙。"').quote === '""');
  ok('引号三态·「」', fingerprint('他说：「甲乙。」').quote === '「」');
  // 上界：k=0 退化成 rule of three
  ok('上界 0/8 = 31.2%', Math.abs(upperBound(0, 8) - 0.3123) < 0.001, `${upperBound(0, 8)}`);

  // 清单往返：语料在本地时才跑
  const { missing } = fs.existsSync(path.join(ROOT, '知乎短故事示例')) ? corpusFiles() : { missing: ['(无本地语料)'] };
  if (!missing.length) {
    const { manifest, byName } = corpusFiles();
    const KEYS = ['han', 'paras', 'pmed', 'smed', 'secs', 'secavg', 'person', 'quote'];
    const bad = manifest.入选.filter((w) => { const g = readFp(byName.get(w.name)); return KEYS.some((k) => g[k] !== w[k]); });
    ok(`清单往返 ${manifest.入选.length} 篇逐字段一致`, bad.length === 0, `${bad.length} 篇不符`);
  } else {
    console.log('· 跳过清单往返：本地没有语料（已 gitignore，付费作品）');
  }

  for (const x of t) console.log(`${x.cond ? '✓' : '✗'} ${x.name}${x.cond ? '' : '   ' + x.detail}`);
  const bad = t.filter((x) => !x.cond).length;
  console.log(bad ? `\n${bad} 条不过。` : `\n${t.length} 条全过。`);
  process.exit(bad ? 1 : 0);
}

function main() {
  const args = process.argv.slice(2);
  if (!args.length) {
    console.log(fs.readFileSync(import.meta.filename, 'utf8').split('*/')[0].replace(/^\/\*\*|^ \* ?/gm, ''));
    process.exit(1);
  }
  if (args[0] === '--selftest') return cmdSelftest();
  if (args[0] === '--diff-manifest') return cmdDiffManifest();
  if (args[0] === '--corpus') return cmdCorpus(args.includes('--write'));
  if (args[0] === '--dedup') {
    const i = args.indexOf('--t');
    const t = i > 0 ? Number(args[i + 1]) : 0.3;
    return cmdDedup(args.slice(1).filter((a) => a !== '--t' && a !== String(t)), t);
  }

  const asJson = args[0] === '--json';
  const targets = (asJson ? args.slice(1) : args).flatMap(collect);
  const manifest = loadManifest();
  const results = targets.map((f) => {
    const fp = readFp(f);
    return { file: path.relative(process.cwd(), f), ...fp, 判定: judge(fp, manifest) };
  });

  if (asJson) { console.log(JSON.stringify(results, null, 2)); return; }

  for (const r of results) {
    console.log(`\n■ ${r.name}`);
    console.log(`  汉字 ${r.han} | 段 ${r.paras} | 段长中位 ${r.pmed} | 句长中位 ${r.smed} | 小节 ${r.secs} | 节均 ${r.secavg ?? '—'}`);
    console.log(`  人称 ${r.person}（我 ${r.wo} / 他她 ${r.ta}） | 引号 ${r.quote}（「」${r.jp} / ""${r.dq}）`);
    for (const x of r.判定.硬拒) console.log(`  ✗ 硬拒  ${x}`);
    for (const x of r.判定.告警) console.log(`  ⚠ 告警  ${x}`);
    const outside = Object.entries(r.判定.分布).filter(([, d]) => d.位置 !== '区间内' && d.位置 !== '不适用');
    for (const [k, d] of outside) {
      console.log(`  · ${k} ${d.v} 落在${d.位置}（语料 p5–p95 ${d.band.p5}–${d.band.p95}，全距 ${d.band.min}–${d.band.max}）`);
    }
    if (!r.判定.硬拒.length && !r.判定.告警.length && !outside.length) console.log('  ✓ 全部落在语料区间内');
  }
  console.log('\n—— 指纹是闸门不是分数：全绿只说明够格进下一层，不说明写得好。');
}

if (process.argv[1] === import.meta.filename) main();
