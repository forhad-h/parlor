/**
 * Fixed-window request counter — enforced (429 past the limit).
 *
 * Real cost/rate-limit control on the paid LLM/TTS providers, not just an
 * observability signal: the threshold (30 req/60s) has enough headroom that
 * normal usage never comes close, but a runaway or abusive
 * client gets rejected instead of silently costing money. The hard size cap
 * is a separate mechanism (`express.json({ limit })` in index.js). Keyed by
 * sessionId when present, else client IP.
 */

import { logger } from '../logging/logger.js';
import { BENGALI_ERROR_MESSAGE } from '../errors.js';

const WINDOW_MS = 60_000;
const MAX = 30;

/** @type {Map<string, {start: number, count: number}>} */
const windows = new Map();

export function rateLimit(req, res, next) {
  const windowMs = WINDOW_MS;
  const now = Date.now();
  const key = req.body?.sessionId || req.ip || 'unknown';

  let entry = windows.get(key);
  if (!entry || now - entry.start >= windowMs) {
    entry = { start: now, count: 0 };
    windows.set(key, entry);
  }
  entry.count += 1;

  // Opportunistic cleanup so the map can't grow unbounded across many sessions.
  if (windows.size > 10_000) {
    for (const [k, v] of windows) {
      if (now - v.start >= windowMs) windows.delete(k);
    }
  }

  if (entry.count > MAX) {
    const retryAfterSec = Math.max(1, Math.ceil((entry.start + windowMs - now) / 1000));
    logger.warn('rate limit exceeded, request rejected', {
      key,
      count: entry.count,
      limit: MAX,
      windowMs,
      retryAfterSec,
    });
    res.set('Retry-After', String(retryAfterSec));
    return res.status(429).json({
      error: 'rate limit exceeded',
      retryAfterSec,
      bengaliMessage: BENGALI_ERROR_MESSAGE,
    });
  }

  next();
}
