import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractSafety } from '../src/llm/geminiProvider.js';

// Helper: a Gemini response with the given output safety ratings.
const withRatings = (ratings, extra = {}) => ({
  candidates: [{ finishReason: 'STOP', safetyRatings: ratings, ...extra }],
});

test('flags when any category rates MEDIUM', () => {
  const res = withRatings([
    { category: 'HARM_CATEGORY_HATE_SPEECH', probability: 'MEDIUM', blocked: false },
  ]);
  const s = extractSafety(res, 'gemini');
  assert.equal(s.flagged, true);
  assert.equal(s.provider, 'gemini');
  assert.deepEqual(s.categories, [{ category: 'HARM_CATEGORY_HATE_SPEECH', probability: 'MEDIUM' }]);
});

test('flags when any category rates HIGH', () => {
  const res = withRatings([{ category: 'HARM_CATEGORY_DANGEROUS_CONTENT', probability: 'HIGH' }]);
  assert.equal(extractSafety(res, 'gemini').flagged, true);
});

test('does NOT flag when all ratings are NEGLIGIBLE or LOW', () => {
  const res = withRatings([
    { category: 'HARM_CATEGORY_HARASSMENT', probability: 'NEGLIGIBLE' },
    { category: 'HARM_CATEGORY_HATE_SPEECH', probability: 'LOW' },
  ]);
  const s = extractSafety(res, 'gemini');
  assert.equal(s.flagged, false);
  // NEGLIGIBLE is dropped from categories; LOW is kept as a non-negligible signal.
  assert.deepEqual(s.categories, [{ category: 'HARM_CATEGORY_HATE_SPEECH', probability: 'LOW' }]);
});

test('flags on blocked===true even when probability is below MEDIUM', () => {
  const res = withRatings([
    { category: 'HARM_CATEGORY_HARASSMENT', probability: 'LOW', blocked: true },
  ]);
  const s = extractSafety(res, 'gemini');
  assert.equal(s.flagged, true);
  assert.equal(s.blocked, true);
});

test('flags on finishReason === SAFETY', () => {
  const res = withRatings([{ category: 'HARM_CATEGORY_HARASSMENT', probability: 'LOW' }], {
    finishReason: 'SAFETY',
  });
  const s = extractSafety(res, 'gemini');
  assert.equal(s.flagged, true);
  assert.equal(s.finishReason, 'SAFETY');
});

test('flags on promptFeedback.blockReason (input side)', () => {
  const res = { promptFeedback: { blockReason: 'SAFETY' } };
  const s = extractSafety(res, 'gemini');
  assert.equal(s.flagged, true);
  assert.equal(s.blockReason, 'SAFETY');
});

test('null-guards a response with no candidates / ratings', () => {
  for (const res of [undefined, {}, { candidates: [] }, { candidates: [{}] }]) {
    const s = extractSafety(res, 'gemini');
    assert.equal(s.flagged, false, `should not flag for ${JSON.stringify(res)}`);
    assert.deepEqual(s.categories, []);
    assert.equal(s.blocked, false);
    assert.equal(s.finishReason, null);
    assert.equal(s.blockReason, null);
  }
});
