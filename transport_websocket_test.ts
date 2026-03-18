// Copyright 2025 the AAI authors. MIT license.
import { assertNotStrictEquals, assertStrictEquals } from "@std/assert";
import { discoverSlot } from "./transport_websocket.ts";
import type { AgentSlot } from "./worker_pool.ts";
import { createTestStore, makeSlot, VALID_ENV } from "./_test_utils.ts";

// --- discoverSlot ---

Deno.test("discoverSlot returns existing slot from map", async () => {
  const slot = makeSlot();
  const slots = new Map([["test-agent", slot]]);
  const store = createTestStore();
  const result = await discoverSlot("test-agent", { slots, store });
  assertStrictEquals(result, slot);
});

Deno.test("discoverSlot returns null when not in map and not in store", async () => {
  const store = createTestStore();
  const result = await discoverSlot("missing-agent", {
    slots: new Map(),
    store,
  });
  assertStrictEquals(result, null);
});

Deno.test("discoverSlot lazy-loads from store", async () => {
  const store = createTestStore();
  const slots = new Map<string, AgentSlot>();
  await store.putAgent({
    slug: "stored-agent",
    env: VALID_ENV,
    worker: "console.log('w');",
    html: "<html></html>",
    credential_hashes: ["hash1"],
  });
  const result = await discoverSlot("stored-agent", { slots, store });
  assertNotStrictEquals(result, null);
  assertStrictEquals(result!.slug, "stored-agent");
  assertStrictEquals(slots.has("stored-agent"), true);
});
