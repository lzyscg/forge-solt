import type { Slot } from './types.ts';

export interface SlotCountRule {
  min: number;
  max: number;
}

export interface StoryHanBudget {
  min: number;
  target?: number | undefined;
  max: number;
  slotType: string;
}

export interface NarrativePlanRule {
  inputField: string;
  slotType: string;
}

export interface OutlineCountRule {
  inputField: string;
  slotType: string;
}

export interface OutputValidationSpec {
  slotCounts: Readonly<Record<string, SlotCountRule>>;
  outlineCount: OutlineCountRule | null;
  storyHan: StoryHanBudget | null;
  narrativePlan?: NarrativePlanRule | null;
}

export interface StaticSlotLimits {
  id: string;
  contentBearing: boolean;
  includeInArtifact: boolean;
  minChars: number | null;
  maxChars: number | null;
}

export interface EffectiveHanRange {
  minHan: number;
  maxHan: number;
}

export type OutputStructureRuleId =
  | 'OUTPUT_SLOT_COUNT'
  | 'OUTPUT_OUTLINE_COUNT'
  | 'OUTPUT_NARRATIVE_UNIT_BINDING'
  | 'OUTPUT_BUDGET_IMPOSSIBLE';

export interface OutputStructureViolation {
  rule: OutputStructureRuleId;
  message: string;
  agentHint: string;
  slotIds: string[];
}

export interface StoryFingerprintRules {
  requireFirstPerson: boolean;
  forbidDoubleQuoteStyle: boolean;
  requireNumberedSections: boolean;
  warnNoDialogueQuotes: boolean;
}

export interface StoryFingerprint {
  han: number;
  sections: number;
  person: 'first' | 'third';
  quote: 'corner' | 'double' | 'none';
  firstPersonCount: number;
  thirdPersonCount: number;
  cornerQuoteCount: number;
  doubleQuoteCount: number;
  paragraphMedian: number | null;
  sentenceMedian: number | null;
}

export interface ArtifactValidationResult {
  fingerprint: StoryFingerprint;
  errors: string[];
  warnings: string[];
}

const OUTLINE_SECTION_PATTERN = /^\s*(\d{1,3})\s*[.．、]\s*\S/u;
const HAN_PATTERN = /[一-鿿]/gu;
const ARTIFACT_SECTION_PATTERN = /^\d{1,3}\s*[.．、]?$/u;
const SENTENCE_END_PATTERN = /[。！？…]+/u;

export function fingerprintStory(text: string): StoryFingerprint {
  const lines = text.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  const paragraphs = lines.filter((line) => !ARTIFACT_SECTION_PATTERN.test(line));
  const body = paragraphs.join('\n');
  const firstPersonCount = occurrences(body, /我/gu);
  const thirdPersonCount = occurrences(body, /[他她]/gu);
  const cornerQuoteCount = occurrences(body, /[「」『』]/gu);
  const doubleQuoteCount = occurrences(body, /["“”]/gu);
  const paragraphLengths = paragraphs.map(countHan).filter((value) => value > 0);
  const sentenceLengths = body.replace(/\n/gu, '').split(SENTENCE_END_PATTERN).map(countHan).filter((value) => value > 0);

  return {
    han: countHan(body),
    sections: lines.length - paragraphs.length,
    person: firstPersonCount > thirdPersonCount ? 'first' : 'third',
    quote: cornerQuoteCount === 0 && doubleQuoteCount === 0
      ? 'none'
      : cornerQuoteCount >= doubleQuoteCount
        ? 'corner'
        : 'double',
    firstPersonCount,
    thirdPersonCount,
    cornerQuoteCount,
    doubleQuoteCount,
    paragraphMedian: median(paragraphLengths),
    sentenceMedian: median(sentenceLengths),
  };
}

export function validateArtifactOutput(
  text: string,
  validation: OutputValidationSpec | null,
  fingerprintRules: StoryFingerprintRules | null,
): ArtifactValidationResult {
  const fingerprint = fingerprintStory(text);
  const errors: string[] = [];
  const warnings: string[] = [];
  const storyHan = validation?.storyHan;
  if (storyHan != null && (fingerprint.han < storyHan.min || fingerprint.han > storyHan.max)) {
    errors.push(`整篇有 ${fingerprint.han} 个汉字，要求 ${storyHan.min}–${storyHan.max} 个汉字`);
  }
  if (fingerprintRules?.requireFirstPerson === true && fingerprint.person !== 'first') {
    errors.push(`整篇判定为第三人称（我 ${fingerprint.firstPersonCount} 次，他/她 ${fingerprint.thirdPersonCount} 次）`);
  }
  if (fingerprintRules?.forbidDoubleQuoteStyle === true && fingerprint.quote === 'double') {
    errors.push(`整篇使用双引号风格（直角引号 ${fingerprint.cornerQuoteCount} 个，双引号 ${fingerprint.doubleQuoteCount} 个）`);
  }
  if (fingerprintRules?.requireNumberedSections === true && fingerprint.sections === 0) {
    errors.push('整篇没有编号小节');
  }
  if (fingerprintRules?.warnNoDialogueQuotes === true && fingerprint.quote === 'none') {
    warnings.push('整篇没有对白引号');
  }
  return { fingerprint, errors, warnings };
}

function occurrences(text: string, pattern: RegExp): number {
  return text.match(pattern)?.length ?? 0;
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = sorted.length >> 1;
  return sorted.length % 2 === 1
    ? (sorted[middle] ?? null)
    : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}


export function countHan(text: string): number {
  return text.match(HAN_PATTERN)?.length ?? 0;
}

export function countNumberedOutlineSections(text: string): number {
  return text.split(/\r?\n/u).filter((line) => OUTLINE_SECTION_PATTERN.test(line)).length;
}

export function validateOutputStructure(
  slots: readonly { id: string; type: string }[],
  input: Readonly<Record<string, string>>,
  validation: OutputValidationSpec | null,
  slotTypes: readonly StaticSlotLimits[],
): OutputStructureViolation[] {
  if (validation === null) return [];
  const violations: OutputStructureViolation[] = [];

  for (const [type, range] of Object.entries(validation.slotCounts)) {
    const matching = slots.filter((slot) => slot.type === type);
    if (matching.length < range.min || matching.length > range.max) {
      violations.push({
        rule: 'OUTPUT_SLOT_COUNT',
        message: `槽位类型「${type}」有 ${matching.length} 个，要求 ${formatRange(range)} 个。`,
        agentHint: `请把类型为 ${type} 的槽位数量调整为 ${formatRange(range)} 个；当前是 ${matching.length} 个。`,
        slotIds: matching.map((slot) => slot.id),
      });
    }
  }

  if (validation.outlineCount !== null) {
    const expected = countNumberedOutlineSections(input[validation.outlineCount.inputField] ?? '');
    const matching = slots.filter((slot) => slot.type === validation.outlineCount?.slotType);
    if (expected !== matching.length) {
      violations.push({
        rule: 'OUTPUT_OUTLINE_COUNT',
        message: `上游大纲有 ${expected} 个编号小节，结构提交了 ${matching.length} 个 ${validation.outlineCount.slotType} 槽位。`,
        agentHint: `请严格按上游大纲一一建立 ${validation.outlineCount.slotType}：需要 ${expected} 个，当前是 ${matching.length} 个。`,
        slotIds: matching.map((slot) => slot.id),
      });
    }
  }

  if (validation.storyHan !== null) {
    const budgetSlots = slots.filter((slot) => slot.type === validation.storyHan?.slotType);
    const range = deriveBudgetRange(validation.storyHan, budgetSlots.length, slotTypes);
    if (range === null) {
      violations.push({
        rule: 'OUTPUT_BUDGET_IMPOSSIBLE',
        message: `当前 ${budgetSlots.length} 个 ${validation.storyHan.slotType} 槽位无法同时满足整篇 ${validation.storyHan.min}–${validation.storyHan.max} 汉字预算与各槽位静态限制。`,
        agentHint: `请调整 ${validation.storyHan.slotType} 槽位数量，使系统能够为每个槽位分配可满足的汉字区间。`,
        slotIds: budgetSlots.map((slot) => slot.id),
      });
    }
  }

  return violations;
}

export function deriveEffectiveHanRange(
  targetType: string,
  slots: readonly Pick<Slot, 'type'>[],
  validation: OutputValidationSpec | null,
  slotTypes: readonly StaticSlotLimits[],
): EffectiveHanRange | null {
  const budget = validation?.storyHan;
  if (budget === null || budget === undefined || targetType !== budget.slotType) return null;
  return deriveBudgetRange(budget, slots.filter((slot) => slot.type === budget.slotType).length, slotTypes);
}

function deriveBudgetRange(
  budget: StoryHanBudget,
  budgetSlotCount: number,
  slotTypes: readonly StaticSlotLimits[],
): EffectiveHanRange | null {
  if (budgetSlotCount <= 0) return null;
  const budgetType = slotTypes.find((type) => type.id === budget.slotType);
  if (budgetType === undefined) return null;

  const reservedMax = slotTypes
    .filter((type) => type.id !== budget.slotType && type.contentBearing && type.includeInArtifact)
    .reduce((sum, type) => sum + (type.maxChars ?? 0), 0);
  const minHan = Math.max(1, Math.ceil(budget.min / budgetSlotCount));
  const maxHan = Math.min(
    Math.floor((budget.max - reservedMax) / budgetSlotCount),
    budgetType.maxChars ?? Number.POSITIVE_INFINITY,
  );
  const staticMin = budgetType.minChars ?? 0;
  const staticMax = budgetType.maxChars ?? Number.POSITIVE_INFINITY;

  if (minHan > maxHan || minHan > staticMax || maxHan < staticMin) return null;
  return { minHan, maxHan };
}

function formatRange(range: SlotCountRule): string {
  return range.min === range.max ? String(range.min) : `${range.min}–${range.max}`;
}
