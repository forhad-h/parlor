/**
 * LLM strategy interface.
 *
 * Every provider implements the same `generate(turn, signal): LlmResult`
 * contract, so adding a provider is additive (new file + one `case` here) and
 * never touches the orchestration in routes/converse.js. Retry/backoff/timeout
 * live here, once, wrapping whichever provider is selected — so no provider
 * re-implements resilience.
 *
 * @typedef {Object} Turn
 * @property {Array<{role:'user'|'model', text:string}>} [history]
 * @property {string} [audioBase64]  base64 WAV (16 kHz mono) from the browser
 * @property {string} [audioMime]    defaults to "audio/wav"
 * @property {string} [imageBase64]  base64 JPEG frame
 * @property {string} [imageMime]    defaults to "image/jpeg"
 * @property {string} [text]         typed text (when present)
 *
 * @typedef {Object} SafetySignal
 * @property {boolean} flagged            MEDIUM+ rating, blocked, or a block reason
 * @property {string} provider            which provider produced the signal
 * @property {Array<{category:string, probability:string}>} categories  non-NEGLIGIBLE ratings
 * @property {boolean} blocked            any rating.blocked === true
 * @property {string|null} finishReason   e.g. 'STOP' | 'SAFETY'
 * @property {string|null} blockReason    promptFeedback.blockReason (input side)
 *
 * @typedef {Object} LlmResult
 * @property {string|null} transcription  what the user said (null if none)
 * @property {string} responseText        the assistant's Bengali reply
 * @property {{promptTokens:number|null, completionTokens:number|null}} usage
 * @property {SafetySignal|null} [safety]  native provider safety signal, or null
 *   when the provider has none — see each provider's file for how (or
 *   whether) it populates this. Consumed log-first in converse.js.
 */

import { config } from '../config.js';
import { withRetry } from '../util/retry.js';
import { ProviderError } from '../errors.js';
import { GeminiProvider } from './geminiProvider.js';
import { OpenRouterProvider } from './openRouterProvider.js';
import { MockProvider } from './mockProvider.js';

function buildProvider() {
  switch (config.llm.provider) {
    case 'gemini':
      return new GeminiProvider({ ...config.llm.gemini, temperature: config.llm.temperature });
    case 'openrouter':
      return new OpenRouterProvider({ ...config.llm.openRouter, temperature: config.llm.temperature });
    case 'mock':
      return new MockProvider();
    default:
      throw new Error(`Unknown LLM_PROVIDER "${config.llm.provider}"`);
  }
}

// Built lazily on first use so `validate()` in the bootstrap runs first and
// owns the fail-fast error path — no provider client is constructed until a
// request actually needs it.
let _provider;
function provider() {
  if (!_provider) _provider = buildProvider();
  return _provider;
}

export function llmProviderName() {
  return config.llm.provider;
}

/**
 * @param {Turn} turn
 * @returns {Promise<LlmResult>}
 */
export async function generateReply(turn) {
  return withRetry((signal) => provider().generate(turn, signal), {
    label: `llm:${config.llm.provider}`,
    isRetryable: (err) => (err instanceof ProviderError ? err.retryable : true),
  });
}
