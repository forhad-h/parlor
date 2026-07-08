/**
 * Durable-log strategy interface.
 *
 * Some events have to outlive the stdout logger, so they're persisted through
 * a swappable storage provider. Each entry carries a `type` discriminator, so
 * a new kind of log needs no change here — only a new `type` value at the call
 * site. Every provider implements the same `write(entry)` contract, so adding a
 * provider is additive too (new file + one `case` here).
 *
 * Beyond `type` (and the `ts` that recordDurableEvent stamps), callers attach
 * whatever type-specific fields that kind of entry needs.
 *
 * @typedef {Object} DurableLogEntry
 * @property {string} type   what kind of entry this is (the discriminator)
 * @property {string|null} [sessionId]
 */

import { config } from '../config.js';
import { NoneDurableLogProvider } from './noneProvider.js';
import { FileDurableLogProvider } from './fileProvider.js';

function buildProvider() {
  switch (config.durableLog.provider) {
    case 'none':
      return new NoneDurableLogProvider();
    case 'file':
      return new FileDurableLogProvider(config.durableLog);
    default:
      throw new Error(`Unknown durableLog.provider "${config.durableLog.provider}" (set in config.js)`);
  }
}

// Built eagerly (unlike llm/tts's lazy singleton) via ensureDurableLogReady(),
// called once at bootstrap right after validate() — there's no fail-fast throw
// here to protect, so building early only adds visibility: a provider that
// validates its destination at construction surfaces a bad one in the startup
// log instead of silently on the first logged event.
let _provider;
function provider() {
  if (!_provider) _provider = buildProvider();
  return _provider;
}

export function ensureDurableLogReady() {
  provider();
}

export function durableLogProviderName() {
  return config.durableLog.provider;
}

/**
 * Fire-and-forget by design: no promise is returned, so a call site inside
 * the latency-sensitive /converse handler can't accidentally await it and add
 * disk-I/O tail latency to the user-facing response.
 * @param {DurableLogEntry} entry
 */
export function recordDurableEvent(entry) {
  provider().write({ ts: new Date().toISOString(), ...entry });
}
