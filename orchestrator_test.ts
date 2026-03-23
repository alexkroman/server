// Copyright 2025 the AAI authors. MIT license.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { stub } from "@std/testing/mock";
import { _internals as _wsInternals } from "./transport_websocket.ts";
import { hashApiKey } from "./auth.ts";
import { signScopeToken } from "./scope_token.ts";
import {
  createTestOrchestrator,
  deployAgent,
  deployBody,
} from "./_test_utils.ts";
import { MockWebSocket } from "@aai/sdk/testing";

// =============================================================================
// Public routes
// =============================================================================

Deno.test("returns health check", async () => {
  const { fetch } = await createTestOrchestrator();
  const res = await fetch("/health");
  assertEquals(res.status, 200);
  assertEquals((await res.json()).status, "ok");
});

Deno.test("returns Prometheus metrics", async () => {
  const { fetch } = await createTestOrchestrator();
  const res = await fetch("/metrics");
  assertEquals(res.status, 200);
  assertStringIncludes(
    res.headers.get("Content-Type") ?? "",
    "text/plain",
  );
  assertStringIncludes(await res.text(), "http_request_duration_seconds");
});

Deno.test("returns 404 for unknown paths", async () => {
  const { fetch } = await createTestOrchestrator();
  assertEquals((await fetch("/foo/bar/baz")).status, 404);
});

// =============================================================================
// Security headers
// =============================================================================

Deno.test("adds Cross-Origin-Isolation headers", async () => {
  const { fetch } = await createTestOrchestrator();
  const res = await fetch("/health");
  assertEquals(res.headers.get("Cross-Origin-Opener-Policy"), "same-origin");
  assertEquals(
    res.headers.get("Cross-Origin-Embedder-Policy"),
    "credentialless",
  );
});

// =============================================================================
// Deploy
// =============================================================================

Deno.test("deploy rejects without auth", async () => {
  const { fetch } = await createTestOrchestrator();
  assertEquals(
    (await fetch("/my-agent/deploy", { method: "POST", body: deployBody() }))
      .status,
    401,
  );
});

Deno.test("deploy rejects different owner for claimed slug", async () => {
  const { fetch, store } = await createTestOrchestrator();
  await store.putAgent({
    slug: "my-agent",
    env: {},
    worker: "w",
    clientFiles: { "index.html": "<html></html>" },
    credential_hashes: [await hashApiKey("key1")],
  });
  const res = await fetch("/my-agent/deploy", {
    method: "POST",
    headers: { Authorization: "Bearer key2" },
    body: deployBody(),
  });
  assertEquals(res.status, 403);
});

Deno.test("deploy succeeds and stores agent", async () => {
  const { fetch, store } = await createTestOrchestrator();
  const res = await fetch("/my-agent/deploy", {
    method: "POST",
    headers: {
      Authorization: "Bearer key1",
      "Content-Type": "application/json",
    },
    body: deployBody(),
  });
  assertEquals(res.status, 200);
  const manifest = await store.getManifest("my-agent");
  assert(manifest!.credential_hashes);
  assert(manifest!.credential_hashes!.includes(await hashApiKey("key1")));
});

Deno.test("deploy can redeploy same slug", async () => {
  const { fetch } = await createTestOrchestrator();
  await deployAgent(fetch);
  const res = await fetch("/my-agent/deploy", {
    method: "POST",
    headers: { Authorization: "Bearer key1", "Content-Type": "application/json" },
    body: deployBody(),
  });
  assertEquals(res.status, 200);
});

// =============================================================================
// Agent health & page (requires deployed agent)
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

Deno.test("agent page redirects bare slug to trailing slash", async () => {
  const { fetch } = await createTestOrchestrator();
  const res = await fetch("/my-agent");
  assertEquals(res.status, 301);
  assertEquals(res.headers.get("Location"), "http://localhost/my-agent/");
});

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
// WebSocket
// =============================================================================

Deno.test("websocket returns 404 for unknown agent", async () => {
  const { fetch } = await createTestOrchestrator();
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

// =============================================================================
// Per-agent metrics
// =============================================================================

Deno.test("per-agent metrics rejects without auth", async () => {
  const { fetch } = await createTestOrchestrator();
  assertEquals((await fetch("/test-agent/metrics")).status, 401);
});

Deno.test("per-agent metrics returns Prometheus format", async () => {
  const { fetch } = await createTestOrchestrator();
  await deployAgent(fetch, "test-agent", "key1");
  const res = await fetch("/test-agent/metrics", {
    headers: { Authorization: "Bearer key1" },
  });
  assertEquals(res.status, 200);
  assertEquals(res.headers.get("Content-Type"), "text/plain; version=0.0.4");
  const body = await res.text();
  assertStringIncludes(body, "http_requests_total");
  assertStringIncludes(body, "http_request_duration_seconds");
});

// =============================================================================
// KV (requires scope token)
// =============================================================================

function kvReq(
  slug: string,
  token: string,
  body: Record<string, unknown>,
): [string, RequestInit] {
  return [`/${slug}/kv`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  }];
}

Deno.test("kv rejects without auth", async () => {
  const { fetch } = await createTestOrchestrator();
  const res = await fetch("my-agent/kv", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ op: "get", key: "k" }),
  });
  assertEquals(res.status, 401);
});

Deno.test("kv set and get round-trip", async () => {
  const { fetch, scopeKey } = await createTestOrchestrator();
  const token = await signScopeToken(scopeKey, {
    keyHash: "acct-1",
    slug: "my-agent",
  });
  const setRes = await fetch(...kvReq("my-agent", token, { op: "set", key: "k1", value: "v1" }));
  assertEquals((await setRes.json()).result, "OK");

  const getRes = await fetch(...kvReq("my-agent", token, { op: "get", key: "k1" }));
  assertEquals((await getRes.json()).result, "v1");
});

Deno.test("kv scope isolation", async () => {
  const { fetch, scopeKey } = await createTestOrchestrator();
  const tokenA = await signScopeToken(scopeKey, {
    keyHash: "acct-1",
    slug: "agent-a",
  });
  const tokenB = await signScopeToken(scopeKey, {
    keyHash: "acct-1",
    slug: "agent-b",
  });

  await fetch(
    ...kvReq("agent-a", tokenA, {
      op: "set",
      key: "secret",
      value: "a-data",
    }),
  );

  const res = await fetch(
    ...kvReq("agent-b", tokenB, { op: "get", key: "secret" }),
  );
  assertEquals((await res.json()).result, null);
});

Deno.test("kv rejects invalid op", async () => {
  const { fetch, scopeKey } = await createTestOrchestrator();
  const token = await signScopeToken(scopeKey, {
    keyHash: "h",
    slug: "my-agent",
  });
  assertEquals(
    (await fetch(...kvReq("my-agent", token, { op: "drop_table" }))).status,
    400,
  );
});
