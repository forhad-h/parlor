# AI Usage

I used **Claude Code** as the primary driver, but the process was deliberately
front-loaded on requirements and planning rather than "prompt once, ship the
output." AI did the fan-out research, drafting, and boilerplate; I owned
scoping, every architectural call, and the file-by-file review before treating
anything as done. Nothing below is hidden — the point of this doc is to show
where AI helped, where its first answer was wrong or vague, and what I did
about it.

## 1. Reading the brief before touching AI

Before writing a single prompt, I read the job description's
"Responsibilities & Context" section and the assessment itself and took my own
notes on the skills/strengths they were actually testing for. This was to have
an independent reference point — so that later, when AI proposed a plan, I
could check it against what I'd already decided mattered, instead of letting
AI's framing set the bar.

## 2. Research pass, and catching vagueness early

I then had AI research both the responsibilities and the assessment and align
them against my notes. Its first pass was vague — generic advice that didn't
commit to specifics about this codebase or this role. Rather than accept that,
I fed it my own notes and constrained it to that scope. I also brought my own
opinions into the mix at this stage — input validation, output validation,
model-swapping as a design axis — and explicitly asked AI to align its
recommendations against that combined scope rather than free-associate, so I
wouldn't overthink or over-engineer the project. That produced a much sharper
set of focus points, which is what the research artifacts in `artifacts/`
(`01`–`09`, covering the Gemma model, `litert_lm`, TTS options, architecture
options, benchmarks, UI research) came out of — each one a scoped research
question, not a single giant "figure it all out" prompt.

## 3. Planning in small, verifiable steps

The implementation plan (`artifacts/10-bengali-localization-implementation-plan.md`)
is the piece I spent the most time on, deliberately. AI's default was to
produce the whole plan in one shot; I split that into multiple steps instead —
research, then constraints, then architecture, then build sequence — reviewing
AI's output against my own thinking at each step. My reasoning: the plan *is*
the spec everything else gets built from. A wrong assumption baked in at the
planning stage propagates through the entire codebase and is far more
expensive to unwind than a wrong line of code. So I put the most scrutiny where
the leverage was highest, rather than treating planning as a formality before
"the real work."

Concretely, before any design decision in that plan, I had AI trace the actual
repo — the `litert_lm` LLM call site and per-sentence Kokoro TTS call site in
`server.py`, the forced `respond_to_user` tool contract (later replaced with
native JSON structured output — see `service/README.md`'s design decisions), and
every user-facing string in `index.html` — and cite the source for each fact it
based a decision
on (the plan marks these `[FACT]` vs `[INFERENCE]`). Two consequences of that
plan turned out to be wrong or incomplete once I actually read the code
myself:

1. The plan assumed `server.py` already served static assets, so
   `strings.bn.js` would "just be served." It didn't — only `/` and `/ws`
   existed. I added one minimal `FileResponse` route.
2. The plan assumed Edge TTS could emit raw PCM directly. The pinned library
   only emits compressed audio, so I added a real MP3→PCM16 transcode step
   (pure-WASM, no ffmpeg) — the "load-bearing transcode" risk the plan itself
   had flagged but hadn't resolved.

## 4. Generating the codebase from the finalized plan

Only once the plan was solid did I move to code generation. I fed the plan
plus the other artifact/context files back to AI so it would build against
that fixed scope instead of inventing architecture or requirements on the fly
mid-implementation. This is also why `CLAUDE.md` and `service/README.md` exist
as checked-in context files, not just for me — they keep future AI sessions
(and reviewers) anchored to the same decisions instead of re-deriving them
differently each time.

Within the Node service (`service/`), AI drafted the first pass of the
strategy-pattern interfaces (`llm/`, `tts/`) and the `/converse` orchestration.
I restructured several things after review:
- Made provider construction **lazy** so `validate()` owns the fail-fast path,
  instead of a provider constructor throwing before config validation runs.
- Hardened the retry helper to **race against a timeout** rather than trusting
  each SDK to honour an `AbortSignal` (Gemini's didn't reliably).
- Kept `routes/converse.js` orchestration-only — pushed all prompt text and
  provider specifics down into their own modules.
- Added a `mock` LLM provider (my call, not the plan's) so the app runs
  end-to-end with **zero API keys** — useful for grading and for tests.
- Upgraded `middleware/rateLimit.js` from the plan's log-only scope to
  **enforced** (429 + `Retry-After`) — a log-only limiter never actually
  manages cost, and the threshold has enough headroom not to trip during
  normal use. `promptInjectionGuard.js` stayed log-only for now: it's regex
  heuristics, and blocking on it today risks breaking a real conversation turn
  on a false positive. Turning it into a real gate, plus fuller input
  validation (profanity/content moderation), is called out as future work in
  `service/README.md`.

## 5. Localization (Bengali)

AI produced the first-pass Bengali for the system prompt, the four modality
instructions, and all UI strings. I steered it toward *spoken, everyday*
Bengali (using "আপনি", contractions) and explicitly away from bookish/literal
phrasing — a failure mode I flagged up front, not one I found by accident. To
verify quality independent of the same model's own output, I built a second AI
pass as a standalone tool (`service/tools/bengaliReview.js`): a
native-reviewer persona re-reads both string files and flags anything stiff.
Fixes are one-line edits because the strings are centralized in
`strings.bn.js` / `strings.en.js`.

## 6. Model / provider choice

I had AI lay out cost/latency/rate-limit tradeoffs for candidate LLM and TTS
providers, then made the call myself: **Gemini** as default (native multimodal
input, free tier reachable without a card, forced function-calling), with
**OpenRouter** as a swappable second provider for a cost/quality dial — both
behind the same interface so switching is a one-line env change, not a
rewrite.

## 7. Reviewing every generated file myself

Even with a solid plan, AI-generated code is not something I'd ship unread. I
went through each generated file one by one — not to nitpick style, but to
actually understand the system I was about to be accountable for: the
tradeoffs, the architecture, where the failure modes were. AI writing good
code doesn't transfer that understanding to me automatically; reading it does.
This step is also where the two plan gaps above got caught — they weren't
visible from the plan text, only from reading the resulting code and the
actual upstream files it touched.

## 8. Verification

I didn't take "it compiles" as good enough. I ran the real Edge TTS path
(Bengali → MP3 → decoded PCM16), a full Python↔Node↔WebSocket turn asserting
the exact frame sequence, the fail-fast/`/health` paths, and the unit suite —
and generated an actual Bengali `.wav` file to listen to the output myself.

## Tools used

- **Claude Code** — the primary driver throughout: research, planning,
  drafting, refactoring, the Bengali review pass, and the verification loop.
  Mostly **Sonnet**; **Opus** for the initial round of code generation off the
  finalized plan; **Fable** on a few occasions where a decision felt
  higher-stakes and I wanted a second, differently-tuned take before
  committing.
- **ChatGPT** — used up front to help draft the initial research/planning
  prompts before handing the scoped work to Claude Code.
- **DeepSeek Chat** — used as a plain technical reference while reading the
  codebase, e.g. to understand what `litert-lm` actually is, how PCM audio
  encoding works, etc. — background knowledge, not code generation.

All scoping, architectural decisions, and final review were mine.
