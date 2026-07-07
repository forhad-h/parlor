# Parlor Bengali service (`service/`)

A Node sidecar that gives Parlor a **Bengali voice + vision brain**. `server.py`
calls into it over HTTP for the two "brain" operations — understanding
(LLM) and speech (TTS) — and relays the result to the browser over the
**existing, unchanged** WebSocket contract.

The browser never talks to this service directly.

```
Browser (index.html, unchanged WS protocol)
   │  WS /ws  { text | audio(b64 wav) | image(b64 jpeg) | interrupt }
   ▼
Python server.py  (thin relay in hosted mode)
   │  HTTP POST /converse  { sessionId, text?, audioBase64?, imageBase64? }
   ▼
Node service/  ← you are here
   ├─ prompts/bengali.js   Bengali system prompt + modality strings + response schema
   ├─ llm/                 provider-agnostic LLM (Gemini · OpenRouter · mock)
   ├─ text/sentenceSplit   Bengali-aware sentence chunking (danda ।)
   ├─ tts/                 hosted TTS (Edge neural voices) → PCM16
   ├─ util/audio.js        MP3 → PCM16 transcode + resample
   └─ routes/converse.js   orchestration → one JSON payload
   │  200 { transcription, responseText, sampleRate, chunks:[{index,audioBase64}], timings }
   ▼
Python relays into the existing WS frames → browser plays audio exactly as before
```

## Quick start

```bash
cd service
npm install
cp .env.example .env      # then add your GEMINI_API_KEY

npm start                 # http://localhost:3001, GET /health
# or: npm run dev         # auto-restart on change
```

Then run the Python server (see the repo root README) — hosted/Bengali mode
is the default, so it routes to this service with no extra flags:

```bash
cd ../src
uv run server.py
```

### Run it with no API key

The `mock` LLM provider returns canned Bengali, so the **whole app runs
end-to-end with zero credentials** (real Edge TTS still speaks):

```bash
LLM_PROVIDER=mock npm start
```

## Configuration

Everything is env-driven and read once in `src/config.js`, which **fails fast at
startup** if the selected provider is missing its key. See `.env.example` for the
full annotated list. The essentials:

| Variable         | Default                 | Notes                                              |
| ---------------- | ----------------------- | -------------------------------------------------- |
| `LLM_PROVIDER`   | `gemini`                | `gemini` · `openrouter` · `mock`                   |
| `GEMINI_API_KEY` | —                       | free at <https://aistudio.google.com/apikey>        |
| `GEMINI_MODEL`   | `gemini-2.5-flash`      | native audio + image input, JSON-schema output     |
| `TTS_PROVIDER`   | `edge`                  | Microsoft Edge neural voices, free/no signup       |
| `TTS_VOICE`      | `bn-BD-NabanitaNeural`  | also `bn-BD-PradeepNeural`, `bn-IN-TanishaaNeural`, `bn-IN-BashkarNeural` |
| `CACHE_TTS`      | `true`                  | deterministic TTS cache (latency + quota saver)    |

### Swapping providers

Both LLM and TTS use a **strategy interface** (`llm/index.js`, `tts/index.js`):
one method, one file per provider, selected by env. Swapping is a config change,
never a code change:

```bash
# Route through OpenRouter instead of calling Gemini directly:
LLM_PROVIDER=openrouter OPENROUTER_MODEL=google/gemini-2.5-flash npm start

# Dial up to a stronger paid model (same provider family, still audio+JSON-schema capable):
LLM_PROVIDER=openrouter OPENROUTER_MODEL=google/gemini-2.5-pro npm start
```

> OpenRouter caveat: audio-input support and reliable JSON-schema-constrained
> output (`response_format: json_schema`, `strict: true`) vary by the routed
> model — most non-Google models on OpenRouter (e.g.
> `anthropic/claude-3.5-sonnet`) don't accept `input_audio` at all and will
> error on the first voice turn instead of silently dropping the modality.
> `OPENROUTER_MODEL` defaults to `google/gemini-2.5-flash`: it's confirmed to
> accept audio + image + strict JSON-schema output in one request, and Gemini's
> Bengali output reads more natural than GPT's in this app's testing. Check a
> model's input modalities on [openrouter.ai/models](https://openrouter.ai/models)
> before swapping to something else.

## Design decisions

- **Why a sidecar, not replacing `/ws`.** The browser's VAD, barge-in, and audio
  playback already work. Reimplementing the WebSocket layer in Node would spread
  new code across low-value plumbing and risk regressions. Instead Python's edit
  surface stays small and every *semantically new* piece — Bengali prompting,
  hosted function-calling, sentence chunking, TTS, audio transcode, logging,
  caching, validation — lives here in Node.
- **JSON structured output, not forced tool-calling.** The original on-device
  `litert_lm` engine only exposed function-calling, so the first hosted port
  emulated its `respond_to_user(transcription, response)` contract with a forced
  tool call (Gemini `ANY` mode / OpenRouter `tool_choice`) restricted to that
  one function. But nothing here ever used *tool* semantics — `routes/converse.js`
  only reads `{transcription, responseText}` off the result regardless of how
  it's produced, and the realistic model set is narrow (only Google/Gemini
  models reliably accept audio on OpenRouter — see the caveat above). Both
  providers support a more direct mechanism for exactly this: native
  JSON-schema-constrained output (`responseMimeType`/`responseSchema` on Gemini,
  `response_format: {type:'json_schema', strict:true}` on OpenRouter), with no
  fake function in the way. Config-level constraint still isn't trusted alone —
  OpenRouter routes to arbitrary models and not all honour `strict` schema
  output — so `prompts/bengali.js` also states the JSON rule in the system
  prompt and repeats it as a per-turn reminder (`JSON_FORMAT_REMINDER`), the
  same prompt-level fail-safe pattern as before, just backing a different
  mechanism. Both providers still fall back to plain-text output (and tolerate a
  stray ```` ```json ```` fence, via `text/parseJsonObject.js`) if parsing fails,
  rather than hanging the turn.
- **Bengali-aware sentence splitting.** The original regex only breaks on
  `.?!`; Bengali's sentence terminator is the danda `।`. Without handling it a
  whole Bengali reply arrives as one chunk and the perceived-streaming UX
  collapses. See `text/sentenceSplit.js`.
- **MP3 → PCM16 transcode is load-bearing.** The browser decodes each
  `audio_chunk` as raw PCM16 at the `audio_start` sample rate. This build of
  `msedge-tts` only emits compressed audio, so `util/audio.js` decodes MP3 to
  24 kHz PCM16 (pure-WASM, no system ffmpeg). Skipping it breaks playback
  silently. *(Plan note: the plan hoped Edge could emit raw PCM directly; the
  library couldn't, so the predicted transcode step is real — and lives here.)*
- **Text-only session history.** History stores the user's transcription and the
  assistant's reply as text, not the raw audio/image blobs — light, coherent
  multi-turn context without re-uploading megabytes. In-memory is sufficient at
  this scale; a real deployment would move it to Redis (interface in
  `session/history.js`).
- **Caching.** Identical Bengali sentences recur and Edge output is
  deterministic, so the TTS cache (`util/cache.js`, LRU+TTL) cuts both latency
  and provider quota.

## Where the user-facing language lives

Two single-source-of-truth files, deliberately isolated from logic:

- **`src/prompts/bengali.js`** — everything the *LLM* sees: system prompt, the
  four per-modality instruction strings, and the response schema.
- **`../src/strings.bn.js`** (paired with `../src/strings.en.js` for on-device
  mode) — everything the *browser* shows. It lives beside `index.html` (not
  here) because it's served to the browser by Python, not by this Node
  service. Before this fork, `server.py` had exactly one route (`/`, returning
  `index.html`) and served no other files. This fork added a second route,
  `/strings.js`, that reads whichever of the two files matches the run mode
  and returns it — the smallest change that lets the same `index.html` work
  in both languages without duplicating it.

Change tone or wording in one place, not scattered call sites.

## Quality: the Bengali QA pass

`npm run review:bengali` runs a second, adversarial AI pass (native-reviewer
persona) over both string files and prints a structured report of any stiff or
literal phrasing — natural, non-robotic Bengali is the named quality bar. Run it
once before shipping; fixes are one-line edits to the source string files.

## Resilience & observability

- **Bounded retry + backoff + per-attempt timeout** around every provider call
  (`util/retry.js`) — free tiers are flaky; one blip shouldn't kill a turn.
- **Graceful failure.** A hard provider failure returns a structured 502 with a
  ready-to-speak Bengali apology (`errors.js`); `server.py` speaks it over the
  existing `text` frame instead of hanging the socket.
- **One structured log line per turn** — `{sessionId, llmProvider, ttsProvider,
  promptTokens, completionTokens, llmLatencyMs, ttsLatencyMs, chunks, cached...}`
  — the cost/latency visibility to reason about spend.
- **`/health`** reports providers, uptime, and cache stats.

## Validation (scoped)

- **Hard size cap** via `express.json({ limit })` — oversized audio/image → 413.
- **Rate limit** (`middleware/rateLimit.js`) is **enforced**: 30 requests per
  60s window (per `sessionId`, falling back to client IP), rejecting with
  `429` + `Retry-After` past the threshold. The threshold has enough headroom
  that normal demo/grading usage never comes close to it — this is real
  cost/rate-limit control on the paid LLM/TTS providers, not just a log line.
- **Safety** has a primary layer plus two secondary layers sharing one knob,
  `SAFETY_MODE` (default `log`). The **primary** layer is a prompt-level safety
  rule in `prompts/bengali.js` (the model refusing in-language — low
  false-positive, and the only safety layer OpenRouter gets, since it has no
  native safety passthrough) — this is always on, in both modes, regardless of
  `SAFETY_MODE`.
  - **Input side**: `middleware/promptInjectionGuard.js` is keyword/regex
    matching, so it only *detects* and attaches `req.promptInjection` — it
    never blocks itself, since blocking on a heuristic false positive would
    kill a legitimate turn with no graceful reply. `converse.js` reads the
    flag: in `log` mode it just logs `possible prompt-injection flagged`; in
    `block` mode it skips the LLM call entirely and speaks `SAFE_REFUSAL`
    instead, so a blocked turn still returns a normal (if canned) audio
    response rather than breaking the wire contract.
  - **Output side**: Gemini's native `safetySettings`, wired at a non-cutting
    threshold (`BLOCK_NONE`) so it never breaks a turn: it's read for its
    `safetyRatings` and, when a category rates MEDIUM+, `converse.js` logs
    `unsafe content flagged`. In `block` mode it swaps `SAFE_REFUSAL` in for
    the flagged reply. Blocking lives in `converse.js`, **not** in the Gemini
    threshold: a native block empties the response and breaks the
    JSON-per-turn contract. OpenRouter has no native safety passthrough (its
    API exposes only Anthropic beta headers), so it only has the primary layer.
  - Both signals default to log-only for the same reason: they're
    weaker/less-calibrated on Bengali than the prompt rule, so we measure real
    false-positive rates from logs before ever letting either one block a
    genuine turn.

## Testing

```bash
npm test    # node:test, no deps
```

Targeted units where logic actually lives: Bengali sentence splitting, prompt
shape, audio math (PCM conversion/resample), and cache LRU/TTL. Not a full e2e
suite — that's out of scope for this exercise.

## Project layout

```
service/
├── src/
│   ├── index.js               Express bootstrap, /health, central error handler
│   ├── config.js              env-driven config, fail-fast validation
│   ├── errors.js              ProviderError + Bengali fallback message
│   ├── routes/converse.js     POST /converse orchestration (thin)
│   ├── llm/                   index (strategy) · gemini · openRouter · mock
│   ├── tts/                   index (strategy) · edgeTtsProvider
│   ├── prompts/bengali.js     LLM strings — single source of truth
│   ├── text/sentenceSplit.js  Bengali-aware chunking
│   ├── session/history.js     per-session text history (in-memory)
│   ├── middleware/            rateLimit (enforced) · promptInjectionGuard (detects; gated by SAFETY_MODE)
│   ├── logging/logger.js      structured JSON logs
│   └── util/                  audio (transcode/resample) · cache · retry
├── tools/bengaliReview.js     pre-submission Bengali QA pass
└── test/                      sentenceSplit · prompts · audio · cache
```

## Future improvements

- Move session history and caches to Redis for horizontal scale.
- Add providers behind the existing interfaces (e.g. Groq LLM, Google Cloud /
  ElevenLabs TTS) — additive, no call-site changes.
- Streaming `/converse` (Server-Sent Events) so the browser gets sentence audio
  as each finishes, restoring true progressive playback across the network hop.
- Enforce safety: once the `possible prompt-injection flagged` / `unsafe
  content flagged` logs show an acceptable false-positive rate on real Bengali
  traffic, flip `SAFETY_MODE=block` (both block paths are already wired). Also
  add the moderation checks intentionally left out of this scope (profanity
  filter, content classification, etc.) — the regex heuristic is a stand-in,
  not a real classifier. A cross-provider moderation classifier could then give
  OpenRouter the native-safety signal it currently lacks.
