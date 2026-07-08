import { test } from 'node:test';
import assert from 'node:assert/strict';
import { floatToPcm16, resamplePcm16, silencePcm16 } from '../src/util/audio.js';

test('floatToPcm16 maps the full range and clips out-of-range samples', () => {
  const buf = floatToPcm16(Float32Array.from([0, 1, -1, 2, -2]));
  assert.equal(buf.length, 5 * 2);
  assert.equal(buf.readInt16LE(0), 0);
  assert.equal(buf.readInt16LE(2), 32767); // +1.0 → max
  assert.equal(buf.readInt16LE(4), -32768); // -1.0 → min
  assert.equal(buf.readInt16LE(6), 32767); // +2.0 clipped
  assert.equal(buf.readInt16LE(8), -32768); // -2.0 clipped
});

test('resamplePcm16 is a no-op when rates match (same buffer instance)', () => {
  const buf = floatToPcm16(Float32Array.from([0.1, 0.2, 0.3]));
  assert.equal(resamplePcm16(buf, 24000, 24000), buf);
});

test('resamplePcm16 upsamples and downsamples by roughly the rate ratio', () => {
  const samples = 100;
  const buf = Buffer.alloc(samples * 2); // silence is fine for length math
  assert.equal(resamplePcm16(buf, 24000, 48000).length / 2, 200); // 2x
  assert.equal(resamplePcm16(buf, 24000, 12000).length / 2, 50); // 0.5x
});

test('resamplePcm16 preserves endpoints of a ramp when downsampling', () => {
  // Ramp 0..1 over 8 samples; downsample to 4 — first sample stays ~0.
  const ramp = Float32Array.from({ length: 8 }, (_, i) => i / 7);
  const out = resamplePcm16(floatToPcm16(ramp), 8000, 4000);
  assert.equal(out.readInt16LE(0), 0);
  assert.ok(out.readInt16LE(out.length - 2) > 0); // last sample still positive
});

test('silencePcm16 produces the right number of zeroed samples', () => {
  const buf = silencePcm16(1000, 24000); // 1 second @ 24kHz
  assert.equal(buf.length, 24000 * 2);
  assert.ok(buf.every((b) => b === 0));
});
