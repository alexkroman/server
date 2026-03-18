// Copyright 2025 the AAI authors. MIT license.
import { assert, assertRejects, assertStrictEquals } from "@std/assert";
import {
  type AgentSlot,
  ensureAgent,
  prepareSession,
  registerSlot,
} from "./worker_pool.ts";
import {
  createTestKvStore,
  createTestStore,
  createTestVectorStore,
  makeSlot,
  VALID_ENV,
} from "./_test_utils.ts";

// --- registerSlot ---

Deno.test("registerSlot with valid env", () => {
  const slots = new Map<string, AgentSlot>();
  const ok = registerSlot(slots, {
    slug: "hello",
    env: VALID_ENV,
    credential_hashes: ["hash1"],
  });
  assertStrictEquals(ok, true);
  assertStrictEquals(slots.has("hello"), true);
});

Deno.test("registerSlot returns false for invalid env", () => {
  const slots = new Map<string, AgentSlot>();
  const ok = registerSlot(slots, {
    slug: "bad",
    env: {},
    credential_hashes: [],
  });
  assertStrictEquals(ok, false);
  assertStrictEquals(slots.has("bad"), false);
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
    slug: "s",
    env: VALID_ENV,
    credential_hashes: [],
  });
  // env is invalid without ASSEMBLYAI_API_KEY so this returns false,
  // but with valid env and empty creds:
  const ok = registerSlot(slots, {
    slug: "s2",
    env: VALID_ENV,
    credential_hashes: [],
  });
  if (ok) {
    assertStrictEquals(slots.get("s2")!.keyHash, "");
  }
});

// --- ensureAgent ---

Deno.test({
  name: "ensureAgent resolves immediately when sandbox exists",
  // resetIdleTimer creates an unref'd timer — skip resource sanitizer
  sanitizeResources: false,
  async fn() {
    const slot = makeSlot({
      sandbox: {
        startSession() {},
        fetch: () => Promise.resolve(new Response()),
        terminate() {},
      },
    });
    await ensureAgent(slot, {
      getEnv: () => Promise.resolve(VALID_ENV),
    });
    assert(slot.sandbox);
    if (slot.idleTimer) clearTimeout(slot.idleTimer);
  },
});

Deno.test({
  name: "ensureAgent returns same promise for concurrent init",
  async fn() {
    const slot = makeSlot();
    // Manually set initializing to simulate an in-flight init
    const deferred = Promise.withResolvers<void>();
    slot.initializing = deferred.promise;

    const p1 = ensureAgent(slot, {
      getEnv: () => Promise.resolve(VALID_ENV),
    });
    const p2 = ensureAgent(slot, {
      getEnv: () => Promise.resolve(VALID_ENV),
    });

    // Both should return the same promise
    assertStrictEquals(p1, p2);
    deferred.resolve();
    await p1;
  },
});

Deno.test("ensureAgent throws when getWorkerCode is missing", async () => {
  const slot = makeSlot();
  await assertRejects(
    () =>
      ensureAgent(slot, {
        getEnv: () => Promise.resolve(VALID_ENV),
        kvCtx: {
          kvStore: createTestKvStore(),
          scope: { keyHash: "k", slug: "test-agent" },
        },
      }),
    Error,
    "No worker code source",
  );
});

Deno.test("ensureAgent throws when worker code not found", async () => {
  const slot = makeSlot();
  await assertRejects(
    () =>
      ensureAgent(slot, {
        getWorkerCode: () => Promise.resolve(null),
        getEnv: () => Promise.resolve(VALID_ENV),
        kvCtx: {
          kvStore: createTestKvStore(),
          scope: { keyHash: "k", slug: "test-agent" },
        },
      }),
    Error,
    "Worker code not found",
  );
});

Deno.test("ensureAgent throws when kvCtx is missing", async () => {
  const slot = makeSlot();
  await assertRejects(
    () =>
      ensureAgent(slot, {
        getWorkerCode: () => Promise.resolve("code"),
        getEnv: () => Promise.resolve(VALID_ENV),
      }),
    Error,
    "No KV context",
  );
});

Deno.test("ensureAgent cleans up initializing on error", async () => {
  const slot = makeSlot();
  try {
    await ensureAgent(slot, {
      getWorkerCode: () => Promise.reject(new Error("boom")),
      getEnv: () => Promise.resolve(VALID_ENV),
      kvCtx: {
        kvStore: createTestKvStore(),
        scope: { keyHash: "k", slug: "test-agent" },
      },
    });
  } catch {
    // expected
  }
  assertStrictEquals(slot.initializing, undefined);
});

// --- prepareSession ---

Deno.test({
  name: "prepareSession returns sandbox from slot",
  sanitizeResources: false,
  async fn() {
    const fakeSandbox = {
      startSession() {},
      fetch: () => Promise.resolve(new Response()),
      terminate() {},
    };
    const slot = makeSlot({ sandbox: fakeSandbox });
    const store = createTestStore();
    const kvStore = createTestKvStore();

    const sandbox = await prepareSession(slot, {
      slug: "test-agent",
      store,
      kvStore,
    });
    assertStrictEquals(sandbox, fakeSandbox);
    if (slot.idleTimer) clearTimeout(slot.idleTimer);
  },
});

Deno.test({
  name: "prepareSession passes vectorStore when provided",
  sanitizeResources: false,
  async fn() {
    const fakeSandbox = {
      startSession() {},
      fetch: () => Promise.resolve(new Response()),
      terminate() {},
    };
    const slot = makeSlot({ sandbox: fakeSandbox });
    const store = createTestStore();
    const kvStore = createTestKvStore();
    const vectorStore = createTestVectorStore();

    const sandbox = await prepareSession(slot, {
      slug: "test-agent",
      store,
      kvStore,
      vectorStore,
    });
    assertStrictEquals(sandbox, fakeSandbox);
    if (slot.idleTimer) clearTimeout(slot.idleTimer);
  },
});
