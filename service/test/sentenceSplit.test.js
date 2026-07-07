import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitSentences } from '../src/text/sentenceSplit.js';

test('splits on the Bengali danda ।', () => {
  assert.deepEqual(
    splitSentences('আমি ভালো আছি। আপনি কেমন আছেন।'),
    ['আমি ভালো আছি।', 'আপনি কেমন আছেন।'],
  );
});

test('keeps the terminator attached to its sentence', () => {
  const parts = splitSentences('এক। দুই! তিন?');
  assert.deepEqual(parts, ['এক।', 'দুই!', 'তিন?']);
});

test('handles mixed Bengali + Latin punctuation', () => {
  const parts = splitSentences('Hello there. কেমন আছেন? আমি ভালো।');
  assert.equal(parts.length, 3);
  assert.equal(parts[2], 'আমি ভালো।');
});

test('handles the double danda ॥', () => {
  assert.deepEqual(splitSentences('শান্তি॥ পুনরায়॥'), ['শান্তি॥', 'পুনরায়॥']);
});

test('a single sentence with no terminator returns the whole string', () => {
  assert.deepEqual(splitSentences('কোনো যতিচিহ্ন নেই'), ['কোনো যতিচিহ্ন নেই']);
});

test('collapses extra whitespace and drops empty fragments', () => {
  assert.deepEqual(splitSentences('  এক।   দুই।  '), ['এক।', 'দুই।']);
});

test('empty / whitespace / non-string inputs return an empty array', () => {
  assert.deepEqual(splitSentences(''), []);
  assert.deepEqual(splitSentences('   '), []);
  assert.deepEqual(splitSentences(null), []);
  assert.deepEqual(splitSentences(undefined), []);
  assert.deepEqual(splitSentences(42), []);
});

test('does NOT split on a decimal point inside a number run', () => {
  // No whitespace after the '.', so it is not a sentence boundary.
  assert.deepEqual(splitSentences('দাম ৩.৫ টাকা।'), ['দাম ৩.৫ টাকা।']);
});
