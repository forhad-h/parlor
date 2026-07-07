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
export class MockProvider {
  constructor() {
    this.name = 'mock';
  }

  async generate(turn) {
    const responseText = turn.text
      ? `আপনি বললেন: “${turn.text}”। দারুণ! আমি আপনাকে সাহায্য করতে এখানেই আছি।`
      : 'আসসালামু আলাইকুম! আমি আপনার কথা শুনেছি। কীভাবে সাহায্য করতে পারি?';

    return {
      transcription: turn.text ?? '(ভয়েস বার্তা)',
      responseText,
      usage: { promptTokens: 0, completionTokens: 0 },
      safety: null, // canned stub — no real generation, so no safety signal applies
    };
  }
}
