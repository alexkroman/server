// Copyright 2025 the AAI authors. MIT license.
import { assertEquals } from "@std/assert";
import { wireSessionSocket, type WsSessionOptions } from "./ws_handler.ts";
import type { Session } from "@aai/sdk/session";
import type { ReadyConfig } from "@aai/sdk/protocol";

/** Minimal mock Session that records method calls. */
function createMockSession(): Session & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    start: () => {
      calls.push("start");
      return Promise.resolve();
    },
    stop: () => {
      calls.push("stop");
      return Promise.resolve();
    },
    onAudio: (data: Uint8Array) => {
      calls.push(`onAudio:${data.byteLength}`);
    },
    onAudioReady: () => {
      calls.push("onAudioReady");
    },
    onCancel: () => {
      calls.push("onCancel");
    },
    onReset: () => {
      calls.push("onReset");
    },
    onHistory: (msgs) => {
      calls.push(`onHistory:${msgs.length}`);
    },
    waitForTurn: () => Promise.resolve(),
  };
}

/** Minimal WebSocket mock that stores listeners and allows dispatching events. */
class MockWebSocket {
  readyState = 1; // WebSocket.OPEN
  sent: (string | Uint8Array)[] = [];
  #listeners = new Map<string, ((ev: Event) => void)[]>();

  addEventListener(type: string, handler: (ev: Event) => void) {
    const list = this.#listeners.get(type) ?? [];
    list.push(handler);
    this.#listeners.set(type, list);
  }

  send(data: string | ArrayBuffer | Uint8Array) {
    if (data instanceof ArrayBuffer) {
      this.sent.push(new Uint8Array(data));
    } else if (data instanceof Uint8Array) {
      this.sent.push(data);
    } else {
      this.sent.push(data);
    }
  }

  dispatch(type: string, eventInit?: Record<string, unknown>) {
    const event = Object.assign(new Event(type), eventInit ?? {});
    for (const handler of this.#listeners.get(type) ?? []) {
      handler(event);
    }
  }

  dispatchMessage(data: string | ArrayBuffer) {
    const event = new MessageEvent("message", { data });
    for (const handler of this.#listeners.get("message") ?? []) {
      handler(event);
    }
  }
}

const TEST_CONFIG: ReadyConfig = {
  protocolVersion: 1,
  audioFormat: "pcm16",
  sampleRate: 16_000,
  ttsSampleRate: 24_000,
};

function setup() {
  const ws = new MockWebSocket();
  const sessions = new Map<string, Session>();
  const mockSession = createMockSession();
  const openCalls: number[] = [];
  const closeCalls: number[] = [];

  const opts: WsSessionOptions = {
    sessions,
    createSession: (_id, _client) => mockSession,
    readyConfig: TEST_CONFIG,
    onOpen: () => openCalls.push(1),
    onClose: () => closeCalls.push(1),
  };

  // Cast mock to WebSocket for wireSessionSocket
  wireSessionSocket(ws as unknown as WebSocket, opts);

  return { ws, sessions, mockSession, openCalls, closeCalls };
}

Deno.test("wireSessionSocket", async (t) => {
  await t.step("sends config and starts session on open", () => {
    const { ws, sessions, mockSession } = setup();

    ws.dispatch("open");

    // Should send config as first message
    assertEquals(ws.sent.length, 1);
    const config = JSON.parse(ws.sent[0] as string);
    assertEquals(config.type, "config");
    assertEquals(config.protocolVersion, 1);
    assertEquals(config.audioFormat, "pcm16");

    // Session should be registered and started
    assertEquals(sessions.size, 1);
    assertEquals(mockSession.calls.includes("start"), true);
  });

  await t.step("calls onOpen callback", () => {
    const { ws, openCalls } = setup();
    ws.dispatch("open");
    assertEquals(openCalls.length, 1);
  });

  await t.step("routes audio_ready message to session", () => {
    const { ws, mockSession } = setup();
    ws.dispatch("open");

    ws.dispatchMessage(JSON.stringify({ type: "audio_ready" }));
    assertEquals(mockSession.calls.includes("onAudioReady"), true);
  });

  await t.step("routes cancel message to session", () => {
    const { ws, mockSession } = setup();
    ws.dispatch("open");

    ws.dispatchMessage(JSON.stringify({ type: "cancel" }));
    assertEquals(mockSession.calls.includes("onCancel"), true);
  });

  await t.step("routes reset message to session", () => {
    const { ws, mockSession } = setup();
    ws.dispatch("open");

    ws.dispatchMessage(JSON.stringify({ type: "reset" }));
    assertEquals(mockSession.calls.includes("onReset"), true);
  });

  await t.step("routes history message to session", () => {
    const { ws, mockSession } = setup();
    ws.dispatch("open");

    ws.dispatchMessage(
      JSON.stringify({
        type: "history",
        messages: [{ role: "user", text: "hi" }],
      }),
    );
    assertEquals(mockSession.calls.includes("onHistory:1"), true);
  });

  await t.step("routes binary audio to session.onAudio", () => {
    const { ws, mockSession } = setup();
    ws.dispatch("open");

    // Valid PCM16 chunk: even length, non-empty, within size limits
    const audio = new ArrayBuffer(1024);
    ws.dispatchMessage(audio);
    assertEquals(mockSession.calls.includes("onAudio:1024"), true);
  });

  await t.step("drops invalid audio (odd byte length)", () => {
    const { ws, mockSession } = setup();
    ws.dispatch("open");

    const audio = new ArrayBuffer(1023); // odd = invalid PCM16
    ws.dispatchMessage(audio);
    // Should not have called onAudio with this chunk
    const audioCalls = mockSession.calls.filter((c) =>
      c.startsWith("onAudio:")
    );
    assertEquals(audioCalls.length, 0);
  });

  await t.step("drops empty audio chunk", () => {
    const { ws, mockSession } = setup();
    ws.dispatch("open");

    const audio = new ArrayBuffer(0);
    ws.dispatchMessage(audio);
    const audioCalls = mockSession.calls.filter((c) =>
      c.startsWith("onAudio:")
    );
    assertEquals(audioCalls.length, 0);
  });

  await t.step("ignores invalid JSON", () => {
    const { ws, mockSession } = setup();
    ws.dispatch("open");
    const callsBefore = mockSession.calls.length;

    ws.dispatchMessage("not json{{{");
    // Should not crash, and no new session calls (except start)
    assertEquals(mockSession.calls.length, callsBefore);
  });

  await t.step("ignores unknown message type", () => {
    const { ws, mockSession } = setup();
    ws.dispatch("open");
    const callsBefore = mockSession.calls.length;

    ws.dispatchMessage(JSON.stringify({ type: "unknown_type" }));
    assertEquals(mockSession.calls.length, callsBefore);
  });

  await t.step("ignores messages before session is created", () => {
    const { ws, mockSession } = setup();
    // Don't dispatch "open" — session is null

    ws.dispatchMessage(JSON.stringify({ type: "audio_ready" }));
    assertEquals(mockSession.calls.length, 0);
  });

  await t.step("stops session and removes from map on close", async () => {
    const { ws, sessions, mockSession, closeCalls } = setup();
    ws.dispatch("open");
    assertEquals(sessions.size, 1);

    ws.dispatch("close");

    // Wait for async stop to complete
    await new Promise((r) => setTimeout(r, 10));

    assertEquals(mockSession.calls.includes("stop"), true);
    assertEquals(sessions.size, 0);
    assertEquals(closeCalls.length, 1);
  });

  await t.step("handles error event without crashing", () => {
    const { ws } = setup();
    ws.dispatch("open");
    // Should not throw
    ws.dispatch("error");
  });
});
