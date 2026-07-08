/**
 * Gemini LLM provider (default).
 *
 * Uses Gemini's native JSON structured output (`responseMimeType:
 * 'application/json'` + `responseSchema`) to get the same {transcription,
 * response} object every turn that server.py expects — without the
 * function-calling trick the on-device litert_lm path needed. The model is
 * config-constrained to the schema, so no real "tool" is involved.
 *
 * Multimodal input (base64 WAV audio + JPEG image) is passed natively as
 * inlineData parts, matching the audio/image shape the browser already sends.
 */

import { GoogleGenAI, Type, HarmCategory, HarmBlockThreshold } from '@google/genai';
import { SYSTEM_PROMPT, RESPONSE_SCHEMA, buildTurnText } from '../prompts/bengali.js';
import { ProviderError } from '../errors.js';
import { cleanText } from '../text/cleanText.js';
import { parseJsonObject } from '../text/parseJsonObject.js';

/**
 * Native Gemini safety config — a SECONDARY, observability-first layer on top of
 * the prompt-level safety rule (see prompts/bengali.js). The threshold is fixed
 * at BLOCK_NONE, not configurable: if Gemini actually blocks, it returns an
 * empty body, `res.text` is empty, and we fall through to the throw below — a
 * broken turn with no graceful refusal, which defeats the whole point of
 * guaranteeing a response every turn. So we always let generation complete and
 * only READ the ratings; the real block decision (speaking SAFE_REFUSAL) lives
 * in routes/converse.js, gated by SAFETY_MODE (see config.js).
 */
const SAFETY_CATEGORIES = [
  HarmCategory.HARM_CATEGORY_HARASSMENT,
  HarmCategory.HARM_CATEGORY_HATE_SPEECH,
  HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
  HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
];

/** Probabilities that count as "flagged" — MEDIUM and above, matching Gemini's own default block threshold. */
const FLAG_PROBABILITIES = new Set(['MEDIUM', 'HIGH']);

/** Loose classification: rate-limit / transient server / network errors are worth a retry. */
function isRetryable(err) {
  const status = err?.status ?? err?.code;
  if (status === 429 || status === 500 || status === 502 || status === 503 || status === 504) return true;
  const msg = String(err?.message ?? '').toLowerCase();
  return /\b(429|500|502|503|504|timeout|timed out|econnreset|etimedout|fetch failed|overloaded|unavailable)\b/.test(msg);
}

export class GeminiProvider {
  constructor({ apiKey, model, temperature }) {
    this.name = 'gemini';
    this.model = model;
    this.temperature = temperature;
    this.client = new GoogleGenAI({ apiKey });
    this.safetySettings = SAFETY_CATEGORIES.map((category) => ({
      category,
      threshold: HarmBlockThreshold.BLOCK_NONE,
    }));
    this.responseSchema = {
      type: Type.OBJECT,
      description: RESPONSE_SCHEMA.description,
      properties: {
        transcription: { type: Type.STRING, description: RESPONSE_SCHEMA.fields.transcription },
        response: { type: Type.STRING, description: RESPONSE_SCHEMA.fields.response },
      },
      required: ['transcription', 'response'],
      propertyOrdering: ['transcription', 'response'],
    };
  }

  /**
   * @param {import('./index.js').Turn} turn
   * @param {AbortSignal} [signal]
   * @returns {Promise<import('./index.js').LlmResult>}
   */
  async generate(turn, signal) {
    const contents = buildContents(turn);

    let res;
    try {
      res = await this.client.models.generateContent({
        model: this.model,
        contents,
        config: {
          systemInstruction: SYSTEM_PROMPT,
          temperature: this.temperature,
          responseMimeType: 'application/json',
          responseSchema: this.responseSchema,
          safetySettings: this.safetySettings,
          abortSignal: signal,
        },
      });
    } catch (err) {
      throw new ProviderError(`Gemini request failed: ${err?.message ?? err}`, {
        provider: this.name,
        stage: 'llm',
        cause: err,
        retryable: isRetryable(err),
      });
    }

    const usage = {
      promptTokens: res?.usageMetadata?.promptTokenCount ?? null,
      completionTokens: res?.usageMetadata?.candidatesTokenCount ?? null,
    };
    const safety = extractSafety(res, this.name);

    const parsed = parseJsonObject(res?.text);
    if (parsed && 'transcription' in parsed && 'response' in parsed) {
      return {
        transcription: cleanText(parsed.transcription),
        responseText: cleanText(parsed.response),
        usage,
        safety,
      };
    }

    // Schema-constrained output should make this unreachable, but never hang the
    // turn: fall back to whatever plain text the model produced.
    const fallback = cleanText(res?.text);
    if (!fallback) {
      throw new ProviderError('Gemini returned neither valid JSON nor text', {
        provider: this.name,
        stage: 'llm',
        retryable: false,
      });
    }
    return { transcription: null, responseText: fallback, usage, safety };
  }
}

/**
 * Normalize Gemini's native safety signal into the compact, provider-agnostic
 * shape converse.js consumes (see the LlmResult typedef in index.js). Everything
 * is null-guarded — safetyRatings can be absent on some responses — and defaults
 * to not-flagged. `flagged` keys off probability (MEDIUM+), independent of the
 * BLOCK_NONE threshold, so we get a "would-block" awareness signal without any
 * turn being cut. See config.js / converse.js for why this is log-first.
 */
export function extractSafety(res, provider) {
  const candidate = res?.candidates?.[0];
  const ratings = candidate?.safetyRatings ?? [];
  const finishReason = candidate?.finishReason ?? null;
  const blockReason = res?.promptFeedback?.blockReason ?? null;

  const categories = ratings
    .filter((r) => r?.probability && r.probability !== 'NEGLIGIBLE')
    .map((r) => ({ category: r.category, probability: r.probability }));
  const blocked = ratings.some((r) => r?.blocked === true);
  const flagged =
    !!blockReason ||
    finishReason === 'SAFETY' ||
    blocked ||
    ratings.some((r) => FLAG_PROBABILITIES.has(r?.probability));

  return { flagged, provider, categories, blocked, finishReason, blockReason };
}

/** Build Gemini `contents` from text-only history plus the current multimodal turn. */
function buildContents(turn) {
  const contents = [];

  for (const { role, text } of turn.history ?? []) {
    contents.push({ role, parts: [{ text }] });
  }

  const parts = [];
  if (turn.audioBase64) {
    parts.push({ inlineData: { mimeType: turn.audioMime ?? 'audio/wav', data: turn.audioBase64 } });
  }
  if (turn.imageBase64) {
    parts.push({ inlineData: { mimeType: turn.imageMime ?? 'image/jpeg', data: turn.imageBase64 } });
  }

  parts.push({
    text: buildTurnText({
      hasAudio: !!turn.audioBase64,
      hasImage: !!turn.imageBase64,
      text: turn.text,
    }),
  });

  contents.push({ role: 'user', parts });
  return contents;
}
