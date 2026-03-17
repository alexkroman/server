// Copyright 2025 the AAI authors. MIT license.
import { assertEquals } from "@std/assert";
import {
  createTestOrchestrator,
  deployBody,
  DUMMY_INFO,
} from "./_test_utils.ts";

function req(path: string, init?: RequestInit) {
  return new Request(`http://localhost${path}`, init);
}

async function deployAndAuth(slug = "my-agent", key = "key1") {
  const orch = await createTestOrchestrator();

  await orch.handler(
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

  return { ...orch, key };
}

// =============================================================================
// GET /env — list
// =============================================================================

Deno.test("env list rejects without auth", async () => {
  const { handler } = await deployAndAuth();
  const res = await handler(req("/my-agent/env"), DUMMY_INFO);
  assertEquals(res.status, 401);
});

Deno.test("env list returns var names for deployed agent", async () => {
  const { handler, key } = await deployAndAuth();
  const res = await handler(
    req("/my-agent/env", {
      headers: { Authorization: `Bearer ${key}` },
    }),
    DUMMY_INFO,
  );
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.vars, ["ASSEMBLYAI_API_KEY"]);
});

// =============================================================================
// PUT /env — set
// =============================================================================

Deno.test("env set rejects without auth", async () => {
  const { handler } = await deployAndAuth();
  const res = await handler(
    req("/my-agent/env", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ MY_KEY: "secret" }),
    }),
    DUMMY_INFO,
  );
  assertEquals(res.status, 401);
});

Deno.test("env set merges new vars", async () => {
  const { handler, key } = await deployAndAuth();

  const setRes = await handler(
    req("/my-agent/env", {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ MY_KEY: "secret" }),
    }),
    DUMMY_INFO,
  );
  assertEquals(setRes.status, 200);
  const setBody = await setRes.json();
  assertEquals(setBody.ok, true);
  assertEquals(setBody.keys.sort(), ["ASSEMBLYAI_API_KEY", "MY_KEY"]);

  // Verify via list
  const listRes = await handler(
    req("/my-agent/env", {
      headers: { Authorization: `Bearer ${key}` },
    }),
    DUMMY_INFO,
  );
  const listBody = await listRes.json();
  assertEquals(listBody.vars.sort(), ["ASSEMBLYAI_API_KEY", "MY_KEY"]);
});

Deno.test("env set rejects non-object body", async () => {
  const { handler, key } = await deployAndAuth();

  const res = await handler(
    req("/my-agent/env", {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(["not", "an", "object"]),
    }),
    DUMMY_INFO,
  );
  assertEquals(res.status, 400);
});

Deno.test("env set rejects non-string values", async () => {
  const { handler, key } = await deployAndAuth();

  const res = await handler(
    req("/my-agent/env", {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ NUM: 123 }),
    }),
    DUMMY_INFO,
  );
  assertEquals(res.status, 400);
});

// =============================================================================
// DELETE /env/:key — remove
// =============================================================================

Deno.test("env delete rejects without auth", async () => {
  const { handler } = await deployAndAuth();
  const res = await handler(
    req("/my-agent/env/ASSEMBLYAI_API_KEY", { method: "DELETE" }),
    DUMMY_INFO,
  );
  assertEquals(res.status, 401);
});

Deno.test("env delete removes a key", async () => {
  const { handler, key } = await deployAndAuth();

  // Add an extra key first
  await handler(
    req("/my-agent/env", {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ EXTRA: "val" }),
    }),
    DUMMY_INFO,
  );

  // Delete it
  const delRes = await handler(
    req("/my-agent/env/EXTRA", {
      method: "DELETE",
      headers: { Authorization: `Bearer ${key}` },
    }),
    DUMMY_INFO,
  );
  assertEquals(delRes.status, 200);
  assertEquals((await delRes.json()).ok, true);

  // Verify it's gone
  const listRes = await handler(
    req("/my-agent/env", {
      headers: { Authorization: `Bearer ${key}` },
    }),
    DUMMY_INFO,
  );
  const listBody = await listRes.json();
  assertEquals(listBody.vars, ["ASSEMBLYAI_API_KEY"]);
});

Deno.test("env delete returns 404 for unknown agent", async () => {
  const { handler, key } = await deployAndAuth();
  const res = await handler(
    req("/nonexistent/env/KEY", {
      method: "DELETE",
      headers: { Authorization: `Bearer ${key}` },
    }),
    DUMMY_INFO,
  );
  // 404 because the agent doesn't exist (unclaimed slug, no manifest)
  // The requireOwner will succeed (unclaimed), but handleEnvDelete will 404
  assertEquals(res.status, 404);
});
