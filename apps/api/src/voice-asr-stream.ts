import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { StreamAsrOpener, StreamAsrSession } from "@rakazo/adapters";
import { funAsrStreamAsr } from "@rakazo/adapters";
import type { Actor, SettingsScope } from "@rakazo/contracts";
import { getLogger } from "@rakazo/logging";
import type { WebSocket } from "ws";
import { WebSocketServer } from "ws";

/** Where the app's streaming recognizer connects; every other upgrade stays refused. */
export const VOICE_ASR_CONNECT_PATH = "/api/voice/asr";

/** One audio frame the app sends; larger frames are refused, not truncated. */
const MAX_FRAME_BYTES = 32 * 1024;
/** A recognizer connection nothing flows through ends, so none outlives its call. */
const IDLE_TIMEOUT_MS = 120_000;
/** Recognizer connections one user may hold at once; a call needs one. */
const MAX_CONNECTIONS_PER_USER = 2;

/** What the relay needs from its host: the saved address and the signed-in caller. */
export interface VoiceAsrRelayDeps {
  resolve: (
    actor: Actor,
    scope?: SettingsScope,
  ) => Promise<{ address: string; scope?: SettingsScope } | null>;
  authenticate: (request: IncomingMessage) => Promise<Actor | null>;
  /** Overridden in tests; the relay otherwise speaks the self-hosted protocol. */
  opener?: StreamAsrOpener;
}

/**
 * Node `upgrade` listener that relays live call audio to the caller's streaming
 * recognizer. The app sends JSON control frames and binary PCM chunks; the relay
 * answers with firming-up transcripts. Nothing here knows a vendor's protocol —
 * the opener does.
 */
export function createVoiceAsrUpgradeHandler(deps: VoiceAsrRelayDeps) {
  const opener = deps.opener ?? funAsrStreamAsr;
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });
  const open = new Map<string, number>();

  const handleUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const path = new URL(request.url ?? "/", "http://voice").pathname;
    if (path !== VOICE_ASR_CONNECT_PATH) {
      socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    const onError = (error: Error) => getLogger().warn("voice asr upgrade socket error", { error });
    socket.on("error", onError);
    void deps
      .authenticate(request)
      .then((actor) => {
        if (!actor) {
          socket.off("error", onError);
          socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
          return;
        }
        wss.handleUpgrade(request, socket, head, (ws) => attach(ws, actor));
      })
      .catch((error: unknown) => {
        getLogger().error("voice asr upgrade failed", error);
        socket.end(
          "HTTP/1.1 500 Internal Server Error\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
        );
      });
  };

  const send = (ws: WebSocket, message: Record<string, unknown>) => {
    if (ws.readyState !== ws.OPEN) return;
    ws.send(JSON.stringify(message));
  };

  const attach = (ws: WebSocket, actor: Actor) => {
    const held = open.get(actor.userId) ?? 0;
    if (held >= MAX_CONNECTIONS_PER_USER) {
      send(ws, { type: "error", message: "Too many recognition connections." });
      ws.close(1013, "Too many");
      return;
    }
    open.set(actor.userId, held + 1);
    let session: StreamAsrSession | null = null;
    let controller: AbortController | null = null;
    let idle: ReturnType<typeof setTimeout> | undefined;
    const touched = () => {
      clearTimeout(idle);
      idle = setTimeout(() => close(1000, "Idle"), IDLE_TIMEOUT_MS);
    };
    const close = (code: number, reason: string) => {
      clearTimeout(idle);
      controller?.abort();
      session?.close();
      session = null;
      const heldNow = (open.get(actor.userId) ?? 1) - 1;
      if (heldNow > 0) open.set(actor.userId, heldNow);
      else open.delete(actor.userId);
      if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) ws.close(code, reason);
    };
    const start = async () => {
      // A later `start` opens the next utterance on the recognizer already held.
      if (session) {
        session.begin();
        return;
      }
      const resolved = await deps.resolve(actor);
      if (!resolved) {
        send(ws, { type: "error", message: "No streaming recognition address is set." });
        close(1011, "Unconfigured");
        return;
      }
      controller = new AbortController();
      try {
        session = await opener(resolved.address, controller.signal);
      } catch (error) {
        getLogger().warn("voice asr session failed to open", {
          error: error instanceof Error ? error : String(error),
        });
        send(ws, {
          type: "error",
          message: "The speech server did not accept the recognition session.",
        });
        close(1011, "Unreachable");
        return;
      }
      session.begin();
      touched();
      void pumpResults(session);
    };
    async function pumpResults(live: StreamAsrSession) {
      try {
        for await (const result of live.results) {
          touched();
          send(ws, { type: "result", text: result.text, final: result.final });
        }
      } catch {
        // The recognizer went away mid-call; the app falls back to its own engine.
        send(ws, { type: "error", message: "The recognizer stopped." });
      }
      if (session === live) close(1011, "Recognizer ended");
    }
    ws.on("message", (data, isBinary) => {
      touched();
      if (isBinary) {
        session?.audio(data as Buffer);
        return;
      }
      let parsed: { type?: unknown };
      try {
        parsed = JSON.parse(String(data));
      } catch {
        return;
      }
      if (parsed.type === "start") void start();
      else if (parsed.type === "stop") session?.finish();
      else if (parsed.type === "abort") close(1000, "Aborted");
    });
    ws.on("error", () => close(1011, "Socket error"));
    ws.on("close", () => close(1000, "Closed"));
    touched();
  };

  return { handleUpgrade, close: () => wss.close() };
}
