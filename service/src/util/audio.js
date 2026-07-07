/**
 * PCM16 audio helpers.
 *
 * The browser's playback path (index.html) decodes each `audio_chunk` as raw
 * little-endian Int16 PCM at the sample rate announced in `audio_start`. Edge
 * TTS only emits *compressed* audio (MP3/Opus), so `decodeMp3ToPcm16` is the
 * load-bearing transcode step from compressed bytes to the raw PCM16 the
 * browser expects — skip it and playback breaks silently. `resamplePcm16` is a
 * correctness guard for any provider whose native rate differs from the
 * advertised output rate, keeping the browser contract intact regardless of
 * source. Both use a pure-WASM decoder (no system ffmpeg dependency).
 */

import { MPEGDecoder } from 'mpg123-decoder';

/** Collect a Readable stream of Buffers into a single Buffer. */
export function collectStream(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (c) => chunks.push(c));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

/**
 * Linear-interpolation resample of mono little-endian PCM16.
 * No-op when the rates match (the common Edge path).
 *
 * @param {Buffer} buf  mono PCM16 LE
 * @param {number} fromRate
 * @param {number} toRate
 * @returns {Buffer}
 */
export function resamplePcm16(buf, fromRate, toRate) {
  if (fromRate === toRate) return buf;
  const inSamples = Math.floor(buf.length / 2);
  if (inSamples === 0) return Buffer.alloc(0);

  const ratio = toRate / fromRate;
  const outSamples = Math.max(1, Math.round(inSamples * ratio));
  const out = Buffer.alloc(outSamples * 2);

  for (let i = 0; i < outSamples; i++) {
    const srcPos = i / ratio;
    const idx = Math.floor(srcPos);
    const frac = srcPos - idx;
    const s0 = idx < inSamples ? buf.readInt16LE(idx * 2) : 0;
    const s1 = idx + 1 < inSamples ? buf.readInt16LE((idx + 1) * 2) : s0;
    const val = Math.round(s0 + (s1 - s0) * frac);
    out.writeInt16LE(Math.max(-32768, Math.min(32767, val)), i * 2);
  }
  return out;
}

/** A buffer of silence (zeroed PCM16). Used by the audio tests. */
export function silencePcm16(ms, sampleRate) {
  const samples = Math.round((ms / 1000) * sampleRate);
  return Buffer.alloc(samples * 2);
}

/**
 * Convert a Float32 sample array in [-1, 1] to little-endian PCM16.
 * @param {Float32Array} float32
 * @param {number} [count] number of samples to read (defaults to full length)
 * @returns {Buffer}
 */
export function floatToPcm16(float32, count = float32.length) {
  const out = Buffer.alloc(count * 2);
  for (let i = 0; i < count; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    out.writeInt16LE(s < 0 ? s * 0x8000 : s * 0x7fff, i * 2);
  }
  return out;
}

/**
 * Decode an MP3 buffer to mono PCM16.
 *
 * Uses mpg123 compiled to WASM, so there's no native/ffmpeg dependency to
 * install. Stereo output (rare for Edge's mono voices) is downmixed by
 * averaging channels.
 *
 * @param {Buffer} mp3
 * @returns {Promise<{pcm: Buffer, sampleRate: number}>}
 */
export async function decodeMp3ToPcm16(mp3) {
  const decoder = new MPEGDecoder();
  await decoder.ready;
  try {
    const bytes = new Uint8Array(mp3.buffer, mp3.byteOffset, mp3.byteLength);
    const { channelData, samplesDecoded, sampleRate } = decoder.decode(bytes);
    if (!samplesDecoded || channelData.length === 0) {
      return { pcm: Buffer.alloc(0), sampleRate: sampleRate || 24000 };
    }

    let mono = channelData[0];
    if (channelData.length > 1) {
      mono = new Float32Array(samplesDecoded);
      for (let i = 0; i < samplesDecoded; i++) {
        let sum = 0;
        for (const ch of channelData) sum += ch[i];
        mono[i] = sum / channelData.length;
      }
    }

    return { pcm: floatToPcm16(mono, samplesDecoded), sampleRate };
  } finally {
    decoder.free();
  }
}
