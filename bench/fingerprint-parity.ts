#!/usr/bin/env node
import process from 'node:process';
import { fingerprint } from './fingerprint.mjs';
import { fingerprintStory } from '../src/server/domain/output-validation.ts';

const VECTORS = [
  '标题\n\n1\n\n我说：「别走。」\n\n她停下。',
  '标题\n\n1.\n\n他说：“留下。”\n\n她点头。',
  '没有编号，也没有对白引号。我推开门，他站在外面。',
];

let failures = 0;
for (const [index, text] of VECTORS.entries()) {
  const offline = fingerprint(text);
  const online = fingerprintStory(text);
  const checks = {
    han: offline.han === online.han,
    sections: offline.secs === online.sections,
    person: offline.person === (online.person === 'first' ? '第一' : '第三'),
    quote: offline.quote === (online.quote === 'corner' ? '「」' : online.quote === 'double' ? '""' : '无'),
    paragraphMedian: offline.pmed === online.paragraphMedian,
    sentenceMedian: offline.smed === online.sentenceMedian,
  };
  const bad = Object.entries(checks).filter(([, ok]) => !ok).map(([key]) => key);
  if (bad.length > 0) {
    failures += 1;
    process.stderr.write(`向量 ${index + 1} 不一致：${bad.join(', ')}\n`);
  }
}
process.stdout.write(`S3 parity：${VECTORS.length - failures}/${VECTORS.length}\n`);
process.exitCode = failures === 0 ? 0 : 1;
