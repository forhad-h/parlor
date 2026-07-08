# CLAUDE.md

Guidance for AI assistants and developers working in this repo.

## What this is

Parlor is a real-time voice + vision assistant. This fork adds **Bengali
support** by introducing a Node service (`service/`) that runs the LLM + TTS via
hosted APIs, while the existing Python/FastAPI backend and the browser WebSocket
protocol stay intact.

**The primary engineering surface is `service/` (Node/JS).** The Python touch is
kept deliberately small.

## Two run modes

`server.py` branches on one env var, `NODE_SERVICE_URL` (hosted/Bengali is the
default; set it empty to opt into on-device English). **The browser WebSocket
frames are byte-for-byte identical in both modes** — that invariant is the
whole point; don't break it.

Setup/run instructions: see README.md's "Bengali mode" section and
`service/README.md` — not duplicated here.

## Wire contracts (hosted mode)

- Client→server WS: `{ text | audio(b64 wav) | image(b64 jpeg) | interrupt }`
- server→client WS (one turn): `text` → `audio_start` → `audio_chunk`×N → `audio_end`
- server.py→Node: `POST /converse { sessionId, text?, audioBase64?, imageBase64? }`
- Node→server.py: **NDJSON stream** (newline-delimited JSON, one object per line, media type `application/x-ndjson`, in playback order):
  `{type:text, transcription, responseText, llmMs}` → `{type:audio_start, sampleRate, sentenceCount}` → `{type:audio_chunk, index, audioBase64}`×N → `{type:done, ttsMs}`. A failure before the stream opens is a normal non-200 JSON with `bengaliMessage`; a mid-stream failure arrives as `{type:error, bengaliMessage}`. server.py relays each event into the server→client WS frames above as it arrives (progressive audio; see `service/README.md` Design decisions).

## Where things live

| Concern | File |
| --- | --- |
| **LLM strings** (system prompt, modality instructions, response schema) | `service/src/prompts/bengali.js` |
| **Browser strings** (all UI text) | `src/strings.en.js` (on-device) / `src/strings.bn.js` (hosted) — `server.py`'s `/strings.js` route picks one based on `HOSTED_MODE` |
| LLM providers (strategy) | `service/src/llm/{index,geminiProvider,openRouterProvider,mockProvider}.js` |
| TTS provider (strategy) | `service/src/tts/{index,edgeTtsProvider}.js` |
| Bengali sentence splitting (danda `।`) | `service/src/text/sentenceSplit.js` |
| MP3→PCM16 transcode / resample | `service/src/util/audio.js` |
| Turn orchestration | `service/src/routes/converse.js` |
| Python integration | `src/server.py` (`process_turn_hosted`) |

## Conventions

- **Node:** ES modules, camelCase, one provider per file implementing the
  interface. New provider = new file + one `case` in the factory + an env value.
  Never inline prompt text or provider specifics into `routes/converse.js`.
- **No provider- or model-specific comments in shared files.** Shared files
  used by every provider (`llm/index.js`, `tts/index.js`, `prompts/bengali.js`,
  and any other factory or shared-type file) must describe behavior generically
  and never name a *specific* concrete provider or model (e.g. "OpenRouter has
  no native safety passthrough" written into `llm/index.js`'s `SafetySignal`
  typedef, or "gemini-2.0-flash follows English meta-instructions more
  reliably" written into `prompts/bengali.js`). A provider's or model's own
  quirks belong only in that provider's own file — otherwise the shared-file
  comment goes stale every time a provider is added, removed, or swapped to a
  different underlying model, even though the code itself didn't need to
  change. If a shared file must say something general, phrase it in terms of a
  category ("LLMs", "providers with no native safety classifier") or point
  elsewhere ("see each provider's file for how it populates this") instead of
  naming names.
- **Python:** match the existing snake_case and the existing print/log style
  (`f"LLM ({t:.2f}s) [tool] ..."`). Keep the diff minimal; new logic belongs in
  Node, not Python.
- **Strings:** change wording in the single-source files only (`strings.bn.js`
  for Bengali, `strings.en.js` for English — kept field-for-field identical in
  shape). If you add a UI string, add it to *both* files and reference
  `STRINGS.*` in `index.html` — don't hardcode literals. `index.html`'s static
  defaults are English (matching the on-device fallback) to avoid a flash
  before `applyStaticStrings()` runs.

## Gotchas

- **Keep the WS contract stable.** The frontend playback/VAD/barge-in code
  depends on the exact frame shapes above.
- **Audio is raw PCM16 at the `audio_start` sample rate.** Edge only emits MP3,
  so it's transcoded in `util/audio.js`. If you swap TTS providers, return PCM16
  (or extend the transcode) and set the correct `sampleRate`.
- **`msedge-tts` must be v2+** — earlier versions get HTTP 403 from Microsoft's
  endpoint (missing the `Sec-MS-GEC` token).
- **Config fails fast:** a missing key for the *selected* provider aborts startup
  with a clear message. Use `LLM_PROVIDER=mock` to run without any key.
- **Hosted mode is now the default**, so `server.py` pings the Node service's
  `/health` at startup and prints a warning (not a hard failure) if it's
  unreachable — the most likely causes are the Node service not being started
  yet, or it having exited on the config-fails-fast check above.

## Context / provenance

This work implements `artifacts/10-bengali-localization-implementation-plan.md`.
Deviations from that plan (all documented in `service/README.md` and
`AI-JOURNEY.md`): the raw-PCM assumption became a real MP3 transcode; a
`/strings.bn.js` route was added; a `mock` LLM provider was added for key-free
runs; hosted mode gates on-device model loading so the app runs without the
2.6 GB Gemma download; the forced `respond_to_user` tool-call mechanism was
replaced with native JSON-schema-constrained output (`responseSchema` on Gemini,
`response_format` on OpenRouter) once both providers' support for it was
confirmed — the `{transcription, response}` shape is unchanged.
