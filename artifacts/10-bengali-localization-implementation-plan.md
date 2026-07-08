# Bengali Localization — Architecture

**Purpose:** Documents the architecture behind adapting Parlor — a real-time voice + vision assistant — to fully support Bengali. Covers the system design, folder structure, and the design decisions and trade-offs behind it.

**[FACT]** = directly from source.

---

## Facts about the original codebase

- **[FACT]** Parlor is a real-time voice + vision assistant: FastAPI + WebSocket backend (`src/server.py`), on-device **Gemma 4 E2B** (via `litert_lm.Engine`) for speech/vision understanding, **Kokoro** (82M) for TTS (`src/tts.py`), and a single monolithic `src/index.html` frontend (inline CSS+JS, no separate files, no i18n framework).
- **[FACT]** WS protocol (verified against the WebSocket handler in `src/server.py` — the `receiver()` loop that parses incoming messages, and the `text`/`audio_start`/`audio_chunk`/`audio_end` emissions that follow LLM + TTS). Client → server, any combination of these keys in one JSON object:
  ```json
  {"text": "hello"}
  {"audio": "<base64 16kHz WAV>"}
  {"image": "<base64 JPEG>"}
  {"type": "interrupt"}
  ```
  Server → client, one turn = this exact sequence:
  ```json
  {"type": "text", "text": "...", "llm_time": 1.23}
  {"type": "audio_start", "sample_rate": 24000, "sentence_count": 3}
  {"type": "audio_chunk", "audio": "<base64 PCM16>", "index": 0}
  {"type": "audio_chunk", "audio": "<base64 PCM16>", "index": 1}
  {"type": "audio_end", "tts_time": 0.87}
  ```
  `transcription` is appended to the `text` message only when the forced `respond_to_user` tool call produced one — it is not always present.
- **[FACT]** System prompt (verbatim, on-device mode): *"You are a friendly, conversational AI assistant. The user is talking to you through a microphone and showing you their camera. You MUST always use the respond_to_user tool to reply. First transcribe exactly what the user said, then write your response."* A forced tool call `respond_to_user(transcription, response)` drives every reply; four hardcoded English instruction strings are appended per turn depending on which of audio/image/text is present.
- **[FACT — hard constraint]** Kokoro has **no language parameter and no Bengali voice**, on either the MLX (Mac) or ONNX (Linux) backend — the G2P pipeline (misaki/espeak-style) is English-oriented regardless of backend. Gemma 4 E2B's Bengali fluency was also unverified.
- **[FACT]** Every frontend user-facing string was a literal with zero i18n abstraction: title `Parlor`, model label `Gemma 4 E2B`, status pill `Disconnected/Connected/Processing`, state labels `Loading.../Listening/Thinking.../Speaking`, `On-device` pill, button `Camera On/Camera Off`, meta template literals (`` `LLM ${t}s` ``), `<html lang="en">`, Latin-only Google Fonts with no Bengali fallback.
- **[FACT]** These two constraints — no on-device Bengali TTS, unverified LLM Bengali fluency — are why hosted LLM and TTS APIs replace the on-device pipeline in Bengali/hosted mode.

## Architecture

Node is a backend sidecar service that `server.py` calls into for the two "brain" operations (LLM + TTS). The browser never talks to Node directly, and the WebSocket contract to the browser is preserved byte-for-byte.

```
Browser (index.html, unmodified WS contract)
   │  WS /ws  { text | audio(b64 wav) | image(b64 jpeg) | interrupt }
   ▼
Python: src/server.py  (WS accept, message parsing, audio_start/audio_chunk/audio_end
                         emission relayed from Node's stream, interrupt handling)
   │  HTTP POST /converse   { sessionId, text?, audioBase64?, imageBase64? }
   ▼
Node: service/  (LLM + TTS orchestration)
   ├─ prompts/bengali.js     → Bengali system prompt + per-modality instructions + response schema
   ├─ llm/*                  → hosted LLM call (Gemini · OpenRouter · mock), JSON-schema-constrained output
   ├─ text/sentenceSplit.js  → Bengali-aware sentence chunking (danda '।' + . ! ?)
   ├─ tts/*                  → hosted TTS per sentence, concurrent, → PCM16
   ├─ log/*                  → durable persistence of flagged safety events
   ├─ util/{audio,cache,retry}.js → MP3→PCM16 transcode, TTS caching, bounded retry/backoff
   └─ routes/converse.js     → orchestrates the above, streams one NDJSON event per line
   │  200 application/x-ndjson: {type:text} → {type:audio_start} → {type:audio_chunk}×N → {type:done}  (or {type:error})
   ▼
Python relays each event into the existing WS message shapes as it arrives → browser plays audio progressively, exactly as before
```

**Why this split, not the alternatives:**
- *Node fully replaces `/ws`* — rejected: would force reimplementing WAV/JPEG decoding and interrupt bookkeeping that already worked in `server.py`, spreading new code across low-value plumbing instead of the LLM/voice logic that actually matters.
- *Node as a thin wrapper Python barely touches* — rejected: under-delivers on demonstrating substantial JavaScript/Node engineering.
- **This design**: Python's edit surface is exactly two call-site redirects in `server.py` (the `litert_lm.Engine` call, the per-sentence TTS call), one new env var (`NODE_SERVICE_URL`), a new static-asset route (`/strings.js`), and an interrupt→stream-cancellation tweak. Every semantically new piece of logic — Bengali prompting, hosted-LLM structured output, sentence chunking, hosted TTS, audio format conversion, logging, caching, rate limiting, safety — lives in Node.

**Turn walkthrough:** mic speech ends (browser's `vad.MicVAD`) → base64 WAV over `/ws` (unchanged) → `server.py` decodes, POSTs to `/converse` with a `sessionId` → Node builds the Bengali multimodal prompt (per-session conversation history kept in-memory, mirroring the original `engine.create_conversation` statefulness) → calls the hosted LLM for a JSON-schema-constrained `{transcription, response}` object → splits `response` into Bengali-punctuation-aware sentences → runs per-sentence TTS concurrently, drained in sentence order → transcodes each to PCM16 at the `audio_start` sample rate → streams the turn back to `server.py` as NDJSON, one event per line, as each piece becomes ready → `server.py` relays each event into the existing `text`/`audio_start`/`audio_chunk`/`audio_end` WS frames as it arrives — so audio starts reaching the browser before the whole reply has finished synthesizing, and the frontend's existing playback code needs no protocol changes.

**Interrupt/barge-in:** `server.py` keeps handling `{"type":"interrupt"}` locally exactly as before. In hosted mode it now closes the in-flight NDJSON stream to Node on interrupt; Node detects this via `res.on('close')` and stops synthesizing the rest of the turn — real cross-process cancellation, not just a discarded result.

## Folder Structure

```
<fork-root>/
├── src/                          # existing Python — minimal, targeted edits
│   ├── server.py                 # two call sites redirected to Node; NODE_SERVICE_URL config; /strings.js route
│   ├── tts.py                    # kept in place, used only in on-device mode
│   ├── index.html                # lang set per mode, Bengali font, STRINGS.* lookups
│   ├── strings.en.js             # on-device/English UI strings
│   └── strings.bn.js             # hosted/Bengali UI strings — served by the /strings.js route
│
└── service/                      # Node project, sibling to src/, separate deploy unit
    ├── package.json
    ├── .env.example               # LLM_PROVIDER, TTS_PROVIDER, API keys, PORT, SAFETY_MODE, ...
    ├── src/
    │   ├── index.js               # Express bootstrap, /health, central error handler
    │   ├── config.js              # env-driven provider selection, fail-fast on missing keys
    │   ├── errors.js              # ProviderError + Bengali fallback message
    │   ├── routes/converse.js     # POST /converse orchestration (thin) — streams NDJSON
    │   ├── llm/
    │   │   ├── index.js           # provider-agnostic interface (strategy pattern)
    │   │   ├── geminiProvider.js  # default — native audio+image input, JSON-schema output
    │   │   ├── openRouterProvider.js  # alternate — swap model via OPENROUTER_MODEL
    │   │   └── mockProvider.js    # canned Bengali replies — runs the whole app with zero API keys
    │   ├── tts/
    │   │   ├── index.js
    │   │   └── edgeTtsProvider.js
    │   ├── prompts/bengali.js     # system prompt + modality strings + response schema
    │   ├── text/
    │   │   ├── sentenceSplit.js   # Bengali-aware sentence chunking
    │   │   ├── cleanText.js
    │   │   └── parseJsonObject.js # tolerates a stray ```json fence from providers
    │   ├── session/history.js     # per-session in-memory text history
    │   ├── middleware/{rateLimit.js, promptInjectionGuard.js}   # enforced rate limit; detect-only injection guard
    │   ├── log/                   # durable event persistence (strategy) — none · file (JSONL, rotation)
    │   ├── logging/logger.js      # ephemeral structured logs → stdout/stderr
    │   └── util/{audio.js, cache.js, retry.js}   # PCM16 transcode/resample, TTS cache, bounded retry
    ├── tools/bengaliReview.js     # standalone Bengali QA pass (adversarial native-reviewer persona)
    ├── test/                      # sentenceSplit, prompts, audio, cache, rateLimit, promptInjectionGuard, ...
    └── README.md                  # setup, provider-swap instructions, design decisions, trade-offs
```

**Why this structure:** `llm/index.js` and `tts/index.js` are strategy interfaces — a new provider is a new file plus one `case` in the factory, never a call-site change. `prompts/bengali.js`, isolated from routing, keeps prompt-template management separate from request handling. `routes/converse.js` stays orchestration-only, no inline business logic. `log/` (durable JSONL persistence of flagged safety events) is kept separate from `logging/logger.js` (ephemeral structured stdout logs) since the two serve different purposes — one is measurement data that must survive a restart, the other is operational visibility. `strings.bn.js`/`strings.en.js` stay inside `src/` rather than `service/` because they are Python-served static assets, not Node service code.

## Design Decisions

| # | Decision | Alternatives considered | Tradeoffs | Why this is the right call |
|---|---|---|---|---|
| a | **LLM: Google Gemini (`gemini-2.5-flash`) via an AI Studio free-tier API key, as the default provider** — plus **OpenRouter as a second, swappable provider** for dialing to a different model without touching code | OpenAI GPT-4o-mini; Groq (Llama-family) | OpenAI has no perpetual free tier. Groq's free tier is genuinely free and fast but has weaker documented Bengali fluency and less mature audio+image multimodal input. | Native multimodal input, documented Bengali support, a free tier reachable without a paid card, and reliable structured output. |
| b | **TTS: Microsoft Edge neural voices (`bn-BD`/`bn-IN`) via a free, unofficial Node client (`msedge-tts` v2+)** | Google Cloud TTS; Azure Speech; ElevenLabs | Free/no-signup but unofficial (endpoint could change) and returns compressed audio, requiring an explicit transcode-to-PCM16 step. | All three alternatives are genuinely good Bengali TTS, but none are free: Google Cloud TTS and Azure Speech both require a billing-enabled account even to reach their free quota, and ElevenLabs' free tier caps out fast and has thinner Bengali voice coverage. Edge is the one option that needs no signup, no card, and no quota to run at all — for a project meant to run end-to-end with zero cost to try, that made it the only viable default; swappable to Google Cloud TTS Neural2 via the same `tts/` strategy interface if a paid tier is ever acceptable. |
| c | **Preserve the existing WS message contract to the browser exactly** — Node never speaks WS to the browser | A new Node↔browser WS protocol; Node replacing `/ws` entirely | A new protocol would have forced a frontend WS-handling rewrite. | Frontend changes stay confined to strings/lang — no protocol rework. |
| d | **Bengali frontend strings centralized in `strings.bn.js`/`strings.en.js`**, field-for-field identical in shape, served by a new `/strings.js` route | Full i18n library (i18next); hand-translating each string in place | A full i18n framework is disproportionate for a Bengali-only, no-toggle scope. | Every string (title, status pill, state labels, camera button, `LLM ${t}s` meta template) lives in one place per language; `server.py`'s only new static-asset route picks the right file from `HOSTED_MODE`. |
| e | **Provider swap via env vars** (`LLM_PROVIDER`, `TTS_PROVIDER`), read once in `config.js`; `OPENROUTER_MODEL` swaps the underlying model when `LLM_PROVIDER=openrouter` | A runtime admin API to switch providers; hardcoding a single provider | An admin API would be over-engineered for this scope. | Keeps the strategy pattern trivial to extend; only Google/Gemini models on OpenRouter are confirmed to accept audio input and honor strict JSON-schema output reliably, so `OPENROUTER_MODEL` defaults to `google/gemini-2.5-flash`. |
| f | **Native JSON-schema-constrained output** (`responseSchema` on Gemini, `response_format: {type:'json_schema', strict:true}` on OpenRouter) drives the `{transcription, response}` shape, not forced tool-calling | Emulating the original `respond_to_user` forced tool call | Not all OpenRouter-routed models honor `strict` schema output. | Nothing downstream ever used *tool* semantics — `routes/converse.js` only reads `{transcription, responseText}` regardless of how it's produced — so the more direct mechanism removes a layer of indirection. The system prompt also states the JSON rule directly and repeats it per turn (`JSON_FORMAT_REMINDER`) as a fail-safe; `text/parseJsonObject.js` tolerates a stray ` ```json ` fence if parsing needs it. |
| g | **`/converse` streams NDJSON** (one JSON event per line: `text` → `audio_start` → `audio_chunk`×N → `done`/`error`) instead of a single buffered JSON response | A single buffered `200 JSON` response with all chunks inline | More moving parts; the error path splits into a pre-stream (normal non-200 JSON) and mid-stream (`{type:error}` event) case. | First audio reaches the browser sooner (~0.3–0.6s earlier on a typical multi-sentence reply — the "wait for the slowest sentence" barrier is removed), and gives real cross-process cancellation on barge-in via `res.on('close')`, instead of a stray in-flight call whose result is simply discarded. |
| h | **Rate limiting is enforced** (30 requests/60s per `sessionId`, else client IP; `429` + `Retry-After` past the threshold) | Log-only observability | A misconfigured threshold could theoretically reject a legitimate burst. | Real cost/rate-limit control on paid LLM/TTS providers — the threshold has enough headroom that normal usage never approaches it, but a runaway or abusive client is rejected instead of silently costing money. |
| i | **Two-tier safety, gated by one `SAFETY_MODE` knob (default `log`)**: a primary always-on prompt-level rule in `prompts/bengali.js`, plus two secondary signals — input-side heuristic (`middleware/promptInjectionGuard.js`) and output-side Gemini native `safetySettings` | A full moderation stack (profanity filter, content classifier); no secondary layer at all | Both secondary signals are heuristics/classifiers weaker on Bengali than the prompt rule. | `log` mode lets false-positive rates be measured from the durably-persisted flagged-event log (`log/`) before either signal is trusted to block a genuine turn; `block` mode is already wired for both, so enforcing is a config flip, not new code. |

## Trade-offs

| Trade-off | Current handling |
|---|---|
| Free-tier LLM/TTS rate limits or downtime | Provider is swappable via env var (decision e); bounded retry + backoff + per-attempt timeout around every provider call (`util/retry.js`); on hard failure, a structured 502 carries a ready-to-speak Bengali apology that `server.py` relays over the existing `text` frame instead of hanging the socket. |
| MP3-only TTS output vs. the browser expecting raw PCM16 | `util/audio.js` transcodes MP3 → PCM16 (pure-WASM, no system ffmpeg) and resamples to the `audio_start` sample rate before every `audio_chunk` — load-bearing, not incidental. |
| Bengali's sentence terminator (`।`, danda) differs from `. ! ?` | `text/sentenceSplit.js` splits on `।` alongside `. ! ?`; without it a full reply arrives as one chunk and the streaming UX collapses. |
| Hosted APIs add a network hop vs. the original blocking local calls | Per-sentence TTS runs concurrently and the turn streams back as NDJSON as each piece is ready (see Architecture), rather than waiting for the full reply. The LLM leg itself is still one non-streamed call — the next latency lever, deferred (see `service/README.md`'s Future improvements). |
| In-memory per-session conversation history | Sufficient at this scale; doesn't survive a restart or scale horizontally. A real deployment would move it to Redis (interface already isolated in `session/history.js`). |
| Edge TTS is an unofficial, free client | Works today with no signup, but the endpoint isn't a documented public API and could change; swappable to Google Cloud TTS Neural2 (`bn-IN`) via the same `tts/` strategy interface if it becomes unreliable. |
| OpenRouter's per-model support for audio input and strict JSON-schema output isn't uniform | Only Google/Gemini models on OpenRouter are confirmed to accept `input_audio` and honor `strict` schema output reliably; `OPENROUTER_MODEL` defaults to `google/gemini-2.5-flash` for that reason — swapping to a different model needs the same check first. |
| Safety/prompt-injection signals are heuristics, weaker on Bengali than the primary prompt-level rule | Both default to `SAFETY_MODE=log` rather than blocking, so false-positive rates on real Bengali traffic can be measured from the durably-persisted flagged-event log before either is ever allowed to block a genuine turn. |

---

*For implementation rationale, trade-offs made during development, and the AI-assisted workflow behind this build, see `service/README.md` and `AI-JOURNEY.md`.*
