/**
 * Split a reply into sentences for streaming TTS.
 *
 * The original `server.py` splits on `(?<=[.!?])\s+`, which never breaks on the
 * Bengali danda "।" (U+0964) — the primary Bengali full stop. Without this a
 * whole Bengali reply is synthesised as one giant chunk, collapsing the
 * sentence-level streaming the audio_start/audio_chunk protocol is built around.
 *
 * We split *after* any terminator (danda "।", the double-danda "॥", and Latin
 * `.?!`, plus their fullwidth variants), keeping the terminator attached to its
 * sentence so nothing is dropped from what gets spoken.
 */

// Sentence terminators: Bengali danda / double danda, Latin ., !, ?, and the
// fullwidth ！？ that occasionally show up in model output.
const TERMINATORS = '।॥.!?！？';

// Break at: a run of terminators, followed by whitespace (or end of string).
// Lookbehind keeps the terminator with the preceding sentence.
const SPLIT_RE = new RegExp(`(?<=[${TERMINATORS}])\\s+`, 'u');

/**
 * @param {string} text
 * @returns {string[]} non-empty, trimmed sentences (never empty — falls back to
 *   the whole trimmed input so the caller always has something to synthesise).
 */
export function splitSentences(text) {
  if (typeof text !== 'string') return [];
  const trimmed = text.trim();
  if (!trimmed) return [];

  const parts = trimmed
    .split(SPLIT_RE)
    .map((s) => s.trim())
    .filter(Boolean);

  return parts.length > 0 ? parts : [trimmed];
}
