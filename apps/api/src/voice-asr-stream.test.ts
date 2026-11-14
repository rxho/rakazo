import type { Server } from "node:http";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { StreamAsrOpener, StreamAsrSession } from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { createVoiceAsrUpgradeHandler, VOICE_ASR_CONNECT_PATH } from "./voice-asr-stream.js";

const actor = { userId: "user-1", spaceId: "space-1" } as unknown as Actor;

function scriptedSession(log: string[]): StreamAsrSession {
  const results: Array<{ text: string; final: boolean }> = [];
  let wake: (() => void) | undefined;
  const say = (text: string, final: boolean) => {
    results.push({ text, final });
    wake?.();
  };
  return {
    audio: (chunk) => log.push(`audio:${chunk.byteLength}`),
    begin: () => log.push("begin"),
    finish: () => say("flushed revision", true),
    close: () => log.push("close"),
    results: (async function* () {
      while (true) {
        const next = results.shift();
        if (next) {
          yield next;
          continue;
        }
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        wake = undefined;
      }
    })(),
  };
}

function once<T>(source: AsyncIterable<T>): Promise<T> {
  return source[Symbol.asyncIterator]()
    .next()
    .then((entry) => entry.value as T);
}

describe("voice asr relay", () => {
  const servers: Server[] = [];
  const sockets: WebSocket[] = [];

  afterEach(async () => {
    for (const ws of sockets) ws.close();
    sockets.length = 0;
    await Promise.all(
      servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
    servers.length = 0;
    vi.restoreAllMocks();
  });

  async function listen(
    handler: ReturnType<typeof createVoiceAsrUpgradeHandler>,
    path = VOICE_ASR_CONNECT_PATH,
  ): Promise<string> {
    const server = createServer();
    server.on("upgrade", (request, socket, head) => {
      if (new URL(request.url ?? "/", "http://relay").pathname === path)
        handler.handleUpgrade(request, socket, head);
      else socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    });
    server.listen(0, "127.0.0.1");
    servers.push(server);
    await new Promise((resolve) => server.once("listening", resolve));
    const { address, port } = server.address() as AddressInfo;
    return `ws://${address}:${port}${path}`;
  }

  function opened(url: string): Promise<WebSocket> {
    const ws = new WebSocket(url);
    sockets.push(ws);
    return new Promise((resolve, reject) => {
      ws.once("open", () => resolve(ws));
      ws.once("error", reject);
    });
  }

  function nextMessage(ws: WebSocket): Promise<Record<string, unknown>> {
    return new Promise((resolve) => {
      ws.once("message", (data, isBinary) => {
        resolve(JSON.parse(String(data)));
      });
    });
  }

  it("relays audio up and transcripts down, and stops the recognizer on close", async () => {
    const log: string[] = [];
    let session: StreamAsrSession | null = null;
    const opener: StreamAsrOpener = async () => {
      session = scriptedSession(log);
      return session;
    };
    const handler = createVoiceAsrUpgradeHandler({
      resolve: async () => ({ address: "ws://recognizer" }),
      authenticate: async () => actor,
      opener,
    });
    const ws = await opened(await listen(handler));

    ws.send(JSON.stringify({ type: "start" }));
    await vi.waitFor(() => expect(log).toContain("begin"));
    ws.send(new Uint8Array([1, 2, 3]));
    await vi.waitFor(() => expect(log).toContain("audio:3"));
    ws.send(JSON.stringify({ type: "stop" }));
    expect(await nextMessage(ws)).toEqual({
      type: "result",
      text: "flushed revision",
      final: true,
    });
    ws.send(new TextEncoder().encode("second chunk"));
    await vi.waitFor(() => expect(log).toContain("audio:12"));

    ws.close();
    await vi.waitFor(() => expect(log).toContain("close"));
  });

  it("refuses a connection without a saved streaming address", async () => {
    const handler = createVoiceAsrUpgradeHandler({
      resolve: async () => null,
      authenticate: async () => actor,
      opener: async () => {
        throw new Error("must not be called");
      },
    });
    const ws = await opened(await listen(handler));
    ws.send(JSON.stringify({ type: "start" }));
    const message = await nextMessage(ws);
    expect(message.type).toBe("error");
    await new Promise((resolve) => ws.once("close", resolve));
  });

  it("refuses an unsigned upgrade and an unknown path", async () => {
    const handler = createVoiceAsrUpgradeHandler({
      resolve: async () => ({ address: "ws://recognizer" }),
      authenticate: async () => null,
    });
    const url = await listen(handler);
    await expect(opened(url)).rejects.toThrow();
    const handler2 = createVoiceAsrUpgradeHandler({
      resolve: async () => ({ address: "ws://recognizer" }),
      authenticate: async () => actor,
    });
    await expect(opened(await listen(handler2, "/api/other"))).rejects.toThrow();
  });
});
