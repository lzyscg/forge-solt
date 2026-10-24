import { sha256Hex } from './canonical.ts';

const HAN_PATTERN = /[一-鿿]/gu;
const SECTION_HEADING_PATTERN = /^\s*(\d{1,3})(?:\s*[.．、](?:\s*\S.*)?)?\s*$/u;
const SENTENCE_END_PATTERN = /[。！？…]+/u;
const QUOTE_SPAN_PATTERN = /「([^」]*)」|『([^』]*)』/gsu;
const NUMBER_PATTERN = /\d+(?:\.\d+)?/gu;

const GENERIC_CAMERA_TERMS = [
  '指尖', '喉咙', '喉头', '目光', '烟', '灯', '窗', '像', '仿佛',
  '忽然', '缓缓', '慢慢', '一点点', '一寸寸',
] as const;

const PROCEDURAL_TERMS = [
  '监控', '声纹', '时间戳', '警方', '警察', '检察院', '立案', '证物',
  '物证', '录音', '鉴定', '调查', '拘留证', '逮捕令', '办案',
] as const;

export type ImitationResponsibility =
  | 'outline'
  | 'plan'
  | 'prose'
  | 'character'
  | 'integrity'
  | 'compression';

export interface TextFidelityProfile {
  hash: string;
  han: number;
  numberedSections: number;
  prefaceHan: number;
  sectionHan: number[];
  sectionMedianHan: number | null;
  sectionMinHan: number | null;
  sectionMaxHan: number | null;
  sectionCoefficientOfVariation: number | null;
  paragraphs: number;
  paragraphMedianHan: number | null;
  sentenceMedianHan: number | null;
  quotedHan: number;
  quotedHanShare: number;
  cameraTermsPer10k: Readonly<Record<string, number>>;
}

export interface PrivateFidelityFinding {
  kind: 'uniform-expansion' | 'length-expansion' | 'novel-number' | 'novel-procedure';
  responsibility: ImitationResponsibility;
  severity: 'hard' | 'important' | 'diagnostic';
  message: string;
  draftEvidence: string | null;
}

export interface FidelityAudit {
  source: TextFidelityProfile;
  outline: TextFidelityProfile | null;
  draft: TextFidelityProfile | null;
  comparison: {
    expansionRatio: number | null;
    sectionMedianExpansionRatio: number | null;
    sourceSectionVariation: number | null;
    draftSectionVariation: number | null;
  };
  findings: PrivateFidelityFinding[];
}

export interface ImitationAuditInput {
  source: string;
  outline?: string | null;
  draft?: string | null;
}

export interface PublicFidelitySummary {
  sourceHash: string;
  outlineHash: string | null;
  draftHash: string | null;
  source: Omit<TextFidelityProfile, 'hash' | 'cameraTermsPer10k'>;
  outline: Omit<TextFidelityProfile, 'hash' | 'cameraTermsPer10k'> | null;
  draft: Omit<TextFidelityProfile, 'hash' | 'cameraTermsPer10k'> | null;
  comparison: FidelityAudit['comparison'];
  findingCounts: Readonly<Record<PrivateFidelityFinding['kind'], number>>;
  responsibilityCounts: Readonly<Record<ImitationResponsibility, number>>;
}

export function profileFidelityText(text: string): TextFidelityProfile {
  const normalized = text.normalize('NFC').replace(/\r\n?/gu, '\n');
  const lines = normalized.split('\n').map((line) => line.trim()).filter(Boolean);
  const sections: string[] = [];
  let preface = '';
  let current: string[] | null = null;

  for (const line of lines) {
    if (SECTION_HEADING_PATTERN.test(line)) {
      if (current !== null) sections.push(current.join('\n'));
      current = [];
      continue;
    }
    if (current === null) preface += `${line}\n`;
    else current.push(line);
  }
  if (current !== null) sections.push(current.join('\n'));

  const bodyLines = lines.filter((line) => !SECTION_HEADING_PATTERN.test(line));
  const body = bodyLines.join('\n');
  const paragraphLengths = bodyLines.map(countHan).filter((value) => value > 0);
  const sentenceLengths = body.replace(/\n/gu, '').split(SENTENCE_END_PATTERN).map(countHan).filter((value) => value > 0);
  const sectionHan = sections.map(countHan);
  const totalHan = countHan(body);
  const quotedHan = [...body.matchAll(QUOTE_SPAN_PATTERN)]
    .reduce((sum, match) => sum + countHan(match[1] ?? match[2] ?? ''), 0);

  return {
    hash: sha256Hex(normalized),
    han: totalHan,
    numberedSections: sections.length,
    prefaceHan: countHan(preface),
    sectionHan,
    sectionMedianHan: median(sectionHan),
    sectionMinHan: sectionHan.length === 0 ? null : Math.min(...sectionHan),
    sectionMaxHan: sectionHan.length === 0 ? null : Math.max(...sectionHan),
    sectionCoefficientOfVariation: coefficientOfVariation(sectionHan),
    paragraphs: paragraphLengths.length,
    paragraphMedianHan: median(paragraphLengths),
    sentenceMedianHan: median(sentenceLengths),
    quotedHan,
    quotedHanShare: totalHan === 0 ? 0 : quotedHan / totalHan,
    cameraTermsPer10k: Object.fromEntries(
      GENERIC_CAMERA_TERMS.map((term) => [term, totalHan === 0 ? 0 : occurrences(body, term) * 10_000 / totalHan]),
    ),
  };
}

export function auditImitation(input: ImitationAuditInput): FidelityAudit {
  const source = profileFidelityText(input.source);
  const outline = input.outline == null ? null : profileFidelityText(input.outline);
  const draft = input.draft == null ? null : profileFidelityText(input.draft);
  const findings: PrivateFidelityFinding[] = [];

  if (draft !== null) {
    const expansionRatio = ratio(draft.han, source.han);
    if (expansionRatio !== null && expansionRatio >= 1.5) {
      findings.push({
        kind: 'length-expansion', responsibility: 'plan', severity: 'important',
        message: `成稿汉字为原文的 ${expansionRatio.toFixed(2)} 倍，展开容量未受原文轻重约束`,
        draftEvidence: null,
      });
    }

    const sourceVariation = source.sectionCoefficientOfVariation;
    const draftVariation = draft.sectionCoefficientOfVariation;
    if (
      sourceVariation !== null && draftVariation !== null && sourceVariation >= 0.35 &&
      draftVariation <= sourceVariation * 0.55
    ) {
      findings.push({
        kind: 'uniform-expansion', responsibility: 'outline', severity: 'important',
        message: `成稿小节长度离散度 ${draftVariation.toFixed(3)}，显著低于原文 ${sourceVariation.toFixed(3)}`,
        draftEvidence: null,
      });
    }

    const sourceNumbers = new Set(input.source.match(NUMBER_PATTERN) ?? []);
    for (const number of unique(input.draft!.match(NUMBER_PATTERN) ?? []).filter((value) => !sourceNumbers.has(value))) {
      findings.push({
        kind: 'novel-number', responsibility: 'integrity', severity: 'hard',
        message: '成稿出现原文未授权的数字', draftEvidence: number,
      });
    }

    for (const term of PROCEDURAL_TERMS) {
      if (!input.source.includes(term) && input.draft!.includes(term)) {
        findings.push({
          kind: 'novel-procedure', responsibility: 'integrity', severity: 'important',
          message: '成稿出现原文未授权的程序或证据机制词', draftEvidence: term,
        });
      }
    }
  }

  return {
    source,
    outline,
    draft,
    comparison: {
      expansionRatio: draft === null ? null : ratio(draft.han, source.han),
      sectionMedianExpansionRatio:
        draft?.sectionMedianHan == null || source.sectionMedianHan == null
          ? null
          : ratio(draft.sectionMedianHan, source.sectionMedianHan),
      sourceSectionVariation: source.sectionCoefficientOfVariation,
      draftSectionVariation: draft?.sectionCoefficientOfVariation ?? null,
    },
    findings,
  };
}

export function toPublicFidelitySummary(audit: FidelityAudit): PublicFidelitySummary {
  const strip = ({ hash: _hash, cameraTermsPer10k: _terms, ...profile }: TextFidelityProfile) => profile;
  const findingKinds: PrivateFidelityFinding['kind'][] = [
    'uniform-expansion', 'length-expansion', 'novel-number', 'novel-procedure',
  ];
  const responsibilities: ImitationResponsibility[] = [
    'outline', 'plan', 'prose', 'character', 'integrity', 'compression',
  ];
  return {
    sourceHash: audit.source.hash,
    outlineHash: audit.outline?.hash ?? null,
    draftHash: audit.draft?.hash ?? null,
    source: strip(audit.source),
    outline: audit.outline === null ? null : strip(audit.outline),
    draft: audit.draft === null ? null : strip(audit.draft),
    comparison: audit.comparison,
    findingCounts: Object.fromEntries(findingKinds.map((kind) => [kind, audit.findings.filter((item) => item.kind === kind).length])) as Record<PrivateFidelityFinding['kind'], number>,
    responsibilityCounts: Object.fromEntries(responsibilities.map((responsibility) => [responsibility, audit.findings.filter((item) => item.responsibility === responsibility).length])) as Record<ImitationResponsibility, number>,
  };
}

function countHan(text: string): number {
  return text.match(HAN_PATTERN)?.length ?? 0;
}

function occurrences(text: string, needle: string): number {
  let count = 0;
  let index = 0;
  while ((index = text.indexOf(needle, index)) >= 0) {
    count += 1;
    index += needle.length;
  }
  return count;
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function coefficientOfVariation(values: readonly number[]): number | null {
  if (values.length < 2) return null;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  if (mean === 0) return null;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance) / mean;
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
