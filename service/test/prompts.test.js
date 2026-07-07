import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SYSTEM_PROMPT,
  MODALITY_INSTRUCTIONS,
  modalityInstruction,
  RESPONSE_SCHEMA,
} from '../src/prompts/bengali.js';

const hasBengali = (s) => /[ঀ-৿]/.test(s);

test('system prompt is Bengali, non-empty, and forces the JSON output contract', () => {
  assert.equal(typeof SYSTEM_PROMPT, 'string');
  assert.ok(SYSTEM_PROMPT.length > 0);
  assert.ok(hasBengali(SYSTEM_PROMPT), 'should contain Bengali text');
  assert.ok(/\bJSON\b/.test(SYSTEM_PROMPT), 'should require JSON output');
  assert.ok(
    SYSTEM_PROMPT.includes('transcription') && SYSTEM_PROMPT.includes('response'),
    'should name both JSON fields',
  );
});

test('all four modality instructions exist and are Bengali', () => {
  const keys = ['audioAndImage', 'audio', 'image', 'text'];
  for (const k of keys) {
    assert.ok(MODALITY_INSTRUCTIONS[k], `missing ${k}`);
    assert.ok(hasBengali(MODALITY_INSTRUCTIONS[k]), `${k} should be Bengali`);
  }
});

test('modalityInstruction selects the right branch for each input combo', () => {
  assert.equal(
    modalityInstruction({ hasAudio: true, hasImage: true }),
    MODALITY_INSTRUCTIONS.audioAndImage,
  );
  assert.equal(modalityInstruction({ hasAudio: true, hasImage: false }), MODALITY_INSTRUCTIONS.audio);
  assert.equal(modalityInstruction({ hasAudio: false, hasImage: true }), MODALITY_INSTRUCTIONS.image);
  assert.equal(modalityInstruction({ hasAudio: false, hasImage: false }), MODALITY_INSTRUCTIONS.text);
});

test('response schema has the exact shape the JSON contract expects', () => {
  assert.equal(RESPONSE_SCHEMA.name, 'bengali_turn_response');
  assert.ok(hasBengali(RESPONSE_SCHEMA.description));
  assert.ok(RESPONSE_SCHEMA.fields.transcription);
  assert.ok(RESPONSE_SCHEMA.fields.response);
});
