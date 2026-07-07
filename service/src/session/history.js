/**
 * Per-session conversation memory.
 *
 * Mirrors the statefulness the original `engine.create_conversation(...)` gave
 * each WebSocket connection in server.py — but here the transport is stateless
 * HTTP, so the sessionId (one per browser WS connection, minted in server.py)
 * threads the history through.
 *
 * We store *text only* — the user's transcription and the assistant's reply —
 * not the raw audio/image blobs. That keeps context light and coherent across
 * turns without re-uploading megabytes of audio, and avoids unbounded growth.
 *
 * In-memory is deliberate and sufficient at this scale. A real deployment would
 * move this to Redis/a session store (noted in the README); the interface below
 * is what such a swap would implement.
 */

// One "exchange" is a user message plus the model's reply. We retain the most
// recent MAX_EXCHANGES of them; older context is dropped.
const MAX_EXCHANGES = 12;
const MESSAGES_PER_EXCHANGE = 2; // one 'user' entry + one 'model' entry
const MAX_MESSAGES = MAX_EXCHANGES * MESSAGES_PER_EXCHANGE;

const SESSION_TTL_MS = 30 * 60 * 1000; // Forget idle sessions after 30 min.

/** @type {Map<string, {messages: Array<{role: 'user'|'model', text: string}>, lastSeen: number}>} */
const sessions = new Map();

function reap() {
  const cutoff = Date.now() - SESSION_TTL_MS;
  for (const [id, s] of sessions) {
    if (s.lastSeen < cutoff) sessions.delete(id);
  }
}

/** Return a shallow copy of the ordered message history for a session. */
export function getHistory(sessionId) {
  if (!sessionId) return [];
  const s = sessions.get(sessionId);
  if (!s) return [];
  s.lastSeen = Date.now();
  return s.messages.slice();
}

/** Append one user→model exchange, trimming to the most recent MAX_EXCHANGES. */
export function appendTurn(sessionId, { userText, modelText }) {
  if (!sessionId) return;
  reap();
  let s = sessions.get(sessionId);
  if (!s) {
    s = { messages: [], lastSeen: Date.now() };
    sessions.set(sessionId, s);
  }
  if (userText) s.messages.push({ role: 'user', text: userText });
  if (modelText) s.messages.push({ role: 'model', text: modelText });
  // Drop the oldest messages once we exceed the retention window.
  if (s.messages.length > MAX_MESSAGES) {
    s.messages = s.messages.slice(-MAX_MESSAGES);
  }
  s.lastSeen = Date.now();
}

/** Test/ops helper. */
export function resetSessions() {
  sessions.clear();
}
