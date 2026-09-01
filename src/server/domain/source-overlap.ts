export const SOURCE_SHINGLE_CHARS = 14;

/**
 * 14 字片段、步长固定 1 的包含度。短于 14 字没有片段，按 0 处理。
 * 固定步长是约束：S0 曾用步长 7 把同文错判为不重复。
 */
export function sourceContainment(candidate: string, source: string): number {
  const candidateShingles = shingles(candidate);
  const sourceShingles = shingles(source);
  if (candidateShingles.size === 0 || sourceShingles.size === 0) return 0;
  const [small, large] = candidateShingles.size <= sourceShingles.size
    ? [candidateShingles, sourceShingles]
    : [sourceShingles, candidateShingles];
  let matched = 0;
  for (const shingle of small) if (large.has(shingle)) matched += 1;
  return matched / small.size;
}

function shingles(text: string): Set<string> {
  const normalized = text.replace(/\s+/g, '').normalize('NFC');
  const result = new Set<string>();
  for (let index = 0; index + SOURCE_SHINGLE_CHARS <= normalized.length; index += 1) {
    result.add(normalized.slice(index, index + SOURCE_SHINGLE_CHARS));
  }
  return result;
}
