/**
 * TTS strategy interface.
 *
 * Mirrors the LLM layer: one `synthesizeSentence(text) -> {audioBase64}`
 * contract, provider selected by env, with resilience (retry/backoff/timeout)
 * and the deterministic-output cache wrapped here once. The route fans these
 * out concurrently per sentence — this module stays single-sentence so caching
 * and retry are per unit of work.
 *
 * @typedef {Object} SynthResult
 * @property {string} audioBase64  base64 PCM16 LE at `outputSampleRate`
 * @property {boolean} cached
 */

import { config } from '../config.js';
import { withRetry } from '../util/retry.js';
import { TtlCache } from '../util/cache.js';
import { resamplePcm16 } from '../util/audio.js';
import { ProviderError } from '../errors.js';
import { EdgeTtsProvider } from './edgeTtsProvider.js';

function buildProvider() {
  switch (config.tts.provider) {
    case 'edge':
      return new EdgeTtsProvider(config.tts);
    default:
      throw new Error(`Unknown TTS_PROVIDER "${config.tts.provider}"`);
  }
}

// Built lazily on first use (see llm/index.js for the same rationale).
let _provider;
function provider() {
  if (!_provider) _provider = buildProvider();
  return _provider;
}

// Identical sentences recur (greetings, confirmations, repeated/retried user
// turns) and Edge output is deterministic, so caching cuts latency and provider
// load on exact repeats. Note: the error apology (errors.js) never reaches
// here — provider failures short-circuit to a text-only WS frame — so it's
// never actually cached.
const cache = config.cache.tts ? new TtlCache({ max: 500, ttlMs: 6 * 60 * 60 * 1000 }) : null;

// Advertised to the browser in `audio_start`. Read from the active provider
// itself (e.g. Edge's native 24 kHz) rather than a separate config value, so
// there's one source of truth per provider instead of two that can drift.
export function outputSampleRate() {
  return provider().sampleRate;
}

export function ttsProviderName() {
  return config.tts.provider;
}

/** Human-friendly rendering of ttsProviderName(), e.g. "edge" -> "Edge". */
export function ttsProviderLabel() {
  const name = ttsProviderName();
  return name.charAt(0).toUpperCase() + name.slice(1);
}

export function ttsCacheStats() {
  return cache?.stats() ?? null;
}

/**
 * Synthesise one sentence to base64 PCM16 at the advertised output rate.
 * @param {string} text
 * @returns {Promise<SynthResult>}
 */
export async function synthesizeSentence(text) {
  const key = cache ? cacheKey(text) : null;
  if (key) {
    const hit = cache.get(key);
    if (hit) return { audioBase64: hit, cached: true };
  }

  const { pcm, sampleRate } = await withRetry(() => provider().synthesize(text), {
    label: `tts:${config.tts.provider}`,
    isRetryable: (err) => (err instanceof ProviderError ? err.retryable : true),
  });

  const targetSampleRate = outputSampleRate();
  const normalized =
    sampleRate === targetSampleRate ? pcm : resamplePcm16(pcm, sampleRate, targetSampleRate);
  const audioBase64 = normalized.toString('base64');

  if (key) cache.set(key, audioBase64);
  return { audioBase64, cached: false };
}

function cacheKey(text) {
  const { provider: name, voice, rate, pitch } = config.tts;
  return `${name}|${voice}|${rate}|${pitch}|${outputSampleRate()}|${text}`;
}
