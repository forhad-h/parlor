/**
 * OpenRouter LLM provider (alternate).
 *
 * Same interface as the Gemini provider, reached through OpenRouter's
 * OpenAI-compatible Chat Completions API. Swapping to it is a one-line env
 * change (`LLM_PROVIDER=openrouter`), and `OPENROUTER_MODEL` then dials the
 * underlying model — a cost-vs-quality knob without touching code.
 *
 * Caveat (documented in the README): audio-input support and reliable
 * JSON-schema-constrained output vary per routed model. We send audio as an
 * `input_audio` part when present; a model that can't accept it will surface an
 * API error rather than silently dropping the modality. Verify a model before
 * relying on it.
 */

import { RESPONSE_SCHEMA, SYSTEM_PROMPT, buildTurnText } from '../prompts/bengali.js';
import { ProviderError } from '../errors.js';
import { cleanText } from '../text/cleanText.js';
import { parseJsonObject } from '../text/parseJsonObject.js';

const RETRYABLE_STATUS = new Set([408, 409, 429, 500, 502, 503, 504]);

export class OpenRouterProvider {
  constructor({ apiKey, model, temperature, baseUrl = 'https://openrouter.ai/api/v1' }) {
    this.name = 'openrouter';
    this.apiKey = apiKey;
    this.model = model;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.temperature = temperature;
    this.jsonSchema = {
      type: 'json_schema',
      json_schema: {
        name: RESPONSE_SCHEMA.name,
        description: RESPONSE_SCHEMA.description,
        strict: true,
        schema: {
          type: 'object',
          properties: {
            transcription: { type: 'string', description: RESPONSE_SCHEMA.fields.transcription },
            response: { type: 'string', description: RESPONSE_SCHEMA.fields.response },
          },
          required: ['transcription', 'response'],
          additionalProperties: false,
        },
      },
    };
  }

  /**
   * @param {import('./index.js').Turn} turn
   * @param {AbortSignal} [signal]
   * @returns {Promise<import('./index.js').LlmResult>}
   */
  async generate(turn, signal) {
    const body = {
      model: this.model,
      temperature: this.temperature,
      messages: buildMessages(turn),
      response_format: this.jsonSchema,
    };

    let res;
    try {
      res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        signal,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://github.com/forhad-h/parlor',
          'X-Title': 'Parlor Bengali',
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new ProviderError(`OpenRouter request failed: ${err?.message ?? err}`, {
        provider: this.name,
        stage: 'llm',
        cause: err,
        retryable: true, // network-level failure
      });
    }

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new ProviderError(`OpenRouter HTTP ${res.status}: ${detail.slice(0, 300)}`, {
        provider: this.name,
        stage: 'llm',
        retryable: RETRYABLE_STATUS.has(res.status),
      });
    }

    const data = await res.json();
    const message = data?.choices?.[0]?.message;
    const usage = {
      promptTokens: data?.usage?.prompt_tokens ?? null,
      completionTokens: data?.usage?.completion_tokens ?? null,
    };

    // OpenRouter has no native safety-settings passthrough (its docs expose only
    // Anthropic beta headers), so safety here is null — the prompt-level rule in
    // prompts/bengali.js is this provider's only safety layer.
    const parsed = parseJsonObject(message?.content);
    if (parsed && 'transcription' in parsed && 'response' in parsed) {
      return { transcription: cleanText(parsed.transcription), responseText: cleanText(parsed.response), usage, safety: null };
    }

    const fallback = cleanText(message?.content);
    if (!fallback) {
      throw new ProviderError('OpenRouter returned neither valid JSON nor content', {
        provider: this.name,
        stage: 'llm',
        retryable: false,
      });
    }
    return { transcription: null, responseText: fallback, usage, safety: null };
  }
}

function buildMessages(turn) {
  const messages = [{ role: 'system', content: SYSTEM_PROMPT }];

  for (const { role, text } of turn.history ?? []) {
    messages.push({ role: role === 'model' ? 'assistant' : 'user', content: text });
  }

  const content = [];
  if (turn.audioBase64) {
    content.push({ type: 'input_audio', input_audio: { data: turn.audioBase64, format: 'wav' } });
  }
  if (turn.imageBase64) {
    const mime = turn.imageMime ?? 'image/jpeg';
    content.push({ type: 'image_url', image_url: { url: `data:${mime};base64,${turn.imageBase64}` } });
  }
  content.push({
    type: 'text',
    text: buildTurnText({
      hasAudio: !!turn.audioBase64,
      hasImage: !!turn.imageBase64,
      text: turn.text,
    }),
  });

  messages.push({ role: 'user', content });
  return messages;
}
