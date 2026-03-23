// Copyright 2025 the AAI authors. MIT license.
import {
  assert,
  assertEquals,
  assertRejects,
  assertStrictEquals,
} from "@std/assert";
import { afterEach, describe, it } from "@std/testing/bdd";
import {
  type AgentSlot,
  createSandbox,
  ensureAgent,
  registerSlot,
  resolveSandbox,
  type SandboxOptions,
} from "./sandbox.ts";
import {
  createTestKvStore,
  createTestStore,
  createTestVectorStore,
  VALID_ENV,
} from "./_test_utils.ts";

const SCOPE = { slug: "test-agent", keyHash: "abc" };

const MINIMAL_WORKER = `
import { CapnwebEndpoint } from "@aai/sdk/capnweb";

const endpoint = new CapnwebEndpoint(globalThis);

endpoint.handle("worker.init", () => null);

endpoint.handle("worker.fetch", (args) => {
  const [url, method] = args;
  return {
    status: 200,
    headers: { "content-type": "text/plain" },
    body: "ok from " + method + " " + url,
  };
});

endpoint.handle("worker.handleWebSocket", () => null);
`;

function makeOpts(overrides?: Partial<SandboxOptions>): SandboxOptions {
  return {
    workerCode: MINIMAL_WORKER,
    env: { ASSEMBLYAI_API_KEY: "test" },
    kvStore: createTestKvStore(),
    scope: SCOPE,
    ...overrides,
  };
}

type Sandbox = Awaited<ReturnType<typeof createSandbox>>;

/** Create sandbox, fetch a URL, return the response body text. */
async function sandboxFetchText(
  sandbox: Sandbox,
  url: string,
  init?: RequestInit,
): Promise<string> {
  const res = await sandbox.fetch(new Request(url, init));
  return res.text();
}

function useSandbox() {
  let sandbox: Sandbox | null = null;
  afterEach(() => {
    sandbox?.terminate();
    sandbox = null;
  });
  return {
    async create(overrides?: Partial<SandboxOptions>) {
      sandbox = await createSandbox(makeOpts(overrides));
      return sandbox;
    },
  };
}

// --- createSandbox ---

describe("createSandbox", () => {
  const ctx = useSandbox();

  it("initializes and returns sandbox", async () => {
    const sb = await ctx.create();
    assert(sb);
  });

  it("fetch proxies request to worker", async () => {
    const sb = await ctx.create();
    assertStrictEquals(
      await sandboxFetchText(sb, "http://example.com/test"),
      "ok from GET http://example.com/test",
    );
  });

  it("fetch forwards POST method", async () => {
    const sb = await ctx.create();
    assertStrictEquals(
      await sandboxFetchText(sb, "http://example.com/api", {
        method: "POST",
        body: "data",
      }),
      "ok from POST http://example.com/api",
    );
  });

  it("terminate does not throw", async () => {
    const sb = await ctx.create();
    sb.terminate();
    sb.terminate(); // calling again should be safe
  });

  it("passes vectorStore option", async () => {
    const sb = await ctx.create({ vectorStore: createTestVectorStore() });
    assert(sb);
  });
});

// --- RPC handler tests via worker that calls host ---

const KV_WORKER = `
import { CapnwebEndpoint } from "@aai/sdk/capnweb";

const endpoint = new CapnwebEndpoint(globalThis);

endpoint.handle("worker.init", () => null);

endpoint.handle("worker.fetch", async (args) => {
  const [url] = args;
  const u = new URL(url);
  const op = u.searchParams.get("op");

  if (op === "set") {
    await endpoint.call("kv.set", ["mykey", { hello: "world" }, undefined]);
    return { status: 200, headers: {}, body: "set-ok" };
  }
  if (op === "get") {
    const val = await endpoint.call("kv.get", ["mykey"]);
    return { status: 200, headers: {}, body: JSON.stringify(val) };
  }
  if (op === "del") {
    await endpoint.call("kv.del", ["mykey"]);
    return { status: 200, headers: {}, body: "del-ok" };
  }
  if (op === "list") {
    const entries = await endpoint.call("kv.list", ["", undefined, undefined]);
    return { status: 200, headers: {}, body: JSON.stringify(entries) };
  }
  return { status: 404, headers: {}, body: "unknown" };
});
`;

describe("sandbox host.kv", () => {
  const ctx = useSandbox();
  const kvOpts = { workerCode: KV_WORKER, kvStore: createTestKvStore() };

  it("set and get round-trip", async () => {
    const sb = await ctx.create(kvOpts);
    assertStrictEquals(await sandboxFetchText(sb, "http://x?op=set"), "set-ok");
    assertEquals(
      JSON.parse(await sandboxFetchText(sb, "http://x?op=get")),
      { hello: "world" },
    );
  });

  it("del removes key", async () => {
    const sb = await ctx.create(kvOpts);
    await sandboxFetchText(sb, "http://x?op=set");
    assertStrictEquals(await sandboxFetchText(sb, "http://x?op=del"), "del-ok");
    assertStrictEquals(await sandboxFetchText(sb, "http://x?op=get"), "null");
  });

  it("list returns entries", async () => {
    const sb = await ctx.create(kvOpts);
    await sandboxFetchText(sb, "http://x?op=set");
    const entries = JSON.parse(await sandboxFetchText(sb, "http://x?op=list"));
    assert(Array.isArray(entries));
  });
});

const VECTOR_WORKER = `
import { CapnwebEndpoint } from "@aai/sdk/capnweb";

const endpoint = new CapnwebEndpoint(globalThis);

endpoint.handle("worker.init", () => null);

endpoint.handle("worker.fetch", async (args) => {
  const [url] = args;
  const u = new URL(url);
  const op = u.searchParams.get("op");

  if (op === "upsert") {
    await endpoint.call("vec.upsert", ["doc1", "hello world", undefined]);
    return { status: 200, headers: {}, body: "upsert-ok" };
  }
  if (op === "query") {
    const results = await endpoint.call("vec.query", ["hello", undefined, undefined]);
    return { status: 200, headers: {}, body: JSON.stringify(results) };
  }
  if (op === "remove") {
    await endpoint.call("vec.remove", [["doc1"]]);
    return { status: 200, headers: {}, body: "remove-ok" };
  }
  if (op === "no-store") {
    try {
      await endpoint.call("vec.query", ["x"]);
    } catch (e) {
      return { status: 200, headers: {}, body: e.message };
    }
  }
  return { status: 404, headers: {}, body: "unknown" };
});
`;

describe("sandbox host.vector", () => {
  const ctx = useSandbox();
  const vecOpts = { workerCode: VECTOR_WORKER, vectorStore: createTestVectorStore() };

  it("upsert and query round-trip", async () => {
    const sb = await ctx.create(vecOpts);
    assertStrictEquals(await sandboxFetchText(sb, "http://x?op=upsert"), "upsert-ok");
    const results = JSON.parse(await sandboxFetchText(sb, "http://x?op=query"));
    assert(Array.isArray(results));
    assert(results.length > 0);
    assertStrictEquals(results[0].id, "doc1");
  });

  it("remove deletes entries", async () => {
    const sb = await ctx.create(vecOpts);
    await sandboxFetchText(sb, "http://x?op=upsert");
    assertStrictEquals(await sandboxFetchText(sb, "http://x?op=remove"), "remove-ok");
    const results = JSON.parse(await sandboxFetchText(sb, "http://x?op=query"));
    assertStrictEquals(results.length, 0);
  });

  it("throws when store not configured", async () => {
    const sb = await ctx.create({ workerCode: VECTOR_WORKER, vectorStore: undefined });
    assertStrictEquals(
      await sandboxFetchText(sb, "http://x?op=no-store"),
      "Vector store not configured",
    );
  });
});

// --- ensureAgent ---

Deno.test({
  name: "ensureAgent returns existing sandbox immediately",
  sanitizeResources: false,
  async fn() {
    const fakeSandbox = {
      startSession() {},
      fetch: () => Promise.resolve(new Response()),
      terminate() {},
    };
    const slot: AgentSlot = {
      slug: "test",
      keyHash: "k",
      sandbox: fakeSandbox,
    };
    const result = await ensureAgent(slot, {
      getWorkerCode: () => Promise.resolve(null),
      kvCtx: { kvStore: createTestKvStore(), scope: { slug: "test", keyHash: "k" } },
      getEnv: () => Promise.resolve({}),
    });
    assertStrictEquals(result, fakeSandbox);
    if (slot.idleTimer) clearTimeout(slot.idleTimer);
  },
});

Deno.test({
  name: "ensureAgent coalesces concurrent init calls",
  sanitizeResources: false,
  async fn() {
    const store = createTestStore();
    await store.putAgent({
      slug: "coalesce-agent",
      env: VALID_ENV,
      worker: MINIMAL_WORKER,
      clientFiles: { "index.html": "<html></html>" },
      credential_hashes: ["hash1"],
    });
    const slot: AgentSlot = { slug: "coalesce-agent", keyHash: "hash1" };
    const scope = { slug: "coalesce-agent", keyHash: "hash1" };
    const opts = {
      getWorkerCode: (s: string) => store.getWorkerCode(s),
      kvCtx: { kvStore: createTestKvStore(), scope },
      getEnv: async () => (await store.getEnv("coalesce-agent")) ?? {},
    };

    // Fire two concurrent calls — both should return the same promise
    const p1 = ensureAgent(slot, opts);
    const p2 = ensureAgent(slot, opts);
    assertStrictEquals(p1, p2);

    const sb = await p1;
    assert(sb);
    sb.terminate();
    if (slot.idleTimer) clearTimeout(slot.idleTimer);
  },
});

Deno.test("ensureAgent rejects when worker code not found", async () => {
  const slot: AgentSlot = { slug: "no-code", keyHash: "k" };
  const scope = { slug: "no-code", keyHash: "k" };
  await assertRejects(
    () =>
      ensureAgent(slot, {
        getWorkerCode: () => Promise.resolve(null),
        kvCtx: { kvStore: createTestKvStore(), scope },
        getEnv: () => Promise.resolve({ ASSEMBLYAI_API_KEY: "k" }),
      }),
    Error,
    "Worker code not found",
  );
  // After error, initializing should be cleared
  assertStrictEquals(slot.initializing, undefined);
});

// --- registerSlot ---

Deno.test("registerSlot uses empty string for missing credential_hashes", () => {
  const slots = new Map<string, AgentSlot>();
  registerSlot(slots, { slug: "empty-creds", env: {}, credential_hashes: [] });
  assertStrictEquals(slots.get("empty-creds")!.keyHash, "");
});

// --- resolveSandbox ---

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

Deno.test({
  name: "resolveSandbox lazy-discovers agent from store and spawns sandbox",
  sanitizeResources: false,
  async fn() {
    const store = createTestStore();
    await store.putAgent({
      slug: "lazy-agent",
      env: VALID_ENV,
      worker: MINIMAL_WORKER,
      clientFiles: { "index.html": "<html></html>" },
      credential_hashes: ["hash1"],
    });
    const slots = new Map<string, AgentSlot>();
    const kvStore = createTestKvStore();
    const result = await resolveSandbox("lazy-agent", {
      slots,
      store,
      kvStore,
    });
    assert(result);
    // Slot should now be registered
    assert(slots.has("lazy-agent"));
    result.terminate();
    const slot = slots.get("lazy-agent")!;
    if (slot.idleTimer) clearTimeout(slot.idleTimer);
  },
});

Deno.test({
  name: "resolveSandbox passes vectorStore when provided",
  sanitizeResources: false,
  async fn() {
    const store = createTestStore();
    await store.putAgent({
      slug: "vec-agent",
      env: VALID_ENV,
      worker: MINIMAL_WORKER,
      clientFiles: { "index.html": "<html></html>" },
      credential_hashes: ["hash1"],
    });
    const slots = new Map<string, AgentSlot>();
    const kvStore = createTestKvStore();
    const vectorStore = createTestVectorStore();
    const result = await resolveSandbox("vec-agent", {
      slots,
      store,
      kvStore,
      vectorStore,
    });
    assert(result);
    result.terminate();
    const slot = slots.get("vec-agent")!;
    if (slot.idleTimer) clearTimeout(slot.idleTimer);
  },
});
