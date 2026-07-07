/**
 * Parlor Bengali service — HTTP bootstrap.
 *
 * A backend sidecar that server.py calls into for the two "brain" operations
 * (LLM + TTS). The browser never talks to this directly; the WebSocket contract
 * to the browser is preserved byte-for-byte by server.py.
 */

import express from 'express';
import { config, validate } from './config.js';
import { logger } from './logging/logger.js';
import { rateLimit } from './middleware/rateLimit.js';
import { promptInjectionGuard } from './middleware/promptInjectionGuard.js';
import { converseRouter } from './routes/converse.js';
import { llmProviderName } from './llm/index.js';
import { ttsProviderName, ttsCacheStats } from './tts/index.js';
import { ensureDurableLogReady, durableLogProviderName } from './log/index.js';
import { ProviderError, BENGALI_ERROR_MESSAGE } from './errors.js';

// Fail fast: refuse to start with a misconfigured/keyless selected provider.
// Print just the actionable message — a config typo shouldn't dump a stack.
try {
  validate();
} catch (err) {
  logger.error('startup aborted', { reason: err.message });
  process.stderr.write(`\n${err.message}\n\n`);
  process.exit(1);
}

// Built eagerly (not lazily like llm/tts) so a bad durable-log destination is
// visible here, at boot, instead of surfacing silently on the first logged event.
ensureDurableLogReady();

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: config.limits.maxRequestBytes }));

// ── Health / ops ───────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    llmProvider: llmProviderName(),
    ttsProvider: ttsProviderName(),
    durableLogProvider: durableLogProviderName(),
    uptimeSec: Math.round(process.uptime()),
    cache: { tts: ttsCacheStats() },
  });
});

// ── Application middleware + routes ─────────────────────────────────────────
app.use(rateLimit); // enforced (429 past threshold)
app.use(promptInjectionGuard); // detection-only; converse.js decides log vs block via SAFETY_MODE
app.use(converseRouter);

// 404
app.use((req, res) => res.status(404).json({ error: 'not found' }));

// ── Central error handler ────────────────────────────────────────────────────
// Turns any thrown error into a structured response. ProviderError → 502 with a
// Bengali apology server.py can speak; oversized body → 413; anything else → 500.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err?.type === 'entity.too.large') {
    logger.warn('request rejected: payload too large', {
      limitBytes: config.limits.maxRequestBytes,
    });
    return res.status(413).json({ error: 'payload too large', bengaliMessage: BENGALI_ERROR_MESSAGE });
  }

  const isProvider = err instanceof ProviderError;
  logger.error('request failed', {
    stage: err?.stage ?? null,
    provider: err?.provider ?? null,
    error: err?.message ?? String(err),
    stack: isProvider ? undefined : err?.stack,
  });

  res.status(isProvider ? 502 : 500).json({
    error: err?.message ?? 'internal error',
    stage: err?.stage ?? null,
    provider: err?.provider ?? null,
    bengaliMessage: BENGALI_ERROR_MESSAGE,
  });
});

const server = app.listen(config.port, () => {
  logger.info('parlor-service listening', {
    port: config.port,
    llmProvider: llmProviderName(),
    ttsProvider: ttsProviderName(),
    durableLogProvider: durableLogProviderName(),
    ttsVoice: config.tts.voice,
    cacheTts: config.cache.tts,
  });
});

// Graceful shutdown so an interrupted demo doesn't leave a dangling port.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    logger.info('shutting down', { signal });
    server.close(() => process.exit(0));
    // Hard-exit backstop if connections don't drain promptly.
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
