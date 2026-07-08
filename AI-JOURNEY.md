# AI Journey

I did not write most of this code. I made almost every decision about it.

That one sentence is the whole philosophy. For the technical trail —
providers, file paths, design tradeoffs — read `README.md` and
`service/README.md`. This page is about how I think, and how I worked with AI
to build something I can defend line by line.

## The split: 20% vibe coding, 80% judgment

Roughly one fifth of this project is vibe-coded — AI-generated code that I
approved. The other four fifths is me — reading the brief, setting scope, planning,
creative thinking, deciding, fixing bugs, and reviewing every generated file
before I called it done. That is not a modest ratio, it is the point. AI is fast at producing
text. It is not responsible for the result. I am. So I spent my time where
responsibility actually lives: catching a wrong assumption before it becomes
code, not patching a bug after it ships.

## Why planning got the most scrutiny

A wrong idea in a plan spreads into everything built on top of it. A wrong
line of code usually stays in one place. So the plan got more attention than
any single file — split into research, then constraints, then architecture,
then build steps, each one checked against my own notes before I moved to
the next. AI is happy to hand you a finished plan in one pass. I did not let
it.

## Four moments that taught me something

A few small catches from the review process — proof that "reviewing every
file" was a real habit, not a line I wrote for this page.

**1. AI deleted something true.** Rewriting the README for Bengali support,
AI quietly dropped the on-device model section — it stopped fitting the
current instruction, so it lost weight. Researchers call this **context
dilution**, or the "lost in the middle" effect. I caught it and put it back.

**2. AI added a cache that would almost never hit.** A response cache for
LLM answers — a fine idea in general, useless here, since a conversation
rarely repeats the same input. I removed it.

**3. AI copied an old habit instead of a better option.** It tried to fake a
forced tool-call for structured output, a trick needed only by the old
on-device model. The new, more capable model supports native structured
output directly. I dropped the trick.

**4. Natural output needed a real ear.** A test suite cannot hear that
Bengali sounds stiff or bookish. I listened myself, and had a second AI pass
review it with a different persona before trusting either one — a judgment
call that mattered enough to become a standing tool
(`service/tools/bengaliReview.js`) rather than a one-off check. The same
principle — don't trust a benchmark you wrote yourself, trust real evidence —
shaped a second tool, `service/tools/reviewTurns.js`: it judges the system's
actual runtime replies against turns a human really typed or spoke during
manual QA, deliberately skipping a synthetic prompt suite, because a test you write
yourself mostly proves you wrote a good test.

## Safety and responsibility

Wherever I was not sure a rule was well-calibrated — prompt injection,
unsafe content — I chose to log first and block later, once real data showed
the false-alarm rate was low enough to trust. That is a small detail, but it
reflects a bigger one: every gate in this project that could silently break
a conversation was my decision, made on purpose, not a default AI reached for
on its own.

## The takeaway

AI wrote a lot of the words in this project. I decided which ones were true,
which ones were safe, and which ones stayed. That is the actual job — and
why I do not trust "AI built it in 10 minutes" stories. The fast part was
never the hard part.

If you want proof instead of philosophy — the provider strategy, the
schema-constrained output, the two QA tools mentioned above — it's all in
`service/README.md`, named and defensible.
