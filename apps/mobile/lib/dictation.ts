/**
 * On-device dictation for calls and the composer, mirroring the web store's endpoint mode: the recognizer
 * reports words, and only a quiet gap measured here ends a turn. The recognizer's own
 * `isFinal` / `end` is a breath or an OS timeout, never the caller finishing a sentence.
 */

import { supportedSpeechTag } from "@rakazo/core";
import { Platform } from "react-native";
import { reportMobileError } from "./monitoring";

/** Quiet gap that ends an utterance. A natural breath is well under it, a finished turn well over. */
export const ENDPOINT_SILENCE_MS = 1_200;
const RESTART_MIN_MS = 250;
const RESTART_MAX_MS = 2_000;
/** Restarts in a row that hear nothing: the recognizer is wedged, stop churning the mic. */
const MAX_DEAD_RESTARTS = 5;
export const QUIET_RESTART_MS = 15_000;
/** Errors that mean this turn cannot recover; the rest are routine and `end` restarts. */
const FATAL_ERRORS = new Set([
  "not-allowed",
  "service-not-allowed",
  "audio-capture",
  "language-not-supported",
  "bad-grammar",
]);
/** Recoverable errors that indicate failure if the last empty attempt still has one. */
const TRANSIENT_ERRORS = new Set(["client", "busy", "network", "unknown", "too-many-requests"]);

export type DictationGiveUp = "idle" | "failed";

type ResultEvent = { isFinal: boolean; results: { transcript: string }[] };
type ErrorEvent = { error?: string };
type DictationEventMap = { result: ResultEvent; end: null; error: ErrorEvent };
type AudioSession = { category: string; categoryOptions: string[]; mode: string };

/** The slice of `expo-speech-recognition` this module needs, so tests can drive the events. */
export type SpeechRecognizer = {
  start(options: {
    lang: string;
    interimResults: boolean;
    continuous: boolean;
    iosCategory?: AudioSession;
  }): void;
  getAudioSessionCategoryAndOptionsIOS(): AudioSession;
  stop(): void;
  abort(): void;
  isRecognitionAvailable(): boolean;
  requestPermissionsAsync(): Promise<{ granted: boolean }>;
  getSupportedLocales(options: Record<string, never>): Promise<{ locales: string[] }>;
  addListener<Event extends keyof DictationEventMap>(
    event: Event,
    listener: (payload: DictationEventMap[Event]) => void,
  ): { remove: () => void };
  /**
   * `stop` ends one utterance but the recognizer stays ready for the next on the
   * same connection (the streaming server recognizer). Its authoritative final
   * revision only arrives after `stop`, and `abort` must still report `end` so a
   * quiet restart can take the microphone back.
   */
  readonly keepsUtterancesOpen?: boolean;
  /** Drops this recognizer's listeners without ending its connection. */
  dispose?(): void;
};

type Session = {
  recognizer: SpeechRecognizer;
  lang: string;
  call: boolean;
  onInterim?: (text: string) => void;
  onFinal: (text: string) => void;
  onGiveUp?: (reason: DictationGiveUp) => void;
  /** Quiet gap that ends the utterance. */
  endpointMs: number;
  /** The caller chose the gap, so the silence timer alone ends a quiet session. */
  ownEndpoint: boolean;
  /** The words last reported, so a repeated result is not mistaken for new speech. */
  reported: string;
  subs: { remove: () => void }[];
  /** Text from earlier recognizer sessions of the same utterance. */
  carried: string;
  /** Text of the recognizer session running now. */
  heard: string;
  silence?: ReturnType<typeof setTimeout>;
  restart?: ReturnType<typeof setTimeout>;
  quiet?: ReturnType<typeof setTimeout>;
  backoff: number;
  deadRestarts: number;
  /** Reset on each native start: only the last attempt classifies empty exhaustion. */
  transientError: boolean;
};

let injected: SpeechRecognizer | null = null;
/** Test seam: an injected recognizer replaces the native module. */
export function setSpeechRecognizer(recognizer: SpeechRecognizer | null): void {
  injected = recognizer;
  supported = null;
}

async function load(): Promise<SpeechRecognizer> {
  if (injected) return injected;
  // The native recognizer loads on first dictation, not with every screen that imports this.
  const { ExpoSpeechRecognitionModule } = await import("expo-speech-recognition");
  return ExpoSpeechRecognitionModule as unknown as SpeechRecognizer;
}

// The server's own streaming recognizer: live audio relays to it over the call's
// WebSocket, so dictation works wherever the system recognizer cannot.

/** Where the streaming recognizer listens, with the headers that signed-in requests carry. */
export type ServerAsrTarget = { url: string; headers: Record<string, string> };

/** The slice of the native module this file needs, so tests can drive the events. */
type StreamAsrModule = {
  isAvailable(): boolean;
  start(url: string, headers: Record<string, string>, lang: string): Promise<boolean>;
  stop(): void;
  abort(): void;
  addListener(
    event: "onResult",
    listener: (payload: { text: string; final: boolean }) => void,
  ): { remove: () => void };
  addListener(
    event: "onError",
    listener: (payload: { message: string }) => void,
  ): {
    remove: () => void;
  };
  addListener(event: "onEnd", listener: () => void): { remove: () => void };
};

let serverTarget: ServerAsrTarget | null = null;

/** Points dictation at the server's streaming recognizer, or back at the device's own. */
export function setServerAsr(target: ServerAsrTarget | null): void {
  serverTarget = target;
}

let streamAsrLoader: Promise<StreamAsrModule | null> | null = null;
let injectedStreamAsr: StreamAsrModule | null | undefined;

/** Test seam: an injected module replaces the native one; null means none. */
export function setStreamAsrModule(module: StreamAsrModule | null): void {
  injectedStreamAsr = module;
  streamAsrLoader = null;
}

function loadStreamAsr(): Promise<StreamAsrModule | null> {
  if (injectedStreamAsr !== undefined) return Promise.resolve(injectedStreamAsr);
  streamAsrLoader ??= (async () => {
    if (Platform.OS !== "android") return null;
    try {
      const { requireNativeModule } = await import("expo-modules-core");
      const native = requireNativeModule<StreamAsrModule>("RakazoStreamAsr");
      return native && typeof native.start === "function" ? native : null;
    } catch {
      return null;
    }
  })();
  return streamAsrLoader;
}

/**
 * The server recognizer as the `SpeechRecognizer` shape the session logic drives.
 * Its live results are short windows of the words being spoken right now — not
 * whole revisions — so they are joined into one growing transcript for display,
 * and the punctuated revision the server sends once the utterance ends is the
 * only final that counts.
 */
function serverRecognizer(target: ServerAsrTarget, native: StreamAsrModule): SpeechRecognizer {
  const resultListeners = new Set<(event: ResultEvent) => void>();
  const endListeners = new Set<() => void>();
  const errorListeners = new Set<(event: ErrorEvent) => void>();
  /** Words an earlier final of this session already reported. */
  let banked = "";
  /** The growing words of the utterance being spoken. */
  let heard = "";
  const emitResult = (text: string, isFinal: boolean) => {
    for (const listener of resultListeners) listener({ isFinal, results: [{ transcript: text }] });
  };
  const subs = [
    native.addListener("onResult", ({ text, final }) => {
      if (final) {
        // The revision covers this utterance since its begin; anything the live
        // windows already added is replaced by it.
        heard = "";
        const revision = text.replace(/\s+/g, " ").trim();
        if (!revision) return;
        banked = join(banked, revision);
        emitResult(revision, true);
        return;
      }
      // The live windows are sequential slivers of the words being spoken; they
      // join, and the display grows with them.
      heard = join(heard, text.trim());
      if (!heard) return;
      emitResult(heard, false);
    }),
    native.addListener("onError", () =>
      errorListeners.forEach((listener) => listener({ error: "network" })),
    ),
    native.addListener("onEnd", () => endListeners.forEach((listener) => listener())),
  ];
  return {
    keepsUtterancesOpen: true,
    start(options) {
      banked = "";
      heard = "";
      // A slow or refused connection surfaces as its error event, like the OS engines.
      void native.start(target.url, target.headers, options.lang).then(
        (opened) => {
          if (!opened)
            errorListeners.forEach((listener) => listener({ error: "service-not-allowed" }));
        },
        () => errorListeners.forEach((listener) => listener({ error: "network" })),
      );
    },
    stop() {
      // Marks the utterance's end; the connection stays for the next one.
      native.stop();
    },
    abort() {
      // The native module ends quietly on abort; the session logic restarts on
      // `end`, so report it here while the bridge still can.
      endListeners.forEach((listener) => listener());
      native.abort();
      for (const sub of subs) sub.remove();
    },
    dispose() {
      for (const sub of subs) sub.remove();
    },
    isRecognitionAvailable() {
      return native.isAvailable();
    },
    async requestPermissionsAsync() {
      return { granted: native.isAvailable() };
    },
    getSupportedLocales() {
      return Promise.resolve({ locales: [] });
    },
    addListener(event, listener) {
      if (event === "result") resultListeners.add(listener as (event: ResultEvent) => void);
      else if (event === "end") endListeners.add(listener as () => void);
      else errorListeners.add(listener as (event: ErrorEvent) => void);
      return {
        remove: () => {
          resultListeners.delete(listener as (event: ResultEvent) => void);
          endListeners.delete(listener as () => void);
          errorListeners.delete(listener as (event: ErrorEvent) => void);
        },
      };
    },
    // Not reached on Android; kept for the interface.
    getAudioSessionCategoryAndOptionsIOS() {
      return { category: "", categoryOptions: [], mode: "" };
    },
  } satisfies SpeechRecognizer;
}

/** The recognizer a dictation session should use, when the server offers streaming. */
async function loadServer(target: ServerAsrTarget | null): Promise<SpeechRecognizer | null> {
  if (!target) return null;
  const native = await loadStreamAsr();
  if (!native || !native.isAvailable()) return null;
  return serverRecognizer(target, native);
}

let supported: Promise<string[]> | null = null;

/**
 * iOS starts a recognizer only for a tag it lists exactly. Android takes any regional tag, and
 * asking it would start its recognition service first, so it lists nothing here.
 */
function supportedLocales(recognizer: SpeechRecognizer): Promise<string[]> {
  if (Platform.OS !== "ios") return Promise.resolve([]);
  supported ??= recognizer.getSupportedLocales({}).then(
    (result) => result.locales,
    () => [],
  );
  return supported;
}

/** A session older than this one can never deliver a final. */
let token = 0;
let active: Session | null = null;

/** True when the device can recognise speech itself and the caller allowed it. */
export async function available(): Promise<boolean> {
  try {
    const recognizer = (await loadServer(serverTarget)) ?? (await load());
    if (!recognizer.isRecognitionAvailable()) return false;
    return (await recognizer.requestPermissionsAsync()).granted;
  } catch {
    return false;
  }
}

export function stop(): void {
  const session = active;
  active = null;
  token += 1;
  if (!session) return;
  clearTimeout(session.silence);
  clearTimeout(session.restart);
  clearTimeout(session.quiet);
  for (const sub of session.subs) sub.remove();
  try {
    session.recognizer.abort();
  } catch {
    // already stopped
  }
}

/** Ends the running session now and delivers what it heard. */
export function finishListening(): void {
  if (active) finish(active, "idle");
}

/**
 * Opens the microphone until a quiet gap ends the utterance, or `signal` aborts it.
 * A caller's own `endpointMs` also counts from the start, so a mic that never hears
 * anything closes too.
 */
export async function listen(opts: {
  onInterim?: (text: string) => void;
  onFinal: (text: string) => void;
  onGiveUp?: (reason: DictationGiveUp) => void;
  signal?: AbortSignal;
  lang?: string;
  endpointMs?: number;
  call?: boolean;
}): Promise<void> {
  // A cancelled request can arrive after a newer session started; it must not stop that one.
  if (opts.signal?.aborted) return;
  stop();
  const mine = token;
  // The server's streaming recognizer comes first; the device's own engine answers
  // wherever the server offers none.
  const recognizer = (await loadServer(serverTarget)) ?? (await load());
  const lang = supportedSpeechTag(opts.lang || "en-US", await supportedLocales(recognizer));
  // A hang-up or a newer session landed while the native module was loading.
  if (token !== mine) return;
  // A signal aborted during loading never fires the listener added below, so check it here.
  if (opts.signal?.aborted) return;
  const session: Session = {
    recognizer,
    lang,
    call: opts.call ?? false,
    onInterim: opts.onInterim,
    onFinal: opts.onFinal,
    onGiveUp: opts.onGiveUp,
    endpointMs: opts.endpointMs ?? ENDPOINT_SILENCE_MS,
    ownEndpoint: opts.endpointMs !== undefined,
    reported: "",
    subs: [],
    carried: "",
    heard: "",
    backoff: RESTART_MIN_MS,
    deadRestarts: 0,
    transientError: false,
  };
  active = session;
  opts.signal?.addEventListener(
    "abort",
    () => {
      if (active === session) stop();
    },
    { once: true },
  );
  session.subs = [
    recognizer.addListener("result", (event) => onResult(session, event)),
    recognizer.addListener("end", () => onEnd(session)),
    recognizer.addListener("error", (event) => onError(session, event)),
  ];
  try {
    start(session);
  } catch {
    giveUp(session, "failed", "start-failed");
    return;
  }
  if (session.ownEndpoint) armSilence(session);
}

/** Ends the utterance once nothing new is heard for the session's quiet gap. */
function armSilence(session: Session): void {
  clearTimeout(session.silence);
  session.silence = setTimeout(() => finish(session, "idle"), session.endpointMs);
}

function start(session: Session): void {
  if (active !== session) return;
  session.transientError = false;
  session.recognizer.start({
    lang: session.lang,
    interimResults: true,
    continuous: true,
    ...(session.call
      ? { iosCategory: session.recognizer.getAudioSessionCategoryAndOptionsIOS() }
      : {}),
  });
  watchQuiet(session);
}

function watchQuiet(session: Session): void {
  clearTimeout(session.quiet);
  session.quiet = setTimeout(() => {
    if (active !== session) return;
    try {
      session.recognizer.abort();
    } catch {
      giveUp(session, "failed", "start-failed");
    }
  }, QUIET_RESTART_MS);
}

function onResult(session: Session, event: ResultEvent): void {
  if (active !== session) return;
  const heard = event.results?.[0]?.transcript ?? "";
  session.backoff = RESTART_MIN_MS;
  session.deadRestarts = 0;
  if (heard.trim()) watchQuiet(session);
  // Android reports a phrase once and starts over, iOS grows one transcript: folding a
  // final into the carried text and clearing the live one covers both.
  if (event.isFinal) {
    session.carried = join(session.carried, heard);
    session.heard = "";
  } else {
    session.heard = heard;
  }
  const text = join(session.carried, session.heard);
  if (!text) return;
  // With the caller's own pause limit, only new words count as being heard.
  if (session.ownEndpoint && text === session.reported) return;
  session.reported = text;
  session.onInterim?.(text);
  // Any result means the caller was just heard, so the quiet gap restarts here — including
  // a phrase the recognizer finalises after repeating it, whose boundary is a breath.
  armSilence(session);
}

function onEnd(session: Session): void {
  if (active !== session) return;
  clearTimeout(session.quiet);
  // iOS ends a session on its own — on a pause, an interruption, or its own cap — and that
  // says nothing about whether the caller finished. Pick the microphone straight back up.
  session.carried = join(session.carried, session.heard);
  session.heard = "";
  session.deadRestarts += 1;
  if (session.deadRestarts > MAX_DEAD_RESTARTS) {
    const failed = session.transientError && !session.carried;
    // A recognizer that keeps failing gives up; one that just ended quietly during a pause
    // keeps restarting when the caller's own silence timer decides when the pause is over.
    if (failed || !session.ownEndpoint) {
      giveUp(session, failed ? "failed" : "idle", failed ? "transient-restarts" : "empty-restarts");
      return;
    }
  }
  clearTimeout(session.restart);
  const delay = session.backoff;
  session.backoff = Math.min(RESTART_MAX_MS, session.backoff * 2);
  session.restart = setTimeout(() => {
    if (active !== session) return;
    try {
      start(session);
    } catch {
      giveUp(session, "failed", "start-failed");
    }
  }, delay);
}

function onError(session: Session, event: ErrorEvent): void {
  if (active !== session) return;
  if (!event?.error) return;
  if (TRANSIENT_ERRORS.has(event.error)) session.transientError = true;
  if (FATAL_ERRORS.has(event.error)) giveUp(session, "failed", event.error);
}

function giveUp(session: Session, reason: DictationGiveUp, code: string): void {
  if (active !== session) return;
  if (reason === "failed") {
    reportMobileError(new Error(`Speech recognition stopped: ${code}`), "voice.microphone", {
      source: "dictation",
    });
  }
  finish(session, reason);
}

/** How long the ended utterance's authoritative revision may take to land. */
export const FINAL_REVISION_WAIT_MS = 1_500;

function finish(session: Session, reason?: DictationGiveUp): void {
  if (active !== session) return;
  active = null;
  token += 1;
  const mine = token;
  clearTimeout(session.silence);
  clearTimeout(session.restart);
  clearTimeout(session.quiet);
  const deliver = () => {
    // A newer session took the microphone while the revision was awaited.
    if (token !== mine) return;
    const text = join(session.carried, session.heard).trim();
    if (text) session.onFinal(text);
    else if (reason) session.onGiveUp?.(reason);
  };
  if (session.recognizer.keepsUtterancesOpen) {
    // The words the live windows showed are fragments; end the utterance and let
    // the server's punctuated revision replace them before they are delivered.
    // The recognizer's connection stays open for the next utterance of the call.
    for (const sub of session.subs) sub.remove();
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      clearTimeout(wait);
      catcher.remove();
      session.recognizer.dispose?.();
      deliver();
    };
    const catcher = session.recognizer.addListener("result", (event) => {
      if (!event.isFinal) return;
      session.heard = event.results?.[0]?.transcript ?? session.heard;
      settle();
    });
    const wait = setTimeout(settle, FINAL_REVISION_WAIT_MS);
    try {
      session.recognizer.stop();
    } catch {
      settle();
    }
    return;
  }
  for (const sub of session.subs) sub.remove();
  try {
    session.recognizer.abort();
  } catch {
    // already stopped
  }
  deliver();
}

/** CJK text joins without a space; the windows the live decoder sends are unspaced. */
const cjk = /[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef]/;

function join(left: string, right: string): string {
  if (!left || !right) return `${left}${right}`.replace(/\s+/g, " ").trim();
  const last = left[left.length - 1] ?? "";
  const first = right[0] ?? "";
  const spaced = cjk.test(last) || cjk.test(first) ? "" : " ";
  return `${left}${spaced}${right}`.replace(/\s+/g, " ").trim();
}
