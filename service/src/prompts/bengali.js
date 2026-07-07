/**
 * Single source of truth for every string the LLM sees.
 *
 * Ports the original English system prompt + the four per-modality instruction
 * strings from `src/server.py` (system prompt at lines 38-43; modality strings
 * at lines 150-157) into natural, spoken Bengali. Keeping prompt text out of the
 * providers means tone/wording changes touch exactly one file.
 *
 * Translation intent (not a literal port): the model is told to speak the way a
 * warm Bangladeshi person actually speaks — using "আপনি", contractions and
 * everyday vocabulary — and explicitly warned off stiff, bookish, or
 * translated-sounding Bengali, which is the named failure mode for this work.
 */

/**
 * System prompt — persona, language lock, and the JSON output contract.
 *
 * The language rule and the output-format rule are both stated in English on
 * purpose: LLMs follow an explicit English meta-instruction about *output
 * language* and *output format* more reliably than a
 * Bengali-only instruction (observed: without the English language rule, it
 * defaulted both the transcription and the reply to English). The
 * persona/tone guidance stays in Bengali so the model's in-language voice is
 * modelled by the prompt itself.
 *
 * The JSON-format rule exists as a prompt-level fail-safe on top of the
 * provider's native structured-output constraint. Not every provider — or every
 * underlying model it may route to — honors strict JSON-schema output, so the
 * prompt itself has to carry the requirement rather than relying solely on the
 * API parameter.
 */
export const SYSTEM_PROMPT = [
  'You are Parlor, a warm, friendly Bengali voice assistant. The user speaks to you through a microphone and shows you their camera.',
  '',
  'CRITICAL LANGUAGE RULE — read carefully:',
  'You MUST write BOTH the `transcription` and the `response` fields in Bengali (Bangla) using Bengali script only (অ, আ, ক, খ …).',
  'NEVER use English words, Latin letters, or romanized/"Banglish" spelling in either field.',
  'This holds even if the user speaks in English or mixes English and Bengali — always transcribe and reply in natural, everyday Bengali script.',
  'If the user speaks English, still write the transcription in Bengali script (transliterate the meaning naturally) and answer in Bengali.',
  '',
  'CRITICAL OUTPUT-FORMAT RULE — read carefully:',
  'You MUST respond with ONLY a single raw JSON object of the exact shape {"transcription": "...", "response": "..."}. Every single turn, with no exceptions.',
  'NEVER wrap the JSON in Markdown code fences (no ```), and NEVER add any prose, explanation, or text before or after the JSON object.',
  'The raw JSON object is the only valid response format; anything else is a failure.',
  '',
  // Stated in English for the same reason as the rules above (LLMs follow
  // an explicit English meta-instruction more reliably). This
  // prompt rule is the PRIMARY safety layer — it's the model itself deciding,
  // in-language, so it has a far lower false-positive rate than an external
  // classifier. Whether there's also a secondary, log-first classifier on top
  // of this depends on the provider's API integration — see each provider's
  // file for whether it adds one. Providers with none rely on this prompt
  // rule alone.
  'CRITICAL SAFETY RULE — read carefully:',
  'You MUST decline any request that is harmful, illegal, dangerous, hateful, sexual, or otherwise unsafe. NEVER produce such content.',
  'When declining, do NOT lecture or explain policies — respond safely and briefly in natural Bengali, and gently steer back to something you can help with.',
  'This rule holds in every turn and still uses the exact {"transcription": "...", "response": "..."} JSON shape in Bengali script.',
  '',
  'স্বাভাবিক, চলিত বাংলায় কথা বলুন — যেভাবে একজন বাংলাদেশি মানুষ সহজ কথোপকথনে বলেন। কখনও বইয়ের ভাষা, কেতাবি বা আড়ষ্ট, অনুবাদ-অনুবাদ বাংলা নয়। ব্যবহারকারীকে সবসময় "আপনি" বলে সম্বোধন করুন।',
  'উত্তর সবসময় {"transcription": "...", "response": "..."} — এই আকারে একটি JSON অবজেক্ট হিসেবে দিন: transcription-এ ব্যবহারকারী ঠিক যা বলেছেন তা হুবহু বাংলা হরফে লিখুন, আর response-এ ১-৪টি সংক্ষিপ্ত, সাবলীল বাক্যে উত্তর দিন।',
].join('\n');

/**
 * Per-modality instruction appended to the user turn, mirroring the four
 * branches in server.py's receiver loop. Chosen by which inputs are present.
 */
export const MODALITY_INSTRUCTIONS = Object.freeze({
  audioAndImage:
    'ব্যবহারকারী ক্যামেরা দেখানোর সময় আপনার সাথে কথা বললেন (অডিও ও ছবি)। তিনি যা বললেন তার উত্তর দিন, প্রাসঙ্গিক হলে আপনি যা দেখছেন তার উল্লেখ করুন।',
  audio:
    'ব্যবহারকারী এইমাত্র আপনার সাথে কথা বললেন। তিনি যা বললেন তার উত্তর দিন।',
  image:
    'ব্যবহারকারী তাঁদের ক্যামেরা আপনাকে দেখাচ্ছেন। আপনি যা দেখছেন তা বর্ণনা করুন।',
  // Fallback used when only typed text is present (no audio to transcribe).
  text:
    'ব্যবহারকারী লিখে বার্তা পাঠিয়েছেন। বার্তাটির উত্তর দিন।',
});

/**
 * Pick the modality instruction for a turn.
 * @param {{hasAudio: boolean, hasImage: boolean}} input
 */
export function modalityInstruction({ hasAudio, hasImage }) {
  if (hasAudio && hasImage) return MODALITY_INSTRUCTIONS.audioAndImage;
  if (hasAudio) return MODALITY_INSTRUCTIONS.audio;
  if (hasImage) return MODALITY_INSTRUCTIONS.image;
  return MODALITY_INSTRUCTIONS.text;
}

/**
 * Per-turn reminder of the JSON-output rule, appended alongside
 * LANGUAGE_REMINDER as the last thing the model reads. Backstops the
 * config-level constraint (see SYSTEM_PROMPT comment) in case a routed model
 * ignores or doesn't support strict JSON-schema output.
 */
export const JSON_FORMAT_REMINDER =
  'Reminder: respond with ONLY a raw JSON object {"transcription": "...", "response": "..."} — no code fences, no extra text.';

/**
 * Per-turn language reminder, appended as the *last* text the model reads.
 * Recency matters — repeating the hard constraint right before generation is
 * what actually keeps LLMs from slipping back into English.
 */
export const LANGUAGE_REMINDER =
  'আবার মনে করিয়ে দিই: transcription ও response — দুটোই কেবল বাংলা হরফে লিখুন, কোনো ইংরেজি বা রোমান অক্ষর নয়। (Reminder: write both fields in Bengali script only, never English/romanized.)';

/**
 * Canned Bengali refusal spoken in place of a flagged reply when SAFETY_MODE is
 * 'block'. Kept here (not inlined in orchestration) so all user-facing strings
 * stay in this single prompt file. In the default 'log' mode this is unused —
 * we only log; see routes/converse.js for why blocking is off by default.
 */
export const SAFE_REFUSAL =
  'দুঃখিত, এই বিষয়ে আমি সাহায্য করতে পারছি না। অন্য কিছু নিয়ে জানতে চাইলে বলুন, আমি সাহায্য করার চেষ্টা করব।';

/**
 * The full text part for a user turn: modality instruction + optional typed
 * text + the JSON-format and language reminders. Both LLM providers use this so
 * the turn is constructed identically regardless of provider.
 * @param {{hasAudio: boolean, hasImage: boolean, text?: string}} input
 * @returns {string}
 */
export function buildTurnText({ hasAudio, hasImage, text }) {
  let out = modalityInstruction({ hasAudio, hasImage });
  if (text) out += `\n\nব্যবহারকারীর বার্তা: ${text}`;
  out += `\n\n${JSON_FORMAT_REMINDER}\n${LANGUAGE_REMINDER}`;
  return out;
}

/**
 * The JSON object the model must produce every turn — the same
 * {transcription, response} shape server.py expects (originally carried by an
 * on-device `respond_to_user(transcription, response)` tool call, now emitted
 * as native structured JSON). Each provider builds its native structured-output
 * constraint from this shape (see the provider files for the concrete
 * mechanism). Field descriptions are in Bengali so the model stays in-language
 * while filling them.
 */
export const RESPONSE_SCHEMA = Object.freeze({
  name: 'bengali_turn_response',
  description: 'ব্যবহারকারীর ভয়েস বার্তার উত্তর দিন।',
  fields: Object.freeze({
    transcription:
      'ব্যবহারকারী ঠিক যা বলেছেন তার হুবহু প্রতিলিপি — অবশ্যই বাংলা হরফে লিখতে হবে, কোনো ইংরেজি বা রোমান অক্ষর নয়।',
    response:
      'ব্যবহারকারীর প্রতি আপনার আন্তরিক, চলিত বাংলা উত্তর — শুধু বাংলা হরফে, ১-৪টি ছোট বাক্যে।',
  }),
});
