/**
 * Lightweight prompt-injection heuristic — LOG-ONLY for now, by design.
 *
 * This is a safety-awareness signal, not a gate: it's keyword/regex matching,
 * so false positives on legitimate conversational text (including Bengali)
 * are a real risk, and blocking on it today would risk killing a genuine turn
 * for a heuristic false-positive. It scans typed `text` for common override
 * patterns and logs a warning; it never blocks, rewrites, or fails the
 * request. Audio is not transcribed at this layer, so only the text channel
 * is inspected. Turning this into a real gate — alongside heavier moderation
 * like profanity/content classification — is explicitly scoped as future
 * work; see "Future Improvements" in the README.
 */

import { logger } from '../logging/logger.js';

const PATTERNS = [
  /ignore (all |the |your |previous )?(prior |above |earlier )?instructions/i,
  /disregard (the |all |your |previous )?(instructions|rules|prompt)/i,
  /(reveal|show|print|repeat) (me )?(your |the )?(system )?prompt/i,
  /you are now\b/i,
  /pretend to be\b/i,
  /jailbreak/i,
  /developer mode/i,
  /\bDAN\b/,
];

export function promptInjectionGuard(req, res, next) {
  const text = req.body?.text;
  if (typeof text === 'string' && text.length > 0) {
    const hits = PATTERNS.filter((p) => p.test(text)).map((p) => p.source);
    if (hits.length > 0) {
      logger.warn('possible prompt-injection (log-only, not blocking)', {
        sessionId: req.body?.sessionId ?? null,
        hits,
        sample: text.slice(0, 120),
      });
    }
  }
  next();
}
