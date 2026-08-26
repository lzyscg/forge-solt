/**
 * R0.5 预研：从 M4/M7 的真实数据库里抽取审核用例底料。
 *
 * 只读，不碰产品代码。输出 raw-slots.json 供构造用例。
 */
// 脚本在 scratchpad 里，ESM 解析跟的是文件位置而不是 cwd，
// 所以显式指到仓库的 node_modules（曾经在这上面栽过一次）。
const { default: Database } = await import(
  '/Users/lzy/Desktop/forge-solt/node_modules/better-sqlite3/lib/index.js'
);
import { writeFileSync } from 'node:fs';

// 三个来源覆盖三份不同的章节执行包——Q-19 的教训：同一份输入重复 N 次
// 测不出泛化，只测出采样方差。
const DBS = [
  'data/m4-measure.sqlite', // 林越/老周
  'data/m7-accept10.sqlite', // 林越/老周
  'data/m4-dense.sqlite', // 沈家分家会（五人物密集包）
  'data/forge-core.sqlite', // 林昭/陈屿/周砚
];

const rows = [];
for (const path of DBS) {
  const db = new Database(path, { readonly: true });
  const tasks = db
    .prepare(`SELECT id, name, input_json FROM tasks WHERE status='completed'`)
    .all();
  for (const task of tasks) {
    const slots = db
      .prepare(
        `SELECT slot_id, type, sort_order, depends_on_json, instruction, content_text
         FROM slots WHERE task_id=? AND status='completed' ORDER BY sort_order`,
      )
      .all(task.id);
    const scenes = slots.filter((s) => s.type === 'scene');
    const outline = slots.find((s) => s.type === 'chapter_outline');
    if (!outline || scenes.length < 2) continue;
    rows.push({
      source: path,
      taskId: task.id,
      taskName: task.name,
      chapterPacket: JSON.parse(task.input_json).chapter_packet,
      outline: outline.content_text,
      scenes: scenes.map((s) => ({
        slotId: s.slot_id,
        sortOrder: s.sort_order,
        dependsOn: JSON.parse(s.depends_on_json),
        instruction: s.instruction,
        content: s.content_text,
      })),
    });
  }
  db.close();
}

writeFileSync(
  new URL('./raw-slots.json', import.meta.url),
  JSON.stringify(rows, null, 2),
);

console.log(`抽取 ${rows.length} 个章节任务`);
console.log(`场景总数：${rows.reduce((n, r) => n + r.scenes.length, 0)}`);
const byPacket = new Map();
for (const r of rows) byPacket.set(r.chapterPacket, (byPacket.get(r.chapterPacket) ?? 0) + 1);
console.log(`不同的章节执行包：${byPacket.size} 份`);
for (const [packet, n] of byPacket) {
  console.log(`  - ${n} 章 · ${packet.slice(0, 40).replace(/\n/g, ' ')}…`);
}
