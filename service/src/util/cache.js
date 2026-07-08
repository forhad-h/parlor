/**
 * Bounded in-memory LRU + TTL cache.
 *
 * Backs the TTS cache only (see tts/index.js): exact-repeat sentences —
 * greetings, confirmations, retried turns — synthesise deterministically, so
 * re-synthesising wastes latency and provider quota. There's deliberately no
 * LLM-layer cache (see llm/index.js for why). Kept small and honest about its
 * narrow scope: eviction by size and age, no external store. A real deployment
 * would swap this for Redis (noted in the README).
 */
export class TtlCache {
  /** @param {{max?: number, ttlMs?: number}} [opts] */
  constructor({ max = 500, ttlMs = 60 * 60 * 1000 } = {}) {
    this.max = max;
    this.ttlMs = ttlMs;
    /** @type {Map<string, {value: unknown, expires: number}>} */
    this.store = new Map();
    this.hits = 0;
    this.misses = 0;
  }

  get(key) {
    const entry = this.store.get(key);
    if (!entry) {
      this.misses++;
      return undefined;
    }
    if (Date.now() > entry.expires) {
      this.store.delete(key);
      this.misses++;
      return undefined;
    }
    // Re-insert to mark as most-recently-used (Map preserves insertion order).
    this.store.delete(key);
    this.store.set(key, entry);
    this.hits++;
    return entry.value;
  }

  set(key, value) {
    if (this.store.has(key)) this.store.delete(key);
    this.store.set(key, { value, expires: Date.now() + this.ttlMs });
    // Evict the least-recently-used entry (first key) past capacity.
    if (this.store.size > this.max) {
      const oldest = this.store.keys().next().value;
      this.store.delete(oldest);
    }
  }

  get size() {
    return this.store.size;
  }

  stats() {
    const total = this.hits + this.misses;
    return {
      size: this.store.size,
      hits: this.hits,
      misses: this.misses,
      hitRate: total === 0 ? 0 : Number((this.hits / total).toFixed(3)),
    };
  }
}
