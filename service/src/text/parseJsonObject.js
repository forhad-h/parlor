/**
 * Parse a raw LLM text response as a JSON object.
 *
 * Providers request native structured JSON, but nothing stops an underlying
 * model — especially arbitrary ones routed through OpenRouter — from wrapping
 * the object in a Markdown ```` ```json ```` fence even when told not to. This
 * tolerates that one common deviation, then `JSON.parse`s the object and
 * returns `null` (never throws) on any failure, so each provider can fall back
 * to plain text instead of hanging the turn.
 */

// A whole response wrapped in a single code fence: ```json\n{...}\n``` (lang optional).
const FENCE_RE = /^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/i;

/**
 * @param {unknown} raw
 * @returns {object|null} the parsed object, or null if `raw` isn't a JSON object
 */
export function parseJsonObject(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;

  const fenced = raw.match(FENCE_RE);
  const candidate = fenced ? fenced[1] : raw;

  try {
    const obj = JSON.parse(candidate);
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : null;
  } catch {
    return null;
  }
}
