/**
 * 引文校验（D-25）。
 *
 * 审核模型返回的每条 finding 带一段 quote，声称它逐字出自待审正文。
 * 本函数用代码校验这一声称：quote 在归一化后必须出现在正文中。
 *
 * 归一化规则（实测依据：21 条 finding 里 20 条逐字命中，
 * 唯一未命中的一条是模型把 `"` 写成了 `'`，定位本身是准的——
 * 不归一化会让有效率虚低 5 个百分点）：
 * - 所有引号变体（弯引号、直角引号、全角引号、直引号）归一到同一符号用于比对；
 * - 所有空白（含换行）折叠为空（删除，不是替换成空格）；
 * - 归一化只用于比对，kept 里存模型原文。
 *
 * 空串 quote 必须显式丢弃：空串 `includes` 恒真，不拦会把无效 finding 放进去。
 */

/** 模型返回的一条原始 finding（未校验） */
export interface RawFinding {
  criterionId: string;
  quote: string;
  problem: string;
}

/** 引文校验后的结果 */
export interface VerifiedFindings {
  /** 通过校验的 findings，存模型原文 */
  readonly kept: readonly RawFinding[];
  /** 被丢弃的数量（引文不匹配或空串） */
  readonly discardedCount: number;
}

/** 所有引号变体归一到此符号用于比对 */
const QUOTE_CANONICAL = '"';

/**
 * 匹配所有需要归一的引号变体：
 * 弯引号（U+201C/201D/201E）、直角引号（U+00AB/00BB）、
 * 弯单引号（U+2018/2019）、直双引号（U+0022）、直单引号（U+0027）、
 * 全角引号（U+FF02/FF07）。
 */
const QUOTE_PATTERN = /[“”„«»‘’"'＂＇]/g;

/** 匹配所有空白字符（含换行、制表符等） */
const WHITESPACE_PATTERN = /\s/g;

/**
 * 归一化文本用于比对：引号归一 + 空白删除。
 * 归一化结果只用于 `includes` 比对，不存进 kept。
 */
function normalizeForComparison(text: string): string {
  return text.replace(QUOTE_PATTERN, QUOTE_CANONICAL).replace(WHITESPACE_PATTERN, '');
}

/**
 * 校验一组 findings 的引文是否逐字出自待审正文（允许标点归一化）。
 *
 * D-25：校验不过的 finding 丢弃；kept 里存模型原文，不存归一化后的串。
 */
export function verifyFindings(
  content: string,
  findings: readonly RawFinding[],
): VerifiedFindings {
  const normalizedContent = normalizeForComparison(content);
  const kept: RawFinding[] = [];
  let discardedCount = 0;

  for (const finding of findings) {
    const normalizedQuote = normalizeForComparison(finding.quote);
    // 空串 quote 必须显式丢弃：空串 includes 恒真。
    // 判空必须在归一化**之后**——全空白/全引号串归一化后同样为空，
    // 若在归一化之前判空会漏拦（「补 1」反证过）。
    if (normalizedQuote === '') {
      discardedCount++;
      continue;
    }
    if (normalizedContent.includes(normalizedQuote)) {
      kept.push(finding);
    } else {
      discardedCount++;
    }
  }

  return { kept, discardedCount };
}
