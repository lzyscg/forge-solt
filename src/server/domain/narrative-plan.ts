export type NarrativePriority = 'P0' | 'P1' | 'bridge';
export type NarrativeExpansion = 'detailed' | 'standard' | 'light';
export type NarrativeMode =
  | 'fast-summary'
  | 'conflict-scene'
  | 'suspense-discovery'
  | 'emotional-reality'
  | 'custom';

export interface NarrativeCapacity {
  dialogueTurns: number;
  actionFeedbackLoops: number;
  cognitionTurns: number;
  aftermathBeats: number;
}

export interface NarrativeBudget {
  minHan: number;
  targetHan: number;
  maxHan: number;
}

export interface CompiledNarrativeUnit {
  unitId: string;
  order: number;
  title: string;
  change: { from: string; to: string };
  priority: NarrativePriority;
  priorityId: string | null;
  expansion: NarrativeExpansion;
  mode: NarrativeMode;
  capacity: NarrativeCapacity;
  cast: string[];
  objective: string;
  conflict: string;
  endState: string;
  informationControl: string | null;
  weight: number;
  budget: NarrativeBudget;
}

export interface CompiledNarrativePlan {
  version: 1;
  weightProfile: 'i0-three-mode-v1';
  storyBudget: NarrativeBudget;
  units: CompiledNarrativeUnit[];
}

export type NarrativePlanRule =
  | 'OUTLINE_EMPTY'
  | 'OUTLINE_FORMAT_UNSUPPORTED'
  | 'SECTION_COUNT'
  | 'SECTION_NUMBER'
  | 'FIELD_MISSING'
  | 'FIELD_INVALID'
  | 'CAPACITY_EXCEEDED'
  | 'PRIORITY_ID_DUPLICATE'
  | 'PRIORITY_ID_SEQUENCE'
  | 'NO_P0'
  | 'ENDING_NOT_P0'
  | 'UNIFORM_EXPANSION'
  | 'STORY_BUDGET_INVALID'
  | 'STORY_BUDGET_UNSATISFIABLE';

export interface NarrativePlanViolation {
  rule: NarrativePlanRule;
  unitId: string | null;
  message: string;
}

export type CompileNarrativePlanResult =
  | { ok: true; plan: CompiledNarrativePlan }
  | { ok: false; violations: NarrativePlanViolation[] };

export interface CompileNarrativePlanInput {
  outlineMarkdown: string;
  storyBudget: NarrativeBudget;
}

export interface NarrativePlanUnitInput {
  unitId: string;
  order: number;
  title: string;
  change: { from: string; to: string };
  priority: NarrativePriority;
  priorityId: string | null;
  expansion: NarrativeExpansion;
  mode: NarrativeMode;
  capacity: NarrativeCapacity;
  cast: string[];
  objective: string;
  conflict: string;
  endState: string;
  informationControl: string | null;
}

export interface CompileNarrativePlanUnitsInput {
  units: readonly NarrativePlanUnitInput[];
  storyBudget: NarrativeBudget;
}

interface ParsedUnit extends Omit<CompiledNarrativeUnit, 'unitId' | 'weight' | 'budget'> {
  unitId: string;
}

const MIN_SECTION_COUNT = 8;
const MAX_SECTION_COUNT = 30;

const SECTION_PATTERN = /^\s*(\d{1,3})[.．、]\s*(\S.*)$/u;
const FIELD_PATTERN = /^([^：:]+)[：:]\s*(.*)$/u;
const CHANGE_PATTERN = /^(.+?)\s*(?:→|->)\s*(.+)$/u;
const PRIORITY_PATTERN = /^(P0|P1)\s+(P\d{3})$/u;
const CAPACITY_PATTERN = /^对白轮次\s*(\d+)(?:（[^）]*）)?\s*；\s*动作反馈闭环\s*(\d+)(?:（[^）]*）)?\s*；\s*认知转折\s*(\d+)(?:（[^）]*）)?\s*；\s*事后余波\s*(\d+)(?:（[^）]*）)?$/u;

const EXPANSION_MAP: Readonly<Record<string, NarrativeExpansion>> = {
  细写: 'detailed',
  标准: 'standard',
  轻过渡: 'light',
};

const MODE_MAP: Readonly<Record<string, NarrativeMode>> = {
  快叙: 'fast-summary',
  冲突场景: 'conflict-scene',
  悬疑发现: 'suspense-discovery',
  现实情感: 'emotional-reality',
  自定义: 'custom',
};

/**
 * I0 三故事只校准相对量级，不拍绝对字数：快叙 7233/26、冲突 6920/23、
 * 现实情感 7394/9。以冲突为 1，模式倍率取故事节均字数的相对值。
 */
const MODE_WEIGHT: Readonly<Record<NarrativeMode, number>> = {
  'fast-summary': 0.92,
  'conflict-scene': 1,
  'suspense-discovery': 1.15,
  'emotional-reality': 2.7,
  custom: 1,
};

const EXPANSION_WEIGHT: Readonly<Record<NarrativeExpansion, number>> = {
  light: 0.6069920579679814,
  standard: 1,
  detailed: 1.5602547530317912,
};

const CAPACITY_MAX: NarrativeCapacity = {
  dialogueTurns: 8,
  actionFeedbackLoops: 4,
  cognitionTurns: 4,
  aftermathBeats: 2,
};

export function compileNarrativePlanUnits(
  input: CompileNarrativePlanUnitsInput,
): CompileNarrativePlanResult {
  const violations: NarrativePlanViolation[] = [];
  if (!validBudget(input.storyBudget)) {
    violations.push({
      rule: 'STORY_BUDGET_INVALID',
      unitId: null,
      message: 'story budget 必须是正整数且 minHan ≤ targetHan ≤ maxHan',
    });
  }
  if (input.units.length < MIN_SECTION_COUNT || input.units.length > MAX_SECTION_COUNT) {
    violations.push({
      rule: 'SECTION_COUNT',
      unitId: null,
      message: `大纲需要 ${MIN_SECTION_COUNT}–${MAX_SECTION_COUNT} 个小节，实际为 ${input.units.length}`,
    });
  }
  if (!input.units.slice(0, -1).some((unit) => unit.priority === 'P0')) {
    violations.push({ rule: 'NO_P0', unitId: null, message: '结局前至少需要一个 P0 建立主要阅读动力' });
  }
  const endingUnit = input.units.at(-1);
  if (endingUnit !== undefined && endingUnit.priority !== 'P0') {
    violations.push({
      rule: 'ENDING_NOT_P0',
      unitId: endingUnit.unitId,
      message: '最后一个小节必须以 P0 兑现原文结局',
    });
  }
  if (new Set(input.units.map((unit) => unit.expansion)).size < 2) {
    violations.push({
      rule: 'UNIFORM_EXPANSION', unitId: null,
      message: '全部小节使用同一展开档，无法表达真人范文的轻重分配',
    });
  }
  if (violations.length > 0) return { ok: false, violations };

  const weighted = input.units.map((unit) => ({ ...unit, weight: weightOf(unit) }));
  if (input.storyBudget.minHan < weighted.length) {
    return {
      ok: false,
      violations: [{
        rule: 'STORY_BUDGET_UNSATISFIABLE',
        unitId: null,
        message: `story budget 的 minHan=${input.storyBudget.minHan} 无法让 ${weighted.length} 个 unit 各获得至少 1 汉字`,
      }],
    };
  }

  const weights = weighted.map((unit) => unit.weight);
  const targetBudgets = largestRemainderWithBounds(
    input.storyBudget.targetHan,
    weights,
    weighted.map(() => 1),
  );
  const minBudgets = largestRemainderWithBounds(
    input.storyBudget.minHan,
    weights,
    weighted.map(() => 1),
    targetBudgets,
  );
  const maxGrowth = largestRemainderWithBounds(
    input.storyBudget.maxHan - input.storyBudget.targetHan,
    weights,
    weighted.map(() => 0),
  );
  const maxBudgets = targetBudgets.map((target, index) => target + maxGrowth[index]!);

  return {
    ok: true,
    plan: {
      version: 1,
      weightProfile: 'i0-three-mode-v1',
      storyBudget: { ...input.storyBudget },
      units: weighted.map((unit, index) => ({
        ...unit,
        budget: {
          minHan: minBudgets[index]!,
          targetHan: targetBudgets[index]!,
          maxHan: maxBudgets[index]!,
        },
      })),
    },
  };
}

export function compileNarrativePlan(input: CompileNarrativePlanInput): CompileNarrativePlanResult {
  const violations: NarrativePlanViolation[] = [];
  const normalizedOutline = normalizeOutline(input.outlineMarkdown);
  if (startsWithJsonContainer(normalizedOutline)) {
    return {
      ok: false,
      violations: [{
        rule: 'OUTLINE_FORMAT_UNSUPPORTED',
        unitId: null,
        message: '大纲只接受 Outline v2 Markdown，不接受 JSON 对象或数组',
      }],
    };
  }
  if (!validBudget(input.storyBudget)) {
    violations.push({
      rule: 'STORY_BUDGET_INVALID',
      unitId: null,
      message: 'story budget 必须是正整数且 minHan ≤ targetHan ≤ maxHan',
    });
  }

  const rawSections = splitSections(normalizedOutline);
  if (rawSections.length === 0) {
    violations.push({ rule: 'OUTLINE_EMPTY', unitId: null, message: '大纲没有 N. 标题形式的编号小节' });
    return { ok: false, violations };
  }
  if (rawSections.length < MIN_SECTION_COUNT || rawSections.length > MAX_SECTION_COUNT) {
    violations.push({
      rule: 'SECTION_COUNT',
      unitId: null,
      message: `大纲需要 ${MIN_SECTION_COUNT}–${MAX_SECTION_COUNT} 个小节，实际为 ${rawSections.length}`,
    });
  }

  const parsed: ParsedUnit[] = [];
  rawSections.forEach((section, index) => {
    const expected = index + 1;
    const unitId = `unit_${String(expected).padStart(2, '0')}`;
    if (section.number !== expected) {
      violations.push({
        rule: 'SECTION_NUMBER', unitId,
        message: `编号应为 ${expected}，实际为 ${section.number}`,
      });
    }
    const unit = parseUnit(section, unitId, violations);
    if (unit !== null) parsed.push(unit);
  });

  const priorityIds = new Map<string, string[]>();
  const orderedPriorityUnits: ParsedUnit[] = [];
  for (const unit of parsed) {
    if (unit.priorityId === null) continue;
    orderedPriorityUnits.push(unit);
    const bucket = priorityIds.get(unit.priorityId) ?? [];
    bucket.push(unit.unitId);
    priorityIds.set(unit.priorityId, bucket);
  }
  for (const [id, unitIds] of priorityIds) {
    if (unitIds.length <= 1) continue;
    violations.push({
      rule: 'PRIORITY_ID_DUPLICATE', unitId: unitIds[0] ?? null,
      message: `重点 ID ${id} 在 ${unitIds.join('、')} 重复，P0/P1 必须只有一个兑现位置`,
    });
  }
  orderedPriorityUnits.forEach((unit, index) => {
    const expected = `P${String(index + 1).padStart(3, '0')}`;
    if (unit.priorityId === expected) return;
    violations.push({
      rule: 'PRIORITY_ID_SEQUENCE',
      unitId: unit.unitId,
      message: `${unit.unitId} 的重点 ID 应为 ${expected}，实际为 ${unit.priorityId}`,
    });
  });
  if (!parsed.slice(0, -1).some((unit) => unit.priority === 'P0')) {
    violations.push({ rule: 'NO_P0', unitId: null, message: '结局前至少需要一个 P0 建立主要阅读动力' });
  }
  const endingUnit = parsed.length === rawSections.length ? parsed.at(-1) : undefined;
  if (endingUnit !== undefined && endingUnit.priority !== 'P0') {
    violations.push({
      rule: 'ENDING_NOT_P0',
      unitId: endingUnit.unitId,
      message: '最后一个小节必须以 P0 兑现原文结局',
    });
  }
  if (new Set(parsed.map((unit) => unit.expansion)).size < 2) {
    violations.push({
      rule: 'UNIFORM_EXPANSION', unitId: null,
      message: '全部小节使用同一展开档，无法表达真人范文的轻重分配',
    });
  }

  if (violations.length > 0) return { ok: false, violations };

  return compileNarrativePlanUnits({ units: parsed, storyBudget: input.storyBudget });
}

interface RawSection { number: number; title: string; lines: string[] }

function normalizeOutline(outline: string): string {
  return outline.normalize('NFC').replace(/\r\n?/gu, '\n').trimStart();
}

function startsWithJsonContainer(outline: string): boolean {
  return outline.startsWith('{') || outline.startsWith('[');
}

function splitSections(markdown: string): RawSection[] {
  const sections: RawSection[] = [];
  let current: RawSection | null = null;
  for (const rawLine of markdown.split('\n')) {
    const line = rawLine.trim();
    const heading = SECTION_PATTERN.exec(line);
    if (heading !== null) {
      if (current !== null) sections.push(current);
      current = { number: Number(heading[1]), title: heading[2]!.trim(), lines: [] };
      continue;
    }
    if (current !== null && line !== '') current.lines.push(line);
  }
  if (current !== null) sections.push(current);
  return sections;
}

function parseUnit(
  section: RawSection,
  unitId: string,
  violations: NarrativePlanViolation[],
): ParsedUnit | null {
  const fields = new Map<string, string>();
  for (const line of section.lines) {
    const match = FIELD_PATTERN.exec(line);
    if (match !== null) fields.set(match[1]!.trim(), match[2]!.trim());
  }
  const required = ['变化', '重点', '展开', '模式', '容量', '出场', '目标', '冲突', '结束状态'];
  const missing = required.filter((field) => !fields.get(field));
  for (const field of missing) {
    violations.push({ rule: 'FIELD_MISSING', unitId, message: `${unitId} 缺少字段「${field}」` });
  }
  if (missing.length > 0) return null;

  const changeMatch = CHANGE_PATTERN.exec(fields.get('变化')!);
  if (changeMatch === null) invalid(violations, unitId, '变化必须写成「起始状态 → 新状态」');

  const priorityText = fields.get('重点')!;
  const priorityMatch = PRIORITY_PATTERN.exec(priorityText);
  let priority: NarrativePriority | null = null;
  let priorityId: string | null = null;
  if (priorityText === 'bridge') priority = 'bridge';
  else if (priorityMatch !== null) {
    priority = priorityMatch[1] as 'P0' | 'P1';
    priorityId = priorityMatch[2]!;
  } else invalid(violations, unitId, '重点必须是「P0 ID」「P1 ID」或 bridge');

  const expansion = EXPANSION_MAP[fields.get('展开')!] ?? null;
  if (expansion === null) invalid(violations, unitId, '展开必须是细写、标准或轻过渡');
  const mode = MODE_MAP[fields.get('模式')!] ?? null;
  if (mode === null) invalid(violations, unitId, '模式不在允许范围');

  const capacityMatch = CAPACITY_PATTERN.exec(fields.get('容量')!);
  let capacity: NarrativeCapacity | null = null;
  if (capacityMatch === null) invalid(violations, unitId, '容量字段格式非法');
  else {
    capacity = {
      dialogueTurns: Number(capacityMatch[1]),
      actionFeedbackLoops: Number(capacityMatch[2]),
      cognitionTurns: Number(capacityMatch[3]),
      aftermathBeats: Number(capacityMatch[4]),
    };
    for (const key of Object.keys(CAPACITY_MAX) as (keyof NarrativeCapacity)[]) {
      if (capacity[key] <= CAPACITY_MAX[key]) continue;
      violations.push({
        rule: 'CAPACITY_EXCEEDED', unitId,
        message: `${unitId} 的 ${key}=${capacity[key]} 超过上限 ${CAPACITY_MAX[key]}`,
      });
    }
  }

  if (changeMatch === null || priority === null || expansion === null || mode === null || capacity === null) return null;

  return {
    unitId,
    order: section.number,
    title: section.title,
    change: { from: changeMatch[1]!.trim(), to: changeMatch[2]!.trim() },
    priority,
    priorityId,
    expansion,
    mode,
    capacity,
    cast: list(fields.get('出场')!),
    objective: fields.get('目标')!,
    conflict: fields.get('冲突')!,
    endState: fields.get('结束状态')!,
    informationControl: fields.get('信息控制') || null,
  };
}

function list(value: string): string[] {
  const trimmed = value.trim();
  if (trimmed === '无' || trimmed === '（无）') return [];
  return trimmed.split(/[、,，]/u).map((item) => item.trim()).filter(Boolean);
}

function invalid(violations: NarrativePlanViolation[], unitId: string, message: string): void {
  violations.push({ rule: 'FIELD_INVALID', unitId, message });
}

function weightOf(unit: ParsedUnit): number {
  const capacityWeight =
    unit.capacity.dialogueTurns * 0.10 +
    unit.capacity.actionFeedbackLoops * 0.18 +
    unit.capacity.cognitionTurns * 0.15 +
    unit.capacity.aftermathBeats * 0.12;
  const priorityWeight = unit.priority === 'P0' ? 1.2 : unit.priority === 'P1' ? 1 : 0.72;
  return MODE_WEIGHT[unit.mode] * EXPANSION_WEIGHT[unit.expansion] * priorityWeight * (1 + capacityWeight);
}

function largestRemainderWithBounds(
  total: number,
  weights: readonly number[],
  lowerBounds: readonly number[],
  upperBounds?: readonly number[],
): number[] {
  if (weights.length !== lowerBounds.length || (upperBounds !== undefined && weights.length !== upperBounds.length)) {
    throw new Error('largest-remainder 的 weights 与 bounds 长度必须一致');
  }
  if (!weights.every((weight) => Number.isFinite(weight) && weight > 0)) {
    throw new Error('largest-remainder 的 weight 必须是有限正数');
  }
  const validBounds = lowerBounds.every((lower, index) =>
    Number.isInteger(lower) && lower >= 0 &&
    (upperBounds === undefined || (
      Number.isInteger(upperBounds[index]) && upperBounds[index]! >= lower
    )),
  );
  if (!validBounds) throw new Error('largest-remainder 的 bounds 必须是有效非负整数区间');

  const allocated = [...lowerBounds];
  let remaining = total - allocated.reduce((sum, value) => sum + value, 0);
  if (remaining < 0) throw new Error('largest-remainder 的 total 小于下界总和');

  while (remaining > 0) {
    const eligible = weights
      .map((weight, index) => ({ index, weight }))
      .filter(({ index }) => upperBounds === undefined || allocated[index]! < upperBounds[index]!);
    if (eligible.length === 0) throw new Error('largest-remainder 的 total 超过上界总和');

    const eligibleWeightTotal = eligible.reduce((sum, item) => sum + item.weight, 0);
    const roundTotal = remaining;
    const exact = eligible.map((item) => ({
      ...item,
      exact: roundTotal * item.weight / eligibleWeightTotal,
    }));
    let roundAllocated = 0;
    for (const item of exact) {
      const capacity = upperBounds === undefined
        ? Number.POSITIVE_INFINITY
        : upperBounds[item.index]! - allocated[item.index]!;
      const amount = Math.min(Math.floor(item.exact), capacity);
      allocated[item.index]! += amount;
      roundAllocated += amount;
    }
    remaining -= roundAllocated;
    if (remaining === 0) break;

    const order = exact
      .filter((item) => upperBounds === undefined || allocated[item.index]! < upperBounds[item.index]!)
      .sort((left, right) =>
        right.exact - Math.floor(right.exact) - (left.exact - Math.floor(left.exact)) ||
        left.index - right.index,
      );
    if (order.length === 0) throw new Error('largest-remainder 的 total 超过上界总和');
    for (const item of order) {
      if (remaining === 0) break;
      allocated[item.index]! += 1;
      remaining -= 1;
    }
  }

  return allocated;
}

function validBudget(budget: NarrativeBudget): boolean {
  return [budget.minHan, budget.targetHan, budget.maxHan].every((value) => Number.isInteger(value) && value > 0) &&
    budget.minHan <= budget.targetHan && budget.targetHan <= budget.maxHan;
}
