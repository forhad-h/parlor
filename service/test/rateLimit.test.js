import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rateLimit } from '../src/middleware/rateLimit.js';

function fakeReq(sessionId) {
  return { body: { sessionId }, ip: '127.0.0.1' };
}

function fakeRes() {
  const res = {
    statusCode: null,
    headers: {},
    body: null,
    set(name, value) {
      res.headers[name] = value;
      return res;
    },
    status(code) {
      res.statusCode = code;
      return res;
    },
    json(payload) {
      res.body = payload;
      return res;
    },
  };
  return res;
}

test('allows requests up to the limit, then rejects with 429', () => {
  const sessionId = `test-session-${Math.random()}`;
  let nextCalls = 0;
  const next = () => { nextCalls += 1; };

  for (let i = 0; i < 30; i++) {
    const res = fakeRes();
    rateLimit(fakeReq(sessionId), res, next);
    assert.equal(res.statusCode, null, `request ${i + 1} should not be rejected`);
  }
  assert.equal(nextCalls, 30);

  const res = fakeRes();
  rateLimit(fakeReq(sessionId), res, next);
  assert.equal(nextCalls, 30); // next() not called on the rejected request
  assert.equal(res.statusCode, 429);
  assert.equal(res.body.error, 'rate limit exceeded');
  assert.ok(res.body.retryAfterSec > 0);
  assert.ok(res.headers['Retry-After']);
});

test('tracks separate sessions independently', () => {
  const res = fakeRes();
  let called = false;
  rateLimit(fakeReq(`isolated-session-${Math.random()}`), res, () => { called = true; });
  assert.equal(called, true);
  assert.equal(res.statusCode, null);
});
