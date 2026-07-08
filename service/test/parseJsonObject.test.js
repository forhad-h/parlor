import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseJsonObject } from '../src/text/parseJsonObject.js';

test('parses a plain (unfenced) JSON object', () => {
  const obj = parseJsonObject('{"transcription": "আমি", "response": "ঠিক আছে"}');
  assert.deepEqual(obj, { transcription: 'আমি', response: 'ঠিক আছে' });
});

test('parses a JSON object wrapped in a ```json code fence', () => {
  const raw = '```json\n{"transcription": "আমি", "response": "ঠিক আছে"}\n```';
  assert.deepEqual(parseJsonObject(raw), { transcription: 'আমি', response: 'ঠিক আছে' });
});

test('parses a JSON object wrapped in a bare ``` fence (no language)', () => {
  const raw = '```\n{"response": "হ্যাঁ"}\n```';
  assert.deepEqual(parseJsonObject(raw), { response: 'হ্যাঁ' });
});

test('returns null for non-JSON / garbage input', () => {
  assert.equal(parseJsonObject('just some prose, not json'), null);
  assert.equal(parseJsonObject('{ not valid json'), null);
});

test('returns null for JSON that is not an object', () => {
  assert.equal(parseJsonObject('"just a string"'), null);
  assert.equal(parseJsonObject('[1, 2, 3]'), null);
  assert.equal(parseJsonObject('42'), null);
});

test('returns null for empty or non-string input', () => {
  assert.equal(parseJsonObject(''), null);
  assert.equal(parseJsonObject('   '), null);
  assert.equal(parseJsonObject(null), null);
  assert.equal(parseJsonObject(undefined), null);
});
