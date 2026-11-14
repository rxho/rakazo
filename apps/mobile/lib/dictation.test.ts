import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SpeechRecognizer } from "./dictation";
import {
  ENDPOINT_SILENCE_MS,
  FINAL_REVISION_WAIT_MS,
  finishListening,
  listen,
  QUIET_RESTART_MS,
  setServerAsr,
  setSpeechRecognizer,
  setStreamAsrModule,
  stop,
} from "./dictation";
import { reportMobileError } from "./monitoring";

vi.mock("./monitoring", () => ({ reportMobileError: vi.fn() }));
vi.mock("react-native", () => ({ Platform: { OS: "ios" } }));

type Listener = (payload: never) => void;

/** Longest restart delay the module backs off to. */
const RESTART_CAP_MS = 2_000;

const CALL_SESSION = {
  category: "playAndRecord",
  categoryOptions: ["mixWithOthers", "defaultToSpeaker", "allowBluetooth"],
  mode: "default",
};

function fakeRecognizer() {
  const listeners = new Map<string, Set<Listener>>();
  const start = vi.fn();
  const abort = vi.fn();
  const recognizer: SpeechRecognizer = {
    start,
    stop: vi.fn(),
    abort,
    isRecognitionAvailable: () => true,
    requestPermissionsAsync: async () => ({ granted: true }),
    getSupportedLocales: async () => ({ locales: [] }),
    getAudioSessionCategoryAndOptionsIOS: () => CALL_SESSION,
    addListener: (event, listener) => {
      const set = listeners.get(event) ?? new Set();
      set.add(listener as Listener);
      listeners.set(event, set);
      return {
        remove: () => {
          set.delete(listener as Listener);
        },
      };
    },
  };
  const emit = (event: string, payload: unknown) => {
    for (const listener of [...(listeners.get(event) ?? [])])
      (listener as (p: unknown) => void)(payload);
  };
  return {
    recognizer,
    start,
    abort,
    hear: (transcript: string, isFinal = false) =>
      emit("result", { isFinal, results: [{ transcript, confidence: 0.9 }] }),
    end: () => emit("end", null),
    fail: (error: string) => emit("error", { error, message: error }),
  };
}

let fake: ReturnType<typeof fakeRecognizer>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(reportMobileError).mockClear();
  fake = fakeRecognizer();
  setSpeechRecognizer(fake.recognizer);
});

afterEach(() => {
  stop();
  setSpeechRecognizer(null);
  vi.useRealTimers();
});

describe("mobile dictation", () => {
  it("uses the supported iOS regional fallback", async () => {
    const locales = vi.fn(async () => ({ locales: ["es-ES", "es-MX"] }));
    fake.recognizer.getSupportedLocales = locales;
    await listen({ lang: "es-AR", onFinal: vi.fn() });
    expect(locales).toHaveBeenCalledWith({});
    expect(fake.start).toHaveBeenCalledWith(expect.objectContaining({ lang: "es-MX" }));
  });

  it("keeps the requested locale when the supported list fails", async () => {
    fake.recognizer.getSupportedLocales = async () => {
      throw new Error("Unavailable");
    };
    await listen({ lang: "es-CL", onFinal: vi.fn() });
    expect(fake.start).toHaveBeenCalledWith(expect.objectContaining({ lang: "es-CL" }));
  });

  it("closes a mic that hears nothing within its own endpoint", async () => {
    const onGiveUp = vi.fn();
    await listen({ onFinal: vi.fn(), onGiveUp, endpointMs: 30_000 });
    vi.advanceTimersByTime(29_999);
    expect(onGiveUp).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onGiveUp).toHaveBeenCalledWith("idle");
  });

  it("does not count a repeated result as new words against its own endpoint", async () => {
    const onFinal = vi.fn();
    await listen({ onFinal, endpointMs: 30_000 });
    fake.hear("buy milk");
    for (let repeat = 0; repeat < 3; repeat += 1) {
      vi.advanceTimersByTime(10_000);
      fake.hear("buy milk");
    }
    expect(onFinal).toHaveBeenCalledWith("buy milk");
  });

  it("restarts through a quiet pause until its own endpoint ends it", async () => {
    const onFinal = vi.fn();
    await listen({ onFinal, endpointMs: 30_000 });
    fake.hear("buy milk", true);
    // The recognizer ends on its own again and again while nothing is said.
    for (let ended = 0; ended < 8; ended += 1) {
      fake.end();
      vi.advanceTimersByTime(RESTART_CAP_MS);
    }
    expect(onFinal).not.toHaveBeenCalled();
    vi.advanceTimersByTime(30_000);
    expect(onFinal).toHaveBeenCalledWith("buy milk");
  });

  it("keeps listening through pauses shorter than its endpoint until finished", async () => {
    const onFinal = vi.fn();
    await listen({ onFinal, endpointMs: 30_000 });
    fake.hear("buy milk", true);
    vi.advanceTimersByTime(ENDPOINT_SILENCE_MS * 5);
    fake.hear("and eggs");
    expect(onFinal).not.toHaveBeenCalled();
    finishListening();
    expect(onFinal).toHaveBeenCalledWith("buy milk and eggs");
    expect(fake.abort).toHaveBeenCalled();
  });

  it("keeps the call's current audio session only when a call is listening", async () => {
    await listen({ onFinal: vi.fn(), call: true });
    expect(fake.start).toHaveBeenLastCalledWith(
      expect.objectContaining({ iosCategory: CALL_SESSION }),
    );
  });

  it("ends the turn only after the silence window, not on the recognizer's own final", async () => {
    const onFinal = vi.fn();
    const interims: string[] = [];
    await listen({ onFinal, onInterim: (text) => interims.push(text) });
    expect(fake.start).toHaveBeenCalledWith({
      lang: "en-US",
      interimResults: true,
      continuous: true,
    });

    fake.hear("how is the");
    fake.hear("how is the", true);
    vi.advanceTimersByTime(ENDPOINT_SILENCE_MS - 400);
    expect(onFinal).not.toHaveBeenCalled();

    fake.hear("deploy going");
    vi.advanceTimersByTime(ENDPOINT_SILENCE_MS - 1);
    expect(onFinal).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);

    expect(onFinal).toHaveBeenCalledTimes(1);
    expect(onFinal).toHaveBeenCalledWith("how is the deploy going");
    expect(interims).toEqual(["how is the", "how is the", "how is the deploy going"]);
  });

  it("restarts a session that reports nothing for too long", async () => {
    const onFinal = vi.fn();
    await listen({ onFinal });
    vi.advanceTimersByTime(QUIET_RESTART_MS - 1);
    expect(fake.abort).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fake.abort).toHaveBeenCalledOnce();

    fake.end();
    vi.advanceTimersByTime(250);
    expect(fake.start).toHaveBeenCalledTimes(2);
    expect(onFinal).not.toHaveBeenCalled();
  });

  it("restarts a quiet session that keeps reporting empty results", async () => {
    await listen({ onFinal: vi.fn() });
    for (let elapsed = 0; elapsed < QUIET_RESTART_MS; elapsed += 5_000) {
      vi.advanceTimersByTime(5_000);
      fake.hear("");
    }
    expect(fake.abort).toHaveBeenCalledOnce();
  });

  it("keeps a session that is hearing the caller", async () => {
    await listen({ onFinal: vi.fn() });
    vi.advanceTimersByTime(QUIET_RESTART_MS - 100);
    fake.hear("still there");
    vi.advanceTimersByTime(100);
    expect(fake.abort).not.toHaveBeenCalled();
  });

  it("restarts a session that ended mid-turn and carries the words already heard", async () => {
    const onFinal = vi.fn();
    await listen({ onFinal });
    fake.hear("hello there");

    fake.end();
    expect(onFinal).not.toHaveBeenCalled();
    vi.advanceTimersByTime(250);
    expect(fake.start).toHaveBeenCalledTimes(2);

    fake.hear("friend");
    vi.advanceTimersByTime(ENDPOINT_SILENCE_MS);
    expect(onFinal).toHaveBeenCalledWith("hello there friend");
  });

  it("gives up after restarts that hear nothing", async () => {
    const onFinal = vi.fn();
    await listen({ onFinal });
    fake.hear("half a sentence");
    for (let attempt = 0; attempt < 6; attempt += 1) {
      fake.end();
      vi.advanceTimersByTime(RESTART_CAP_MS);
    }
    expect(onFinal).toHaveBeenCalledTimes(1);
    expect(onFinal).toHaveBeenCalledWith("half a sentence");
  });

  it("notifies the caller when empty restarts give up", async () => {
    const onFinal = vi.fn();
    const onGiveUp = vi.fn();
    await listen({ onFinal, onGiveUp });
    for (let attempt = 0; attempt < 6; attempt += 1) {
      fake.end();
      vi.advanceTimersByTime(RESTART_CAP_MS);
    }
    expect(onGiveUp).toHaveBeenCalledExactlyOnceWith("idle");
    expect(reportMobileError).not.toHaveBeenCalled();
    expect(onFinal).not.toHaveBeenCalled();
    expect(fake.abort).toHaveBeenCalled();
    fake.end();
    expect(onGiveUp).toHaveBeenCalledOnce();
  });

  it.each([
    "not-allowed",
    "service-not-allowed",
    "audio-capture",
    "language-not-supported",
    "bad-grammar",
  ])("notifies the caller when recognition fails with %s", async (error) => {
    const onFinal = vi.fn();
    const onGiveUp = vi.fn();
    await listen({ onFinal, onGiveUp });
    fake.fail(error);
    expect(onGiveUp).toHaveBeenCalledExactlyOnceWith("failed");
    expect(reportMobileError).toHaveBeenCalledExactlyOnceWith(
      new Error(`Speech recognition stopped: ${error}`),
      "voice.microphone",
      { source: "dictation" },
    );
    expect(onFinal).not.toHaveBeenCalled();
    fake.end();
    vi.advanceTimersByTime(RESTART_CAP_MS);
    expect(fake.start).toHaveBeenCalledOnce();
  });

  it.each(["no-speech", "speech-timeout", "interrupted", "aborted"])(
    "restarts after routine %s without disabling recognition",
    async (error) => {
      const onGiveUp = vi.fn();
      await listen({ onFinal: vi.fn(), onGiveUp });
      fake.fail(error);
      fake.end();
      vi.advanceTimersByTime(250);
      expect(fake.start).toHaveBeenCalledTimes(2);
      expect(onGiveUp).not.toHaveBeenCalled();
    },
  );

  it.each(["client", "busy", "network", "unknown", "too-many-requests"])(
    "delivers a turn after a transient %s error and restart",
    async (error) => {
      const onFinal = vi.fn();
      const onGiveUp = vi.fn();
      await listen({ onFinal, onGiveUp });
      fake.fail(error);
      fake.end();
      vi.advanceTimersByTime(250);
      expect(fake.start).toHaveBeenCalledTimes(2);
      fake.hear("status please");
      vi.advanceTimersByTime(ENDPOINT_SILENCE_MS);
      expect(onFinal).toHaveBeenCalledExactlyOnceWith("status please");
      expect(onGiveUp).not.toHaveBeenCalled();
      expect(reportMobileError).not.toHaveBeenCalled();
    },
  );

  it.each(["network", "client", "busy", "unknown", "too-many-requests"])(
    "fails after empty restarts ending in transient %s errors",
    async (error) => {
      const onFinal = vi.fn();
      const onGiveUp = vi.fn();
      await listen({ onFinal, onGiveUp });
      for (let attempt = 0; attempt < 6; attempt += 1) {
        fake.fail(error);
        expect(onGiveUp).not.toHaveBeenCalled();
        fake.end();
        vi.advanceTimersByTime(RESTART_CAP_MS);
      }
      expect(fake.start).toHaveBeenCalledTimes(6);
      expect(onGiveUp).toHaveBeenCalledExactlyOnceWith("failed");
      expect(onFinal).not.toHaveBeenCalled();
      expect(reportMobileError).toHaveBeenCalledExactlyOnceWith(
        new Error("Speech recognition stopped: transient-restarts"),
        "voice.microphone",
        { source: "dictation" },
      );
    },
  );

  it.each(["no-speech", "speech-timeout"])(
    "stays idle after empty %s restarts even after an earlier transient error",
    async (error) => {
      const onGiveUp = vi.fn();
      await listen({ onFinal: vi.fn(), onGiveUp });
      fake.fail("network");
      fake.end();
      vi.advanceTimersByTime(RESTART_CAP_MS);
      for (let attempt = 0; attempt < 5; attempt += 1) {
        fake.fail(error);
        fake.end();
        vi.advanceTimersByTime(RESTART_CAP_MS);
      }
      expect(fake.start).toHaveBeenCalledTimes(6);
      expect(onGiveUp).toHaveBeenCalledExactlyOnceWith("idle");
      expect(reportMobileError).not.toHaveBeenCalled();
    },
  );

  it("notifies the caller when start throws on restart", async () => {
    const onFinal = vi.fn();
    const onGiveUp = vi.fn();
    await listen({ onFinal, onGiveUp });
    fake.start.mockImplementationOnce(() => {
      throw new Error("recognizer unavailable");
    });
    fake.end();
    vi.advanceTimersByTime(RESTART_CAP_MS);
    expect(onGiveUp).toHaveBeenCalledExactlyOnceWith("failed");
    expect(onFinal).not.toHaveBeenCalled();
  });

  it("never starts the recognizer when the signal aborts during loading", async () => {
    const onFinal = vi.fn();
    const controller = new AbortController();
    const listening = listen({ onFinal, signal: controller.signal });
    controller.abort();
    await listening;

    expect(fake.start).not.toHaveBeenCalled();
    expect(onFinal).not.toHaveBeenCalled();
  });

  it("never finalizes an aborted session", async () => {
    const onFinal = vi.fn();
    const controller = new AbortController();
    await listen({ onFinal, signal: controller.signal });
    fake.hear("cancel this");

    controller.abort();
    expect(fake.abort).toHaveBeenCalled();
    fake.hear("and this", true);
    fake.end();
    vi.advanceTimersByTime(10_000);

    expect(onFinal).not.toHaveBeenCalled();
  });

  it("leaves a newer session running when a cancelled request arrives late", async () => {
    const onFinal = vi.fn();
    await listen({ onFinal, signal: new AbortController().signal });
    const cancelled = new AbortController();
    cancelled.abort();

    await listen({ onFinal: vi.fn(), signal: cancelled.signal });
    expect(fake.abort).not.toHaveBeenCalled();
    fake.hear("still here");
    vi.advanceTimersByTime(ENDPOINT_SILENCE_MS);

    expect(fake.start).toHaveBeenCalledOnce();
    expect(onFinal).toHaveBeenCalledWith("still here");
  });

  it("ends the turn on a permission error instead of hanging on the mic", async () => {
    const onFinal = vi.fn();
    await listen({ onFinal });
    fake.hear("open the door");
    fake.fail("not-allowed");
    expect(onFinal).toHaveBeenCalledWith("open the door");
    expect(reportMobileError).toHaveBeenCalledExactlyOnceWith(
      new Error("Speech recognition stopped: not-allowed"),
      "voice.microphone",
      { source: "dictation" },
    );
  });
});

describe("server streaming dictation", () => {
  type NativeListener = (payload: never) => void;

  function fakeStreamAsr() {
    const listeners = new Map<string, Set<NativeListener>>();
    const emit = (event: string, payload: unknown) => {
      for (const listener of [...(listeners.get(event) ?? [])])
        (listener as (p: unknown) => void)(payload);
    };
    const module = {
      isAvailable: () => true,
      start: vi.fn(async () => true),
      stop: vi.fn(),
      abort: vi.fn(),
      addListener: (event: string, listener: NativeListener) => {
        const set = listeners.get(event) ?? new Set();
        set.add(listener);
        listeners.set(event, set);
        return {
          remove: () => {
            set.delete(listener);
          },
        };
      },
    };
    return {
      module,
      say: (text: string, final: boolean) => emit("onResult", { text, final }),
      fail: (message: string) => emit("onError", { message }),
      end: () => emit("onEnd", undefined),
      started: module.start,
      stopped: module.stop,
      aborted: module.abort,
    };
  }

  type Heard = { interim: string[]; final: string[] };

  function collect(): Heard {
    const heard: Heard = { interim: [], final: [] };
    listen({
      onInterim: (text) => heard.interim.push(text),
      onFinal: (text) => heard.final.push(text),
    });
    return heard;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(reportMobileError).mockClear();
  });

  afterEach(() => {
    stop();
    setServerAsr(null);
    setStreamAsrModule(undefined as never);
    vi.useRealTimers();
  });

  it("joins the live decoder's windows and takes the server's revision as the final", async () => {
    const fake = fakeStreamAsr();
    setStreamAsrModule(fake.module);
    setServerAsr({ url: "wss://api/api/voice/asr", headers: {} });
    const heard = collect();
    await vi.advanceTimersByTimeAsync(0);

    // The live decoder sends short windows of the words being spoken, not revisions.
    fake.say("你好", false);
    expect(heard.interim).toEqual(["你好"]);
    fake.say("我是", false);
    expect(heard.interim).toEqual(["你好", "你好我是"]);
    // The finalized revision covers everything the interim guessed.
    fake.say("你好，我是。", true);
    expect(heard.final).toEqual([]);
    expect(heard.interim.at(-1)).toBe("你好，我是。");
    // The next utterance starts over without repeating the banked one.
    fake.say("今天", false);
    expect(heard.interim.at(-1)).toBe("你好，我是。今天");
    fake.say("天气好。", false);
    // The silence window after the last words ends the utterance; the turn is
    // delivered once the ended utterance's revision had its chance to land.
    await vi.advanceTimersByTimeAsync(ENDPOINT_SILENCE_MS + FINAL_REVISION_WAIT_MS + 10);
    expect(fake.stopped).toHaveBeenCalledTimes(1);
    expect(heard.final).toEqual(["你好，我是。今天天气好。"]);
  });

  it("starts the native stream with the call's signed target", async () => {
    const fake = fakeStreamAsr();
    setStreamAsrModule(fake.module);
    setServerAsr({ url: "wss://api/api/voice/asr", headers: { authorization: "Bearer t" } });
    collect();
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.started).toHaveBeenCalledWith(
      "wss://api/api/voice/asr",
      { authorization: "Bearer t" },
      "en-US",
    );
  });

  it("gives the turn up when the server refuses the session, so the call falls back", async () => {
    const native = fakeStreamAsr();
    native.started.mockResolvedValue(false);
    setStreamAsrModule(native.module);
    setServerAsr({ url: "wss://api/api/voice/asr", headers: {} });
    const gave: string[] = [];
    listen({
      onInterim: () => undefined,
      onFinal: () => undefined,
      onGiveUp: (reason) => gave.push(reason),
    });
    await vi.advanceTimersByTimeAsync(0);
    native.fail("connection refused");
    await vi.advanceTimersByTimeAsync(FINAL_REVISION_WAIT_MS + 10);
    expect(gave).toEqual(["failed"]);
  });
});
