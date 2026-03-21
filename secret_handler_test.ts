// Copyright 2025 the AAI authors. MIT license.
import { assertEquals } from "@std/assert";
import { createTestOrchestrator, deployAgent } from "./_test_utils.ts";

async function deployAndAuth(slug = "my-agent", key = "key1") {
  const orch = await createTestOrchestrator();
  await deployAgent(orch.fetch, slug, key);
  return { ...orch, key };
}

function secretReq(
  slug: string,
  key: string,
  method: string,
  body?: unknown,
): [string, RequestInit] {
  return [`/${slug}/secret`, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }];
}

// =============================================================================
// GET /secret — list
// =============================================================================

Deno.test("secret list rejects without auth", async () => {
  const { fetch } = await deployAndAuth();
  assertEquals((await fetch("/my-agent/secret")).status, 401);
});

Deno.test("secret list returns var names for deployed agent", async () => {
  const { fetch, key } = await deployAndAuth();
  const res = await fetch(...secretReq("my-agent", key, "GET"));
  assertEquals(res.status, 200);
  assertEquals((await res.json()).vars, ["ASSEMBLYAI_API_KEY"]);
});

// =============================================================================
// PUT /secret — set
// =============================================================================

Deno.test("secret set rejects without auth", async () => {
  const { fetch } = await deployAndAuth();
  assertEquals(
    (await fetch("/my-agent/secret", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ MY_KEY: "secret" }),
    })).status,
    401,
  );
});

Deno.test("secret set merges new vars", async () => {
  const { fetch, key } = await deployAndAuth();
  const setRes = await fetch(
    ...secretReq("my-agent", key, "PUT", { MY_KEY: "secret" }),
  );
  assertEquals(setRes.status, 200);
  const setBody = await setRes.json();
  assertEquals(setBody.ok, true);
  assertEquals(setBody.keys.sort(), ["ASSEMBLYAI_API_KEY", "MY_KEY"]);

  const listRes = await fetch(...secretReq("my-agent", key, "GET"));
  assertEquals((await listRes.json()).vars.sort(), [
    "ASSEMBLYAI_API_KEY",
    "MY_KEY",
  ]);
});

for (
  const [name, body] of [
    ["non-object body", ["not", "an", "object"]],
    ["non-string values", { NUM: 123 }],
  ] as const
) {
  Deno.test(`secret set rejects ${name}`, async () => {
    const { fetch, key } = await deployAndAuth();
    assertEquals(
      (await fetch(...secretReq("my-agent", key, "PUT", body))).status,
      400,
    );
  });
}

// =============================================================================
// DELETE /secret/:key — remove
// =============================================================================

Deno.test("secret delete rejects without auth", async () => {
  const { fetch } = await deployAndAuth();
  assertEquals(
    (await fetch("/my-agent/secret/ASSEMBLYAI_API_KEY", {
      method: "DELETE",
    })).status,
    401,
  );
});

Deno.test("secret delete removes a key", async () => {
  const { fetch, key } = await deployAndAuth();
  await fetch(...secretReq("my-agent", key, "PUT", { EXTRA: "val" }));

  const delRes = await fetch("/my-agent/secret/EXTRA", {
    method: "DELETE",
    headers: { Authorization: `Bearer ${key}` },
  });
  assertEquals(delRes.status, 200);
  assertEquals((await delRes.json()).ok, true);

  const listRes = await fetch(...secretReq("my-agent", key, "GET"));
  assertEquals((await listRes.json()).vars, ["ASSEMBLYAI_API_KEY"]);
});

Deno.test("secret delete returns 404 for unknown agent", async () => {
  const { fetch, key } = await deployAndAuth();
  assertEquals(
    (await fetch("/nonexistent/secret/KEY", {
      method: "DELETE",
      headers: { Authorization: `Bearer ${key}` },
    })).status,
    404,
  );
});
