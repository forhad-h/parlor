# Parlor

Real-time multimodal AI. Have natural voice and vision conversations with an AI that talks back.

Parlor talks and listens in **Bengali (বাংলা) by default** — a small **Node
service** (`service/`) runs the LLM + speech via hosted APIs (Gemini for
understanding, Microsoft Edge neural voices for TTS), and `server.py` becomes
a thin relay. An **on-device English mode** is also available, running
[Gemma 4 E2B](https://huggingface.co/google/gemma-4-E2B-it) and
[Kokoro](https://huggingface.co/hexgrad/Kokoro-82M) fully locally, no API keys
or internet required.

> **Jump to [Quick start (Bengali, default)](#quick-start) ·
> [On-device English mode](#on-device-english-mode) ·
> see [`service/README.md`](service/README.md) · [`CLAUDE.md`](CLAUDE.md) ·
> [`AI-JOURNEY.md`](AI-JOURNEY.md).**

> Bengali is forced as the default intentionally, so the project runs end to
> end in minutes with just a free API key (or none at all, via the `mock`
> provider) — no 2.6 GB model download required. The original on-device
> English path is untouched, not removed; it's one line of configuration away
> and fully verifiable — see [On-device English mode](#on-device-english-mode).

https://github.com/user-attachments/assets/cb0ffb2e-f84f-48e7-872c-c5f7b5c6d51f

> **Research preview.** This is an early experiment. Expect rough edges and bugs.

# Why?

I'm [self-hosting a totally free voice AI](https://www.fikrikarim.com/bule-ai-initial-release/) on my home server to help people learn speaking English. It has hundreds of monthly active users, and I've been thinking about how to keep it free while making it sustainable.

The obvious answer: run everything on-device, eliminating any server cost. Six months ago I needed an RTX 5090 to run just the voice models in real-time.

Google just released a super capable small model that I can run on my M3 Pro in real-time, with vision too! Sure you can't do agentic coding with this, but it is a game-changer for people learning a new language. Imagine a few years from now that people can run this locally on their phones. They can point their camera at objects and talk about them. And this model is multi-lingual, so people can always fallback to their native language if they want. This is essentially what OpenAI demoed a few years ago.

## How it works

```
Browser (mic + camera)
    │
    │  WebSocket (audio PCM + JPEG frames) — identical in both modes
    ▼
FastAPI server (server.py)
    ├── Hosted, Bengali (default): HTTP → Node service (service/)
    │       ├── Gemini            →  understands speech + vision
    │       └── Edge neural voices →  speaks back
    └── On-device, English (opt-in): runs locally, no Node service
            ├── Gemma 4 E2B via LiteRT-LM (GPU)  →  understands speech + vision
            └── Kokoro TTS (MLX on Mac, ONNX on Linux)  →  speaks back
    │
    │  WebSocket (streamed audio chunks)
    ▼
Browser (playback + transcript)
```

- **Voice Activity Detection** in the browser ([Silero VAD](https://github.com/ricky0123/vad)). Hands-free, no push-to-talk.
- **Barge-in.** Interrupt the AI mid-sentence by speaking.
- **Sentence-level TTS streaming.** Audio starts playing before the full response is generated.

See [On-device English mode](#on-device-english-mode) below for setup details
on that path.

## Requirements

- Node.js 18+ (for the `service/` sidecar)
- Python 3.12+
- A free [Gemini API key](https://aistudio.google.com/apikey) (or run key-free with the `mock` LLM provider)

## Quick start

Bengali mode needs two processes: the Node service (the "brain") and the
Python server (the browser-facing relay).

```bash
git clone https://github.com/fikrikarim/parlor.git
cd parlor

# 1) Node service (terminal 1)
cd service
npm install
cp .env.example .env          # add your free GEMINI_API_KEY
npm start                     # http://localhost:3001
#    …or run with NO key at all:  LLM_PROVIDER=mock npm start   (canned Bengali + real voice)

# 2) Python server (terminal 2) — hosted/Bengali is the default, no env var needed
# Install uv if you don't have it: curl -LsSf https://astral.sh/uv/install.sh | sh
cd src
uv sync
uv run server.py              # :8000
```

Open [http://localhost:8000](http://localhost:8000), grant camera and microphone
access, and start talking — in Bengali.

If you skip step 1 (or its API key is missing/invalid), `server.py` will print
a warning at startup telling you so — the app itself still starts, but every
turn will fail until the Node service is reachable.

See [`service/README.md`](service/README.md) for provider swapping
(`LLM_PROVIDER`, `TTS_VOICE`, OpenRouter), caching, resilience, and the Bengali
QA tool.

## On-device English mode

The original, fully local mode — Gemma 4 E2B via LiteRT-LM (GPU) for speech +
vision understanding, and Kokoro TTS (MLX on Mac, ONNX on Linux) — no Node
service, no API keys, no internet after the model download. It's kept exactly
as it was before Bengali support was added; Bengali is just the default now
for a faster out-of-the-box run, not a replacement.

Requires macOS with Apple Silicon or Linux with a supported GPU, and ~3 GB free
RAM for the model.

Opt in by setting `NODE_SERVICE_URL=` (empty) in `src/.env`, then:

```bash
cd src
uv sync
uv run server.py
```

Models are downloaded automatically on first run (~2.6 GB for Gemma 4 E2B, plus TTS models).

## Configuration

| Variable           | Default                          | Description                                                                        |
| ------------------ | --------------------------------- | ----------------------------------------------------------------------------------- |
| `NODE_SERVICE_URL` | `http://localhost:3001`           | Node service URL → hosted Bengali mode. Set to empty to run on-device English instead. |
| `MODEL_PATH`       | auto-download from HuggingFace    | Path to a local `gemma-4-E2B-it.litertlm` file (on-device mode only)                |
| `PORT`             | `8000`                            | Server port                                                                          |

See `service/.env.example` for the Node service's own configuration
(`GEMINI_API_KEY`, `LLM_PROVIDER`, `TTS_VOICE`, etc.) — it fails fast at
startup if a required key for the selected provider is missing.

## Troubleshooting

### macOS (on-device mode): `Error processing file '.../espeak-ng-data/phontab': No such file or directory`

The `espeakng-loader` PyPI package (a dependency of `misaki`, used for TTS phonemization) bundles a `libespeak-ng.dylib` for macOS that ignores the data path it's given at runtime and always looks for its own CI build path. This is an upstream packaging bug, not a local misconfiguration.

**Fix:** install a correctly-built espeak-ng via Homebrew:

```bash
brew install espeak-ng
```

`tts.py` auto-detects it via `brew --prefix espeak-ng` (falling back to the default Apple Silicon/Intel Homebrew locations if `brew` isn't on `PATH`), so no further setup is needed on a standard install.

This only affects macOS (the MLX backend). Linux's `kokoro-onnx` path uses a different, correctly-built `espeakng-loader` wheel and is unaffected.

## Performance (Apple M3 Pro, on-device mode)

| Stage                            | Time          |
| -------------------------------- | ------------- |
| Speech + vision understanding    | ~1.8-2.2s     |
| Response generation (~25 tokens) | ~0.3s         |
| Text-to-speech (1-3 sentences)   | ~0.3-0.7s     |
| **Total end-to-end**             | **~2.5-3.0s** |

Decode speed: ~83 tokens/sec on GPU (Apple M3 Pro).

## Performance: hosted (Bengali) vs on-device

`benchmarks/bench.py` talks to the server purely over the WebSocket protocol,
which is byte-for-byte identical in both modes, so the same script runs
unmodified against either — just start `server.py` with or without
`NODE_SERVICE_URL` set. Run on a different machine (Apple M2 Pro) than the
table above, so compare within this table, not across it:

| Test                  | On-device (Gemma + Kokoro) | Hosted (Gemini + Edge TTS, Bengali) |
| --------------------- | --------------------------- | ------------------------------------ |
| Text only              | 3.80s                       | 4.20s                                |
| Audio 2s               | 1.43s                       | 5-28s (rate-limit retries, see below) |
| Audio 5s               | 1.84s                       | 5.21s                                 |
| Image only             | 2.26s                       | 3.69s                                 |
| Image + audio 2s       | 1.97s                       | 5.68s                                 |
| Image + audio 5s       | 1.87s                       | 5.64s                                 |
| **Total (typical)**    | **~2-2.3s**                  | **~4-6s**                             |

Hosted mode is consistently a few seconds slower per turn — expected, since a
turn is now a network round trip to Gemini + Edge TTS instead of local GPU
inference. That gap isn't something the TTS cache (`util/cache.js`) closes: it
only helps *repeated identical* Bengali sentences, and free-form LLM replies
rarely repeat verbatim.

Two real constraints this run surfaced, worth knowing before a live demo:

- **Free-tier quota.** `gemini-2.5-flash`'s free tier allows ~20 requests/day
  and a handful per minute. Running the individual-turn and multi-turn
  benchmarks back to back exhausted it mid-run — visible as `nextRetryMs`
  backoff in the Node service log, then a hard 429 once daily quota was gone.
  The retry/backoff logic (`util/retry.js`) behaved correctly; the quota
  itself is just tight for repeated back-to-back local testing.
- **A pre-existing on-device crash**, unrelated to this fork: a 5-second-audio
  turn reliably makes `litert_lm`'s `conversation.send_message` raise
  (`litert_lm_conversation_send_message failed`), killing that WebSocket
  connection. Reproducible on the original English/Gemma path too.

Not a voice-quality comparison — on-device speaks English (Kokoro), hosted
speaks Bengali (Edge) — only the architecture/latency cost of moving off-device
is comparable here.

## Project structure

```
src/
├── server.py              # FastAPI WebSocket server + Gemma 4 inference
├── tts.py                 # Platform-aware TTS (MLX on Mac, ONNX on Linux)
├── index.html             # Frontend UI (VAD, camera, audio playback)
├── pyproject.toml         # Dependencies
└── benchmarks/
    ├── bench.py           # End-to-end WebSocket benchmark
    └── benchmark_tts.py   # TTS backend comparison
```

See [`service/README.md`](service/README.md) for the Node service's structure.

## Acknowledgments

- [Gemma 4](https://ai.google.dev/gemma) by Google DeepMind
- [LiteRT-LM](https://github.com/google-ai-edge/LiteRT-LM) by Google AI Edge
- [Kokoro](https://huggingface.co/hexgrad/Kokoro-82M) TTS by Hexgrad
- [Silero VAD](https://github.com/snakers4/silero-vad) for browser voice activity detection

## License

[Apache 2.0](LICENSE)
