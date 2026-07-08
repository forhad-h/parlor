#!/usr/bin/env node
/**
 * Bengali translation-quality reviewer — an internal AI tool.
 *
 * The named quality bar for this project is *natural, professional,
 * native-sounding* Bengali; the failure mode is stiff, literal, "translated"
 * phrasing. This script runs a second, adversarial AI pass over the two
 * single-source-of-truth string files (prompts/bengali.js, ../src/strings.bn.js)
 * with a native-reviewer persona, and prints a structured report of anything
 * that reads unnaturally — so weak phrasing is caught before shipping rather
 * than by an evaluator.
 *
 * It reuses whichever LLM credentials/config the service is already set up
 * with (`LLM_PROVIDER=gemini` or `openrouter`) — no separate key. Run once:
 *     npm run review:bengali
 *
 * Design note: because the fix for a flagged string is a one-line edit to a
 * single file (not a code change), this pass pairs directly with the
 * prompt-template centralisation — quality iteration stays cheap.
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { generateJson } from './lib/llmJson.js';

const here = dirname(fileURLToPath(import.meta.url));
const FILES = [
  resolve(here, '../src/prompts/bengali.js'),
  resolve(here, '../../src/strings.bn.js'),
];

const REVIEW_INSTRUCTION = `আপনি একজন বাংলা ভাষার পেশাদার সম্পাদক ও নেটিভ স্পিকার।
নিচের সোর্স ফাইলগুলোতে থাকা প্রতিটি বাংলা স্ট্রিং পর্যালোচনা করুন। লক্ষ্য: ভাষা যেন
স্বাভাবিক, সাবলীল ও পেশাদার শোনায় — আড়ষ্ট, আক্ষরিক বা কৃত্রিম নয়।

প্রতিটি সমস্যাযুক্ত স্ট্রিংয়ের জন্য জানান: মূল টেক্সট, সমস্যা কী, এবং একটি উন্নত বিকল্প।
যেসব স্ট্রিং ইতিমধ্যে স্বাভাবিক, সেগুলো বাদ দিন।`;

const REPORT_SCHEMA = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          original: { type: 'string', description: 'The original string' },
          issue: { type: 'string', description: 'What reads unnaturally' },
          suggestion: { type: 'string', description: 'A more natural alternative' },
          severity: { type: 'string', description: 'low | medium | high' },
        },
        required: ['original', 'issue', 'suggestion', 'severity'],
      },
    },
    overall: { type: 'string' },
  },
  required: ['findings', 'overall'],
};

async function main() {
  const sources = await Promise.all(
    FILES.map(async (f) => `# FILE: ${f}\n\n${await readFile(f, 'utf8')}`),
  );

  let report;
  try {
    report = await generateJson({
      prompt: `${REVIEW_INSTRUCTION}\n\n${sources.join('\n\n')}`,
      schemaName: 'bengali_qa_report',
      schema: REPORT_SCHEMA,
    });
  } catch (err) {
    console.error('Reviewer failed:', err?.message ?? err);
    process.exit(1);
  }

  console.log(`\nবাংলা QA — overall: ${report.overall}\n`);
  if (!report.findings?.length) {
    console.log('✓ No unnatural phrasing flagged.');
    return;
  }
  const order = { high: 0, medium: 1, low: 2 };
  report.findings.sort((a, b) => (order[a.severity] ?? 3) - (order[b.severity] ?? 3));
  for (const f of report.findings) {
    console.log(`[${(f.severity || '?').toUpperCase()}] ${f.original}`);
    console.log(`   issue      : ${f.issue}`);
    console.log(`   suggestion : ${f.suggestion}\n`);
  }
  console.log(`${report.findings.length} finding(s). These are advisory — apply by editing the source string files.`);
}

main().catch((err) => {
  console.error('Reviewer failed:', err?.message ?? err);
  process.exit(1);
});
