/**
 * 返修编辑清单的校验与应用（D-61 / D-62，见 `notes/REVISION-GRANULARITY-DESIGN-V0.1.md`）。
 *
 * ── 它存在的理由 ────────────────────────────────────────────────
 *
 * 返修此前提交的是**整篇正文**，`commitContentForReview` 整列覆写。
 * 实测（`probe/revision-granularity.py`）：为修一条 finding，平均 22.4% 的正文
 * 被改动却从未被任何人点名；最坏一次 1 条 finding 动了 83 句里的 49 句。
 * 更要紧的是 `probe/finding-origin.py`：27 条被检出的缺陷里 **5 条在第 0 稿
 * 根本不存在**，是返修自己写出来的，其中一条吃光预算导致带病发货。
 *
 * 提示词方案已经试过并失败（`context-builder.ts` 里本来就写着「未被指出问题的
 * 部分保持原样」，然后 72.8%）。阈值闸门也被证伪（`probe/drift-gate-simulation.py`：
 * 要拦住全部坏返修就得误伤大多数好返修，中间没有可用落点；而且「打回」等于让模型
 * 再重写一遍全文，用重写惩罚重写是循环的）。
 *
 * 所以这里走的是**构造性保证**，不是判别：
 *
 *   > 没有写进编辑清单的段落，根本不参与这次提交，因此不可能漂移。
 *
 * 这一点很重要，别讲混：本模块成立的理由**不是**「改得少所以错得少」
 * （那个相关性在 n=10 上并不成立），而是「没提交的东西改不了」。
 *
 * ── 归一化与引文闸门同源 ────────────────────────────────────────
 *
 * `oldText` 的逐字比对用与 `review-evidence.ts` 完全相同的归一化
 * （引号折成一种 + 删掉全部空白）。两边不一致，就会出现「审核认这句引文、
 * 返修却说找不到」这种自相矛盾的反馈。
 *
 * 实测支撑（`probe/edit-contract-replay.ts`，10 次历史返修重放，
 * prompt 由生产的 buildContext 生成且 contextHash 与库里 10/10 对账通过）：
 * 8 次产出编辑清单，**oldText 逐字对不上 0 条、不唯一 0 条、超过半篇 0 条**；
 * 附带改动从这 8 次的历史均值 11.5% 降到 0.6%。
 * 另 2 次产不出可用清单——那是 D-65 降级路径存在的理由，不是本模块能解决的。
 */

import type { SlotEdit } from '@shared/tools.ts';

const QUOTE_CANONICAL = '"';

/**
 * 一条编辑没通过校验的原因。
 *
 * `agentHint` 是给模型看的**可执行修复指令**（D-13），`message` 是给人看的现象描述。
 * 两者分开的理由与结构校验那边一致：把现象描述回灌给模型，它不知道该改什么。
 */
export interface SlotEditViolation {
  readonly rule: 'edit_old_text_not_found' | 'edit_old_text_ambiguous' | 'edit_old_text_oversized' | 'edit_list_empty';
  readonly message: string;
  readonly agentHint: string;
  /** 第几条编辑（从 1 起）。`edit_list_empty` 时为 null */
  readonly editIndex: number | null;
}

export type ApplySlotEditsResult =
  | { readonly ok: true; readonly content: string; readonly touchedChars: number }
  | { readonly ok: false; readonly violations: readonly SlotEditViolation[] };

/**
 * 归一化，并记下每个归一化字符**来自原文的哪一个下标**。
 *
 * 需要这张表是因为归一化删掉了空白：在归一化文本上匹配到的区间，
 * 必须能映射回原文的区间才能真正替换。少了它就只能在原文上做朴素 `includes`，
 * 而那样一来「原文换行了、模型引的时候没换行」就会判成找不到——
 * 这正是归一化本来要解决的问题。
 */
/** 逐字符判定用的无标志版本。带 /g 的正则 `test()` 会记住 lastIndex，逐字符调用必然漏判 */
const IS_WHITESPACE = /\s/;
const QUOTE_CHARS = new Set('“”„«»‘’"\'＂＇');

function normalizeWithIndex(text: string): { normalized: string; rawIndexOf: number[] } {
  let normalized = '';
  const rawIndexOf: number[] = [];
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i] as string;
    if (IS_WHITESPACE.test(ch)) continue;
    normalized += QUOTE_CHARS.has(ch) ? QUOTE_CANONICAL : ch;
    rawIndexOf.push(i);
  }
  return { normalized, rawIndexOf };
}

/**
 * **刻意由 `normalizeWithIndex` 派生，而不是另写一遍 replace 链。**
 * 两份实现摆在同一个文件里迟早会漂，而它们一旦不一致，
 * 表现是「匹配莫名其妙地失败」——最难查的那一类。
 * 与 `review-evidence.ts` 的一致性由 `slot-edits.test.ts` 钉住。
 */
function normalize(text: string): string {
  return normalizeWithIndex(text).normalized;
}

/**
 * 把编辑清单应用到 `base` 上。
 *
 * **全有或全无**：任何一条不合格就整份拒绝，不部分应用。
 * 部分应用会让模型下一轮面对一份它没预期过的正文，而它手里那份清单
 * 已经有一半失效了——比整份退回难恢复得多。
 *
 * 各条编辑的匹配**都对着原始 `base`**（而不是前一条应用后的结果）。
 * 逐条串行匹配会让「第 2 条的 oldText 恰好落在第 1 条改出来的新文本里」
 * 这种情况静默生效，而模型引的明明是旧稿。区间重叠时按下面的规则拒绝。
 */
export function applySlotEdits(base: string, edits: readonly SlotEdit[]): ApplySlotEditsResult {
  if (edits.length === 0) {
    return {
      ok: false,
      violations: [
        {
          rule: 'edit_list_empty',
          message: '编辑清单是空的',
          agentHint:
            '这一轮没有提交任何编辑。若确实无需改动，说明返修理由不成立，' +
            '请用 report_work 说明；若需要改动，请给出至少一条 {oldText, newText}。',
          editIndex: null,
        },
      ],
    };
  }

  const { normalized: normBase, rawIndexOf } = normalizeWithIndex(base);
  const violations: SlotEditViolation[] = [];
  /** 每条编辑落在原文上的区间，用于重叠检查与最终替换 */
  const ranges: { start: number; end: number; newText: string; normLength: number }[] = [];

  edits.forEach((edit, i) => {
    const index = i + 1;
    const normOld = normalize(edit.oldText);

    if (normOld === '') {
      violations.push({
        rule: 'edit_old_text_not_found',
        message: `第 ${index} 条编辑的 oldText 是空的`,
        agentHint: `第 ${index} 条编辑的 oldText 不能为空。请填入上一稿里真实存在的一段原文。`,
        editIndex: index,
      });
      return;
    }

    // 半篇上限（D-65 配套）：整篇重写请走 slot_content，别塞进一条编辑里伪装成定点修改
    if (normOld.length * 2 > normBase.length) {
      violations.push({
        rule: 'edit_old_text_oversized',
        message: `第 ${index} 条编辑的 oldText 覆盖了上一稿的一半以上`,
        agentHint:
          `第 ${index} 条编辑的 oldText 太长（覆盖了上一稿一半以上）。` +
          '请拆成若干条只针对具体问题的编辑；确实需要整篇重排时，' +
          '改用 kind 为 "slot_content" 的整篇提交。',
        editIndex: index,
      });
      return;
    }

    const first = normBase.indexOf(normOld);
    if (first === -1) {
      violations.push({
        rule: 'edit_old_text_not_found',
        message: `第 ${index} 条编辑的 oldText 在上一稿里找不到`,
        agentHint:
          `第 ${index} 条编辑的 oldText 在上一稿里逐字找不到。` +
          '请从上一稿正文里**原样复制**要替换的那段（标点、语气词都要一致），不要凭印象重写。',
        editIndex: index,
      });
      return;
    }
    if (normBase.indexOf(normOld, first + 1) !== -1) {
      violations.push({
        rule: 'edit_old_text_ambiguous',
        message: `第 ${index} 条编辑的 oldText 在上一稿里出现了不止一次`,
        agentHint:
          `第 ${index} 条编辑的 oldText 在上一稿里出现了不止一次，系统无法确定改哪一处。` +
          '请把 oldText 向前或向后延长，直到它在全文中唯一。',
        editIndex: index,
      });
      return;
    }

    // 归一化区间 → 原文区间。末字符的原文下标 +1 才是开区间右端
    const start = rawIndexOf[first] as number;
    const end = (rawIndexOf[first + normOld.length - 1] as number) + 1;
    ranges.push({ start, end, newText: edit.newText, normLength: normOld.length });
  });

  if (violations.length > 0) return { ok: false, violations };

  // 重叠检查：两条编辑指向同一段原文，先后顺序会决定结果，那不是可预期的行为
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  for (let i = 1; i < sorted.length; i += 1) {
    const prev = sorted[i - 1] as (typeof sorted)[number];
    const cur = sorted[i] as (typeof sorted)[number];
    if (cur.start < prev.end) {
      return {
        ok: false,
        violations: [
          {
            rule: 'edit_old_text_ambiguous',
            message: '有两条编辑指向了上一稿里重叠的同一段原文',
            agentHint:
              '有两条编辑的 oldText 在上一稿里重叠。请把它们合并成一条，' +
              '或者各自缩短到互不重叠。',
            editIndex: null,
          },
        ],
      };
    }
  }

  // 从后往前替换，前面的下标才不会被前一次替换的长度变化推移
  let content = base;
  for (let i = sorted.length - 1; i >= 0; i -= 1) {
    const range = sorted[i] as (typeof sorted)[number];
    content = content.slice(0, range.start) + range.newText + content.slice(range.end);
  }

  return { ok: true, content, touchedChars: sorted.reduce((n, r) => n + r.normLength, 0) };
}
