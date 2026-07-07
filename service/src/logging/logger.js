/**
 * Tiny structured logger — one JSON object per line, level-filtered.
 *
 * Deliberately dependency-free: at this scale a 40-line logger is more legible
 * than wiring up pino, and it still gives grep-able, machine-parseable output
 * (`{sessionId, llmProvider, promptTokens, llmLatencyMs, ...}`) for the
 * cost/latency visibility the per-request `/converse` log needs.
 */

import { config } from '../config.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[config.logLevel] ?? LEVELS.info;

function emit(level, msg, fields) {
  if (LEVELS[level] < threshold) return;
  const line = { ts: new Date().toISOString(), level, msg, ...fields };
  const sink = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  sink.write(`${JSON.stringify(line)}\n`);
}

export const logger = {
  debug: (msg, fields) => emit('debug', msg, fields),
  info: (msg, fields) => emit('info', msg, fields),
  warn: (msg, fields) => emit('warn', msg, fields),
  error: (msg, fields) => emit('error', msg, fields),
};
