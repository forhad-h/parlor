/**
 * POST /converse — the one endpoint server.py calls per turn.
 *
 * Orchestration only: no prompt text, no provider specifics, no audio math live
 * here. It sequences LLM → sentence-split → concurrent TTS, threads per-session
 * history, emits one structured cost/latency log line, and *streams* the turn
 * back as NDJSON (one JSON object per line) so server.py can relay each event
 * into the *unchanged* browser WS frames (text → audio_start → audio_chunk* →
 * audio_end) as soon as it arrives. The LLM reply is complete before the stream
 * opens; what streams is the per-sentence TTS, so the first sentence reaches the
 * user while later ones are still synthesizing — progressive playback across the
 * network hop.
 *
 * Request:  { sessionId, text?, audioBase64?, imageBase64? }
 * Response (NDJSON stream — newline-delimited JSON, in order):
 *   { type:'text', transcription, responseText, llmMs }
 *   { type:'audio_start', sampleRate, sentenceCount }
 *   { type:'audio_chunk', index, audioBase64 }   (× N, in playback order)
 *   { type:'error', bengaliMessage }             (only on a mid-stream failure)
 *   { type:'done', ttsMs }
 * Pre-stream failures (before any bytes are written) still return a normal
 * non-200 JSON error via the central error handler.
 */

import { Router } from 'express';
import { generateReply, llmProviderName } from '../llm/index.js';
import { synthesizeSentence, ttsProviderName, outputSampleRate } from '../tts/index.js';
import { splitSentences } from '../text/sentenceSplit.js';
import { getHistory, appendTurn } from '../session/history.js';
import { SAFE_REFUSAL } from '../prompts/bengali.js';
import { BENGALI_ERROR_MESSAGE } from '../errors.js';
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

  // If server.py disconnects mid-turn (the user barged in), stop the work in
  // progress instead of finishing a turn nobody will hear — the streaming
  // equivalent of real cross-process cancellation.
  let clientGone = false;
  res.on('close', () => {
    clientGone = true;
  });

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

    // ── TTS leg (concurrent per sentence, Bengali-aware split), streamed ──
    const sentences = splitSentences(responseForTurn);

    // The user already barged in before we could open the stream — don't bother.
    if (clientGone) return;

    res.writeHead(200, {
      // NDJSON: the same line-delimited JSON shape the durable log's JSONL
      // uses, streamed live instead of written to disk.
      'Content-Type': 'application/x-ndjson',
      'Cache-Control': 'no-cache',
      // Defeat proxy response buffering so each event flushes as it's written.
      'X-Accel-Buffering': 'no',
    });
    const send = (event) => res.write(`${JSON.stringify(event)}\n`);

    send({ type: 'text', transcription: transcription ?? null, responseText: responseForTurn, llmMs });
    send({ type: 'audio_start', sampleRate: outputSampleRate(), sentenceCount: sentences.length });

    // Fan the per-sentence TTS out concurrently (all provider calls in flight at
    // once), but drain the promises in sentence order so audio is *emitted* in
    // playback order for a gapless run. Each promise is wrapped so an early
    // rejection can't surface as an unhandled rejection while we're still
    // awaiting an earlier sentence.
    const pending = sentences.map((s) =>
      synthesizeSentence(s).then(
        (value) => ({ ok: true, value }),
        (reason) => ({ ok: false, reason }),
      ),
    );

    const t1 = Date.now();
    let emitted = 0; // index over *surviving* chunks — stays gapless past a failed sentence
    let ttsCachedCount = 0;
    let ttsFailures = 0;
    for (let i = 0; i < pending.length; i++) {
      if (clientGone) break;
      const result = await pending[i];
      if (clientGone) break;
      if (result.ok) {
        if (result.value.cached) ttsCachedCount += 1;
        send({ type: 'audio_chunk', index: emitted, audioBase64: result.value.audioBase64 });
        emitted += 1;
      } else {
        // Drop the failed sentence and keep going; surviving chunks stay gapless
        // because `emitted` only advances on success.
        ttsFailures += 1;
        logger.warn('tts sentence failed (skipped)', {
          sessionId: sessionId ?? null,
          sentenceIndex: i,
          error: String(result.reason?.message ?? result.reason),
        });
      }
    }
    const ttsMs = Date.now() - t1;

    if (!clientGone) {
      send({ type: 'done', ttsMs });
      res.end();
    }

    logger.info('converse', {
      sessionId: sessionId ?? null,
      llmProvider: llmProviderName(),
      ttsProvider: ttsProviderName(),
      promptTokens: usage?.promptTokens ?? null,
      completionTokens: usage?.completionTokens ?? null,
      llmLatencyMs: llmMs,
      ttsLatencyMs: ttsMs,
      sentences: sentences.length,
      chunks: emitted,
      ttsFailures,
      ttsCachedCount,
      promptInjectionFlagged: !!injection?.flagged,
      inputBlocked,
      safetyFlagged: !!safety?.flagged,
      totalMs: Date.now() - startedAt,
      clientGone,
    });

    // Off unless LOG_TURNS is set. Durably persist the *full* turn (input +
    // spoken response text, not just the metrics the stdout line above carries)
    // so the offline output-quality gate (tools/reviewTurns.js) has real
    // manual-testing data to review. Same fire-and-forget durable sink as the
    // safety events above — no added tail latency.
    if (config.logTurns) {
      recordDurableEvent({
        type: 'turn_metric',
        sessionId: sessionId ?? null,
        llmProvider: llmProviderName(),
        input: transcription ?? text ?? '',
        responseText: responseForTurn, // what was actually spoken (post-safety substitution)
        llmMs,
        ttsMs,
        promptTokens: usage?.promptTokens ?? null,
        completionTokens: usage?.completionTokens ?? null,
      });
    }
  } catch (err) {
    // Pre-stream failures (nothing written yet) go to the central error handler,
    // which returns a structured non-200 JSON carrying a Bengali apology. Once
    // the stream is open the status/headers are already sent, so surface the
    // failure as an in-band error event and close instead.
    if (res.headersSent) {
      logger.error('converse stream failed mid-turn', {
        sessionId: sessionId ?? null,
        error: err?.message ?? String(err),
      });
      try {
        res.write(`${JSON.stringify({ type: 'error', bengaliMessage: BENGALI_ERROR_MESSAGE })}\n`);
        res.end();
      } catch {
        // client already gone; nothing to flush
      }
      return;
    }
    next(err);
  }
});
