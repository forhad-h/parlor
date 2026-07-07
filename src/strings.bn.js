/*
 * Bengali UI strings — single source of truth for every user-facing string in
 * index.html when running in hosted mode.
 *
 * Why a flat object and not an i18n framework: this app only ever has one
 * language live per backend (decided by NODE_SERVICE_URL, see server.py's
 * `/strings.js` route), so i18next would be over-engineering. Centralising
 * here (instead of scattering literals through index.html) is the point — it
 * proves every string was located and makes tone edits a one-file change.
 * strings.en.js mirrors this file field-for-field for on-device mode.
 *
 * Loaded as a plain script (index.html has no build step / module system), so
 * it publishes a single `window.STRINGS`. `applyStaticStrings()` in index.html
 * drives the initial DOM from this file; the static HTML carries matching
 * English defaults (the default run mode) only to avoid a flash before the
 * script runs.
 *
 * Note on tone: everyday, spoken Bengali — short and warm, not bookish. "কণ্ঠ"
 * (voice) / "উত্তর" (reply) read naturally as latency labels; a literal
 * "টেক্সট-টু-স্পিচ" would feel robotic.
 */
window.STRINGS = {
  // <html lang> and document title.
  htmlLang: 'bn',
  title: 'Parlor — বাংলা কণ্ঠ-সহকারী',

  // Header: model/assistant label. Kept provider-neutral (the backend model is
  // swappable), so it names what it *is* rather than a specific model.
  modelLabel: 'বাংলা সহকারী',

  // Language chip (bottom bar; replaces the original "On-device" pill, which is
  // no longer accurate once the brain runs via hosted APIs). Full markup
  // (icon + label) so each language file owns its own pill contents.
  langPill: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="8" cy="8" r="6"/><path d="M2 8h12"/><path d="M8 2c1.9 1.9 1.9 10.1 0 12M8 2c-1.9 1.9-1.9 10.1 0 12"/></svg> বাংলা',

  // Connection status pill (top-right).
  status: {
    disconnected: 'বিচ্ছিন্ন',
    connected: 'সংযুক্ত',
    processing: 'প্রসেসিং',
  },

  // Assistant state indicator (bottom-centre).
  state: {
    loading: 'লোড হচ্ছে…',
    listening: 'শুনছি',
    thinking: 'ভাবছি…',
    speaking: 'বলছি',
  },

  // Camera toggle button.
  camera: {
    on: 'ক্যামেরা চালু',
    off: 'ক্যামেরা বন্ধ',
  },

  // Shown under a user message when a camera frame was sent with it.
  withCamera: 'ক্যামেরাসহ',

  // Transcript metadata (latency). Functions so the number stays formatting-free.
  meta: {
    llm: (t) => `উত্তর ${t}s`,
    tts: (t) => ` · কণ্ঠ ${t}s`,
  },
};
