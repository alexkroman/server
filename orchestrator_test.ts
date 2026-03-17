// Copyright 2025 the AAI authors. MIT license.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { stub } from "@std/testing/mock";
import { _internals as _wsInternals } from "./transport_websocket.ts";
import { hashApiKey } from "./auth.ts";
import { signScopeToken } from "./scope_token.ts";
import {
  createTestOrchestrator,
  deployBody,
  DUMMY_INFO,
  makeConfig,
} from "./_test_utils.ts";
import { MockWebSocket } from "@aai/sdk/testing";

function req(path: string, init?: RequestInit) {
  return new Request(`http://localhost${path}`, init);
}

// =============================================================================
// Public routes
// =============================================================================

Deno.test("returns landing page for root path", async () => {
  const { handler } = await createTestOrchestrator();
  const res = await handler(req("/"), DUMMY_INFO);
  assertEquals(res.status, 200);
  assertStringIncludes(await res.text(), "</html>");
});

Deno.test("returns health check", async () => {
  const { handler } = await createTestOrchestrator();
  const res = await handler(req("/health"), DUMMY_INFO);
  assertEquals(res.status, 200);
  assertEquals((await res.json()).status, "ok");
});

Deno.test("returns Prometheus metrics", async () => {
  const { handler } = await createTestOrchestrator();
  const res = await handler(req("/metrics"), DUMMY_INFO);
  assertEquals(res.status, 200);
  assertEquals(res.headers.get("Content-Type"), "text/plain; version=0.0.4");
  assertStringIncludes(await res.text(), "aai_sessions_total");
});

Deno.test("returns favicon SVG", async () => {
  const { handler } = await createTestOrchestrator();
  const res = await handler(req("/favicon.svg"), DUMMY_INFO);
  assertEquals(res.status, 200);
  assertEquals(res.headers.get("Content-Type"), "image/svg+xml");
  assertStringIncludes(await res.text(), "<svg");
});

Deno.test("returns install script", async () => {
  const { handler } = await createTestOrchestrator();
  const res = await handler(req("/install"), DUMMY_INFO);
  assertEquals(res.status, 200);
  const body = await res.text();
  assertStringIncludes(body, "#!/bin/sh");
  assertStringIncludes(body, "alexkroman/aai");
});

Deno.test("returns 404 for unknown paths", async () => {
  const { handler } = await createTestOrchestrator();
  // /:slug redirects to /:slug/ (301), so single-segment paths are not 404
  assertEquals(
    (await handler(req("/foo/bar/baz"), DUMMY_INFO)).status,
    404,
  );
});

// =============================================================================
// Security headers
// =============================================================================

Deno.test("adds Cross-Origin-Isolation headers", async () => {
  const { handler } = await createTestOrchestrator();
  const res = await handler(req("/health"), DUMMY_INFO);
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
  const { handler } = await createTestOrchestrator();
  const res = await handler(
    req("/my-agent/deploy", { method: "POST", body: deployBody() }),
    DUMMY_INFO,
  );
  assertEquals(res.status, 401);
});

Deno.test("deploy rejects different owner for claimed slug", async () => {
  const { handler, store } = await createTestOrchestrator();
  // Deploy with key1 first to claim the slug
  await store.putAgent({
    slug: "my-agent",
    env: {},
    transport: ["websocket"],
    worker: "w",
    html: "<html></html>",
    credential_hashes: [await hashApiKey("key1")],
    config: makeConfig(),
    toolSchemas: [],
  });

  const res = await handler(
    req("/my-agent/deploy", {
      method: "POST",
      headers: { Authorization: "Bearer key2" },
      body: deployBody(),
    }),
    DUMMY_INFO,
  );
  assertEquals(res.status, 403);
});

Deno.test("deploy succeeds and stores agent", async () => {
  const { handler, store } = await createTestOrchestrator();
  const res = await handler(
    req("/my-agent/deploy", {
      method: "POST",
      headers: {
        Authorization: "Bearer key1",
        "Content-Type": "application/json",
      },
      body: deployBody(),
    }),
    DUMMY_INFO,
  );
  assertEquals(res.status, 200);
  const manifest = await store.getManifest("my-agent");
  // credential_hashes should be stored
  assert(manifest!.credential_hashes);
  assert(manifest!.credential_hashes!.includes(await hashApiKey("key1")));
});

Deno.test("deploy can redeploy same slug", async () => {
  const { handler } = await createTestOrchestrator();
  const init = {
    method: "POST",
    headers: {
      Authorization: "Bearer key1",
      "Content-Type": "application/json",
    },
    body: deployBody(),
  };
  await handler(req("/my-agent/deploy", init), DUMMY_INFO);
  const res = await handler(
    req("/my-agent/deploy", {
      ...init,
      body: deployBody(),
    }),
    DUMMY_INFO,
  );
  assertEquals(res.status, 200);
});

// =============================================================================
// Agent health & page (requires deployed agent)
// =============================================================================

async function deployAgent(
  handler: Deno.ServeHandler,
  slug = "my-agent",
  key = "key1",
) {
  await handler(
    req(`/${slug}/deploy`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: deployBody(),
    }),
    DUMMY_INFO,
  );
}

Deno.test("agent health returns 404 for unknown agent", async () => {
  const { handler } = await createTestOrchestrator();
  const res = await handler(req("/missing-agent/health"), DUMMY_INFO);
  assertEquals(res.status, 404);
});

Deno.test("agent health returns ok for deployed agent", async () => {
  const { handler } = await createTestOrchestrator();
  await deployAgent(handler);
  const res = await handler(req("/my-agent/health"), DUMMY_INFO);
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.status, "ok");
  assertEquals(body.slug, "my-agent");
});

Deno.test("agent page redirects bare slug to trailing slash", async () => {
  const { handler } = await createTestOrchestrator();
  const res = await handler(req("/my-agent"), DUMMY_INFO);
  assertEquals(res.status, 301);
  assertEquals(res.headers.get("Location"), "http://localhost/my-agent/");
});

Deno.test("agent page returns 404 for unknown agent", async () => {
  const { handler } = await createTestOrchestrator();
  const res = await handler(req("/missing-agent/"), DUMMY_INFO);
  assertEquals(res.status, 404);
});

Deno.test("agent page returns HTML for deployed agent", async () => {
  const { handler } = await createTestOrchestrator();
  await deployAgent(handler);
  const res = await handler(req("/my-agent/"), DUMMY_INFO);
  assertEquals(res.status, 200);
  assertStringIncludes(res.headers.get("Content-Type")!, "text/html");
  const body = await res.text();
  assertStringIncludes(body, "<html>");
});

// =============================================================================
// Trailing-slash redirect
// =============================================================================

Deno.test("trailing slash on agent page serves HTML", async () => {
  const { handler } = await createTestOrchestrator();
  await deployAgent(handler);
  const res = await handler(req("/my-agent/"), DUMMY_INFO);
  assertEquals(res.status, 200);
  assertStringIncludes(res.headers.get("Content-Type")!, "text/html");
});

// =============================================================================
// WebSocket
// =============================================================================

Deno.test("websocket returns 404 for unknown agent", async () => {
  const { handler } = await createTestOrchestrator();
  const res = await handler(
    req("/missing-agent/websocket", { headers: { upgrade: "websocket" } }),
    DUMMY_INFO,
  );
  assertEquals(res.status, 404);
});

Deno.test("websocket returns 400 without upgrade header", async () => {
  const { handler } = await createTestOrchestrator();
  await deployAgent(handler);
  const res = await handler(req("/my-agent/websocket"), DUMMY_INFO);
  assertEquals(res.status, 400);
});

Deno.test("websocket upgrades for deployed agent", async () => {
  const { handler } = await createTestOrchestrator();
  await deployAgent(handler);

  const mockSocket = new MockWebSocket("ws://test");
  using _upgradeStub = stub(
    Deno,
    "upgradeWebSocket",
    () => ({
      socket: mockSocket as unknown as WebSocket,
      response: new Response(null, { status: 101 }),
    }),
  );
  using _prepareStub = stub(
    _wsInternals,
    "prepareSession",
    (() =>
      Promise.resolve({
        agentConfig: {
          name: "test",
          instructions: "",
          greeting: "",
          voice: "",
        },
        toolSchemas: [],
        platformConfig: {
          s2sConfig: { inputSampleRate: 24000, outputSampleRate: 24000 },
        } as never,
        executeTool: () => Promise.resolve("ok"),
        hookInvoker: {} as never,
      })) as never,
  );
  const res = await handler(
    req("/my-agent/websocket", { headers: { upgrade: "websocket" } }),
    DUMMY_INFO,
  );
  assertEquals(res.status, 101);
});

// =============================================================================
// Per-agent metrics
// =============================================================================

Deno.test("per-agent metrics rejects without auth", async () => {
  const { handler } = await createTestOrchestrator();
  const res = await handler(
    req("/test-agent/metrics"),
    DUMMY_INFO,
  );
  assertEquals(res.status, 401);
});

Deno.test("per-agent metrics returns Prometheus format", async () => {
  const { handler } = await createTestOrchestrator();
  // Deploy the agent first so the slug exists with credentials
  await deployAgent(handler, "test-agent", "key1");
  const res = await handler(
    req("/test-agent/metrics", {
      headers: { Authorization: "Bearer key1" },
    }),
    DUMMY_INFO,
  );
  assertEquals(res.status, 200);
  assertEquals(
    res.headers.get("Content-Type"),
    "text/plain; version=0.0.4",
  );
  const body = await res.text();
  assertStringIncludes(body, "aai_sessions_total");
  assertStringIncludes(body, "aai_sessions_active");
});

// =============================================================================
// KV (requires scope token)
// =============================================================================

Deno.test("kv rejects without auth", async () => {
  const { handler } = await createTestOrchestrator();
  const res = await handler(
    req("/my-agent/kv", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ op: "get", key: "k" }),
    }),
    DUMMY_INFO,
  );
  assertEquals(res.status, 401);
});

Deno.test("kv set and get round-trip", async () => {
  const { handler, scopeKey } = await createTestOrchestrator();
  const token = await signScopeToken(scopeKey, {
    keyHash: "acct-1",
    slug: "my-agent",
  });

  const kvReq = (body: Record<string, unknown>) =>
    req("/my-agent/kv", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

  const setRes = await handler(
    kvReq({ op: "set", key: "k1", value: "v1" }),
    DUMMY_INFO,
  );
  assertEquals(setRes.status, 200);
  assertEquals((await setRes.json()).result, "OK");

  const getRes = await handler(
    kvReq({ op: "get", key: "k1" }),
    DUMMY_INFO,
  );
  assertEquals((await getRes.json()).result, "v1");
});

Deno.test("kv scope isolation", async () => {
  const { handler, scopeKey } = await createTestOrchestrator();
  const tokenA = await signScopeToken(scopeKey, {
    keyHash: "acct-1",
    slug: "agent-a",
  });
  const tokenB = await signScopeToken(scopeKey, {
    keyHash: "acct-1",
    slug: "agent-b",
  });

  // Set via agent-a
  await handler(
    req("/agent-a/kv", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokenA}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ op: "set", key: "secret", value: "a-data" }),
    }),
    DUMMY_INFO,
  );

  // Get via agent-b — should be null
  const res = await handler(
    req("/agent-b/kv", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokenB}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ op: "get", key: "secret" }),
    }),
    DUMMY_INFO,
  );
  assertEquals((await res.json()).result, null);
});

Deno.test("kv rejects invalid op", async () => {
  const { handler, scopeKey } = await createTestOrchestrator();
  const token = await signScopeToken(scopeKey, {
    keyHash: "h",
    slug: "my-agent",
  });
  const res = await handler(
    req("/my-agent/kv", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ op: "drop_table" }),
    }),
    DUMMY_INFO,
  );
  assertEquals(res.status, 400);
});
