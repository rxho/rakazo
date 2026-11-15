import { spokenMemory, words } from "./echo.js";

/** Lower echo match while audio plays: most of what the mic hears is the speaker. */
const PLAYBACK_ECHO_RATIO = 0.4;
/** The only one-word turns worth cutting a reply short for. */
const INTERRUPT_WORDS = new Set([
  "stop",
  "wait",
  "hold on",
  "pause",
  "no",
  "停",
  "等等",
  "等一下",
  "停一下",
  "别说了",
  "不要",
]);

/**
 * How long an interim phrase must stand before it cuts playback.
 * The final transcript arrives later, after the reply has already finished.
 */
export const INTERIM_BARGE_IN_MS = 300;

/** A phrase stands on its own: two Latin words, or two CJK characters. */
function isPhrase(cleaned: string): boolean {
  const tokens = words(cleaned);
  if (tokens.length >= 2) return true;
  // A two-character CJK phrase is a single bigram token.
  return /^[\u2e80-\u9fff\uf900-\ufaff]{2}$/.test(cleaned);
}

/** A sentence, or one interruption word, that is not the reply leaking back into the mic. */
export function isCallBargeIn(text: string): boolean {
  if (spokenMemory.isEcho(text, PLAYBACK_ECHO_RATIO)) return false;
  const cleaned = cleanWords(text);
  if (INTERRUPT_WORDS.has(cleaned)) return true;
  return isPhrase(cleaned);
}

/** An interim is revised word by word, so one stray word never cuts playback. */
export function isInterimCallBargeIn(text: string): boolean {
  return isPhrase(cleanWords(text)) && !spokenMemory.isEcho(text, PLAYBACK_ECHO_RATIO);
}

function cleanWords(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/**
 * Counts down an interim phrase heard over a reply: one that stands for
 * INTERIM_BARGE_IN_MS calls `onBargeIn`, and anything that no longer qualifies resets it.
 */
export function createInterimBargeIn(onBargeIn: () => void) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const clear = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  return {
    hear(text: string): void {
      if (!isInterimCallBargeIn(text)) {
        clear();
        return;
      }
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        onBargeIn();
      }, INTERIM_BARGE_IN_MS);
    },
    clear,
  };
}
