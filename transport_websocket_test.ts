// Copyright 2025 the AAI authors. MIT license.
import { assertEquals, assertStringIncludes } from "@std/assert";
import { stub } from "@std/testing/mock";
import { _internals as _wsInternals } from "./transport_websocket.ts";
import {
  createTestOrchestrator,
  deployAgent,
  deployBody,
} from "./_test_utils.ts";
import { MockWebSocket } from "@aai/sdk/testing";

// =============================================================================
// handleAgentHealth
// =============================================================================

Deno.test("agent health returns 404 for unknown agent", async () => {
  const { fetch } = await createTestOrchestrator();
  assertEquals((await fetch("/missing-agent/health")).status, 404);
});

Deno.test("agent health returns ok for deployed agent", async () => {
  const { fetch } = await createTestOrchestrator();
  await deployAgent(fetch);
  const res = await fetch("/my-agent/health");
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.status, "ok");
  assertEquals(body.slug, "my-agent");
});

// =============================================================================
// handleAgentPage
// =============================================================================

Deno.test("agent page returns 404 for unknown agent", async () => {
  const { fetch } = await createTestOrchestrator();
  assertEquals((await fetch("/missing-agent/")).status, 404);
});

Deno.test("agent page returns HTML for deployed agent", async () => {
  const { fetch } = await createTestOrchestrator();
  await deployAgent(fetch);
  const res = await fetch("/my-agent/");
  assertEquals(res.status, 200);
  assertStringIncludes(res.headers.get("Content-Type")!, "text/html");
  assertStringIncludes(await res.text(), "<html>");
});

// =============================================================================
// handleClientAsset
// =============================================================================

Deno.test("client asset returns 404 for unknown agent", async () => {
  const { fetch } = await createTestOrchestrator();
  assertEquals(
    (await fetch("/missing-agent/assets/index.js")).status,
    404,
  );
});

Deno.test("client asset returns 404 for missing asset", async () => {
  const { fetch } = await createTestOrchestrator();
  await deployAgent(fetch);
  assertEquals(
    (await fetch("/my-agent/assets/nonexistent.js")).status,
    404,
  );
});

Deno.test("client asset returns JS with correct content type", async () => {
  const { fetch } = await createTestOrchestrator();
  await deployAgent(fetch);
  const res = await fetch("/my-agent/assets/index.js");
  assertEquals(res.status, 200);
  assertStringIncludes(
    res.headers.get("Content-Type")!,
    "javascript",
  );
  assertEquals(
    res.headers.get("Cache-Control"),
    "public, max-age=31536000, immutable",
  );
  assertStringIncludes(await res.text(), 'console.log("c")');
});

Deno.test("client asset falls back to octet-stream for unknown extension", async () => {
  const { fetch } = await createTestOrchestrator();
  await fetch("/my-agent/deploy", {
    method: "POST",
    headers: {
      Authorization: "Bearer key1",
      "Content-Type": "application/json",
    },
    body: deployBody({
      clientFiles: {
        "index.html": "<html></html>",
        "assets/data.xyz123": "binary stuff",
      },
    }),
  });
  const res = await fetch("/my-agent/assets/data.xyz123");
  assertEquals(res.status, 200);
  assertEquals(
    res.headers.get("Content-Type"),
    "application/octet-stream",
  );
});

// =============================================================================
// handleWebSocket
// =============================================================================

Deno.test("websocket returns 404 for unknown agent", async () => {
  const { fetch } = await createTestOrchestrator();
  using _resolveStub = stub(
    _wsInternals,
    "resolveSandbox",
    (() => Promise.resolve(null)) as never,
  );
  assertEquals(
    (await fetch("/missing-agent/websocket", {
      headers: { upgrade: "websocket" },
    })).status,
    404,
  );
});

Deno.test("websocket returns 400 without upgrade header", async () => {
  const { fetch } = await createTestOrchestrator();
  await deployAgent(fetch);
  assertEquals((await fetch("/my-agent/websocket")).status, 400);
});

Deno.test("websocket upgrades for deployed agent", async () => {
  const { fetch } = await createTestOrchestrator();
  await deployAgent(fetch);

  const mockSocket = new MockWebSocket("ws://test");
  using _upgradeStub = stub(
    Deno,
    "upgradeWebSocket",
    () => ({
      socket: mockSocket as unknown as WebSocket,
      response: new Response(null, { status: 101 }),
    }),
  );
  using _resolveStub = stub(
    _wsInternals,
    "resolveSandbox",
    (() =>
      Promise.resolve({
        startSession: () => {},
        fetch: () => Promise.resolve(new Response("ok")),
        terminate: () => {},
      })) as never,
  );
  assertEquals(
    (await fetch("/my-agent/websocket", {
      headers: { upgrade: "websocket" },
    })).status,
    101,
  );
});

Deno.test("websocket passes resume=true when query param present", async () => {
  const { fetch } = await createTestOrchestrator();
  await deployAgent(fetch);

  let capturedSkipGreeting: boolean | undefined;
  const mockSocket = new MockWebSocket("ws://test");
  using _upgradeStub = stub(
    Deno,
    "upgradeWebSocket",
    () => ({
      socket: mockSocket as unknown as WebSocket,
      response: new Response(null, { status: 101 }),
    }),
  );
  using _resolveStub = stub(
    _wsInternals,
    "resolveSandbox",
    (() =>
      Promise.resolve({
        startSession: (_s: unknown, skipGreeting?: boolean) => {
          capturedSkipGreeting = skipGreeting;
        },
        fetch: () => Promise.resolve(new Response("ok")),
        terminate: () => {},
      })) as never,
  );
  await fetch("/my-agent/websocket?resume", {
    headers: { upgrade: "websocket" },
  });
  assertEquals(capturedSkipGreeting, true);
});
