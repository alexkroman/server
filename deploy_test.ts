// Copyright 2025 the AAI authors. MIT license.
import { assert, assertEquals, assertStrictEquals } from "@std/assert";
import {
  createTestOrchestrator,
  deployAgent,
  deployBody,
} from "./_test_utils.ts";
import { hashApiKey } from "./auth.ts";

// =============================================================================
// handleDeploy — body validation
// =============================================================================

Deno.test("deploy rejects missing worker field", async () => {
  const { fetch } = await createTestOrchestrator();
  const res = await fetch("/my-agent/deploy", {
    method: "POST",
    headers: {
      Authorization: "Bearer key1",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ clientFiles: { "index.html": "<html></html>" } }),
  });
  assertEquals(res.status, 400);
});

Deno.test("deploy rejects empty worker string", async () => {
  const { fetch } = await createTestOrchestrator();
  const res = await fetch("/my-agent/deploy", {
    method: "POST",
    headers: {
      Authorization: "Bearer key1",
      "Content-Type": "application/json",
    },
    body: deployBody({ worker: "" }),
  });
  assertEquals(res.status, 400);
});

Deno.test("deploy rejects non-JSON body", async () => {
  const { fetch } = await createTestOrchestrator();
  const res = await fetch("/my-agent/deploy", {
    method: "POST",
    headers: {
      Authorization: "Bearer key1",
      "Content-Type": "application/json",
    },
    body: "not json",
  });
  assertEquals(res.status, 400);
});

// =============================================================================
// handleDeploy — env validation
// =============================================================================

Deno.test("deploy succeeds with env containing ASSEMBLYAI_API_KEY", async () => {
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
  assert(manifest);
  assertStrictEquals(manifest.env.ASSEMBLYAI_API_KEY, "test-key");
});

Deno.test("deploy merges env with stored env", async () => {
  const { fetch, store } = await createTestOrchestrator();

  // First deploy with env
  await fetch("/my-agent/deploy", {
    method: "POST",
    headers: {
      Authorization: "Bearer key1",
      "Content-Type": "application/json",
    },
    body: deployBody(),
  });

  // Set additional secret
  await store.putEnv("my-agent", {
    ASSEMBLYAI_API_KEY: "test-key",
    EXTRA: "extra-val",
  });

  // Redeploy without env — stored env should be preserved
  const res = await fetch("/my-agent/deploy", {
    method: "POST",
    headers: {
      Authorization: "Bearer key1",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      worker: "console.log('w');",
      clientFiles: { "index.html": "<html></html>" },
    }),
  });
  assertEquals(res.status, 200);

  const env = await store.getEnv("my-agent");
  assert(env);
  assertStrictEquals(env.EXTRA, "extra-val");
  assertStrictEquals(env.ASSEMBLYAI_API_KEY, "test-key");
});

Deno.test("deploy returns 400 when merged env lacks ASSEMBLYAI_API_KEY", async () => {
  const { fetch } = await createTestOrchestrator();
  const res = await fetch("/my-agent/deploy", {
    method: "POST",
    headers: {
      Authorization: "Bearer key1",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      env: { OTHER_KEY: "val" },
      worker: "console.log('w');",
      clientFiles: { "index.html": "<html></html>" },
    }),
  });
  assertEquals(res.status, 400);
});

// =============================================================================
// handleDeploy — credential hashing
// =============================================================================

Deno.test("deploy stores hashed credential", async () => {
  const { fetch, store } = await createTestOrchestrator();
  await deployAgent(fetch, "my-agent", "my-secret-key");

  const manifest = await store.getManifest("my-agent");
  assert(manifest);
  assert(
    manifest.credential_hashes.includes(await hashApiKey("my-secret-key")),
  );
});

// =============================================================================
// handleDeploy — slot replacement
// =============================================================================

Deno.test("deploy replaces existing agent bundle", async () => {
  const { fetch, store } = await createTestOrchestrator();
  await deployAgent(fetch);

  // Redeploy with different worker
  const res = await fetch("/my-agent/deploy", {
    method: "POST",
    headers: {
      Authorization: "Bearer key1",
      "Content-Type": "application/json",
    },
    body: deployBody({ worker: "console.log('v2');" }),
  });
  assertEquals(res.status, 200);

  const workerCode = await store.getFile("my-agent", "worker");
  assertStrictEquals(workerCode, "console.log('v2');");
});
