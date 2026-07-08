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
import { GoogleGenAI, Type } from '@google/genai';
import { config } from '../src/config.js';

const here = dirname(fileURLToPath(import.meta.url));
const FILES = [
  resolve(here, '../src/prompts/bengali.js'),
  resolve(here, '../../src/strings.bn.js'),
];

const REVIEW_INSTRUCTION = `আপনি একজন বাংলা ভাষার পেশাদার সম্পাদক ও নেটিভ স্পিকার।
নিচের সোর্স ফাইলগুলোতে থাকা প্রতিটি বাংলা স্ট্রিং পর্যালোচনা করুন। লক্ষ্য: ভাষা যেন
স্বাভাবিক, সাবলীল ও পেশাদার শোনায় — আড়ষ্ট, আক্ষরিক বা "অনুবাদ-অনুবাদ" নয়।

প্রতিটি সমস্যাযুক্ত স্ট্রিংয়ের জন্য জানান: মূল টেক্সট, সমস্যা কী, এবং একটি উন্নত বিকল্প।
যেসব স্ট্রিং ইতিমধ্যে স্বাভাবিক, সেগুলো বাদ দিন।`;

const FINDING_PROPERTIES = {
  original: { description: 'The original string' },
  issue: { description: 'What reads unnaturally' },
  suggestion: { description: 'A more natural alternative' },
  severity: { description: 'low | medium | high' },
};

async function reviewWithGemini(prompt) {
  const ai = new GoogleGenAI({ apiKey: config.llm.gemini.apiKey });
  const res = await ai.models.generateContent({
    model: config.llm.gemini.model,
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    config: {
      temperature: 0.3,
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          findings: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                original: { type: Type.STRING, ...FINDING_PROPERTIES.original },
                issue: { type: Type.STRING, ...FINDING_PROPERTIES.issue },
                suggestion: { type: Type.STRING, ...FINDING_PROPERTIES.suggestion },
                severity: { type: Type.STRING, ...FINDING_PROPERTIES.severity },
              },
              required: ['original', 'issue', 'suggestion', 'severity'],
            },
          },
          overall: { type: Type.STRING },
        },
        required: ['findings', 'overall'],
      },
    },
  });
  return res.text;
}

async function reviewWithOpenRouter(prompt) {
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.llm.openRouter.apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://github.com/forhad-h/parlor',
      'X-Title': 'Parlor Bengali QA',
    },
    body: JSON.stringify({
      model: config.llm.openRouter.model,
      temperature: 0.3,
      messages: [{ role: 'user', content: prompt }],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'bengali_qa_report',
          strict: true,
          schema: {
            type: 'object',
            properties: {
              findings: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    original: { type: 'string', ...FINDING_PROPERTIES.original },
                    issue: { type: 'string', ...FINDING_PROPERTIES.issue },
                    suggestion: { type: 'string', ...FINDING_PROPERTIES.suggestion },
                    severity: { type: 'string', ...FINDING_PROPERTIES.severity },
                  },
                  required: ['original', 'issue', 'suggestion', 'severity'],
                  additionalProperties: false,
                },
              },
              overall: { type: 'string' },
            },
            required: ['findings', 'overall'],
            additionalProperties: false,
          },
        },
      },
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`OpenRouter HTTP ${res.status}: ${detail.slice(0, 300)}`);
  }
  const data = await res.json();
  return data?.choices?.[0]?.message?.content;
}

async function main() {
  const provider = config.llm.provider;
  if (provider === 'gemini' && !config.llm.gemini.apiKey) {
    console.error('LLM_PROVIDER=gemini requires GEMINI_API_KEY.\n(This is a pre-submission QA pass, not part of the runtime.)');
    process.exit(1);
  }
  if (provider === 'openrouter' && !config.llm.openRouter.apiKey) {
    console.error('LLM_PROVIDER=openrouter requires OPENROUTER_API_KEY.\n(This is a pre-submission QA pass, not part of the runtime.)');
    process.exit(1);
  }
  if (provider !== 'gemini' && provider !== 'openrouter') {
    console.error(
      `This reviewer needs a real LLM. Set LLM_PROVIDER=gemini or openrouter (got "${provider}"), then rerun.\n` +
        '(It is a pre-submission QA pass, not part of the runtime.)',
    );
    process.exit(1);
  }

  const sources = await Promise.all(
    FILES.map(async (f) => `# FILE: ${f}\n\n${await readFile(f, 'utf8')}`),
  );
  const prompt = `${REVIEW_INSTRUCTION}\n\n${sources.join('\n\n')}`;

  let raw;
  try {
    raw = provider === 'gemini' ? await reviewWithGemini(prompt) : await reviewWithOpenRouter(prompt);
  } catch (err) {
    console.error(`Reviewer failed (${provider}):`, err?.message ?? err);
    process.exit(1);
  }

  let report;
  try {
    report = JSON.parse(raw);
  } catch {
    console.error('Could not parse reviewer output:\n', raw);
    process.exit(1);
  }

  console.log(`\nবাংলা QA (${provider}) — overall: ${report.overall}\n`);
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
