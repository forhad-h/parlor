# Parlor Bengali service (`service/`)

## Highlights

- Built a Bengali voice+vision AI assistant sidecar (Node/Express) that layers
  hosted LLM+TTS onto an existing Python/WebSocket app with **zero breaking
  changes** to the wire protocol — the browser's WS frames are byte-for-byte
  identical whether the backend is on-device or hosted.
- Designed a provider-agnostic **strategy pattern** for LLM (Gemini ·
  OpenRouter · mock) and TTS, swappable via a single env var — no code
  changes to switch providers.
- Implemented **NDJSON streaming** for progressive audio playback across a
  process boundary, cutting time-to-first-audio ~18% (more on longer
  replies), with real cross-process cancellation on barge-in.
- Added **defense-in-depth safety**: an always-on prompt-level refusal layer,
  plus input prompt-injection detection and output safety scoring — both
  gated behind a single `log`/`block` mode switch for measured rollout.
- Built resilience into every provider call: bounded retry + backoff +
  per-attempt timeout, enforced rate limiting, request size caps, and
  structured per-turn cost/latency logging.
- Wrote an **adversarial AI QA pass** (native-reviewer persona) that audits
  shipped Bengali strings for unnatural phrasing before release.

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
   ├─ log/                 durable event persistence (today: flagged safety events)
   ├─ util/audio.js        MP3 → PCM16 transcode + resample
   └─ routes/converse.js   orchestration → NDJSON event stream
   │  200 application/x-ndjson (NDJSON), one JSON object per line, in playback order:
   │    {type:text} · {type:audio_start} · {type:audio_chunk}×N · {type:done}   (or {type:error})
   ▼
Python relays each event into the existing WS frames as it arrives → progressive audio
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
LLM_PROVIDER=openrouter OPENROUTER_MODEL=google/gemini-3-flash-preview npm start

# Dial up to Google's frontier reasoning tier (same family, still audio+JSON-schema
# capable, ~4x the per-token cost of the flash-preview default):
LLM_PROVIDER=openrouter OPENROUTER_MODEL=google/gemini-3.1-pro-preview npm start
```

> OpenRouter caveat: audio-input support and reliable JSON-schema-constrained
> output (`response_format: json_schema`, `strict: true`) vary by the routed
> model — most non-Google models on OpenRouter (e.g.
> `anthropic/claude-sonnet-5`, `openai/gpt-5.5`) don't accept `input_audio` at
> all and will error on the first voice turn instead of silently dropping the
> modality; as of this writing the only frontier-generation family that does
> is Google's Gemini 3.x line (plus a couple of narrower audio-only models like
> `openai/gpt-audio`). `OPENROUTER_MODEL` defaults to `google/gemini-3-flash-preview`:
> confirmed to accept audio + image + strict JSON-schema output in one request,
> and Gemini's Bengali output reads more natural than GPT's in this app's
> testing. Check a model's input modalities on
> [openrouter.ai/models](https://openrouter.ai/models) before swapping to
> something else.

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
- **Native audio input to the LLM, not a separate transcribe-then-LLM pipeline.**
  An alternative architecture would run a dedicated ASR model first (e.g.
  Whisper) to get a Bengali transcript, then send that text to the LLM —
  decoupling "hearing" from "understanding." We didn't choose that, for a few
  reasons specific to this app:
  - **Extra network hop, extra latency, extra failure mode.** Every voice turn
    would need two provider round-trips (ASR, then LLM) instead of one, adding
    a full request's latency and a second point where a flaky free-tier API
    can fail the turn — directly working against the streaming/latency work
    described above.
  - **Loses cross-modal grounding.** The multimodal request already carries
    audio *and* the current camera frame in the same call, so the model can
    resolve references like "what is this" against what it's hearing and
    seeing at once. A standalone ASR step only ever sees audio — it has no way
    to let the image disambiguate the transcript (e.g. an ambiguous word that
    the visual context would resolve), and image + transcript would only meet
    downstream in the second (LLM) call.
  - **The transcript is a side effect we already need, not a separate goal.**
    `{transcription, response}` — see the JSON-structured-output bullet above —
    is produced by the same call that generates the reply, at no extra cost;
    a standalone ASR step would duplicate work the LLM call does for free.
  - **Where a separate ASR step *would* win — and doesn't apply here.** A
    dedicated ASR model can outperform a multimodal LLM's transcription
    on accuracy for noisy audio or low-resource-language speech recognition
    specifically, since that's its one job rather than a byproduct of a
    generation call. If Bengali transcription quality (not reply quality)
    becomes the bottleneck — e.g. `unsafe content flagged`- or
    review-driven evidence that the model mishears rather than misresponds —
    revisit this with a real ASR provider slotted in ahead of the LLM call,
    behind its own strategy interface the same way `llm/` and `tts/` are.
- **Bengali-aware sentence splitting.** The original regex only breaks on
  `.?!`; Bengali's sentence terminator is the danda `।`. Without handling it a
  whole Bengali reply arrives as one chunk and the perceived-streaming UX
  collapses. See `text/sentenceSplit.js`.
- **Streaming `/converse` (progressive audio across the network hop).**
  `converse.js` streams the turn back as **NDJSON** (newline-delimited JSON,
  media type `application/x-ndjson` — the same line-per-object shape the
  durable log's JSONL uses, but named NDJSON here since it's a live stream
  rather than an on-disk log) — one event per line
  (`text` → `audio_start` → `audio_chunk`×N → `done`) — instead of buffering a
  single JSON payload, and `server.py` relays each event into the browser WS
  frames *as it arrives*. So the first sentence plays while later ones are still
  synthesizing. (The browser already played each `audio_chunk` on arrival; the
  only barrier was server-side — Node's `Promise.allSettled` waiting for the
  slowest sentence, then Python's `resp.json()` waiting for the whole body.) The
  per-sentence TTS still fans out concurrently, but the promises are drained
  **in sentence order** so audio is emitted gaplessly and in-order; a failed
  sentence is dropped while the surviving `index` stays gapless.
  - **Measured benefit:** in a 3-sentence localhost turn, first audio reaches the
    browser **~0.15 s (~18%) sooner**. The saving equals
    `slowest_sentence_TTS − first_sentence_TTS` (the "wait for the slowest
    sentence" barrier; the Python↔Node transfer term is ~0 on localhost), so it
    **grows with reply length and sentence-length variance** — roughly
    **0.3–0.6 s** earlier first-audio for typical multi-sentence Bengali replies,
    and it also just *feels* more alive (audio trickles in vs. a silent pause
    then a block).
  - **Ceiling (honest):** the LLM leg is still one non-streamed call, so this
    shaves the TTS barrier, **not** the ~1–2 s LLM latency — first audio can't
    start until the full reply text exists. Streaming the LLM itself
    (token → sentence-boundary → TTS) is the next lever and a larger change,
    since it fights the JSON-schema-constrained `{transcription, response}`
    output.
  - **Cancellation bonus:** on barge-in `server.py` stops reading and closes the
    stream, which Node detects (`res.on('close')`) and uses to stop synthesizing
    the rest of the turn — real cross-process cancellation, versus the old
    fire-and-forget request that ran to completion and was discarded.
  - **Error path splits by timing:** a failure *before* the stream opens still
    returns a normal non-200 JSON with a Bengali apology; *mid-stream* (headers
    already sent) it arrives as a `{type:error, bengaliMessage}` event instead.
- **MP3 → PCM16 transcode is load-bearing.** The browser decodes each
  `audio_chunk` as raw PCM16 at the `audio_start` sample rate. This build of
  `msedge-tts` only emits compressed audio, so `util/audio.js` decodes MP3 to
  24 kHz PCM16 (pure-WASM, no system ffmpeg). Skipping it breaks playback
  silently. *(Plan note: the plan hoped Edge could emit raw PCM directly; the
  library couldn't, so the predicted transcode step is real — and lives here.)*
- **`log/` is named for the mechanism, not its first caller.** It started as a
  safety-specific event log, but an append-only, rotated, swappable-storage
  writer isn't actually a safety concept — safety just happens to be the only
  thing writing to it today. Each entry carries a `type` discriminator, so a
  new kind of durable event is a new `type` value at the call site
  (`recordDurableEvent`), with no change to the interface itself.
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

## Quality

### Automated Bengali review

`npm run review:bengali` runs a second, adversarial AI pass (native-reviewer
persona) over both string files and prints a structured report of any stiff or
literal phrasing — natural, non-robotic Bengali is the named quality bar. Run it
once before shipping; fixes are one-line edits to the source string files.

### Manual QA notes: `google/gemini-3-flash-preview` (2026-07-08)

Hand-tested over voice, mixing English and Turkish input with a Bengali-only
reply target (e.g. an English question about *Kitabullah*; Turkish `Bu ne?`
and `Teşekkür ederim, Görüşmek üzere`). See [Swapping
providers](#swapping-providers) for how this model is selected.

**Strengths**

- Understands multiple input languages, transcribes, and replies in Bengali
  only — confirmed with English and Turkish input in the same session.
- Robust to background noise — noise present during capture didn't visibly
  affect reply quality.
- Held the safety line — did not generate unsafe content under testing.

**Limitations**

- TTS pronunciation (Edge, downstream of the LLM's Bengali text) is close to
  natural but still mispronounces some words, Arabic terms in particular.
- TTS occasionally fails to play in the browser even though the backend log
  shows chunks sent correctly — points at a client-side playback issue, not
  the provider.
- Audio input is sometimes only partially captured — most noticeable with a
  longer mid-sentence pause or a low speaking volume.

## Resilience & observability

- **Bounded retry + backoff + per-attempt timeout** around every provider call
  (`util/retry.js`) — free tiers are flaky; one blip shouldn't kill a turn. Each
  attempt races against a hard timeout rather than trusting the provider SDK's
  `AbortSignal` alone, since not every SDK honours it reliably — the timeout is
  what actually bounds a hung attempt.
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
  - The flagged-event log lines above are also durably persisted by
    `log/index.js` — a strategy interface (mirroring `llm/`/`tts/`) with a
    `none` (no-op) and `file` (JSONL, size-based rotation) provider. This
    exists because stdout alone isn't captured anywhere by default, and the
    log-first strategy above only works if the data
    survives to actually measure false-positive rates from. Not a
    crucial-path feature yet, so the provider choice and rotation/retention
    knobs are constants in `config.js` rather than env vars — see
    `log/fileProvider.js` for the rotation scheme and its known
    ephemeral-filesystem limitation.

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
│   ├── log/                   durable event persistence (strategy) · none · file — not the stdout logger, see logging/ below
│   ├── prompts/bengali.js     LLM strings — single source of truth
│   ├── text/sentenceSplit.js  Bengali-aware chunking
│   ├── session/history.js     per-session text history (in-memory)
│   ├── middleware/            rateLimit (enforced) · promptInjectionGuard (detects; gated by SAFETY_MODE)
│   ├── logging/logger.js      ephemeral structured JSON logs → stdout/stderr (not persisted; see log/ above)
│   └── util/                  audio (transcode/resample) · cache · retry
├── tools/bengaliReview.js     pre-submission Bengali QA pass
└── test/                      sentenceSplit · prompts · audio · cache
```

## Future improvements

- Move session history and caches to Redis for horizontal scale.
- Add providers behind the existing interfaces (e.g. Groq LLM, Google Cloud /
  ElevenLabs TTS) — additive, no call-site changes.
- Add a durable-store `log` provider (e.g. object storage) for
  deployments on ephemeral filesystems, where the `file` provider's data
  doesn't survive a redeploy or restart — same additive shape as any other
  provider swap.
- Stream the **LLM** leg too (token → sentence-boundary → TTS), so the first
  sentence's audio can start before the whole reply text is generated — the one
  latency lever the current TTS-only streaming (see Design decisions) leaves on
  the table. Everything downstream is already progressive (server.py relays the
  NDJSON line-by-line; the browser schedules chunks gaplessly), so the LLM call
  is the last remaining buffer.
  - *Benefit:* cuts perceived time-to-first-audio to `first-sentence` +
    first-sentence TTS instead of `full reply` + first-sentence TTS (~1.5–2.5s
    on a 6-sentence reply) — the metric that dominates conversational feel.
    Bonus: the LLM leg becomes cancellable on barge-in (today it always runs to
    completion and the turn is written to history before an interrupt is known).
    The win is *bounded* to the first-sentence head start, since sentences 2..N
    already overlap playback.
  - *Cost/risk:* it fights the JSON-schema-constrained `{transcription,
    response}` output the turn relies on — a token stream is a growing JSON
    document, so each provider must incrementally parse the `response` string
    out of partial JSON (the main new complexity). The bigger risk is the
    **safety gate**: output safety currently runs on the *complete* reply before
    any audio is emitted, so streaming could speak sentence 1 before the safety
    signal resolves — preserving that guarantee (hold sentence 1 until safety
    resolves, or a streaming-safe classifier) is a precondition, not an
    afterthought. Audio-only scope needs no WS-contract change; streaming the
    reply *text* to the UI would (the `text` frame is single-shot today).
- Enforce safety: once the `possible prompt-injection flagged` / `unsafe
  content flagged` logs show an acceptable false-positive rate on real Bengali
  traffic, flip `SAFETY_MODE=block` (both block paths are already wired). Also
  add the moderation checks intentionally left out of this scope (profanity
  filter, content classification, etc.) — the regex heuristic is a stand-in,
  not a real classifier. A cross-provider moderation classifier could then give
  OpenRouter the native-safety signal it currently lacks.
