/**
 * Lightweight prompt-injection heuristic — detection only, no decision-making.
 *
 * This is keyword/regex matching, so false positives on legitimate conversational
 * text (including Bengali) are a real risk. Rather than gate here, this middleware
 * just scans typed `text` and attaches the result to `req.promptInjection`; it
 * always calls `next()`. The log-vs-block decision lives in routes/converse.js,
 * gated by the shared `SAFETY_MODE` (config.safety.mode) — the same knob that
 * gates the output-side Gemini safety signal. Keeping the decision there (not
 * here) means a block still flows through the normal TTS/response path (speaking
 * SAFE_REFUSAL) instead of a bare early-return that would break the
 * transcription/responseText/chunks wire contract. Audio is not transcribed at
 * this layer, so only the text channel is inspected.
 *
 * Why guard `text` at all when the shipped browser UI (src/index.html) has no
 * text-input element and only ever sends `{audio, image?}`: the browser WS
 * endpoint and this HTTP endpoint are both reachable directly by any client
 * that speaks the protocol (curl, a script, a different frontend), not just
 * index.html. server.py forwards a client-supplied `text` field verbatim into
 * the `/converse` payload it POSTs here (see the `if msg.get("text")` branch
 * in its WS receive loop). So this middleware defends the endpoint's attack
 * surface, not the shipped page's — the UI having no text box is not a
 * security boundary and shouldn't be read as making this dead code.
 */

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

/** Pure detector, kept separate from the Express plumbing so it's directly unit-testable. */
export function detectPromptInjection(text) {
  if (typeof text !== 'string' || text.length === 0) {
    return { flagged: false, hits: [], sample: null };
  }
  const hits = PATTERNS.filter((p) => p.test(text)).map((p) => p.source);
  return { flagged: hits.length > 0, hits, sample: hits.length > 0 ? text.slice(0, 120) : null };
}

export function promptInjectionGuard(req, res, next) {
  req.promptInjection = detectPromptInjection(req.body?.text);
  next();
}
