// Copyright 2025 the AAI authors. MIT license.
/**
 * Integration tests that exercise the full deploy → slot load → serve pipeline.
 *
 * These tests spin up a real sandbox (Deno Worker) to verify that deployed
 * agent code can actually be loaded and executed — catching regressions in
 * the bundle store → sandbox → transport chain.
 */
import {
  assert,
  assertEquals,
  assertNotStrictEquals,
  assertStrictEquals,
  assertStringIncludes,
} from "@std/assert";
import {
  createTestKvStore,
  createTestOrchestrator,
  createTestVectorStore,
  deployBody,
  KV_WORKER,
  MINIMAL_WORKER,
  type TestFetch,
  VECTOR_WORKER,
} from "./_test_utils.ts";
import { createSandbox, evictSlot, resolveSandbox } from "./sandbox.ts";

const CLIENT_HTML =
  '<!DOCTYPE html><html><head><title>Test Agent</title></head><body><div id="app"></div><script type="module" src="./assets/index.js"></script></body></html>';
const CLIENT_JS = 'console.log("agent loaded");';

const SCOPE = { slug: "test-agent", keyHash: "test-key-hash" };

async function deployRealAgent(
  fetch: TestFetch,
  slug = "test-agent",
  key = "key1",
  opts?: { worker?: string; clientFiles?: Record<string, string> },
): Promise<Response> {
  return await fetch(`/${slug}/deploy`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: deployBody({
      worker: opts?.worker ?? MINIMAL_WORKER,
      clientFiles: opts?.clientFiles ?? {
        "index.html": CLIENT_HTML,
        "assets/index.js": CLIENT_JS,
      },
    }),
  });
}

// =============================================================================
// Deploy → Slot Load → Serve: end-to-end
// =============================================================================

Deno.test("integration: deploy creates slot and agent health succeeds", async () => {
  const { fetch } = await createTestOrchestrator();
  const deployRes = await deployRealAgent(fetch);
  assertEquals(deployRes.status, 200);

  const healthRes = await fetch("/test-agent/health");
  assertEquals(healthRes.status, 200);
  assertEquals((await healthRes.json()).slug, "test-agent");
});

Deno.test("integration: deploy and serve HTML page", async () => {
  const { fetch } = await createTestOrchestrator();
  await deployRealAgent(fetch);

  const pageRes = await fetch("/test-agent/");
  assertEquals(pageRes.status, 200);
  assertStringIncludes(pageRes.headers.get("Content-Type")!, "text/html");
  const html = await pageRes.text();
  assertStringIncludes(html, "<title>Test Agent</title>");
  assertStringIncludes(html, '<div id="app"></div>');
});

Deno.test("integration: deploy and serve client JS asset", async () => {
  const { fetch } = await createTestOrchestrator();
  await deployRealAgent(fetch);

  const assetRes = await fetch("/test-agent/assets/index.js");
  assertEquals(assetRes.status, 200);
  assertStringIncludes(
    assetRes.headers.get("Content-Type")!,
    "javascript",
  );
  assertStringIncludes(await assetRes.text(), "agent loaded");
  assertEquals(
    assetRes.headers.get("Cache-Control"),
    "public, max-age=31536000, immutable",
  );
});

Deno.test("integration: asset returns 404 for nonexistent file", async () => {
  const { fetch } = await createTestOrchestrator();
  await deployRealAgent(fetch);

  const res = await fetch("/test-agent/assets/nonexistent.js");
  assertEquals(res.status, 404);
});

Deno.test({
  name: "integration: slot loads sandbox and worker handles fetch",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const { fetch, store, kvStore } = await createTestOrchestrator();
    await deployRealAgent(fetch);

    const slots = new Map();
    const sandbox = await resolveSandbox("test-agent", {
      slots,
      store,
      kvStore,
    });
    assert(sandbox);

    const res = await sandbox.fetch(
      new Request("http://localhost/api/data"),
    );
    assertStrictEquals(res.status, 200);
    assertStrictEquals(
      await res.text(),
      "ok from GET /api/data",
    );

    const postRes = await sandbox.fetch(
      new Request("http://localhost/submit", { method: "POST" }),
    );
    assertStrictEquals(postRes.status, 200);
    assertStrictEquals(
      await postRes.text(),
      "ok from POST /submit",
    );

    sandbox.terminate();
  },
});

Deno.test("integration: redeploy replaces slot and serves new code", async () => {
  const { fetch } = await createTestOrchestrator();

  await deployRealAgent(fetch);
  const v1 = await fetch("/test-agent/");
  assertStringIncludes(await v1.text(), "Test Agent");

  const newHtml = "<!DOCTYPE html><html><body>Version 2</body></html>";
  await fetch("/test-agent/deploy", {
    method: "POST",
    headers: {
      Authorization: "Bearer key1",
      "Content-Type": "application/json",
    },
    body: deployBody({
      worker: MINIMAL_WORKER,
      clientFiles: {
        "index.html": newHtml,
        "assets/index.js": CLIENT_JS,
      },
    }),
  });

  const v2 = await fetch("/test-agent/");
  assertStringIncludes(await v2.text(), "Version 2");
});

Deno.test("integration: undiscovered agent returns 404 for all routes", async () => {
  const { fetch } = await createTestOrchestrator();

  assertEquals((await fetch("/ghost/health")).status, 404);
  assertEquals((await fetch("/ghost/")).status, 404);
  assertEquals((await fetch("/ghost/assets/app.js")).status, 404);
});

Deno.test("integration: deploy with env merge preserves existing secrets", async () => {
  const { fetch } = await createTestOrchestrator();

  await deployRealAgent(fetch);

  await fetch("/test-agent/secret", {
    method: "PUT",
    headers: {
      Authorization: "Bearer key1",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ EXTRA_KEY: "extra-value" }),
  });

  const listRes = await fetch("/test-agent/secret", {
    headers: { Authorization: "Bearer key1" },
  });
  const vars = (await listRes.json()).vars as string[];
  assert(vars.includes("EXTRA_KEY"));
  assert(vars.includes("ASSEMBLYAI_API_KEY"));

  await fetch("/test-agent/deploy", {
    method: "POST",
    headers: {
      Authorization: "Bearer key1",
      "Content-Type": "application/json",
    },
    body: deployBody({
      worker: MINIMAL_WORKER,
      clientFiles: { "index.html": CLIENT_HTML, "assets/index.js": CLIENT_JS },
    }),
  });

  const afterRedeploy = await fetch("/test-agent/secret", {
    headers: { Authorization: "Bearer key1" },
  });
  const reVars = (await afterRedeploy.json()).vars as string[];
  assert(reVars.includes("EXTRA_KEY"));
});

// =============================================================================
// Real WebSocket: deploy → Deno.serve → WS connect → session bridge
// =============================================================================

Deno.test({
  name: "integration: real WebSocket connection through Deno.serve",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const { store, scopeKey, kvStore, vectorStore } =
      await createTestOrchestrator();
    const { createOrchestrator } = await import("./orchestrator.ts");
    const app = createOrchestrator({ store, scopeKey, kvStore, vectorStore });

    await store.putAgent({
      slug: "ws-agent",
      env: { ASSEMBLYAI_API_KEY: "test-key" },
      worker: MINIMAL_WORKER,
      clientFiles: { "index.html": CLIENT_HTML },
      credential_hashes: [],
    });

    const ac = new AbortController();
    const server = Deno.serve(
      { port: 0, signal: ac.signal, onListen: () => {} },
      (req, info) => app.fetch(req, { info }),
    );
    const addr = server.addr;
    const baseUrl = `http://localhost:${addr.port}`;

    try {
      const healthRes = await globalThis.fetch(`${baseUrl}/ws-agent/health`);
      assertEquals(healthRes.status, 200);

      const ws = new WebSocket(
        `ws://localhost:${addr.port}/ws-agent/websocket`,
      );

      const opened = new Promise<void>((resolve, reject) => {
        ws.onopen = () => resolve();
        ws.onerror = (e) => reject(e);
      });

      await opened;
      assertStrictEquals(ws.readyState, WebSocket.OPEN);
      ws.close();

      await new Promise<void>((resolve) => {
        ws.onclose = () => resolve();
      });
    } finally {
      ac.abort();
      await server.finished;
    }
  },
});

// =============================================================================
// KV through full HTTP → sandbox RPC chain
// =============================================================================

Deno.test({
  name: "integration: KV set/get through sandbox RPC",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const kvStore = createTestKvStore();
    const sandbox = await createSandbox({
      workerCode: KV_WORKER,
      env: { ASSEMBLYAI_API_KEY: "test" },
      kvStore,
      scope: SCOPE,
    });

    try {
      const setRes = await sandbox.fetch(
        new Request("http://x?op=set&key=greeting&val=hello"),
      );
      assertStrictEquals(await setRes.text(), "set-ok");

      const getRes = await sandbox.fetch(
        new Request("http://x?op=get&key=greeting"),
      );
      assertStrictEquals(await getRes.text(), '"hello"');

      const raw = await kvStore.get(SCOPE, "greeting");
      assertStrictEquals(raw, '"hello"');

      const listRes = await sandbox.fetch(
        new Request("http://x?op=list"),
      );
      const entries = JSON.parse(await listRes.text());
      assert(Array.isArray(entries));
      assert(entries.length > 0);
      assertStrictEquals(entries[0].key, "greeting");
    } finally {
      sandbox.terminate();
    }
  },
});

// =============================================================================
// Vector through full HTTP → sandbox RPC chain
// =============================================================================

Deno.test({
  name: "integration: vector upsert/query through sandbox RPC",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const vectorStore = createTestVectorStore();
    const sandbox = await createSandbox({
      workerCode: VECTOR_WORKER,
      env: { ASSEMBLYAI_API_KEY: "test" },
      kvStore: createTestKvStore(),
      scope: SCOPE,
      vectorStore,
    });

    try {
      const upsertRes = await sandbox.fetch(
        new Request("http://x?op=upsert&id=doc1&data=hello+world"),
      );
      assertStrictEquals(await upsertRes.text(), "upsert-ok");

      const queryRes = await sandbox.fetch(
        new Request("http://x?op=query&text=hello"),
      );
      const results = JSON.parse(await queryRes.text());
      assert(Array.isArray(results));
      assert(results.length > 0);
      assertStrictEquals(results[0].id, "doc1");
    } finally {
      sandbox.terminate();
    }
  },
});

// =============================================================================
// KV scope isolation through sandbox RPC
// =============================================================================

Deno.test({
  name: "integration: KV is scoped per-agent through sandbox RPC",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const kvStore = createTestKvStore();

    const scopeA = { slug: "agent-a", keyHash: "owner-1" };
    const scopeB = { slug: "agent-b", keyHash: "owner-1" };

    const sandboxA = await createSandbox({
      workerCode: KV_WORKER,
      env: { ASSEMBLYAI_API_KEY: "test" },
      kvStore,
      scope: scopeA,
    });
    const sandboxB = await createSandbox({
      workerCode: KV_WORKER,
      env: { ASSEMBLYAI_API_KEY: "test" },
      kvStore,
      scope: scopeB,
    });

    try {
      await sandboxA.fetch(
        new Request("http://x?op=set&key=secret&val=a-data"),
      );

      const bGet = await sandboxB.fetch(
        new Request("http://x?op=get&key=secret"),
      );
      assertStrictEquals(await bGet.text(), "null");

      const aGet = await sandboxA.fetch(
        new Request("http://x?op=get&key=secret"),
      );
      assertStrictEquals(await aGet.text(), '"a-data"');
    } finally {
      sandboxA.terminate();
      sandboxB.terminate();
    }
  },
});

// =============================================================================
// Idle eviction
// =============================================================================

Deno.test({
  name: "integration: idle eviction terminates sandbox and re-creation works",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const { fetch, store, kvStore } = await createTestOrchestrator();
    await deployRealAgent(fetch);

    const slots = new Map();

    // First load — creates sandbox
    const sandbox1 = await resolveSandbox("test-agent", {
      slots,
      store,
      kvStore,
    });
    assert(sandbox1);

    const slot = slots.get("test-agent")!;
    assert(slot.sandbox);
    assert(slot.idleTimer !== undefined);

    const res1 = await sandbox1.fetch(
      new Request("http://localhost/ping"),
    );
    assertStrictEquals(res1.status, 200);

    // Simulate idle eviction
    evictSlot(slot);

    assertStrictEquals(slot.sandbox, undefined);

    // resolveSandbox should re-create the sandbox
    const sandbox2 = await resolveSandbox("test-agent", {
      slots,
      store,
      kvStore,
    });
    assert(sandbox2);
    assert(slot.sandbox);

    const res2 = await sandbox2.fetch(
      new Request("http://localhost/ping2"),
    );
    assertStrictEquals(res2.status, 200);
    assertStringIncludes(await res2.text(), "ok from GET /ping2");

    sandbox2.terminate();
  },
});

// =============================================================================
// Multi-tenant isolation (two agents in same orchestrator)
// =============================================================================

Deno.test("integration: two agents serve independent content", async () => {
  const { fetch } = await createTestOrchestrator();

  const htmlA = "<!DOCTYPE html><html><body>Agent Alpha</body></html>";
  const htmlB = "<!DOCTYPE html><html><body>Agent Beta</body></html>";

  await deployRealAgent(fetch, "agent-alpha", "key-a", {
    clientFiles: { "index.html": htmlA, "assets/app.js": "alpha();" },
  });
  await deployRealAgent(fetch, "agent-beta", "key-b", {
    clientFiles: { "index.html": htmlB, "assets/app.js": "beta();" },
  });

  const pageA = await fetch("/agent-alpha/");
  assertEquals(pageA.status, 200);
  assertStringIncludes(await pageA.text(), "Agent Alpha");

  const pageB = await fetch("/agent-beta/");
  assertEquals(pageB.status, 200);
  assertStringIncludes(await pageB.text(), "Agent Beta");

  const assetA = await fetch("/agent-alpha/assets/app.js");
  assertStringIncludes(await assetA.text(), "alpha()");

  const assetB = await fetch("/agent-beta/assets/app.js");
  assertStringIncludes(await assetB.text(), "beta()");

  assertEquals(
    (await (await fetch("/agent-alpha/health")).json()).slug,
    "agent-alpha",
  );
  assertEquals(
    (await (await fetch("/agent-beta/health")).json()).slug,
    "agent-beta",
  );
});

Deno.test({
  name: "integration: multi-tenant KV isolation through full deploy pipeline",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const { fetch, store, kvStore } = await createTestOrchestrator();

    await fetch("/agent-aa/deploy", {
      method: "POST",
      headers: {
        Authorization: "Bearer key-aa",
        "Content-Type": "application/json",
      },
      body: deployBody({ worker: KV_WORKER }),
    });
    await fetch("/agent-bb/deploy", {
      method: "POST",
      headers: {
        Authorization: "Bearer key-bb",
        "Content-Type": "application/json",
      },
      body: deployBody({ worker: KV_WORKER }),
    });

    const slots = new Map();
    const sandboxA = await resolveSandbox("agent-aa", {
      slots,
      store,
      kvStore,
    });
    const sandboxB = await resolveSandbox("agent-bb", {
      slots,
      store,
      kvStore,
    });
    assert(sandboxA);
    assert(sandboxB);

    const slotA = slots.get("agent-aa")!;
    const slotB = slots.get("agent-bb")!;
    assertNotStrictEquals(slotA.keyHash, slotB.keyHash);

    try {
      await sandboxA.fetch(
        new Request("http://x?op=set&key=data&val=from-A"),
      );

      await sandboxB.fetch(
        new Request("http://x?op=set&key=data&val=from-B"),
      );

      const aVal = await sandboxA.fetch(
        new Request("http://x?op=get&key=data"),
      );
      assertStrictEquals(await aVal.text(), '"from-A"');

      const bVal = await sandboxB.fetch(
        new Request("http://x?op=get&key=data"),
      );
      assertStrictEquals(await bVal.text(), '"from-B"');
    } finally {
      sandboxA.terminate();
      sandboxB.terminate();
    }
  },
});
