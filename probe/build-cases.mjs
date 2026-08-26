/**
 * 构造审核用例。
 *
 * 设计原则：**缺陷尽量用机械变换制造，不靠我手写**——手写的缺陷会带上我的
 * 文风痕迹，审核 Agent 可能是靠「这段不像模型写的」发现它，而不是靠判断质量。
 * 那样测出来的召回率是假的。
 *
 * 四类缺陷都直接对应 skills/scene-writing/SKILL.md 里明写的判据：
 *   D1 承接断裂     ← S2 / S6 第 1 条「首段与上一场的结尾状态接得上」
 *   D2 心理解释     ← S3「摄像机拍不到的就是解释不是事件」（唯一手写的一类）
 *   D3 事实矛盾     ← S1「别和别的场次撞设定」
 *   D4 停错地方     ← S1 / S6 第 2 条「停在哪里必须兑现」
 */
import { readFileSync, writeFileSync } from 'node:fs';

const raw = JSON.parse(readFileSync(new URL('./raw-slots.json', import.meta.url), 'utf8'));

/** 段落切分：正文用空行分段（SKILL S3 明确要求）。 */
const paras = (text) => text.split(/\n\s*\n/).filter((p) => p.trim() !== '');
const join = (ps) => ps.join('\n\n');

/** 按执行包分组，便于在「同一个故事」内部做替换（换故事会混入人名变化）。 */
const byPacket = new Map();
for (const ch of raw) {
  if (!byPacket.has(ch.chapterPacket)) byPacket.set(ch.chapterPacket, []);
  byPacket.get(ch.chapterPacket).push(ch);
}

const cases = [];
let seq = 0;
const nextId = (kind) => `${kind}-${String(++seq).padStart(2, '0')}`;

/** 取某章的某个场景，附带它的上一场（依赖）。 */
function sceneWithPrev(ch, sortOrder) {
  const scene = ch.scenes.find((s) => s.sortOrder === sortOrder);
  if (!scene) return null;
  const prevId = scene.dependsOn.find((d) => d.startsWith('scene_'));
  const prev = prevId ? ch.scenes.find((s) => s.slotId === prevId) : null;
  return { scene, prev };
}

function pushCase({ ch, scene, prev, content, label, defectKind, defectNote }) {
  cases.push({
    caseId: nextId(label === 'PASS' ? 'pos' : 'neg'),
    source: ch.source,
    taskName: ch.taskName,
    chapterPacket: ch.chapterPacket,
    outline: ch.outline,
    slotId: scene.slotId,
    instruction: scene.instruction,
    prevSceneContent: prev ? prev.content : null,
    content,
    // 以下三项是答案，绝不进 prompt
    label,
    defectKind: defectKind ?? null,
    defectNote: defectNote ?? null,
  });
}

// ---------- 正例：原样的真实产物 ----------
// 从每份执行包里挑，覆盖 scene_2 / scene_3（有承接依赖的那些）。
const positivePicks = [];
for (const [, chapters] of byPacket) {
  for (const ch of chapters.slice(0, 6)) {
    for (const order of [4, 5]) {
      const got = sceneWithPrev(ch, order);
      if (got?.prev) positivePicks.push({ ch, ...got });
    }
  }
}
for (const pick of positivePicks.slice(0, 12)) {
  pushCase({ ...pick, content: pick.scene.content, label: 'PASS' });
}

// ---------- D1 承接断裂：把 scene_3 的开头换成同一章 scene_1 的开头 ----------
// scene_1 开头是「林越还在雨里往约见地点走」，scene_3 必须接在
// 「老周伸手去接凭证」之后。整段是真实生成的文字，只是接错了地方。
{
  let made = 0;
  for (const [, chapters] of byPacket) {
    for (const ch of chapters) {
      if (made >= 3) break;
      const target = sceneWithPrev(ch, 5);
      const opener = ch.scenes.find((s) => s.sortOrder === 3);
      if (!target?.prev || !opener) continue;
      const tp = paras(target.scene.content);
      const op = paras(opener.content);
      if (tp.length < 4 || op.length < 2) continue;
      pushCase({
        ch,
        scene: target.scene,
        prev: target.prev,
        content: join([...op.slice(0, 2), ...tp.slice(2)]),
        label: 'REVISE',
        defectKind: 'D1-承接断裂',
        defectNote:
          '首段被换成本章 scene_1 的开头（人物还在雨中赶路），' +
          '而上一场结尾人已在包间桌前、老周正伸手接凭证。',
      });
      made++;
    }
    if (made >= 3) break;
  }
}

// ---------- D3 事实矛盾：后半段替换关键物件 ----------
// 「伪造的转账凭证」是整章的支点（执行包情节目标 2 就是它被识破）。
// 把后半段的凭证/信封换成另一种东西，与骨架和前半段自相矛盾。
{
  const swaps = [
    [/凭证/g, '欠条'],
    [/信封/g, '布包'],
  ];
  let made = 0;
  for (const [, chapters] of byPacket) {
    for (const ch of chapters) {
      if (made >= 3) break;
      const got = sceneWithPrev(ch, 5) ?? sceneWithPrev(ch, 4);
      if (!got?.prev) continue;
      const ps = paras(got.scene.content);
      if (ps.length < 6) continue;
      const cut = Math.floor(ps.length / 2);
      let tail = join(ps.slice(cut));
      const before = tail;
      for (const [re, to] of swaps) tail = tail.replace(re, to);
      if (tail === before) continue; // 没替换到就跳过，别造一个假缺陷
      pushCase({
        ch,
        scene: got.scene,
        prev: got.prev,
        content: `${join(ps.slice(0, cut))}\n\n${tail}`,
        label: 'REVISE',
        defectKind: 'D3-事实矛盾',
        defectNote: '后半段把「凭证/信封」改成「欠条/布包」，与前半段及章节骨架矛盾。',
      });
      made++;
    }
    if (made >= 3) break;
  }
}

// ---------- D4 停错地方：删掉结尾若干段 ----------
// instruction 明写「停在哪里」，删掉结尾后场景停在一个别的地方。
{
  let made = 0;
  for (const [, chapters] of byPacket) {
    for (const ch of chapters) {
      if (made >= 3) break;
      const got = sceneWithPrev(ch, 5) ?? sceneWithPrev(ch, 4);
      if (!got?.prev) continue;
      // 只挑 instruction 里**明写了「停在哪里」**的场景：缺陷必须能对照一条
      // 白纸黑字的要求，否则「停错了」只是我的主观判断，用例就不成立。
      if (!/停在哪里/.test(got.scene.instruction)) continue;
      const ps = paras(got.scene.content);
      if (ps.length < 8) continue;
      const kept = ps.slice(0, ps.length - 3);
      if (join(kept).length < 400) continue; // 保证仍满足 minChars=300，缺陷是语义的不是字数的
      pushCase({
        ch,
        scene: got.scene,
        prev: got.prev,
        content: join(kept),
        label: 'REVISE',
        defectKind: 'D4-停错地方',
        defectNote: `删掉结尾 3 段，场景没有停在 instruction 指定的位置。`,
      });
      made++;
    }
    if (made >= 3) break;
  }
}

writeFileSync(
  new URL('./cases.json', import.meta.url),
  JSON.stringify(cases, null, 2),
);

const tally = {};
for (const c of cases) {
  const k = c.label === 'PASS' ? '正例' : c.defectKind;
  tally[k] = (tally[k] ?? 0) + 1;
}
console.log('用例构成：');
for (const [k, v] of Object.entries(tally)) console.log(`  ${k}: ${v}`);
console.log(`合计 ${cases.length}（D2 心理解释待手写补入）`);
