import { getRandomValues } from "node:crypto";
import { getLogger } from "@rakazo/logging";
import { WebSocket } from "ws";
import { selfHostedAsrStreamUrl } from "./openai-compatible-voice.js";

/**
 * A streaming speech recognizer: live audio in, firming-up transcripts out. The
 * API's relay route speaks this interface, so only this file knows a vendor's
 * WebSocket protocol.
 */
export interface StreamAsrSession {
  /** One chunk of 16 kHz mono PCM16 little-endian audio. */
  audio(chunk: Uint8Array): void;
  /** (Re)opens an utterance; the first chunk of a turn follows this. */
  begin(): void;
  /** The caller stopped speaking; flush the final transcript of this utterance. */
  finish(): void;
  /** Closes the recognizer; no result after this counts. */
  close(): void;
  /**
   * Transcripts as they firm up. Ends when the recognizer closes; an
   * unreachable or broken recognizer ends it with an error.
   */
  results: AsyncIterable<{ text: string; final: boolean }>;
}

/** Opens one streaming recognition session against a self-hosted address. */
export type StreamAsrOpener = (address: string, signal: AbortSignal) => Promise<StreamAsrSession>;

/** What the app's WebSocket route relays: vendor-free, JSON and binary frames. */
export const ASR_CONNECT_TIMEOUT_MS = 10_000;

/** Bytes of one audio chunk the relay forwards; ~300 ms of 16 kHz PCM16. */
export const ASR_CHUNK_BYTES = 9600;

/**
 * A recognizer speaking the FunASR two-pass WebSocket protocol: a JSON start
 * frame, raw PCM chunks, an `is_speaking: false` to close an utterance, and
 * online results while speaking with an offline revision to finish it.
 */
export const funAsrStreamAsr: StreamAsrOpener = async (address, signal) => {
  const url = selfHostedAsrStreamUrl(address);
  if (!url) throw new Error("No streaming recognition address is configured.");
  const socket = new WebSocket(url, { signal });
  socket.binaryType = "nodebuffer";
  const started = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("The speech server did not answer in time.")),
      ASR_CONNECT_TIMEOUT_MS,
    );
    socket.once("open", () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
  const queued: Array<{ text: string; final: boolean }> = [];
  let wake: (() => void) | undefined;
  let ended: Error | null = null;
  let closed = false;
  const finish = (error: Error | null) => {
    if (closed) return;
    closed = true;
    ended = error;
    wake?.();
    try {
      socket.close();
    } catch {
      socket.terminate();
    }
  };
  socket.on("message", (data, isBinary) => {
    if (isBinary || closed) return;
    let parsed: {
      text?: unknown;
      mode?: unknown;
      is_final?: unknown;
    };
    try {
      parsed = JSON.parse(String(data));
    } catch {
      return;
    }
    const text = typeof parsed.text === "string" ? parsed.text.trim() : "";
    if (!text) return;
    // `offline` results are the finished revision of what `online` guessed.
    const final = parsed.mode === "2pass-offline" || parsed.is_final === true;
    queued.push({ text, final });
    wake?.();
  });
  socket.on("error", (error) => finish(error instanceof Error ? error : new Error(String(error))));
  socket.on("close", () => finish(null));
  signal.addEventListener(
    "abort",
    () => finish(signal.reason instanceof Error ? signal.reason : new Error("Aborted.")),
    { once: true },
  );
  await started.catch((error: unknown) => {
    finish(null);
    throw error instanceof Error ? error : new Error(String(error));
  });
  const begin = () => {
    if (closed) return;
    // A fresh name per utterance, so one connection can carry a whole call's
    // utterances and the server resets its state between them.
    const id = randomId();
    socket.send(
      JSON.stringify({
        mode: "2pass",
        chunk_size: [5, 10, 5],
        chunk_interval: 10,
        wav_name: id,
        wav_format: "pcm",
        audio_fs: 16_000,
        is_speaking: true,
      }),
    );
  };
  return {
    audio(chunk) {
      if (closed) return;
      socket.send(chunk, { binary: true }, (error) => {
        if (error) finish(error);
      });
    },
    begin,
    finish() {
      if (closed) return;
      socket.send(JSON.stringify({ is_speaking: false }));
    },
    close() {
      finish(null);
    },
    results: (async function* () {
      while (true) {
        const next = queued.shift();
        if (next) {
          yield next;
          continue;
        }
        if (closed) {
          if (ended) throw ended;
          return;
        }
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        wake = undefined;
      }
    })(),
  };
};

function randomId(): string {
  return Array.from(getRandomValues(new Uint8Array(8)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

/** Picks the opener for a saved address; only the FunASR protocol is known today. */
export function streamAsrOpener(): StreamAsrOpener {
  getLogger().debug("opening a streaming recognition session");
  return funAsrStreamAsr;
}
