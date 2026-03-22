// Copyright 2025 the AAI authors. MIT license.
import { assertStrictEquals } from "@std/assert";
import type { AgentSlot } from "./sandbox.ts";
import { registerSlot, resolveSandbox } from "./sandbox.ts";
import {
  createTestKvStore,
  createTestStore,
  VALID_ENV,
} from "./_test_utils.ts";

// --- resolveSandbox ---

Deno.test({
  name: "resolveSandbox returns existing sandbox from slot map",
  sanitizeResources: false,
  async fn() {
    const fakeSandbox = {
      startSession() {},
      fetch: () => Promise.resolve(new Response()),
      terminate() {},
    };
    const slots = new Map<string, AgentSlot>();
    slots.set("test-agent", {
      slug: "test-agent",
      keyHash: "test-key-hash",
      sandbox: fakeSandbox,
    });
    const store = createTestStore();
    const kvStore = createTestKvStore();
    const result = await resolveSandbox("test-agent", {
      slots,
      store,
      kvStore,
    });
    assertStrictEquals(result, fakeSandbox);
    const slot = slots.get("test-agent")!;
    if (slot.idleTimer) clearTimeout(slot.idleTimer);
  },
});

Deno.test("resolveSandbox returns null when not in map and not in store", async () => {
  const store = createTestStore();
  const kvStore = createTestKvStore();
  const result = await resolveSandbox("missing-agent", {
    slots: new Map(),
    store,
    kvStore,
  });
  assertStrictEquals(result, null);
});

// --- registerSlot (lazy discovery helper) ---

Deno.test("registerSlot lazy-loads from manifest", async () => {
  const store = createTestStore();
  const slots = new Map<string, AgentSlot>();
  await store.putAgent({
    slug: "stored-agent",
    env: VALID_ENV,
    worker: "console.log('w');",
    clientFiles: { "index.html": "<html></html>" },
    credential_hashes: ["hash1"],
  });
  const manifest = await store.getManifest("stored-agent");
  registerSlot(slots, manifest!);
  assertStrictEquals(slots.has("stored-agent"), true);
  assertStrictEquals(slots.get("stored-agent")!.slug, "stored-agent");
  assertStrictEquals(slots.get("stored-agent")!.keyHash, "hash1");
});
