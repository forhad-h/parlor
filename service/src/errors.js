/**
 * Typed error for anything that goes wrong inside a provider (LLM or TTS).
 *
 * The route handler catches these and turns them into a structured 502 that
 * carries a ready-to-speak Bengali message, so `server.py` can relay a friendly
 * apology over the existing `text` frame instead of hanging the WebSocket.
 */
export class ProviderError extends Error {
  /**
   * @param {string} message      Operator-facing detail (logged, not spoken).
   * @param {object} [opts]
   * @param {string} [opts.provider] Which provider raised it (e.g. "gemini").
   * @param {string} [opts.stage]    "llm" | "tts".
   * @param {Error}  [opts.cause]    Underlying error, preserved for logs.
   * @param {boolean}[opts.retryable] Whether a bounded retry might succeed.
   */
  constructor(message, { provider, stage, cause, retryable = false } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.provider = provider;
    this.stage = stage;
    this.cause = cause;
    this.retryable = retryable;
  }
}

/** A polite Bengali apology spoken to the user when a provider hard-fails. */
export const BENGALI_ERROR_MESSAGE =
  'দুঃখিত, এই মুহূর্তে আমি উত্তর দিতে পারছি না। একটু পরে আবার চেষ্টা করুন।';
