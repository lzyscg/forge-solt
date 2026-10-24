import { z } from 'zod';

import {
  compileNarrativePlanUnits,
  type CompiledNarrativePlan,
  type NarrativeBudget,
  type NarrativeCapacity,
  type NarrativeExpansion,
  type NarrativeMode,
  type NarrativePriority,
} from './narrative-plan.ts';

const SECTION_HEADING_PATTERN = /^\s*(\d{1,3})(?:\s*[.．、](?:\s*\S.*)?)?\s*$/u;
const HAN_PATTERN = /[一-鿿]/gu;
const MIN_SECTION_COUNT = 8;
const MAX_SECTION_COUNT = 30;

const NarrativeAnswerUnitSchema = z.object({
  sourceSectionRef: z.string().min(1),
  title: z.string().trim().min(1),
  change: z.object({ from: z.string().trim().min(1), to: z.string().trim().min(1) }).strict(),
  priority: z.enum(['P0', 'P1', 'bridge']),
  mode: z.enum(['fast-summary', 'conflict-scene', 'suspense-discovery', 'emotional-reality', 'custom']),
  capacity: z.object({
    dialogueTurns: z.number().int().min(0),
    actionFeedbackLoops: z.number().int().min(0),
    cognitionTurns: z.number().int().min(0),
    aftermathBeats: z.number().int().min(0),
  }).strict(),
  cast: z.array(z.string().trim().min(1)),
  objective: z.string().trim().min(1),
  conflict: z.string().trim().min(1),
  endState: z.string().trim().min(1),
  informationControl: z.string().trim().min(1).nullable(),
}).strict();

export const NarrativeAnswerSchema = z.object({
  units: z.array(NarrativeAnswerUnitSchema),
}).strict();

const NarrativeAnswerV3UnitSchema = z.object({
  sourceSectionRef: z.string().min(1),
  title: z.string().trim().min(1),
  priority: z.enum(['P0', 'P1', 'bridge']),
  mode: z.enum(['fast-summary', 'conflict-scene', 'suspense-discovery', 'emotional-reality', 'custom']),
  capacity: z.object({
    dialogueTurns: z.number().int().min(0),
    actionFeedbackLoops: z.number().int().min(0),
    cognitionTurns: z.number().int().min(0),
    aftermathBeats: z.number().int().min(0),
  }).strict(),
  cast: z.array(z.string().trim().min(1)),
  intent: z.string().trim().min(1),
  resistance: z.string().trim().min(1),
  outcome: z.string().trim().min(1),
  informationControl: z.string().trim().min(1).nullable(),
}).strict();

export const NarrativeAnswerV3Schema = z.object({
  initialState: z.string().trim().min(1),
  units: z.array(NarrativeAnswerV3UnitSchema),
}).strict();

export type NarrativeAnswer = z.infer<typeof NarrativeAnswerSchema>;

export interface NarrativeSourceSection {
  ref: string;
  sourceToken: string;
  order: number;
  hanCount: number;
  expansion: NarrativeExpansion;
}

export interface PreparedNarrativeAnswerContract {
  kind: 'narrative-plan';
  version: 2;
  sourceSegmentation: 'preserve-numbered-sections';
  expansionPolicy: 'source-length-quantiles-v1';
  sections: readonly NarrativeSourceSection[];
}

export type PrepareNarrativeAnswerResult =
  | { ok: true; contract: PreparedNarrativeAnswerContract; sections: readonly NarrativeSourceSection[] }
  | { ok: false; reason: 'SOURCE_SECTIONS_UNAVAILABLE' };

export type NarrativeAnswerRule =
  | 'ANSWER_INVALID'
  | 'SOURCE_SECTION_REF_DUPLICATE'
  | 'SOURCE_SECTION_REF_UNKNOWN'
  | 'SOURCE_SECTION_REF_MISSING'
  | 'CAPACITY_EXCEEDED'
  | 'PLAN_INVALID';

export interface NarrativeAnswerViolation {
  rule: NarrativeAnswerRule;
  sourceSectionRef: string | null;
  message: string;
}

export type CompileNarrativeAnswerResult =
  | { ok: true; plan: CompiledNarrativePlan }
  | { ok: false; violations: NarrativeAnswerViolation[] };

export function prepareNarrativeAnswerContract(source: string): PrepareNarrativeAnswerResult {
  const normalized = source.normalize('NFC').replace(/\r\n?/gu, '\n');
  const sections: { token: string; body: string[] }[] = [];
  let current: { token: string; body: string[] } | null = null;

  for (const rawLine of normalized.split('\n')) {
    const line = rawLine.trim();
    const heading = SECTION_HEADING_PATTERN.exec(line);
    if (heading !== null) {
      if (current !== null) sections.push(current);
      current = { token: heading[1]!, body: [] };
      continue;
    }
    if (current !== null && line !== '') current.body.push(line);
  }
  if (current !== null) sections.push(current);

  if (sections.length < MIN_SECTION_COUNT || sections.length > MAX_SECTION_COUNT) {
    return { ok: false, reason: 'SOURCE_SECTIONS_UNAVAILABLE' };
  }

  const lengths = sections.map((section) => countHan(section.body.join('\n')));
  const ordered = [...lengths].sort((left, right) => left - right);
  const q30 = ordered[Math.floor((ordered.length - 1) * 0.3)] ?? 0;
  const q70 = ordered[Math.floor((ordered.length - 1) * 0.7)] ?? 0;
  const profiled = sections.map((section, index): NarrativeSourceSection => ({
    ref: `source-section-${String(index + 1).padStart(2, '0')}`,
    sourceToken: section.token,
    order: index + 1,
    hanCount: lengths[index]!,
    expansion: lengths[index]! <= q30 ? 'light' : lengths[index]! >= q70 ? 'detailed' : 'standard',
  }));
  const contract: PreparedNarrativeAnswerContract = {
    kind: 'narrative-plan',
    version: 2,
    sourceSegmentation: 'preserve-numbered-sections',
    expansionPolicy: 'source-length-quantiles-v1',
    sections: profiled,
  };
  return { ok: true, contract, sections: profiled };
}

export function compileNarrativeAnswerV3(input: {
  contract: PreparedNarrativeAnswerContract | { sections: readonly NarrativeSourceSection[] };
  answer: unknown;
  storyBudget: NarrativeBudget;
}): CompileNarrativeAnswerResult {
  const parsed = NarrativeAnswerV3Schema.safeParse(input.answer);
  if (!parsed.success) {
    return {
      ok: false,
      violations: parsed.error.issues.map((issue) => ({
        rule: issue.path.includes('capacity') ? 'CAPACITY_EXCEEDED' : 'ANSWER_INVALID',
        sourceSectionRef: sectionRefAt(input.answer, issue.path),
        message: `${issue.path.join('.') || '(根)'}: ${issue.message}`,
      })),
    };
  }
  return compileNarrativeAnswer({
    contract: input.contract,
    storyBudget: input.storyBudget,
    answer: {
      units: parsed.data.units.map((unit, index) => ({
        sourceSectionRef: unit.sourceSectionRef,
        title: unit.title,
        change: {
          from: index === 0 ? parsed.data.initialState : parsed.data.units[index - 1]!.outcome,
          to: unit.outcome,
        },
        priority: unit.priority,
        mode: unit.mode,
        capacity: unit.capacity,
        cast: unit.cast,
        objective: unit.intent,
        conflict: unit.resistance,
        endState: unit.outcome,
        informationControl: unit.informationControl,
      })),
    },
  });
}

export function compileNarrativeAnswer(input: {
  contract: PreparedNarrativeAnswerContract | { sections: readonly NarrativeSourceSection[] };
  answer: unknown;
  storyBudget: NarrativeBudget;
}): CompileNarrativeAnswerResult {
  const parsed = NarrativeAnswerSchema.safeParse(input.answer);
  if (!parsed.success) {
    return {
      ok: false,
      violations: parsed.error.issues.map((issue) => ({
        rule: issue.path.includes('capacity') ? 'CAPACITY_EXCEEDED' : 'ANSWER_INVALID',
        sourceSectionRef: sectionRefAt(input.answer, issue.path),
        message: `${issue.path.join('.') || '(根)'}: ${issue.message}`,
      })),
    };
  }

  const expected = new Map(input.contract.sections.map((section) => [section.ref, section]));
  const seen = new Set<string>();
  const violations: NarrativeAnswerViolation[] = [];
  const capacityMax: NarrativeCapacity = {
    dialogueTurns: 8,
    actionFeedbackLoops: 4,
    cognitionTurns: 4,
    aftermathBeats: 2,
  };
  for (const unit of parsed.data.units) {
    for (const key of Object.keys(capacityMax) as (keyof NarrativeCapacity)[]) {
      if (unit.capacity[key] <= capacityMax[key]) continue;
      violations.push({
        rule: 'CAPACITY_EXCEEDED',
        sourceSectionRef: unit.sourceSectionRef,
        message: `${unit.sourceSectionRef} 的 ${key}=${unit.capacity[key]} 超过上限 ${capacityMax[key]}`,
      });
    }
    if (!expected.has(unit.sourceSectionRef)) {
      violations.push({
        rule: 'SOURCE_SECTION_REF_UNKNOWN',
        sourceSectionRef: unit.sourceSectionRef,
        message: `未知原文分节引用 ${unit.sourceSectionRef}`,
      });
      continue;
    }
    if (seen.has(unit.sourceSectionRef)) {
      violations.push({
        rule: 'SOURCE_SECTION_REF_DUPLICATE',
        sourceSectionRef: unit.sourceSectionRef,
        message: `原文分节引用 ${unit.sourceSectionRef} 重复`,
      });
    }
    seen.add(unit.sourceSectionRef);
  }
  for (const section of input.contract.sections) {
    if (!seen.has(section.ref)) {
      violations.push({
        rule: 'SOURCE_SECTION_REF_MISSING',
        sourceSectionRef: section.ref,
        message: `缺少原文分节 ${section.ref} 的业务回答`,
      });
    }
  }
  if (violations.length > 0) return { ok: false, violations };

  const byRef = new Map(parsed.data.units.map((unit) => [unit.sourceSectionRef, unit]));
  let priorityNumber = 0;
  const units = input.contract.sections.map((section, index) => {
    const answer = byRef.get(section.ref)!;
    const priorityId = answer.priority === 'bridge'
      ? null
      : `P${String(++priorityNumber).padStart(3, '0')}`;
    return {
      unitId: `unit_${String(index + 1).padStart(2, '0')}`,
      order: index + 1,
      title: answer.title,
      change: answer.change,
      priority: answer.priority,
      priorityId,
      expansion: section.expansion,
      mode: answer.mode,
      capacity: answer.capacity,
      cast: [...answer.cast],
      objective: answer.objective,
      conflict: answer.conflict,
      endState: answer.endState,
      informationControl: answer.informationControl,
    };
  });
  const compiled = compileNarrativePlanUnits({ units, storyBudget: input.storyBudget });
  if (!compiled.ok) {
    return {
      ok: false,
      violations: compiled.violations.map((violation) => ({
        rule: 'PLAN_INVALID',
        sourceSectionRef: violation.unitId,
        message: `[${violation.rule}] ${violation.message}`,
      })),
    };
  }
  return compiled;
}

const EXPANSION_TEXT: Readonly<Record<NarrativeExpansion, string>> = {
  light: '轻过渡',
  standard: '标准',
  detailed: '细写',
};
const MODE_TEXT: Readonly<Record<NarrativeMode, string>> = {
  'fast-summary': '快叙',
  'conflict-scene': '冲突场景',
  'suspense-discovery': '悬疑发现',
  'emotional-reality': '现实情感',
  custom: '自定义',
};

export function serializeNarrativePlanMarkdown(
  plan: CompiledNarrativePlan,
  contract: { sections: readonly NarrativeSourceSection[] },
): string {
  return plan.units.map((unit, index) => {
    const source = contract.sections[index];
    if (source === undefined) throw new Error(`NarrativePlan 缺少第 ${index + 1} 个原文分节绑定`);
    const priority = unit.priority === 'bridge' ? 'bridge' : `${unit.priority} ${unit.priorityId}`;
    const capacity = unit.capacity;
    return [
      `${source.sourceToken}. ${unit.title}`,
      `变化：${unit.change.from} → ${unit.change.to}`,
      `重点：${priority}`,
      `展开：${EXPANSION_TEXT[unit.expansion]}`,
      `模式：${MODE_TEXT[unit.mode]}`,
      `容量：对白轮次 ${capacity.dialogueTurns}；动作反馈闭环 ${capacity.actionFeedbackLoops}；认知转折 ${capacity.cognitionTurns}；事后余波 ${capacity.aftermathBeats}`,
      `出场：${unit.cast.length === 0 ? '无' : unit.cast.join('、')}`,
      `目标：${unit.objective}`,
      `冲突：${unit.conflict}`,
      `结束状态：${unit.endState}`,
      ...(unit.informationControl === null ? [] : [`信息控制：${unit.informationControl}`]),
    ].join('\n');
  }).join('\n\n');
}

function countHan(text: string): number {
  return text.match(HAN_PATTERN)?.length ?? 0;
}

function sectionRefAt(answer: unknown, path: readonly PropertyKey[]): string | null {
  const unitIndex = path[0] === 'units' && typeof path[1] === 'number' ? path[1] : null;
  if (unitIndex === null || typeof answer !== 'object' || answer === null) return null;
  const units = (answer as { units?: unknown }).units;
  if (!Array.isArray(units)) return null;
  const unit = units[unitIndex];
  if (typeof unit !== 'object' || unit === null) return null;
  const ref = (unit as { sourceSectionRef?: unknown }).sourceSectionRef;
  return typeof ref === 'string' ? ref : null;
}

export type { NarrativeCapacity, NarrativePriority };
