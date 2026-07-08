/**
 * Mock LLM provider.
 *
 * Returns canned Bengali without any network call or API key. Two jobs:
 *   1. Lets the whole pipeline (server.py → /converse → sentence-split → Edge
 *      TTS → audio frames) run and be demoed end-to-end with zero credentials.
 *   2. Backs deterministic tests of the orchestration without hitting a paid API.
 *
 * That it drops in as a third provider with no other change is the point of the
 * strategy interface — new providers are additive.
 */

// Turn 2+ walks through this script once, then repeats the last line — it
// exists so a demo session doesn't just echo forever without ever disclosing
// that there's no real model behind it.
const FOLLOW_UP_LINES = [
  'এটি মক সংস্করণ — তাই প্রকৃত কথোপকথন সম্ভব নয়, শুধু ধাপগুলো (অডিও → টেক্সট → স্পিচ) দেখানো হচ্ছে।',
  'বাস্তব উত্তরের জন্য একটি LLM প্রোভাইডার (Gemini বা OpenRouter) এবং তার API key কনফিগার করা দরকার।',
  'আপাতত আমি শুধু আপনার কথার একটি ধাপ-অনুযায়ী নমুনা উত্তর দিচ্ছি, বিষয়বস্তু বুঝে জবাব দিচ্ছি না।',
  'ধন্যবাদ ডেমোটি চালিয়ে দেখার জন্য! বাকি টার্নগুলোতে আমি এই একই বার্তাটি পুনরাবৃত্তি করব।',
];

export class MockProvider {
  constructor() {
    this.name = 'mock';
  }

  async generate(turn) {
    const priorExchanges = Math.floor((turn.history?.length ?? 0) / 2);

    let responseText;
    if (priorExchanges === 0) {
      responseText = turn.text
        ? `আপনি বললেন: “${turn.text}”। দারুণ! আমি আপনাকে সাহায্য করতে এখানেই আছি।`
        : 'আসসালামু আলাইকুম! আমি আপনার কথা শুনেছি। কীভাবে সাহায্য করতে পারি?';
    } else {
      const line = FOLLOW_UP_LINES[Math.min(priorExchanges - 1, FOLLOW_UP_LINES.length - 1)];
      responseText = turn.text ? `আপনি বললেন: “${turn.text}”। ${line}` : line;
    }

    return {
      transcription: turn.text ?? '(ভয়েস বার্তা)',
      responseText,
      usage: { promptTokens: 0, completionTokens: 0 },
      safety: null, // canned stub — no real generation, so no safety signal applies
    };
  }
}
