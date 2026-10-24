import { gzipSync } from 'node:zlib';

export const REDUNDANCY_WINDOW_HAN = 2000;

export interface RedundancyMetrics {
  uniqueBigramRate: number;
  repeatedFourgramRate: number;
  gzipRatio: number;
  han: number;
}

export function normalizeHanWindow(text: string, windowHan = REDUNDANCY_WINDOW_HAN): string {
  let output = '';
  let han = 0;
  for (const char of text) {
    output += char;
    if (/[一-鿿]/u.test(char)) han += 1;
    if (han === windowHan) return output;
  }
  return '';
}

export function combinedRedundancyMetrics(
  texts: readonly string[],
  windowHan = REDUNDANCY_WINDOW_HAN,
): RedundancyMetrics | null {
  return redundancyMetrics(texts.join('\n\n'), windowHan);
}

export function redundancyMetrics(text: string, windowHan = REDUNDANCY_WINDOW_HAN): RedundancyMetrics | null {
  const normalized = normalizeHanWindow(text, windowHan);
  if (normalized === '') return null;
  const hanText = [...normalized].filter((char) => /[一-鿿]/u.test(char)).join('');
  const bigrams = ngrams(hanText, 2);
  const fourgrams = ngrams(hanText, 4);
  const repeatedFourgrams = fourgrams.length - new Set(fourgrams).size;
  const sourceBytes = Buffer.byteLength(normalized, 'utf8');
  return {
    uniqueBigramRate: new Set(bigrams).size / bigrams.length,
    repeatedFourgramRate: repeatedFourgrams / fourgrams.length,
    gzipRatio: gzipSync(Buffer.from(normalized, 'utf8')).byteLength / sourceBytes,
    han: hanText.length,
  };
}

function ngrams(text: string, size: number): string[] {
  const chars = [...text];
  const values: string[] = [];
  for (let index = 0; index <= chars.length - size; index += 1) {
    values.push(chars.slice(index, index + size).join(''));
  }
  return values;
}
