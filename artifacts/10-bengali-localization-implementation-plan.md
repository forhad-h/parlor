# Bengali Localization — Implementation Plan

**Purpose:** A complete, evidence-driven implementation plan for adapting Parlor — a real-time voice + vision assistant currently English-only — to fully support Bengali. Covers architecture, folder structure, design decisions, risks, a priority-ordered build sequence, implementation guidelines, and optional differentiators.

**Context this plan is written against:** Parlor is currently English-only. Its backend (Python/FastAPI) is intentionally left as-is except for two integration points — the goal is to demonstrate strong JavaScript/Node engineering in new glue/service code, plus clean navigation of an unfamiliar codebase, while producing natural, professional (not literal/robotic) Bengali throughout the product. The result must run end-to-end; it does not need to be a flawless, mergeable feature.

**Grounding note:** This plan is based on direct research of the actual repository (`github.com/fikrikarim/parlor`) — its exact WebSocket protocol, system prompt, TTS internals, and every frontend string were read and confirmed before any design decision below was made. Where a decision depends on a fact about the codebase, that fact is cited.

**[FACT]** = directly from source. **[INFERENCE]** = reasoning beyond the text.

---

# Part A — Planning Before Coding

## Confirmed facts about the codebase driving this design

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
- **[FACT]** System prompt (verbatim): *"You are a friendly, conversational AI assistant. The user is talking to you through a microphone and showing you their camera. You MUST always use the respond_to_user tool to reply. First transcribe exactly what the user said, then write your response."* A forced tool call `respond_to_user(transcription, response)` drives every reply; four hardcoded English instruction strings are appended per turn depending on which of audio/image/text is present.
- **[FACT — hard constraint]** Kokoro has **no language parameter and no Bengali voice**, on either the MLX (Mac) or ONNX (Linux) backend — the G2P pipeline (misaki/espeak-style) is English-oriented regardless of backend. **There is no configuration that makes the current TTS speak Bengali.** Gemma 4 E2B's Bengali fluency is also unverified.
- **[FACT]** Every frontend user-facing string is a literal with zero i18n abstraction: title `Parlor`, model label `Gemma 4 E2B`, status pill `Disconnected/Connected/Processing`, state labels `Loading.../Listening/Thinking.../Speaking`, `On-device` pill, button `Camera On/Camera Off`, meta template literals (`` `LLM ${t}s` ``), `<html lang="en">`, Latin-only Google Fonts with no Bengali fallback.
- **[INFERENCE]** These two facts together (no on-device Bengali TTS, unverified LLM Bengali fluency) are almost certainly *why* swapping to hosted APIs is a sensible move here — it is closer to a requirement than an option.

## High-Level Architecture

**Node is a backend sidecar service that `server.py` calls into for the two "brain" operations (LLM + TTS). The browser never talks to Node directly, and the existing WebSocket contract to the browser is preserved byte-for-byte.**

```
Browser (index.html, unmodified WS contract)
   │  WS /ws  { text | audio(b64 wav) | image(b64 jpeg) | interrupt }
   ▼
Python: src/server.py  (kept almost as-is: WS accept, message parsing,
                         audio_start/audio_chunk/audio_end emission, interrupt handling)
   │  HTTP POST /converse   { text?, audioBase64?, imageBase64?, sessionId }
   ▼
Node: service/  (new, substantial, central — this is where the new code lives)
   ├─ prompts/bengali.js     → Bengali system prompt + per-modality instruction strings + tool schema
   ├─ llm/*                  → hosted LLM call (function-calling emulation of respond_to_user)
   ├─ text/sentenceSplit.js  → Bengali-aware sentence chunking (danda '।' + . ! ?)
   ├─ tts/*                  → hosted TTS per sentence, concurrent, → PCM16
   └─ routes/converse.js     → orchestrates the above, returns one JSON payload
   │  200 JSON { transcription, responseText, sampleRate, chunks:[{index,audioBase64}], timings }
   ▼
Python relays the JSON into the *existing* message shapes → WS → Browser plays audio exactly as before
```

**Why this split, not the alternatives:**
- *Node fully replaces `/ws`* — rejected: forces reimplementing WAV/JPEG decoding and interrupt bookkeeping that already works in `server.py`. Reading and adapting unfamiliar code is part of what's being demonstrated here, and rewriting a working WS layer from scratch spreads new code across low-value plumbing instead of the LLM/voice logic that actually matters.
- *Node as a thin wrapper Python barely touches* — rejected: under-delivers on the primary goal of showing strong, substantial JavaScript/Node engineering.
- **This design**: Python's edit surface shrinks to exactly two call-site redirects in `server.py` (the `litert_lm.Engine` call, the per-sentence TTS call), one new env var (`NODE_SERVICE_URL`), and an interrupt→task-cancellation tweak. Every semantically new piece of logic — Bengali prompting, hosted-LLM function-calling, sentence chunking, hosted TTS, audio format conversion, logging, rate limiting, prompt-injection guard — lives in Node. This maximizes both the amount and quality of new Node code *and* keeps the Python touch minimal and clean.

**Turn walkthrough:** mic speech ends (browser's `vad.MicVAD`) → base64 WAV over `/ws` (unchanged) → `server.py` decodes, POSTs to `/converse` with a `sessionId` → Node builds the Bengali multimodal prompt (maintaining per-session conversation history in-memory, mirroring the original `engine.create_conversation` statefulness) → calls the hosted LLM with a forced function call `respond_to_user(transcription, response)` → splits `response` into Bengali-punctuation-aware sentences → runs per-sentence TTS concurrently (`Promise.allSettled`) → converts each to PCM16, resampled to match `audio_start.sample_rate` → base64-encodes → returns one JSON payload → `server.py` re-emits `text`, then `audio_start`, then N `audio_chunk`s, then `audio_end` — identical shapes to today, so the frontend's existing playback code needs no protocol changes.

**Interrupt/barge-in:** `server.py` keeps handling `{"type":"interrupt"}` locally exactly as today, now cancelling its outstanding async HTTP call to Node (asyncio task cancellation) instead of a local `litert_lm` call. Node needs no matching `/interrupt` endpoint — a stray in-flight call whose result gets discarded is an accepted, deliberately scoped-down cost (see Risks).

## Folder Structure

```
<fork-root>/
├── src/                          # existing Python — minimal, targeted edits only
│   ├── server.py                 # 2 call sites redirected to Node; + NODE_SERVICE_URL config
│   ├── tts.py                    # left in place, out of the hot path (kept, not deleted — smaller diff)
│   ├── index.html                # + lang="bn", Bengali font link, + <script src="strings.bn.js">, literals → STRINGS.* lookups
│   └── strings.bn.js             # NEW — one small flat object, lives beside index.html (a static browser asset Python already serves as-is)
│
└── service/                      # NEW Node project, sibling to src/, wholly separate deploy unit
    ├── package.json
    ├── .env.example               # LLM_PROVIDER, TTS_PROVIDER, API keys (incl. OPENROUTER_API_KEY, OPENROUTER_MODEL), PORT
    ├── src/
    │   ├── index.js               # Express/Fastify bootstrap + /health
    │   ├── config.js              # env-driven provider selection, fail-fast on missing keys
    │   ├── routes/converse.js     # POST /converse orchestration (kept thin — orchestration only)
    │   ├── llm/
    │   │   ├── index.js           # provider-agnostic interface (strategy pattern)
    │   │   ├── geminiProvider.js  # default — verified native audio+image input, verified function-calling
    │   │   └── openRouterProvider.js  # alternate — swap to any OpenRouter-hosted model via OPENROUTER_MODEL for a cost/quality dial; verify per-model audio-input + tool-calling support before relying on it (see Design Decisions, row a)
    │   ├── tts/
    │   │   ├── index.js
    │   │   └── edgeTtsProvider.js
    │   ├── prompts/bengali.js     # single source of truth: system prompt + 4 modality strings + tool schema
    │   ├── text/sentenceSplit.js
    │   ├── middleware/{rateLimit.js, promptInjectionGuard.js}   # log-only, per locked scope
    │   ├── logging/logger.js      # per-request: provider, tokens, latency
    │   └── util/audio.js          # PCM16 conversion/resampling
    ├── test/                      # light: sentenceSplit, prompt shape — not a full suite
    └── README.md                  # provider-swap instructions, codebase-comprehension notes, trade-offs, future improvements
```

**Why this structure:** `llm/index.js` and `tts/index.js` as strategy interfaces demonstrate deliberate Node architecture rather than a script. `prompts/bengali.js`, isolated from routing, cleanly separates prompt-template management from request handling. `routes/converse.js` kept thin (orchestration only, no business logic inline) shows separation of concerns. `strings.bn.js` staying inside `src/` rather than `service/` signals correct identification of it as a Python-served static asset, not new service code — an easy-to-follow signal for anyone navigating the diff.

## Design Decisions

| # | Decision | Alternatives considered | Tradeoffs | Why this is the right call |
|---|---|---|---|---|
| a | **LLM: Google Gemini (`gemini-2.0-flash`-class) via an AI Studio free-tier API key, as the default provider** — plus **OpenRouter as a second, swappable provider** (`llm/openRouterProvider.js`) for dialing up to a stronger paid model without touching code | OpenAI GPT-4o-mini; Groq (Llama-family) | OpenAI has no perpetual free tier (billing required to start). Groq's free tier is genuinely free and fast but has weaker documented Bengali fluency and less mature audio+image multimodal input than Gemini. OpenRouter adds a second network hop, and audio-input support plus reliable forced function-calling vary by the specific model it's routed to — must be verified for whichever `OPENROUTER_MODEL` is chosen before relying on it for the full audio+tool-call flow; a model lacking one of these may need a text-only fallback. | Gemini-direct: native multimodal input (matches the original audio/image `respond_to_user` shape), documented Bengali support, a free tier reachable without a paid card, and function-calling to emulate the forced tool call — a justified default with real cost/rate-limit awareness behind it. OpenRouter costs nothing architecturally (same `llm/` interface, one more provider file) and turns "is free-tier quality good enough" into a one-line env swap (`LLM_PROVIDER=openrouter`, `OPENROUTER_MODEL=...`) instead of a rewrite — concretely demonstrating awareness of output quality, which pairs directly with the Bengali-QA review pass (Part C): if that pass flags weak phrasing, the fix is a config change, not new code. |
| b | **TTS: Microsoft Edge neural voices (`bn-IN`/`bn-BD`) via a free, unofficial Node client**, with Google Cloud TTS Neural2 (`bn-IN`) documented as the drop-in official alternative | Google Cloud TTS; Azure Speech; ElevenLabs | Edge TTS is free/no-signup but unofficial (endpoint could change) and returns compressed audio requiring an explicit transcode-to-PCM16 step; Google TTS is official and emits raw `LINEAR16` natively but needs a billing-enabled GCP account; ElevenLabs' free tier and Bengali coverage are both limited. | Prioritizes "runnable without a paid key," and the transcode step becomes legitimate, visible Node engineering (buffer/stream handling) rather than a liability — the provider is swappable via env var if the unofficial endpoint proves unreliable. |
| c | **Preserve the existing WS message contract exactly** — Node never speaks WS to the browser | A new Node↔browser WS protocol; Node replacing `/ws` entirely | A new protocol would force a frontend WS-handling rewrite, expanding the audited diff and risking regressions in the already-working VAD/interrupt flow. | Keeps frontend changes confined to strings/lang, not protocol rework — clean, minimal Python/frontend touch. |
| d | **Bengali frontend strings centralized in one flat `src/strings.bn.js` object**, not a full i18n framework, not scattered inline replacement | Full i18n library (i18next); hand-translating each string in place | Inline replacement is fast but leaves strings scattered and undiscoverable, undercutting the "figuring out where user-facing language lives" work; a full i18n framework is disproportionate for a Bengali-only, no-toggle scope. | Matches the locked Bengali-only scope while still proving every string (title, status pill, state labels, camera button, `LLM ${t}s` meta template) was located and centralized — pragmatic scoping over gold-plating. |
| e | **Provider swap via env vars** (`LLM_PROVIDER=gemini`, `TTS_PROVIDER=edge`), read once in `config.js`, injected into a factory in `llm/index.js`/`tts/index.js`; for the OpenRouter provider specifically, a further `OPENROUTER_MODEL` env var swaps the underlying model itself | A runtime admin API to switch providers; hardcoding a single provider | An admin API is over-engineered for this scope; hardcoding forecloses any cost/rate-limit-awareness signal. | Keeps the strategy pattern trivial to extend, and cheaply demonstrates cost/rate-limit judgment without building a real ops layer — the `OPENROUTER_MODEL` layer additionally demonstrates a cost-vs-quality dial, not just a cost-vs-uptime one. |

## Risks

| Risk | Mitigation |
|---|---|
| Free-tier LLM/TTS rate limits or downtime during a demo | Provider abstraction (decision e) makes a fallback provider a one-line env swap, not a rewrite; bounded retry with backoff in `llm/index.js`/`tts/index.js`; on hard failure, `server.py` emits a friendly Bengali error message over the existing `text` message type instead of hanging the WS. |
| Frontend expects raw **PCM16** audio chunks decoded directly (`msg.audio`), but Edge TTS returns compressed audio | `util/audio.js` performs an explicit transcode-to-PCM16 + resample step before base64-encoding `audio_chunk`s — called out as load-bearing, not incidental; skipping it silently breaks the browser's existing playback code. |
| Sentence-splitting regex `(?<=[.!?])\s+` doesn't recognize Bengali's `।` (danda) | `text/sentenceSplit.js` extends the pattern to include `।` alongside `. ! ?`; without this, a full Bengali reply arrives as one giant chunk, breaking the perceived-streaming UX the `audio_start`/`audio_chunk` design relies on. |
| Hosted APIs add network latency vs. the original blocking local calls | The original `litert_lm.Engine` call was already blocking/non-streaming — not a UX regression in kind. Mitigate by synthesizing all sentence-TTS calls concurrently (`Promise.allSettled`) rather than sequentially. |
| Interrupt/barge-in racing an in-flight async Node call | `server.py` cancels its own await via asyncio task cancellation on interrupt; a stray Node-side call whose result is discarded is accepted as a bounded, explicitly scoped-down cost rather than building real cross-process cancellation. |
| Bengali quality risk — literal/robotic translation is the failure mode to avoid | `prompts/bengali.js` and `strings.bn.js` are single-source-of-truth files, easy to hand-review or run through a lightweight Bengali-QA review pass before submission (see Part C). If that pass finds the default free-tier model's Bengali weak, `llm/openRouterProvider.js` + `OPENROUTER_MODEL` gives a config-only escape hatch to a stronger paid model. |
| OpenRouter's per-model support for audio input and forced function-calling isn't uniform across the models it routes to | Verify both capabilities for the specific `OPENROUTER_MODEL` chosen before switching to it; if a chosen model can't take audio directly, fall back to text-only turns for that provider rather than silently dropping the audio modality. |
| Scope creep re-introducing cut features (profanity filter, camera content moderation, age monitoring, full eval subsystem, heavy AI-tooling suite) | Explicitly listed as non-goals in `service/README.md`'s "Future Improvements" section; `middleware/promptInjectionGuard.js` logs only, never hard-gates, per the locked minimal-validation scope decision. |
| Overinvesting effort in Python | Python diff is scoped up front to exactly: two call-site redirects in `server.py`, one new env var, and the interrupt-cancellation tweak — no other `server.py`/`tts.py` restructuring is planned. |

## Priority Plan

1. **Trace, don't touch.** Read `server.py` end-to-end; pinpoint the exact `litert_lm.Engine` call site and the TTS-per-sentence call site with file/line references. Zero code written — the cheapest way to de-risk the integration before writing anything.
2. **Wire the plumbing with stubs.** Scaffold `service/` (bootstrap, `config.js`, `/health`, a stub `/converse` returning fixed Bengali text + one silent PCM16 chunk). Redirect the two `server.py` call sites to hit the stub over HTTP. Prove the full Python↔Node↔WS↔browser chain works before any provider integration — retires the biggest architectural risk first.
3. **Real LLM leg.** `prompts/bengali.js` + `llm/geminiProvider.js`, function-calling emulation of `respond_to_user`, `text/sentenceSplit.js` with Bengali punctuation. This is the highest-value new code — front-loaded intentionally.
4. **Real TTS leg.** `tts/edgeTtsProvider.js` + `util/audio.js` PCM16 conversion, concurrent per-sentence synthesis, wired into `/converse`'s response shape.
5. **Finalize the Python integration.** Confirm the two call-site redirects, add `NODE_SERVICE_URL`, interrupt-cancellation handling, graceful-failure Bengali error path. Keep this diff small and reviewable.
6. **Frontend localization.** `strings.bn.js`, `<html lang="bn">`, Bengali font, literal-to-`STRINGS.*` swaps in `index.html`. Deliberately sequenced after the backend so the Bengali system prompt and frontend strings can be reviewed together for consistency of tone.
7. **End-to-end manual verification.** Full mic+camera turn, barge-in/interrupt still functions, audio plays correctly, Bengali reads naturally.
8. **Polish/differentiators (time-permitting only)** — see Part C.

This order secures the highest-value new code (Node service + Bengali quality) and the cleanest possible integration before any time is spent on logging depth, validation breadth, or documentation polish.

---

# Part B — Implementation Guidelines

| Area | Guidance |
|---|---|
| **Architecture** | Strategy-pattern interfaces for `llm/` and `tts/` (one `index.js` exposing `generate()`/`synthesize()`, one file per provider implementing it) — new providers are additive, never require touching call sites. |
| **Code organization** | Keep `routes/converse.js` to orchestration only — no prompt text, no provider-specific logic inline. Business logic lives in `llm/`, `tts/`, `prompts/`, `text/`. |
| **Naming conventions** | Node: camelCase files/functions, PascalCase for provider classes if used (`GeminiProvider`). When touching `server.py`, match its existing snake_case and its existing logging style (`f"LLM ({t}s) [tool] heard: ..."`) rather than imposing Node conventions on Python. |
| **Error handling** | Every provider call wrapped in try/catch with a typed error (`ProviderError`); `routes/converse.js` catches these and returns a structured error the Python side turns into a Bengali-language `text` message rather than dropping the WS connection. |
| **Logging** | One structured log line per `/converse` call: `{sessionId, llmProvider, ttsProvider, promptTokens, completionTokens, llmLatencyMs, ttsLatencyMs}`. Console/JSON is sufficient — no log aggregation infra. |
| **Validation** | Request size cap (reject audio/image blobs above a sane limit) and a lightweight prompt-injection heuristic in `middleware/promptInjectionGuard.js` — both **log, don't block**, per the locked minimal-validation scope. Nothing beyond this (no profanity filter, no content moderation) is implemented. |
| **Testing** | A handful of targeted unit tests: `text/sentenceSplit.js` (Bengali punctuation cases), `prompts/bengali.js` (shape/required-fields check). No integration/e2e suite, no CI — production-grade test infra is out of scope here. |
| **Documentation** | `service/README.md`: setup, env vars, provider-swap instructions, and a short "how I found the user-facing strings / system prompt" comprehension note. Root-level write-up covers AI-usage, trade-offs, future improvements. |
| **Performance** | Concurrent per-sentence TTS synthesis (`Promise.allSettled`) rather than sequential; avoid blocking the Node event loop with synchronous work in `util/audio.js`. |
| **Security** | No hardcoded API keys — `.env` + `.env.example` + `.gitignore` entry; `config.js` fails fast at startup if a required key is missing rather than failing on first request. |
| **Maintainability** | `prompts/bengali.js` as the single source of truth for every string sent to the LLM; changing tone/wording touches one file, not scattered call sites. |
| **Developer experience** | `npm run dev` / `npm start` scripts, a `/health` endpoint, a clear `.env.example` with inline comments — a new contributor should be running the service in under two minutes. |
| **Scalability** | In-memory per-session conversation history map is sufficient at this scale; note in the README that a real deployment would move this to Redis/a session store — don't build that now. |
| **Future extensibility** | Adding a new LLM/TTS provider = implement the interface + register in the factory + set an env var. Adding a second language = extend `prompts/` and `strings.*.js`, no architecture change. Document both explicitly in the README's "Future Improvements" section. |

---

# Part C — Differentiators

| Enhancement | Effort | Impact | Worth doing? |
|---|---|---|---|
| **README with AI-usage/decisions write-up** (workflow, prompts used, trade-offs, future improvements) | Low | High — the only way a reader sees the reasoning and AI-tool workflow behind the work, since there's no PR/review step | **Yes** — do this first among differentiators |
| **Structured per-request logging** (tokens, latency, provider) | Low | Medium-high — visible cost-consciousness signal | **Yes** |
| **Env-driven config with fail-fast validation** | Low | Medium — professionalism/DX signal | **Yes** |
| **Graceful error handling + bounded retry/backoff on provider calls** | Medium | Medium-high — protects against free-tier flakiness during a live demo | **Yes** |
| **1-2 lightweight internal review tools** (e.g. a Bengali-translation-quality reviewer, run once before submission; optionally a quick security/code-quality pass) | Medium | High for showing internal-tooling instincts, without the cost of a full suite | **Yes, capped at 1-2** — do not expand into a large tooling suite |
| **`/health` endpoint** | Trivial | Low-medium — basic ops hygiene | **Yes**, cheap |
| **Targeted unit tests** (sentence-splitting, prompt shape) | Low | Low-medium | **Yes**, kept small |
| **Docker / CI/CD pipeline** | High | Low, given this isn't meant to be a flawless, mergeable feature | **No** — skip |
| **Full observability/metrics dashboard** | High | Low | **No** — skip |
| **Bilingual EN/BN toggle** | Medium | Low-medium, not required by the task | **Optional**, only if all Critical/Important items are done with time to spare |
| **Full input-validation/moderation stack** (profanity, camera content moderation, age monitoring, output classifier) | High | Low relative to cost — no clear basis in the task, actively competes with higher-value work | **No** — explicitly deferred to "Future Improvements" in the write-up, not implemented |
| **Autonomous bug-fix/feature-add agent loop** | High | Negative — unsupervised edits cut against clean, reviewable navigation and are invisible to a reader anyway | **No** — explicitly rejected |

---

# Part D — Final Execution Checklist

## Critical

| # | What | Why it matters |
|---|---|---|
| 1 | Build the Node `service/` layer with LLM + TTS provider abstraction | This is the single highest-value new code surface, and the primary thing being demonstrated |
| 2 | Redirect exactly the two call sites in `server.py`, minimal diff | Demonstrates clean navigation of unfamiliar code without over-touching it |
| 3 | Translate every frontend string + the system prompt to natural, professional Bengali | Natural, native-sounding phrasing is the named quality bar — literal/robotic translation is a failure mode |
| 4 | Get a full end-to-end run working (mic/camera in → Bengali text + voice reply out) | Base requirement for the result to be usable at all — working end-to-end, not necessarily flawless |

## Important

| # | What | Why it matters |
|---|---|---|
| 5 | Env-driven provider swap (`LLM_PROVIDER`/`TTS_PROVIDER`) | Cheap, visible cost/rate-limit judgment |
| 6 | Per-request logging (tokens, latency, provider) | Same as above, made concrete |
| 7 | README covering AI-usage, trade-offs, future improvements | The only channel to make the reasoning and AI workflow behind the work visible — no PR/review step exists |
| 8 | Minimal input validation (size/rate limit + logged prompt-injection guard) | Shows safety awareness without overbuilding |
| 9 | Graceful error handling / fallback Bengali error message on provider failure | Protects the "genuinely working" bar against free-tier flakiness during a demo |

## Optional

| # | What | Why it matters |
|---|---|---|
| 10 | 1-2 lightweight internal review tools (Bengali-QA reviewer, etc.), documented | Demonstrates internal-tooling instincts cheaply, without diverting time from Critical/Important items |
| 11 | Targeted unit tests (sentence-splitting, prompt shape) | Small, credible testing signal |
| 12 | `/health` endpoint | Trivial ops hygiene |
| 13 | Bilingual EN/BN toggle | Only if all of the above are done with time to spare — not required |

---

*This plan is ready to code from. Implementation should follow the Priority Plan in Part A, sequenced so the Critical items are secured before any Optional-tier item is touched.*
