export interface I1DistributionMetrics {
  shareAbsoluteError: number;
  rankError: number;
}

export interface I1DistributionComparison {
  baseline: I1DistributionMetrics;
  variant: I1DistributionMetrics;
  shareImproved: boolean;
  rankImproved: boolean;
}

export function compareI1Distribution(input: {
  sourceHan: readonly number[];
  variantTargetHan: readonly number[];
}): I1DistributionComparison | null {
  const { sourceHan, variantTargetHan } = input;
  if (
    sourceHan.length === 0
    || sourceHan.length !== variantTargetHan.length
    || !allFiniteNonNegative(sourceHan)
    || !allFiniteNonNegative(variantTargetHan)
  ) {
    return null;
  }
  const sourceTotal = sum(sourceHan);
  const variantTotal = sum(variantTargetHan);
  if (sourceTotal <= 0 || variantTotal <= 0) return null;

  const sourceShares = sourceHan.map((value) => value / sourceTotal);
  const baselineShares = sourceHan.map(() => 1 / sourceHan.length);
  const variantShares = variantTargetHan.map((value) => value / variantTotal);
  const baseline = metrics(sourceShares, baselineShares);
  const variant = metrics(sourceShares, variantShares);
  return {
    baseline,
    variant,
    shareImproved: variant.shareAbsoluteError < baseline.shareAbsoluteError,
    rankImproved: variant.rankError < baseline.rankError,
  };
}

function metrics(
  sourceShares: readonly number[],
  candidateShares: readonly number[],
): I1DistributionMetrics {
  const shareAbsoluteError = sourceShares.reduce(
    (total, value, index) => total + Math.abs(value - candidateShares[index]!),
    0,
  ) / sourceShares.length;
  const sourceRanks = normalizedAverageRanks(sourceShares);
  const candidateRanks = normalizedAverageRanks(candidateShares);
  const rankError = sourceRanks.reduce(
    (total, value, index) => total + Math.abs(value - candidateRanks[index]!),
    0,
  ) / sourceRanks.length;
  return { shareAbsoluteError, rankError };
}

function normalizedAverageRanks(values: readonly number[]): number[] {
  if (values.length === 1) return [0];
  const entries = values
    .map((value, index) => ({ value, index }))
    .sort((left, right) => left.value - right.value || left.index - right.index);
  const ranks = Array<number>(values.length);
  let cursor = 0;
  while (cursor < entries.length) {
    let end = cursor + 1;
    while (end < entries.length && entries[end]!.value === entries[cursor]!.value) end += 1;
    const averageRank = (cursor + end - 1) / 2 / (values.length - 1);
    for (let index = cursor; index < end; index += 1) {
      ranks[entries[index]!.index] = averageRank;
    }
    cursor = end;
  }
  return ranks;
}

function allFiniteNonNegative(values: readonly number[]): boolean {
  return values.every((value) => Number.isFinite(value) && value >= 0);
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
