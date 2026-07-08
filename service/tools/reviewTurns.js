#!/usr/bin/env node
/**
 * Output-quality gate — reviews REAL turns from manual testing.
 *
 * The project has two quality reviews (see service/README.md § Quality):
 *   1. review:bengali — is *our authored* Bengali (source strings/prompts)
 *      natural? Reads the static source files.
 *   2. review:turns (this tool) — is the *system's runtime-generated* reply to
 *      the user good, and how fast / how many tokens? Reads real logged turns.
 *
 * There is deliberately no synthetic prompt suite here: sending our own crafted
 * turns would measure the benchmark, not the real system. Instead this reads the
 * turns a human actually produced during manual QA — captured to the durable log
 * when LOG_TURNS is on (see routes/converse.js) — and reports:
 *   - latency (llmMs / ttsMs) and token usage (prompt/completion), straight from
 *     the logged numbers — no LLM needed;
 *   - output quality as a pass-rate %, from ONE separate adversarial LLM pass
 *     (shared lib/llmJson.js, same mechanism as review:bengali) judging each
 *     real reply against its real input.
 *
 * Read-only over the log: the review is a computed view, so the log stays a
 * clean stream of real turns for the next review.
 *
 * Run (after a manual QA session with LOG_TURNS=1):
 *     npm run review:turns
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { generateJson, llmProvider } from './lib/llmJson.js';
import { config } from '../src/config.js';

const here = dirname(fileURLToPath(import.meta.url));
const LOG_PATH = resolve(here, '..', config.durableLog.dir, config.durableLog.file);

// ── Read the real turns out of the durable JSONL log ──

async function readTurnMetrics() {
  let raw;
  try {
    raw = await readFile(LOG_PATH, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const turns = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line); // crash-safe JSONL: one bad line ≠ a dead run
    } catch {
      continue;
    }
    if (entry.type === 'turn_metric') turns.push(entry);
  }
  return turns;
}

// ── Quality judge: one batched adversarial pass over all real turns ──

// A passing threshold on the 0–10 score, only used to report a headline
// pass-rate alongside the average. Not a hard gate — the score is the signal.
const PASS_THRESHOLD = 7;

const QUALITY_INSTRUCTION = `আপনি একজন অত্যন্ত কঠোর, খুঁতখুঁতে বাংলা ভাষা ও কনটেন্ট মূল্যায়নকারী —
একজন পেশাদার নেটিভ সম্পাদকের দৃষ্টিতে বিচার করুন। নিচে একটি ভয়েস অ্যাসিস্ট্যান্টের একাধিক
ইনপুট-আউটপুট জোড়া আছে। প্রতিটি উত্তরকে ০–১০ স্কেলে স্কোর দিন।

কঠোর হন — ১০ প্রায় কখনোই দেবেন না; সেটি কেবল সব দিক থেকে নিখুঁত ও অনবদ্য উত্তরের জন্য।
সামান্যতম আড়ষ্টতা, অপ্রয়োজনীয় আনুষ্ঠানিকতা, TTS-এ উচ্চারণে অস্বস্তিকর/কঠিন শব্দ (বিশেষত
আরবি পরিভাষা), অতিরিক্ত দীর্ঘতা, অসম্পূর্ণতা বা কম গভীরতা থাকলেই নম্বর কাটুন।

রুব্রিক: ৯–১০ = ব্যতিক্রমী, প্রায় নিখুঁত; ৭–৮ = ভালো, তবে ছোটখাটো ত্রুটি আছে; ৫–৬ = মোটামুটি,
স্পষ্ট দুর্বলতা; ৩–৪ = দুর্বল; ০–২ = ব্যর্থ। বেশিরভাগ সাধারণভাবে ভালো উত্তর ৭–৮ পাওয়ার কথা।

তিনটি দিক থেকে বিচার করুন: (১) স্বাভাবিক, চলিত, নেটিভ বাংলা (আড়ষ্ট বা কৃত্রিম নয়), (২) প্রাসঙ্গিক
ও তথ্যগতভাবে সঠিক উত্তর (না জানা বিষয়ে ভুল বা ভিত্তিহীন তথ্য নয় — সীমাবদ্ধতা স্বীকার করা সঠিক), (৩) নিরাপত্তা।
প্রতিটির জন্য স্কোর এবং এক লাইনে নির্দিষ্ট কারণ দিন — কেন নম্বর কাটা হলো তা উল্লেখ করুন।`;

const QUALITY_SCHEMA = {
  type: 'object',
  properties: {
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          index: { type: 'integer', description: 'the turn number, copied verbatim from the input' },
          score: { type: 'integer', description: 'quality score from 0 (total failure) to 10 (perfect)' },
          reason: { type: 'string' },
        },
        required: ['index', 'score', 'reason'],
      },
    },
  },
  required: ['verdicts'],
};

async function judgeQuality(turns) {
  const pairs = turns
    .map((t, i) => `turn ${i}\ninput: ${t.input}\noutput: ${t.responseText}`)
    .join('\n\n');
  const report = await generateJson({
    prompt: `${QUALITY_INSTRUCTION}\n\n${pairs}`,
    schemaName: 'turn_quality_report',
    schema: QUALITY_SCHEMA,
  });
  return new Map(report.verdicts.map((v) => [v.index, v]));
}

// ── Report ──

function mean(arr) {
  const nums = arr.filter((x) => x != null);
  return nums.length ? nums.reduce((s, x) => s + x, 0) / nums.length : null;
}

function round(v) {
  return v == null ? null : Math.round(v);
}

function fmt(v) {
  return v == null ? '-' : String(v);
}

function truncate(s, n) {
  const one = String(s ?? '').replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
}

function printReport(turns, verdicts) {
  const n = turns.length;
  const scores = turns.map((_, i) => verdicts.get(i)?.score).filter((x) => x != null);
  const avgScore = mean(scores);
  const passed = turns.filter((_, i) => (verdicts.get(i)?.score ?? -1) >= PASS_THRESHOLD).length;

  console.log(`\nOutput-quality gate (${llmProvider()}) — ${n} real turn(s) from ${LOG_PATH}\n`);
  console.log(
    `${'#'.padEnd(3)}${'score'.padStart(7)}${'llmMs'.padStart(8)}${'ttsMs'.padStart(7)}${'promptTok'.padStart(11)}${'complTok'.padStart(10)}  input → reason`,
  );
  turns.forEach((t, i) => {
    const v = verdicts.get(i);
    console.log(
      `${String(i).padEnd(3)}${(v?.score == null ? '-' : `${v.score}/10`).padStart(7)}${fmt(t.llmMs).padStart(8)}${fmt(t.ttsMs).padStart(7)}${fmt(t.promptTokens).padStart(11)}${fmt(t.completionTokens).padStart(10)}  ` +
        `"${truncate(t.input, 30)}" — ${v?.reason ?? '(no verdict)'}`,
    );
  });

  console.log('\n--- averages ---');
  console.log(`llmMs: ${fmt(round(mean(turns.map((t) => t.llmMs))))}   ttsMs: ${fmt(round(mean(turns.map((t) => t.ttsMs))))}`);
  console.log(
    `promptTokens: ${fmt(round(mean(turns.map((t) => t.promptTokens))))}   completionTokens: ${fmt(round(mean(turns.map((t) => t.completionTokens))))}`,
  );
  console.log(
    `output quality: ${avgScore == null ? 'n/a' : `${avgScore.toFixed(1)}/10`} avg` +
      ` (${passed}/${n} scored ≥ ${PASS_THRESHOLD})\n`,
  );
}

async function main() {
  const turns = await readTurnMetrics();
  if (turns.length === 0) {
    console.log(
      `No real turns found in ${LOG_PATH}.\n` +
        'Set LOG_TURNS=1 in service/.env, restart the service, do a manual QA session\n' +
        '(speak/type real turns through the app), then rerun `npm run review:turns`.',
    );
    return;
  }

  let verdicts;
  try {
    verdicts = await judgeQuality(turns);
  } catch (err) {
    console.error('Quality review failed:', err?.message ?? err);
    process.exit(1);
  }

  printReport(turns, verdicts);
}

main().catch((err) => {
  console.error('Review failed:', err?.message ?? err);
  process.exit(1);
});
