// Copyright 2025 the AAI authors. MIT license.
import {
  assert,
  assertEquals,
  assertMatch,
  assertNotStrictEquals,
  assertStrictEquals,
} from "@std/assert";
import { hashApiKey, verifySlugOwner } from "./auth.ts";
import { createTestStore, makeConfig } from "./_test_utils.ts";

const TC = makeConfig();
const TS: [] = [];

Deno.test("hashApiKey produces consistent 64-char hex", async () => {
  const h1 = await hashApiKey("key");
  const h2 = await hashApiKey("key");
  assertStrictEquals(h1, h2);
  assertMatch(h1, /^[0-9a-f]{64}$/);
  assertNotStrictEquals(await hashApiKey("other"), h1);
});

Deno.test("verifySlugOwner returns unclaimed for missing slug", async () => {
  const store = createTestStore();
  const result = await verifySlugOwner("key1", { slug: "my-agent", store });
  assertEquals(result.status, "unclaimed");
  assert("keyHash" in result);
  assertStrictEquals(result.keyHash, await hashApiKey("key1"));
});

Deno.test("verifySlugOwner returns owned for matching credential", async () => {
  const store = createTestStore();
  const hash = await hashApiKey("key1");
  await store.putAgent({
    slug: "my-agent",
    env: {},
    transport: ["websocket"],
    worker: "w",
    html: "<html></html>",
    credential_hashes: [hash],
    config: TC,
    toolSchemas: TS,
  });
  const result = await verifySlugOwner("key1", { slug: "my-agent", store });
  assertEquals(result.status, "owned");
  assert("keyHash" in result);
});

Deno.test("verifySlugOwner returns forbidden for different credential", async () => {
  const store = createTestStore();
  const hash = await hashApiKey("key1");
  await store.putAgent({
    slug: "my-agent",
    env: {},
    transport: ["websocket"],
    worker: "w",
    html: "<html></html>",
    credential_hashes: [hash],
    config: TC,
    toolSchemas: TS,
  });
  const result = await verifySlugOwner("key2", { slug: "my-agent", store });
  assertEquals(result.status, "forbidden");
});

Deno.test("verifySlugOwner allows multiple credential hashes", async () => {
  const store = createTestStore();
  const hash1 = await hashApiKey("key1");
  const hash2 = await hashApiKey("key2");
  await store.putAgent({
    slug: "my-agent",
    env: {},
    transport: ["websocket"],
    worker: "w",
    html: "<html></html>",
    credential_hashes: [hash1, hash2],
    config: TC,
    toolSchemas: TS,
  });

  const r1 = await verifySlugOwner("key1", { slug: "my-agent", store });
  assertEquals(r1.status, "owned");

  const r2 = await verifySlugOwner("key2", { slug: "my-agent", store });
  assertEquals(r2.status, "owned");

  const r3 = await verifySlugOwner("key3", { slug: "my-agent", store });
  assertEquals(r3.status, "forbidden");
});

Deno.test("verifySlugOwner rejects when credential_hashes is empty", async () => {
  const store = createTestStore();
  await store.putAgent({
    slug: "my-agent",
    env: {},
    transport: ["websocket"],
    worker: "w",
    html: "<html></html>",
    credential_hashes: [],
    config: TC,
    toolSchemas: TS,
  });
  const result = await verifySlugOwner("any-key", { slug: "my-agent", store });
  assertEquals(result.status, "forbidden");
});
