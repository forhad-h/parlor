/**
 * Clean raw LLM output before it hits `splitSentences` → TTS.
 *
 * Providers request structured JSON output, but nothing stops an underlying
 * model (especially arbitrary ones routed through OpenRouter) from slipping
 * Markdown into `response`/`transcription` — bold, bullets, headers, code
 * fences, links. TTS has no notion of Markdown, so it would read the raw
 * punctuation aloud (e.g. "asterisk asterisk ..."). This strips that
 * formatting down to plain spoken text and collapses whitespace/newlines,
 * while leaving Bengali punctuation (danda `।`, `॥`) untouched since
 * `sentenceSplit.js` relies on it.
 */

/** Strip the stray `<|"|>` token the original code also guarded against. */
const STRAY_TOKEN_RE = /<\|"\|>/g;

// Fenced code blocks: ```lang\n...``` -> keep the inner text, drop the fence.
const CODE_FENCE_RE = /```[^\n`]*\n?([\s\S]*?)```/g;
// Inline code: `x` -> x
const INLINE_CODE_RE = /`([^`]+)`/g;
// Images: ![alt](url) -> alt
const IMAGE_RE = /!\[([^\]]*)\]\([^)]*\)/g;
// Links: [text](url) -> text
const LINK_RE = /\[([^\]]+)\]\([^)]*\)/g;
// Bold/italic emphasis: ***x***, **x**, *x*, ___x___, __x__, _x_ -> x
const EMPHASIS_RE = /(\*{1,3}|_{1,3})([^*_\n]+)\1/g;
// Heading markers at line start: "# ", "## ", ...
const HEADING_RE = /^\s{0,3}#{1,6}\s+/gm;
// Blockquote markers at line start: "> "
const BLOCKQUOTE_RE = /^\s{0,3}>\s?/gm;
// Bullet list markers at line start: "- ", "* ", "+ "
const BULLET_RE = /^\s*[-*+]\s+/gm;
// Numbered list markers at line start: "1. ", "2) "
const NUMBERED_RE = /^\s*\d+[.)]\s+/gm;

/**
 * @param {unknown} s
 * @returns {string} plain, trimmed, single-line-friendly text safe to speak
 */
export function cleanText(s) {
  if (typeof s !== 'string') return '';

  let out = s.replace(STRAY_TOKEN_RE, '');

  out = out.replace(CODE_FENCE_RE, '$1');
  out = out.replace(INLINE_CODE_RE, '$1');
  out = out.replace(IMAGE_RE, '$1');
  out = out.replace(LINK_RE, '$1');
  out = out.replace(EMPHASIS_RE, '$2');
  out = out.replace(HEADING_RE, '');
  out = out.replace(BLOCKQUOTE_RE, '');
  out = out.replace(BULLET_RE, '');
  out = out.replace(NUMBERED_RE, '');

  // Collapse newlines/runs of whitespace (list items, wrapped paragraphs) into
  // single spaces so `sentenceSplit.js` sees one flowing utterance.
  out = out.replace(/\s*\n+\s*/g, ' ');
  out = out.replace(/[ \t]{2,}/g, ' ');

  return out.trim();
}
