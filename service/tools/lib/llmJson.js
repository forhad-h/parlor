/**
 * Structured-JSON LLM call for internal tools (Bengali QA review, turn
 * benchmarking) — NOT the runtime turn path (see ../../src/llm/index.js for
 * that). Tool prompts and response shapes are one-off and differ per tool
 * (a findings list here, a pass/fail verdict there), so this takes a plain
 * JSON Schema per call instead of the fixed {transcription, response} turn
 * contract the runtime providers implement.
 *
 * Reuses whichever LLM provider the service is already configured with
 * (`gemini` or `openrouter`) — no separate key, and no tool-specific env var.
 */

import { GoogleGenAI, Type } from '@google/genai';
import { config } from '../../src/config.js';

const GEMINI_TYPE = {
  object: Type.OBJECT,
  array: Type.ARRAY,
  string: Type.STRING,
  number: Type.NUMBER,
  integer: Type.INTEGER,
  boolean: Type.BOOLEAN,
};

/** Plain JSON Schema (lowercase `type`) -> Gemini's `responseSchema` shape (Type enum). */
function toGeminiSchema(schema) {
  const out = { type: GEMINI_TYPE[schema.type], description: schema.description };
  if (schema.type === 'object') {
    out.properties = Object.fromEntries(
      Object.entries(schema.properties).map(([k, v]) => [k, toGeminiSchema(v)]),
    );
    out.required = schema.required;
  } else if (schema.type === 'array') {
    out.items = toGeminiSchema(schema.items);
  }
  return out;
}

/** Plain JSON Schema -> OpenAI/OpenRouter strict json_schema shape (every object closed + fully required). */
function toStrictJsonSchema(schema) {
  const out = { type: schema.type, description: schema.description };
  if (schema.type === 'object') {
    out.properties = Object.fromEntries(
      Object.entries(schema.properties).map(([k, v]) => [k, toStrictJsonSchema(v)]),
    );
    out.required = Object.keys(schema.properties);
    out.additionalProperties = false;
  } else if (schema.type === 'array') {
    out.items = toStrictJsonSchema(schema.items);
  }
  return out;
}

/** Throws with a tool-appropriate message if the configured LLM provider can't run a tool call. */
export function requireConfiguredProvider() {
  const provider = config.llm.provider;
  if (provider === 'gemini' && !config.llm.gemini.apiKey) {
    throw new Error('LLM_PROVIDER=gemini requires GEMINI_API_KEY.');
  }
  if (provider === 'openrouter' && !config.llm.openRouter.apiKey) {
    throw new Error('LLM_PROVIDER=openrouter requires OPENROUTER_API_KEY.');
  }
  if (provider !== 'gemini' && provider !== 'openrouter') {
    throw new Error(`Need LLM_PROVIDER=gemini or openrouter (got "${provider}").`);
  }
  return provider;
}

async function callGemini(prompt, schema) {
  const ai = new GoogleGenAI({ apiKey: config.llm.gemini.apiKey });
  const res = await ai.models.generateContent({
    model: config.llm.gemini.model,
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    config: {
      temperature: 0.3,
      responseMimeType: 'application/json',
      responseSchema: toGeminiSchema(schema),
    },
  });
  return res.text;
}

async function callOpenRouter(prompt, schemaName, schema) {
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.llm.openRouter.apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://github.com/forhad-h/parlor',
      'X-Title': 'Parlor tools',
    },
    body: JSON.stringify({
      model: config.llm.openRouter.model,
      temperature: 0.3,
      messages: [{ role: 'user', content: prompt }],
      response_format: {
        type: 'json_schema',
        json_schema: { name: schemaName, strict: true, schema: toStrictJsonSchema(schema) },
      },
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`OpenRouter HTTP ${res.status}: ${detail.slice(0, 300)}`);
  }
  const data = await res.json();
  return data?.choices?.[0]?.message?.content;
}

/**
 * @param {{prompt: string, schemaName: string, schema: object}} args  `schema` is
 *   a plain JSON Schema object (lowercase `type`s), converted per-provider internally.
 * @returns {Promise<object>} the parsed JSON response
 */
export async function generateJson({ prompt, schemaName, schema }) {
  const provider = requireConfiguredProvider();
  const raw =
    provider === 'gemini' ? await callGemini(prompt, schema) : await callOpenRouter(prompt, schemaName, schema);
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`Could not parse ${provider} JSON response:\n${raw}`);
  }
}

export function llmProvider() {
  return config.llm.provider;
}
