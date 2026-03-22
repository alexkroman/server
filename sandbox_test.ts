// Copyright 2025 the AAI authors. MIT license.
import { assert, assertEquals, assertStrictEquals } from "@std/assert";
import { afterEach, describe, it } from "@std/testing/bdd";
import { createSandbox, type SandboxOptions } from "./sandbox.ts";
import {
  createTestKvStore,
  createTestVectorStore,
  KV_WORKER,
  MINIMAL_WORKER,
  VECTOR_WORKER,
} from "./_test_utils.ts";

const SCOPE = { slug: "test-agent", keyHash: "abc" };

function makeOpts(overrides?: Partial<SandboxOptions>): SandboxOptions {
  return {
    workerCode: MINIMAL_WORKER,
    env: { ASSEMBLYAI_API_KEY: "test" },
    kvStore: createTestKvStore(),
    scope: SCOPE,
    ...overrides,
  };
}

// --- createSandbox ---

describe("createSandbox", () => {
  let sandbox: Awaited<ReturnType<typeof createSandbox>> | null = null;

  afterEach(() => {
    sandbox?.terminate();
    sandbox = null;
  });

  it("initializes and returns sandbox", async () => {
    sandbox = await createSandbox(makeOpts());
    assert(sandbox);
    assert(typeof sandbox.startSession === "function");
    assert(typeof sandbox.fetch === "function");
    assert(typeof sandbox.terminate === "function");
  });

  it("fetch proxies request to worker", async () => {
    sandbox = await createSandbox(makeOpts());
    const res = await sandbox.fetch(new Request("http://example.com/test"));
    assertStrictEquals(res.status, 200);
    assertStrictEquals(
      await res.text(),
      "ok from GET /test",
    );
  });

  it("fetch forwards POST method", async () => {
    sandbox = await createSandbox(makeOpts());
    const res = await sandbox.fetch(
      new Request("http://example.com/api", { method: "POST", body: "data" }),
    );
    assertStrictEquals(res.status, 200);
    assertStrictEquals(
      await res.text(),
      "ok from POST /api",
    );
  });

  it("terminate does not throw", async () => {
    sandbox = await createSandbox(makeOpts());
    sandbox.terminate();
    sandbox.terminate(); // calling again should be safe
    sandbox = null; // already terminated
  });

  it("works without clientHtml", async () => {
    sandbox = await createSandbox(makeOpts());
    assert(sandbox);
  });

  it("passes vectorStore option", async () => {
    sandbox = await createSandbox(
      makeOpts({ vectorStore: createTestVectorStore() }),
    );
    assert(sandbox);
  });
});

// --- RPC handler tests via worker that calls host ---

describe("sandbox host.kv", () => {
  let sandbox: Awaited<ReturnType<typeof createSandbox>> | null = null;

  afterEach(() => {
    sandbox?.terminate();
    sandbox = null;
  });

  it("set and get round-trip", async () => {
    sandbox = await createSandbox(
      makeOpts({ workerCode: KV_WORKER, kvStore: createTestKvStore() }),
    );
    assertStrictEquals(
      await (await sandbox.fetch(new Request("http://x?op=set"))).text(),
      "set-ok",
    );
    const val = JSON.parse(
      await (await sandbox.fetch(new Request("http://x?op=get"))).text(),
    );
    assertEquals(val, { hello: "world" });
  });

  it("del removes key", async () => {
    sandbox = await createSandbox(
      makeOpts({ workerCode: KV_WORKER, kvStore: createTestKvStore() }),
    );
    await sandbox.fetch(new Request("http://x?op=set"));
    assertStrictEquals(
      await (await sandbox.fetch(new Request("http://x?op=del"))).text(),
      "del-ok",
    );
    assertStrictEquals(
      await (await sandbox.fetch(new Request("http://x?op=get"))).text(),
      "null",
    );
  });

  it("list returns entries", async () => {
    sandbox = await createSandbox(
      makeOpts({ workerCode: KV_WORKER, kvStore: createTestKvStore() }),
    );
    await sandbox.fetch(new Request("http://x?op=set"));
    const entries = JSON.parse(
      await (await sandbox.fetch(new Request("http://x?op=list"))).text(),
    );
    assert(Array.isArray(entries));
  });
});

describe("sandbox host.vector", () => {
  let sandbox: Awaited<ReturnType<typeof createSandbox>> | null = null;

  afterEach(() => {
    sandbox?.terminate();
    sandbox = null;
  });

  it("upsert and query round-trip", async () => {
    sandbox = await createSandbox(
      makeOpts({
        workerCode: VECTOR_WORKER,
        vectorStore: createTestVectorStore(),
      }),
    );
    assertStrictEquals(
      await (await sandbox.fetch(new Request("http://x?op=upsert"))).text(),
      "upsert-ok",
    );
    const results = JSON.parse(
      await (await sandbox.fetch(new Request("http://x?op=query"))).text(),
    );
    assert(Array.isArray(results));
    assertStrictEquals(results.length > 0, true);
    assertStrictEquals(results[0].id, "doc1");
  });

  it("remove deletes entries", async () => {
    sandbox = await createSandbox(
      makeOpts({
        workerCode: VECTOR_WORKER,
        vectorStore: createTestVectorStore(),
      }),
    );
    await sandbox.fetch(new Request("http://x?op=upsert"));
    assertStrictEquals(
      await (await sandbox.fetch(new Request("http://x?op=remove"))).text(),
      "remove-ok",
    );
    const results = JSON.parse(
      await (await sandbox.fetch(new Request("http://x?op=query"))).text(),
    );
    assertStrictEquals(results.length, 0);
  });

  it("throws when store not configured", async () => {
    sandbox = await createSandbox(
      makeOpts({ workerCode: VECTOR_WORKER, vectorStore: undefined }),
    );
    const body = await (
      await sandbox.fetch(new Request("http://x?op=no-store"))
    ).text();
    assertStrictEquals(body, "Vector store not configured");
  });
});
