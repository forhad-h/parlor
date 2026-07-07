/**
 * POST /converse — the one endpoint server.py calls per turn.
 *
 * Orchestration only: no prompt text, no provider specifics, no audio math live
 * here. It sequences LLM → sentence-split → concurrent TTS, threads per-session
 * history, emits one structured cost/latency log line, and returns a single
 * JSON payload that server.py relays into the *unchanged* browser WS frames
 * (text → audio_start → audio_chunk* → audio_end).
 *
 * Request:  { sessionId, text?, audioBase64?, imageBase64? }
 * Response: { transcription, responseText, sampleRate, chunks:[{index,audioBase64}], timings }
 */

import { Router } from 'express';
import { generateReply, llmProviderName } from '../llm/index.js';
import { synthesizeSentence, ttsProviderName, outputSampleRate } from '../tts/index.js';
import { splitSentences } from '../text/sentenceSplit.js';
import { getHistory, appendTurn } from '../session/history.js';
import { SAFE_REFUSAL } from '../prompts/bengali.js';
import { config } from '../config.js';
import { logger } from '../logging/logger.js';
import { recordDurableEvent } from '../log/index.js';

export const converseRouter = Router();

converseRouter.post('/converse', async (req, res, next) => {
  const startedAt = Date.now();
  const { sessionId, text, audioBase64, imageBase64 } = req.body ?? {};

  if (!audioBase64 && !imageBase64 && !text) {
    return res
      .status(400)
      .json({ error: 'converse requires at least one of: audioBase64, imageBase64, text' });
  }

  try {
    // ── Input-safety hook (promptInjectionGuard detects; shares SAFETY_MODE with
    //    the output-safety hook below) ─────────────────────────────────────────
    //
    // The middleware only flags — it never blocks itself, so deciding here means
    // a blocked turn still flows through TTS and comes back as a normal (if
    // canned-refusal) audio response instead of a bare early error that would
    // break the transcription/responseText/chunks wire contract. Same log-first
    // stance as the output-safety hook: it's a regex heuristic, so a false
    // positive killing a genuine turn is worse than logging a borderline one.
    const injection = req.promptInjection;
    if (injection?.flagged) {
      logger.warn('possible prompt-injection flagged', {
        sessionId: sessionId ?? null,
        hits: injection.hits,
        sample: injection.sample,
        mode: config.safety.mode,
      });
      recordDurableEvent({
        type: 'prompt_injection',
        sessionId: sessionId ?? null,
        mode: config.safety.mode,
        hits: injection.hits,
        sample: injection.sample,
      });
    }
    const inputBlocked = config.safety.mode === 'block' && injection?.flagged;

    // ── LLM leg (skipped entirely when the input is blocked) ────────────────
    let transcription = null;
    let responseText = SAFE_REFUSAL;
    let usage = null;
    let safety = null;
    let llmMs = 0;
    if (!inputBlocked) {
      const history = getHistory(sessionId);
      const t0 = Date.now();
      ({ transcription, responseText, usage, safety } = await generateReply({
        history,
        text,
        audioBase64,
        imageBase64,
      }));
      llmMs = Date.now() - t0;
    }

    // ── Output-safety hook (log-first, same SAFETY_MODE) ────────────────────
    //
    // Why this is LOG-ONLY by default (SAFETY_MODE=log):
    //   1. Gemini's `safety` here is a SEPARATE classifier, not the model's own
    //      judgment, and it's weaker/less-calibrated on Bengali — our language —
    //      so false positives are a real risk.
    //   2. It mostly rates the assistant's OWN reply, which the prompt-level
    //      safety rule (prompts/bengali.js) already keeps safe, so it should fire
    //      rarely; when it does fire on benign Bengali it's more likely a false
    //      positive than a true catch.
    //   3. Wrongly refusing a genuine Bengali turn is a worse failure than logging
    //      a borderline one (same stance as promptInjectionGuard, above). So we
    //      log to measure the real false-positive rate on live traffic first,
    //      then flip SAFETY_MODE=block once the data justifies it.
    //   4. This isn't "no protection": the prompt-level safety rule (the model
    //      deciding, in-language, low FP) is the real-time layer in BOTH modes.
    // Blocking is done HERE (speak SAFE_REFUSAL), never by tightening Gemini's
    // threshold — a native block empties the response and breaks the JSON turn.
    let responseForTurn = responseText;
    if (safety?.flagged) {
      logger.warn('unsafe content flagged', {
        sessionId: sessionId ?? null,
        provider: safety.provider,
        categories: safety.categories,
        blocked: safety.blocked,
        finishReason: safety.finishReason,
        blockReason: safety.blockReason,
        mode: config.safety.mode,
      });
      recordDurableEvent({
        type: 'unsafe_content',
        sessionId: sessionId ?? null,
        mode: config.safety.mode,
        provider: safety.provider,
        categories: safety.categories,
        blocked: safety.blocked,
        finishReason: safety.finishReason,
        blockReason: safety.blockReason,
      });
      if (config.safety.mode === 'block') {
        responseForTurn = SAFE_REFUSAL; // speak a Bengali refusal instead of the flagged reply
      }
    }

    // Persist text-only history so the next turn has conversational context.
    appendTurn(sessionId, { userText: transcription ?? text ?? '', modelText: responseForTurn });

    // ── TTS leg (concurrent per sentence, Bengali-aware split) ───────────
    const sentences = splitSentences(responseForTurn);
    const t1 = Date.now();
    const settled = await Promise.allSettled(sentences.map((s) => synthesizeSentence(s)));
    const ttsMs = Date.now() - t1;

    const chunks = [];
    let ttsCachedCount = 0;
    let ttsFailures = 0;
    settled.forEach((result, i) => {
      if (result.status === 'fulfilled') {
        // Re-index against surviving chunks so the browser plays a gapless run
        // even if a middle sentence failed.
        chunks.push({ index: chunks.length, audioBase64: result.value.audioBase64 });
        if (result.value.cached) ttsCachedCount += 1;
      } else {
        ttsFailures += 1;
        logger.warn('tts sentence failed (skipped)', {
          sessionId: sessionId ?? null,
          sentenceIndex: i,
          error: String(result.reason?.message ?? result.reason),
        });
      }
    });

    logger.info('converse', {
      sessionId: sessionId ?? null,
      llmProvider: llmProviderName(),
      ttsProvider: ttsProviderName(),
      promptTokens: usage?.promptTokens ?? null,
      completionTokens: usage?.completionTokens ?? null,
      llmLatencyMs: llmMs,
      ttsLatencyMs: ttsMs,
      sentences: sentences.length,
      chunks: chunks.length,
      ttsFailures,
      ttsCachedCount,
      promptInjectionFlagged: !!injection?.flagged,
      inputBlocked,
      safetyFlagged: !!safety?.flagged,
      totalMs: Date.now() - startedAt,
    });

    res.json({
      transcription: transcription ?? null,
      responseText: responseForTurn,
      sampleRate: outputSampleRate(),
      chunks,
      timings: { llmMs, ttsMs },
    });
  } catch (err) {
    // Hand off to the central error handler, which returns a structured error
    // carrying a Bengali apology for server.py to speak.
    next(err);
  }
});
