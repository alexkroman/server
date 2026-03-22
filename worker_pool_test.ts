// Copyright 2025 the AAI authors. MIT license.
import { assert, assertRejects, assertStrictEquals } from "@std/assert";
import {
  type AgentSlot,
  ensureAgent,
  registerSlot,
  resolveSandbox,
} from "./sandbox.ts";
import {
  createTestKvStore,
  createTestStore,
  makeSlot,
  VALID_ENV,
} from "./_test_utils.ts";

// --- registerSlot ---

Deno.test("registerSlot always registers", () => {
  const slots = new Map<string, AgentSlot>();
  registerSlot(slots, {
    slug: "hello",
    env: VALID_ENV,
    credential_hashes: ["hash1"],
  });
  assertStrictEquals(slots.has("hello"), true);
});

Deno.test("registerSlot registers even with empty env", () => {
  const slots = new Map<string, AgentSlot>();
  registerSlot(slots, {
    slug: "bad",
    env: {},
    credential_hashes: [],
  });
  assertStrictEquals(slots.has("bad"), true);
});

Deno.test("registerSlot overwrites existing slot", () => {
  const slots = new Map<string, AgentSlot>();
  registerSlot(slots, {
    slug: "x",
    env: VALID_ENV,
    credential_hashes: ["h"],
  });
  registerSlot(slots, {
    slug: "x",
    env: VALID_ENV,
    credential_hashes: ["h"],
  });
  assertStrictEquals(slots.size, 1);
});

Deno.test("registerSlot stores first credential hash as keyHash", () => {
  const slots = new Map<string, AgentSlot>();
  registerSlot(slots, {
    slug: "s",
    env: VALID_ENV,
    credential_hashes: ["first", "second"],
  });
  assertStrictEquals(slots.get("s")!.keyHash, "first");
});

Deno.test("registerSlot uses empty string keyHash when no credential_hashes", () => {
  const slots = new Map<string, AgentSlot>();
  registerSlot(slots, {
    slug: "s2",
    env: VALID_ENV,
    credential_hashes: [],
  });
  assertStrictEquals(slots.get("s2")!.keyHash, "");
});

// --- ensureAgent ---

const dummyOpts = {
  getWorkerCode: () => Promise.resolve("code"),
  getEnv: () => Promise.resolve(VALID_ENV),
  kvCtx: {
    kvStore: createTestKvStore(),
    scope: { keyHash: "k", slug: "test-agent" },
  },
};

Deno.test({
  name: "ensureAgent resolves immediately when sandbox exists",
  sanitizeResources: false,
  async fn() {
    const slot = makeSlot({
      sandbox: {
        startSession() {},
        fetch: () => Promise.resolve(new Response()),
        terminate() {},
      },
    });
    await ensureAgent(slot, dummyOpts);
    assert(slot.sandbox);
    if (slot.idleTimer) clearTimeout(slot.idleTimer);
  },
});

Deno.test({
  name: "ensureAgent returns same promise for concurrent init",
  async fn() {
    const fakeSandbox = {
      startSession() {},
      fetch: () => Promise.resolve(new Response()),
      terminate() {},
    };
    const slot = makeSlot();
    const deferred = Promise.withResolvers<typeof fakeSandbox>();
    slot.initializing = deferred.promise;

    const p1 = ensureAgent(slot, dummyOpts);
    const p2 = ensureAgent(slot, dummyOpts);

    assertStrictEquals(p1, p2);
    deferred.resolve(fakeSandbox);
    await p1;
  },
});

Deno.test("ensureAgent throws when worker code not found", async () => {
  const slot = makeSlot();
  await assertRejects(
    () =>
      ensureAgent(slot, {
        ...dummyOpts,
        getWorkerCode: () => Promise.resolve(null),
      }),
    Error,
    "Worker code not found",
  );
});

Deno.test("ensureAgent cleans up initializing on error", async () => {
  const slot = makeSlot();
  try {
    await ensureAgent(slot, {
      ...dummyOpts,
      getWorkerCode: () => Promise.reject(new Error("boom")),
    });
  } catch {
    // expected
  }
  assertStrictEquals(slot.initializing, undefined);
});

// --- resolveSandbox ---

Deno.test({
  name: "resolveSandbox returns null for unknown agent",
  async fn() {
    const store = createTestStore();
    const kvStore = createTestKvStore();
    const result = await resolveSandbox("missing", {
      slots: new Map(),
      store,
      kvStore,
    });
    assertStrictEquals(result, null);
  },
});

Deno.test({
  name: "resolveSandbox returns sandbox from existing slot",
  sanitizeResources: false,
  async fn() {
    const fakeSandbox = {
      startSession() {},
      fetch: () => Promise.resolve(new Response()),
      terminate() {},
    };
    const slots = new Map<string, AgentSlot>();
    slots.set("test-agent", makeSlot({ sandbox: fakeSandbox }));
    const store = createTestStore();
    const kvStore = createTestKvStore();

    const sandbox = await resolveSandbox("test-agent", {
      slots,
      store,
      kvStore,
    });
    assertStrictEquals(sandbox, fakeSandbox);
    const slot = slots.get("test-agent")!;
    if (slot.idleTimer) clearTimeout(slot.idleTimer);
  },
});
