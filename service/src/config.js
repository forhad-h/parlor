/**
 * Central, env-driven configuration.
 *
 * Read once at import time, frozen, and shared everywhere. `validate()` runs at
 * startup and throws for the *selected* providers' missing keys — you learn about
 * a misconfiguration at boot, not on the first user turn mid-demo.
 */

import 'dotenv/config';

const str = (key, fallback = '') => {
  const v = process.env[key];
  return v === undefined || v === '' ? fallback : v;
};

const int = (key, fallback) => {
  const v = process.env[key];
  if (v === undefined || v === '') return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isNaN(n) ? fallback : n;
};

const float = (key, fallback) => {
  const v = process.env[key];
  if (v === undefined || v === '') return fallback;
  const n = Number.parseFloat(v);
  return Number.isNaN(n) ? fallback : n;
};

const bool = (key, fallback) => {
  const v = process.env[key];
  if (v === undefined || v === '') return fallback;
  return /^(1|true|yes|on)$/i.test(v.trim());
};

export const config = Object.freeze({
  port: int('PORT', 3001),
  logLevel: str('LOG_LEVEL', 'info'),

  llm: Object.freeze({
    provider: str('LLM_PROVIDER', 'gemini').toLowerCase(),
    temperature: float('LLM_TEMPERATURE', 0.7),
    gemini: Object.freeze({
      apiKey: str('GEMINI_API_KEY'),
      model: str('GEMINI_MODEL', 'gemini-2.5-flash'),
    }),
    openRouter: Object.freeze({
      apiKey: str('OPENROUTER_API_KEY'),
      model: str('OPENROUTER_MODEL', 'google/gemini-2.5-flash'),
    }),
  }),

  tts: Object.freeze({
    provider: str('TTS_PROVIDER', 'edge').toLowerCase(),
    voice: str('TTS_VOICE', 'bn-BD-NabanitaNeural'),
    rate: str('TTS_RATE', '+0%'),
    pitch: str('TTS_PITCH', '+0Hz'),
  }),

  limits: Object.freeze({
    maxRequestBytes: int('MAX_REQUEST_MB', 12) * 1024 * 1024,
  }),

  cache: Object.freeze({
    tts: bool('CACHE_TTS', true),
  }),
});

/** Keys each provider cannot run without. */
const REQUIRED_KEYS = {
  llm: {
    gemini: [['GEMINI_API_KEY', config.llm.gemini.apiKey]],
    openrouter: [['OPENROUTER_API_KEY', config.llm.openRouter.apiKey]],
    mock: [], // Offline/test provider — no credentials.
  },
  tts: {
    edge: [], // Edge TTS needs no credentials.
  },
};

/**
 * Validate the *active* configuration. Throws an aggregated, human-readable
 * error listing every problem at once rather than failing one key at a time.
 */
export function validate() {
  const problems = [];

  const llmKeys = REQUIRED_KEYS.llm[config.llm.provider];
  if (!llmKeys) {
    problems.push(`Unknown LLM_PROVIDER "${config.llm.provider}" (expected: ${Object.keys(REQUIRED_KEYS.llm).join(', ')})`);
  } else {
    for (const [name, value] of llmKeys) {
      if (!value) problems.push(`LLM_PROVIDER=${config.llm.provider} requires ${name}`);
    }
  }

  const ttsKeys = REQUIRED_KEYS.tts[config.tts.provider];
  if (!ttsKeys) {
    problems.push(`Unknown TTS_PROVIDER "${config.tts.provider}" (expected: ${Object.keys(REQUIRED_KEYS.tts).join(', ')})`);
  } else {
    for (const [name, value] of ttsKeys) {
      if (!value) problems.push(`TTS_PROVIDER=${config.tts.provider} requires ${name}`);
    }
  }

  if (problems.length > 0) {
    throw new Error(
      `Invalid configuration:\n  - ${problems.join('\n  - ')}\n` +
      `Fix your .env (see .env.example) and restart.`,
    );
  }
}
