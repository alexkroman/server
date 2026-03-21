// Copyright 2025 the AAI authors. MIT license.
import { assert, assertEquals, assertStrictEquals } from "@std/assert";
import { afterEach, describe, it } from "@std/testing/bdd";
import { createSandbox, type SandboxOptions } from "./sandbox.ts";
import { createTestKvStore, createTestVectorStore } from "./_test_utils.ts";

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
      "ok from GET http://example.com/test",
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
      "ok from POST http://example.com/api",
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

const KV_WORKER = `
import { CapnwebEndpoint } from "@aai/sdk/capnweb";

const endpoint = new CapnwebEndpoint(globalThis);
let kvResult = null;

endpoint.handle("worker.init", () => null);

endpoint.handle("worker.fetch", async (args) => {
  const [url] = args;
  const u = new URL(url);
  const op = u.searchParams.get("op");

  if (op === "set") {
    await endpoint.call("host.kv", ["set", "mykey", { hello: "world" }, undefined]);
    return { status: 200, headers: {}, body: "set-ok" };
  }
  if (op === "get") {
    const val = await endpoint.call("host.kv", ["get", "mykey"]);
    return { status: 200, headers: {}, body: JSON.stringify(val) };
  }
  if (op === "del") {
    await endpoint.call("host.kv", ["del", "mykey"]);
    return { status: 200, headers: {}, body: "del-ok" };
  }
  if (op === "list") {
    const entries = await endpoint.call("host.kv", ["list", "", undefined, undefined]);
    return { status: 200, headers: {}, body: JSON.stringify(entries) };
  }
  return { status: 404, headers: {}, body: "unknown" };
});
`;

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

const VECTOR_WORKER = `
import { CapnwebEndpoint } from "@aai/sdk/capnweb";

const endpoint = new CapnwebEndpoint(globalThis);

endpoint.handle("worker.init", () => null);

endpoint.handle("worker.fetch", async (args) => {
  const [url] = args;
  const u = new URL(url);
  const op = u.searchParams.get("op");

  if (op === "upsert") {
    await endpoint.call("host.vector", ["upsert", "doc1", "hello world", undefined]);
    return { status: 200, headers: {}, body: "upsert-ok" };
  }
  if (op === "query") {
    const results = await endpoint.call("host.vector", ["query", "hello", undefined, undefined]);
    return { status: 200, headers: {}, body: JSON.stringify(results) };
  }
  if (op === "remove") {
    await endpoint.call("host.vector", ["remove", ["doc1"]]);
    return { status: 200, headers: {}, body: "remove-ok" };
  }
  if (op === "no-store") {
    try {
      await endpoint.call("host.vector", ["query", "x"]);
    } catch (e) {
      return { status: 200, headers: {}, body: e.message };
    }
  }
  return { status: 404, headers: {}, body: "unknown" };
});
`;

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
