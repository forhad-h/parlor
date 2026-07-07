/**
 * Microsoft Edge neural-voice TTS provider.
 *
 * Free and no signup. This build of msedge-tts emits only compressed audio, so
 * we request 24 kHz mono MP3 and transcode it to raw PCM16 here (via
 * `decodeMp3ToPcm16`) — the browser's `audio_chunk` path needs raw PCM, and
 * 24 kHz matches the original Kokoro rate so the client is untouched.
 *
 * Bengali voices: bn-BD-NabanitaNeural / bn-BD-PradeepNeural (Bangladesh),
 * bn-IN-TanishaaNeural / bn-IN-BashkarNeural (India). Set via TTS_VOICE.
 *
 * One short-lived connection per sentence keeps concurrent syntheses (the
 * Promise.allSettled fan-out in the route) isolated from each other's WS state.
 */

import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';
import { collectStream, decodeMp3ToPcm16 } from '../util/audio.js';
import { ProviderError } from '../errors.js';

const OUTPUT = OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3;
const NATIVE_SAMPLE_RATE = 24000;

export class EdgeTtsProvider {
  constructor({ voice, rate, pitch }) {
    this.name = 'edge';
    this.voice = voice;
    this.rate = rate;
    this.pitch = pitch;
    this.sampleRate = NATIVE_SAMPLE_RATE;
  }

  /**
   * @param {string} text
   * @returns {Promise<{pcm: Buffer, sampleRate: number}>}
   */
  async synthesize(text) {
    const tts = new MsEdgeTTS();
    try {
      await tts.setMetadata(this.voice, OUTPUT);
      const result = tts.toStream(text, { rate: this.rate, pitch: this.pitch });
      // msedge-tts returns { audioStream, metadataStream }; older builds a Readable.
      const stream = result?.audioStream ?? result;
      const mp3 = await collectStream(stream);
      if (!mp3.length) throw new Error('Edge TTS returned empty audio');
      const { pcm, sampleRate } = await decodeMp3ToPcm16(mp3);
      if (!pcm.length) throw new Error('Edge TTS audio decoded to zero samples');
      return { pcm, sampleRate: sampleRate || NATIVE_SAMPLE_RATE };
    } catch (err) {
      throw new ProviderError(`Edge TTS failed: ${err?.message ?? err}`, {
        provider: this.name,
        stage: 'tts',
        cause: err,
        retryable: true,
      });
    } finally {
      try {
        tts.close?.();
      } catch {
        /* connection already closed by the library after stream end */
      }
    }
  }
}
