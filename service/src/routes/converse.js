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
import { logger } from '../logging/logger.js';

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
    // ── LLM leg ──────────────────────────────────────────────────────────
    const history = getHistory(sessionId);
    const t0 = Date.now();
    const { transcription, responseText, usage } = await generateReply({
      history,
      text,
      audioBase64,
      imageBase64,
    });
    const llmMs = Date.now() - t0;

    // Persist text-only history so the next turn has conversational context.
    appendTurn(sessionId, { userText: transcription ?? text ?? '', modelText: responseText });

    // ── TTS leg (concurrent per sentence, Bengali-aware split) ───────────
    const sentences = splitSentences(responseText);
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
      totalMs: Date.now() - startedAt,
    });

    res.json({
      transcription: transcription ?? null,
      responseText,
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
