/*
 * English UI strings — single source of truth for every user-facing string in
 * index.html when running in on-device (default) mode.
 *
 * Mirrors strings.bn.js field-for-field. Which file backs `window.STRINGS` is
 * decided server-side (see server.py's `/strings.js` route): on-device mode
 * serves this file, hosted mode serves strings.bn.js. This is what lets the
 * same index.html present two different UIs depending on which backend is
 * actually running.
 */
window.STRINGS = {
  // <html lang> and document title.
  htmlLang: 'en',
  title: 'Parlor',

  // Header: model/assistant label.
  modelLabel: 'Gemma 4 E2B',

  // Language badge next to the logo (header). Empty on-device — the badge
  // exists to name a non-English UI language, which doesn't apply here.
  langBadge: '',

  // Run-mode chip (bottom bar). Full markup (icon + label) so each language
  // file owns its own pill contents.
  langPill: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="4" width="12" height="9" rx="2"/><path d="M5 4V3a3 3 0 0 1 6 0v1"/></svg> On-device',

  // Connection status pill (top-right).
  status: {
    disconnected: 'Disconnected',
    connected: 'Connected',
    processing: 'Processing',
  },

  // Assistant state indicator (bottom-centre).
  state: {
    loading: 'Loading...',
    listening: 'Listening',
    thinking: 'Thinking...',
    speaking: 'Speaking',
  },

  // Camera toggle button.
  camera: {
    on: 'Camera On',
    off: 'Camera Off',
  },

  // Shown under a user message when a camera frame was sent with it.
  withCamera: 'with camera',

  // Transcript metadata (latency).
  meta: {
    llm: (t) => `LLM ${t}s`,
    tts: (t) => ` · TTS ${t}s`,
  },
};
