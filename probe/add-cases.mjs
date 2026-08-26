/**
 * R0.5 预研：向 cases.json 补入三类手写/半手写用例。
 *
 * 1. 4 条新正例——补到「正例过半」（§5.1）：机械注入 9 条 + D2 手写 3 条 = 12 反例，
 *    原 12 正例恰好对半，不满足「正例必须占一半以上」，故每故事各补。
 * 2. 3 条 D2（心理解释代替事件）——唯一必须手写的一类（§3.2）。
 *    做法：挑一个具体动作段，改写成同等篇幅、同语域的内心解释。
 *    这 3 例在报告里必须声明是人工撰写的。
 * 3. 1 条文风对照（§3.2）：动作段原样保留但句序倒置——读着别扭但不违反四条判据。
 *    若模型也打回它，说明它在挑文风不是挑判据。
 *
 * 重名坑：m4-measure 与 m4-dense 的章节同名（都叫「M4 实测 #N」），
 * 跨故事的选择必须带 source 过滤。
 */
import { readFileSync, writeFileSync } from 'node:fs';

const raw = JSON.parse(readFileSync(new URL('./raw-slots.json', import.meta.url), 'utf8'));
const cases = JSON.parse(readFileSync(new URL('./cases.json', import.meta.url), 'utf8'));

let seq = cases.length;
const nextId = (kind) => `${kind}-${String(++seq).padStart(2, '0')}`;

const findChapter = ({ source, taskName }) => {
  const ch = raw.find(
    (c) => c.taskName === taskName && (source === undefined || c.source === source),
  );
  if (!ch) throw new Error(`找不到章节：${source ?? ''} ${taskName}`);
  return ch;
};

const sceneWithPrev = (ch, slotId) => {
  const scene = ch.scenes.find((s) => s.slotId === slotId);
  if (!scene) throw new Error(`${ch.taskName} 没有槽位 ${slotId}`);
  const prevId = scene.dependsOn.find((d) => d.startsWith('scene'));
  const prev = prevId ? ch.scenes.find((s) => s.slotId === prevId) : null;
  if (!prev) throw new Error(`${ch.taskName}/${slotId} 没有上一场，不能做正例`);
  return { scene, prev };
};

const push = ({ ch, scene, prev, content, label, defectKind, defectNote }) => {
  cases.push({
    caseId: nextId(label === 'PASS' ? 'pos' : label === 'CONTROL' ? 'ctl' : 'neg'),
    source: ch.source,
    taskName: ch.taskName,
    chapterPacket: ch.chapterPacket,
    outline: ch.outline,
    slotId: scene.slotId,
    instruction: scene.instruction,
    prevSceneContent: prev.content,
    content,
    // 以下三项是答案，绝不进 prompt
    label,
    defectKind: defectKind ?? null,
    defectNote: defectNote ?? null,
  });
};

// ---------- 4 条新正例：每故事覆盖，且不与已有正例重复 ----------
const newPositives = [
  { source: 'data/m4-measure.sqlite', taskName: 'M4 实测 #20', slotId: 'scene3' },
  { source: 'data/m4-measure.sqlite', taskName: 'M4 实测 #19', slotId: 'scene3' },
  { source: 'data/m4-dense.sqlite', taskName: 'M4 实测 #2', slotId: 'scene_will' },
  { taskName: '《深夜来电》第三章', slotId: 'scene_4' },
];
for (const pick of newPositives) {
  const ch = findChapter(pick);
  push({ ch, ...sceneWithPrev(ch, pick.slotId), content: sceneWithPrev(ch, pick.slotId).scene.content, label: 'PASS' });
}

// ---------- 3 条 D2：具体动作段 → 同等篇幅的内心解释（人工撰写） ----------
const d2 = [
  {
    source: 'data/m4-measure.sqlite',
    taskName: 'M4 实测 #20',
    slotId: 'scene3',
    original:
      '檐外一阵风顶着雨浇在窗上。堂里很静，静得能听见那盏灯在梁上嗡响。林越后腰抵着椅背，指尖在膝上蜷了蜷，又松开。他说不清自己哪一环露了，只觉得老周说的每一句，都像早就写好，等他撞上来。',
    rewrite:
      '林越心里慌得厉害，知道主动权已经完全落在老周手里。他说不清自己哪一环露了，只觉得老周说的每一句，都像早就写好，等他撞上来。越想越是胸闷，那股压在心口的不安越来越重，他甚至开始怀疑自己今晚这一趟，是不是从一开始就错了。',
  },
  {
    source: 'data/m4-dense.sqlite',
    taskName: 'M4 实测 #5',
    slotId: 'scene_3',
    original:
      '沈明远没有说话。他伸手，指腹在那行日期的墨迹上碾了一下，却没有翻页，也没有追问。他垂着眼，喉咙里动了一下，像把一个到嘴边的问题原样咽了回去。',
    rewrite:
      '沈明远没有说话。他心里乱极了：一方面愿意相信这份遗嘱是真的，另一方面那行日期又像一根刺扎在眼前，让他没法踏实。他明白自己一旦开口追问，就再也没有回头的余地，于是只好把那份怀疑硬压下去，不敢让它露出分毫。',
  },
  {
    taskName: '《深夜来电》第三章',
    slotId: 'scene_3',
    original:
      '他把手从衣袋里抽出来，在裤缝上按了按，掌心的潮意隔着布料透了薄薄一层。他重新看向窗外——高架桥尽头那盏路灯不知何时又亮了起来，白晃晃地照着一段空荡的桥面，桥面上什么都没有。',
    rewrite:
      '林昭心里乱成一团。周砚和他朝夕共事这些年，他不愿意怀疑对方，可「早就清走了」「从来没见过」那几句话，此刻越想越刺耳。信任与怀疑在他心里来回拉扯，谁也没能压倒谁，他只觉这夜太长了，长得让他害怕听到答案。',
  },
];
for (const d of d2) {
  const ch = findChapter(d);
  const { scene, prev } = sceneWithPrev(ch, d.slotId);
  const count = scene.content.split(d.original).length - 1;
  if (count !== 1) throw new Error(`${ch.taskName}/${d.slotId} 的原段匹配 ${count} 次，不是 1`);
  push({
    ch,
    scene,
    prev,
    content: scene.content.replace(d.original, d.rewrite),
    label: 'REVISE',
    defectKind: 'D2-心理解释',
    defectNote: `人工撰写：把一段具体动作改写成同等篇幅的内心解释（原段以动作/环境为主，改后摄像机拍不到任何新东西）。`,
  });
}

// ---------- 1 条文风对照：动作段句序倒置（别扭但不违反判据） ----------
{
  const ch = findChapter({ source: 'data/m4-dense.sqlite', taskName: 'M4 实测 #5' });
  const { scene, prev } = sceneWithPrev(ch, 'scene_3');
  const original =
    '陈律师没答。他从公文包里取出一份文件，翻到某一页，指尖点着纸面，却没递出去。他抬眼，目光在沈明远脸上停了一瞬。';
  const count = scene.content.split(original).length - 1;
  if (count !== 1) throw new Error(`对照原段匹配 ${count} 次，不是 1`);
  const sentences = original.match(/[^。]+。/g) ?? [];
  if (sentences.length < 2) throw new Error('对照段句数不足');
  const shuffled = [...sentences].reverse().join('');
  push({
    ch,
    scene,
    prev,
    content: scene.content.replace(original, shuffled),
    label: 'CONTROL',
    defectKind: 'CONTROL-句序倒置',
    defectNote: '动作原样保留、仅句序倒置：读着别扭，但四条判据都没有违反。若被打回，说明模型在挑文风。',
  });
}

writeFileSync(new URL('./cases.json', import.meta.url), JSON.stringify(cases, null, 2));

const tally = {};
for (const c of cases) {
  const k = c.label === 'PASS' ? '正例' : c.defectKind;
  tally[k] = (tally[k] ?? 0) + 1;
}
console.log('用例构成：');
for (const [k, v] of Object.entries(tally)) console.log(`  ${k}: ${v}`);
const pos = cases.filter((c) => c.label === 'PASS').length;
console.log(`合计 ${cases.length}，正例 ${pos}（${Math.round((pos / (cases.length - 1)) * 100)}%，对照不计入分母）`);
