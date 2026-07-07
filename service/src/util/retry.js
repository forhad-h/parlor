/**
 * Bounded retry with exponential backoff + jitter, and a hard per-attempt
 * timeout. Free-tier LLM/TTS endpoints are flaky and occasionally 429/503;
 * this keeps a live demo from dying on a single transient blip without turning
 * into an unbounded hammer on a rate-limited API.
 */

import { logger } from '../logging/logger.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Run `fn` with a timeout. `fn` receives an AbortSignal it should forward to
 * any underlying fetch so a timed-out attempt is actually cancelled. We also
 * race against a timeout promise so a provider SDK that ignores the signal
 * still can't hang the request past `timeoutMs`.
 */
async function withTimeout(fn, timeoutMs) {
  const ctrl = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      ctrl.abort();
      reject(new Error(`timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([fn(ctrl.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @template T
 * @param {(signal: AbortSignal) => Promise<T>} fn
 * @param {object} [opts]
 * @param {number} [opts.retries=2]        Max additional attempts after the first.
 * @param {number} [opts.timeoutMs=30000]  Per-attempt timeout.
 * @param {string} [opts.label]            For logs.
 * @param {(err: unknown) => boolean} [opts.isRetryable] Defaults to "always".
 * @returns {Promise<T>}
 */
export async function withRetry(
  fn,
  { retries = 2, timeoutMs = 30_000, label = 'call', isRetryable = () => true } = {},
) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await withTimeout(fn, timeoutMs);
    } catch (err) {
      lastErr = err;
      const canRetry = attempt < retries && isRetryable(err);
      if (!canRetry) break;
      const backoff = Math.round(2 ** attempt * 250 + Math.random() * 250);
      logger.warn('retrying after failure', {
        label,
        attempt: attempt + 1,
        nextRetryMs: backoff,
        error: err instanceof Error ? err.message : String(err),
      });
      await sleep(backoff);
    }
  }
  throw lastErr;
}
