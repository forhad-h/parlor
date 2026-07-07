import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanText } from '../src/text/cleanText.js';

test('strips the stray <|"|> token and trims', () => {
  assert.equal(cleanText('  আমি ভালো আছি<|"|> '), 'আমি ভালো আছি');
});

test('strips bold and italic emphasis', () => {
  assert.equal(cleanText('এটা **জরুরি** এবং *ভালো*'), 'এটা জরুরি এবং ভালো');
  assert.equal(cleanText('এটা __জরুরি__ এবং _ভালো_'), 'এটা জরুরি এবং ভালো');
});

test('strips inline code and fenced code blocks', () => {
  assert.equal(cleanText('চালান `npm start`'), 'চালান npm start');
  assert.equal(cleanText('```js\nconsole.log(1)\n```'), 'console.log(1)');
});

test('strips links and images down to their text', () => {
  assert.equal(cleanText('দেখুন [এখানে](https://example.com)'), 'দেখুন এখানে');
  assert.equal(cleanText('![ছবি](https://example.com/x.png)'), 'ছবি');
});

test('strips heading, blockquote, bullet and numbered markers', () => {
  assert.equal(cleanText('# শিরোনাম\nবাক্য'), 'শিরোনাম বাক্য');
  assert.equal(cleanText('> উক্তি'), 'উক্তি');
  assert.equal(cleanText('- এক\n- দুই'), 'এক দুই');
  assert.equal(cleanText('1. এক\n2) দুই'), 'এক দুই');
});

test('collapses newlines and repeated whitespace into single spaces', () => {
  assert.equal(cleanText('এক\n\nদুই   তিন'), 'এক দুই তিন');
});

test('leaves Bengali punctuation (danda) untouched for sentence splitting', () => {
  assert.equal(cleanText('আমি ভালো আছি। আপনি কেমন আছেন।'), 'আমি ভালো আছি। আপনি কেমন আছেন।');
});

test('non-string input returns an empty string', () => {
  assert.equal(cleanText(null), '');
  assert.equal(cleanText(undefined), '');
  assert.equal(cleanText(42), '');
});
