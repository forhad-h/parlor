import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { TtlCache } from '../src/util/cache.js';

test('stores and returns values, tracking hit/miss stats', () => {
  const c = new TtlCache({ max: 10, ttlMs: 60_000 });
  assert.equal(c.get('a'), undefined); // miss
  c.set('a', 123);
  assert.equal(c.get('a'), 123); // hit
  const stats = c.stats();
  assert.equal(stats.hits, 1);
  assert.equal(stats.misses, 1);
  assert.equal(stats.hitRate, 0.5);
});

test('evicts the least-recently-used entry past capacity', () => {
  const c = new TtlCache({ max: 2, ttlMs: 60_000 });
  c.set('a', 1);
  c.set('b', 2);
  c.get('a'); // touch 'a' so 'b' becomes LRU
  c.set('c', 3); // evicts 'b'
  assert.equal(c.get('a'), 1);
  assert.equal(c.get('b'), undefined);
  assert.equal(c.get('c'), 3);
});

test('expires entries after their TTL', async () => {
  const c = new TtlCache({ max: 10, ttlMs: 10 });
  c.set('a', 1);
  assert.equal(c.get('a'), 1);
  await sleep(25);
  assert.equal(c.get('a'), undefined); // expired
});
