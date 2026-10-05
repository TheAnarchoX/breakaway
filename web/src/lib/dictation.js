// Dictation: the browser's speech recognition (the Web Speech API) typing into a text field.
// Chrome, Edge, and Safari have it; Firefox doesn't, so the board shows no microphone there.
// Brave has the API but turns off the speech service behind it, so every try ends in a
// 'network' error: the board shows no microphone there either.
// Where the browser can recognise speech on the device it does; otherwise the browser sends
// the audio to its own speech service, and only while the person has dictation on.

/** @typedef {{ transcript: string }} Alternative */
/** @typedef {ArrayLike<ArrayLike<Alternative>>} Results */

/** @returns {any} the browser's SpeechRecognition constructor, if it has one */
function recognitionClass() {
  if (typeof window === 'undefined') return undefined;
  const w = /** @type {any} */ (window);
  return w.SpeechRecognition ?? w.webkitSpeechRecognition;
}

/**
 * Whether a browser with this navigator and recognition class can dictate: it has the API, and
 * it isn't Brave, which has it but never reaches a speech service.
 * @param {any} nav
 * @param {unknown} Recognition
 */
export function dictationWorks(nav, Recognition) {
  return Boolean(Recognition) && !nav?.brave;
}

/** Whether this browser can dictate at all. */
export const canDictate = dictationWorks(typeof navigator === 'undefined' ? undefined : navigator, recognitionClass());

/** Per language, whether the browser can already recognise it on the device, once it's known. */
const onDevice = /** @type {Map<string, boolean | undefined>} */ (new Map());

/**
 * Asks the browser, ahead of the click, whether it can recognise the person's language on the
 * device (Chrome's on-device models), so `dictate` can choose without waiting: the browser only
 * starts listening inside the click's user activation. It never downloads a model.
 * @param {string} [lang]
 */
export function checkOnDevice(lang = dictationLang()) {
  const Recognition = recognitionClass();
  if (!canDictate || onDevice.has(lang) || typeof Recognition?.available !== 'function') return;
  onDevice.set(lang, undefined);
  Promise.resolve()
    .then(() => Recognition.available({ langs: [lang], processLocally: true }))
    .then((/** @type {string} */ status) => onDevice.set(lang, status === 'available'))
    .catch(() => onDevice.set(lang, false));
}

/** The language to listen for: the person's own, as the browser reports it. */
export function dictationLang() {
  return (typeof navigator !== 'undefined' && navigator.language) || 'en-US';
}

/**
 * Everything heard so far in one go, from the browser's results: each result's best guess,
 * joined, with the spaces tidied.
 * @param {Results} results
 */
export function transcriptOf(results) {
  let text = '';
  for (let i = 0; i < results.length; i++) text += ` ${results[i][0]?.transcript ?? ''}`;
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * The text to put at `start`, in place of the `shown` characters an earlier result put there:
 * what was heard, after a space when it follows a word, cut to fit the field's `maxLength`.
 * @param {{ value: string, start: number, shown: number, text: string, maxLength?: number }} at
 */
export function dictationText({ value, start, shown, text, maxLength }) {
  if (!text) return '';
  const before = value.slice(0, start);
  const insert = (before && !/\s$/.test(before) ? ' ' : '') + text;
  if (maxLength == null || maxLength < 0) return insert;
  return insert.slice(0, Math.max(0, maxLength - (value.length - shown)));
}

/**
 * What to say when dictation stops with an error, or null when there's nothing to say (the
 * person stopped it, or didn't say anything).
 * @param {string} code the SpeechRecognitionErrorEvent's `error`
 * @param {string} [lang]
 */
export function dictationError(code, lang = dictationLang()) {
  switch (code) {
    case 'aborted':
    case 'no-speech':
      return null;
    case 'not-allowed':
    case 'service-not-allowed':
      return 'Couldn’t start dictating. Allow the microphone for the board in your browser’s site settings, then try again.';
    case 'audio-capture':
      return 'No microphone found. Connect one, then try again.';
    case 'network':
      return 'Couldn’t reach your browser’s speech service. Check your connection, then try again.';
    case 'language-not-supported':
      return `Your browser can’t dictate in ${lang}. Type it instead, or change your browser’s language.`;
    default:
      return 'Dictation stopped. Try again.';
  }
}

/**
 * Starts dictating into `field` at its cursor (or over its selection). Words appear as they're
 * heard and settle as the browser finalises them. Typing in the field, or `stop()`, ends it.
 * Each change goes in as an `input` event, so controlled and uncontrolled fields both see it.
 * @param {HTMLTextAreaElement | HTMLInputElement} field
 * @param {{ onEnd: () => void, onError: (message: string) => void }} handlers
 * @returns {() => void} stop
 */
export function dictate(field, { onEnd, onError }) {
  const Recognition = recognitionClass();
  const recognition = new Recognition();
  const lang = dictationLang();
  recognition.lang = lang;
  recognition.continuous = true;
  recognition.interimResults = true;

  const start = field.selectionStart ?? field.value.length;
  // Dictating over a selection replaces it, like typing would.
  let shown = (field.selectionEnd ?? start) - start;
  let writing = false;
  let ended = false;

  const put = (/** @type {string} */ text) => {
    const insert = dictationText({ value: field.value, start, shown, text, maxLength: field.maxLength });
    writing = true;
    field.setRangeText(insert, start, start + shown, 'end');
    field.dispatchEvent(new Event('input', { bubbles: true }));
    writing = false;
    shown = insert.length;
  };
  const typed = () => {
    if (!writing) recognition.abort();
  };
  field.addEventListener('input', typed);

  recognition.onresult = (/** @type {any} */ event) => put(transcriptOf(event.results));
  recognition.onerror = (/** @type {any} */ event) => {
    const message = dictationError(event.error, lang);
    if (message) onError(message);
  };
  let started = false;
  const finish = () => {
    if (ended) return;
    ended = true;
    field.removeEventListener('input', typed);
    onEnd();
  };
  recognition.onend = finish;

  // Start now, inside the click: the browser asks for the microphone only then. Recognise on the
  // device where checkOnDevice found the browser already can, so the audio stays on it.
  if ('processLocally' in recognition && onDevice.get(lang)) recognition.processLocally = true;
  try {
    recognition.start();
    started = true;
  } catch {
    onError(dictationError('unknown', lang) ?? '');
    finish();
  }

  // Stopping lets the browser finish the words it's still working out; they still go in.
  return () => {
    if (started && !ended) recognition.stop();
  };
}
