// Copyright 2025 the AAI authors. MIT license.
import { assert, assertEquals, assertStrictEquals } from "@std/assert";
import { createSandbox, type SandboxOptions } from "./sandbox.ts";
import { createTestKvStore, createTestVectorStore } from "./_test_utils.ts";

// --- helpers ---

const SCOPE = { slug: "test-agent", keyHash: "abc" };

/**
 * Minimal worker code that responds to capnweb RPC init and fetch calls.
 * Uses postMessage to simulate the capnweb protocol.
 */
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

Deno.test("createSandbox initializes and returns sandbox", async () => {
  const sandbox = await createSandbox(makeOpts());
  try {
    assert(sandbox);
    assert(typeof sandbox.startSession === "function");
    assert(typeof sandbox.fetch === "function");
    assert(typeof sandbox.terminate === "function");
  } finally {
    sandbox.terminate();
  }
});

Deno.test("sandbox.fetch proxies request to worker", async () => {
  const sandbox = await createSandbox(makeOpts());
  try {
    const res = await sandbox.fetch(new Request("http://example.com/test"));
    assertStrictEquals(res.status, 200);
    const body = await res.text();
    assertStrictEquals(body, "ok from GET http://example.com/test");
  } finally {
    sandbox.terminate();
  }
});

Deno.test("sandbox.fetch forwards POST method", async () => {
  const sandbox = await createSandbox(makeOpts());
  try {
    const res = await sandbox.fetch(
      new Request("http://example.com/api", { method: "POST", body: "data" }),
    );
    assertStrictEquals(res.status, 200);
    const body = await res.text();
    assertStrictEquals(body, "ok from POST http://example.com/api");
  } finally {
    sandbox.terminate();
  }
});

Deno.test("sandbox.terminate does not throw", async () => {
  const sandbox = await createSandbox(makeOpts());
  sandbox.terminate();
  // calling terminate again should be safe
  sandbox.terminate();
});

Deno.test("createSandbox works without clientHtml", async () => {
  const sandbox = await createSandbox(makeOpts());
  try {
    assert(sandbox);
  } finally {
    sandbox.terminate();
  }
});

Deno.test("createSandbox passes vectorStore option", async () => {
  const vs = createTestVectorStore();
  const sandbox = await createSandbox(makeOpts({ vectorStore: vs }));
  try {
    assert(sandbox);
  } finally {
    sandbox.terminate();
  }
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

Deno.test("sandbox host.kv set and get round-trip", async () => {
  const kvStore = createTestKvStore();
  const sandbox = await createSandbox(
    makeOpts({ workerCode: KV_WORKER, kvStore }),
  );
  try {
    const setRes = await sandbox.fetch(new Request("http://x?op=set"));
    assertStrictEquals(await setRes.text(), "set-ok");

    const getRes = await sandbox.fetch(new Request("http://x?op=get"));
    const val = JSON.parse(await getRes.text());
    assertEquals(val, { hello: "world" });
  } finally {
    sandbox.terminate();
  }
});

Deno.test("sandbox host.kv del removes key", async () => {
  const kvStore = createTestKvStore();
  const sandbox = await createSandbox(
    makeOpts({ workerCode: KV_WORKER, kvStore }),
  );
  try {
    await sandbox.fetch(new Request("http://x?op=set"));
    const delRes = await sandbox.fetch(new Request("http://x?op=del"));
    assertStrictEquals(await delRes.text(), "del-ok");

    const getRes = await sandbox.fetch(new Request("http://x?op=get"));
    assertStrictEquals(await getRes.text(), "null");
  } finally {
    sandbox.terminate();
  }
});

Deno.test("sandbox host.kv list returns entries", async () => {
  const kvStore = createTestKvStore();
  const sandbox = await createSandbox(
    makeOpts({ workerCode: KV_WORKER, kvStore }),
  );
  try {
    await sandbox.fetch(new Request("http://x?op=set"));
    const listRes = await sandbox.fetch(new Request("http://x?op=list"));
    const entries = JSON.parse(await listRes.text());
    assert(Array.isArray(entries));
  } finally {
    sandbox.terminate();
  }
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

Deno.test("sandbox host.vector upsert and query round-trip", async () => {
  const vs = createTestVectorStore();
  const sandbox = await createSandbox(
    makeOpts({ workerCode: VECTOR_WORKER, vectorStore: vs }),
  );
  try {
    const upsertRes = await sandbox.fetch(new Request("http://x?op=upsert"));
    assertStrictEquals(await upsertRes.text(), "upsert-ok");

    const queryRes = await sandbox.fetch(new Request("http://x?op=query"));
    const results = JSON.parse(await queryRes.text());
    assert(Array.isArray(results));
    assertStrictEquals(results.length > 0, true);
    assertStrictEquals(results[0].id, "doc1");
  } finally {
    sandbox.terminate();
  }
});

Deno.test("sandbox host.vector remove deletes entries", async () => {
  const vs = createTestVectorStore();
  const sandbox = await createSandbox(
    makeOpts({ workerCode: VECTOR_WORKER, vectorStore: vs }),
  );
  try {
    await sandbox.fetch(new Request("http://x?op=upsert"));
    const removeRes = await sandbox.fetch(new Request("http://x?op=remove"));
    assertStrictEquals(await removeRes.text(), "remove-ok");

    const queryRes = await sandbox.fetch(new Request("http://x?op=query"));
    const results = JSON.parse(await queryRes.text());
    assertStrictEquals(results.length, 0);
  } finally {
    sandbox.terminate();
  }
});

Deno.test("sandbox host.vector throws when store not configured", async () => {
  const sandbox = await createSandbox(
    makeOpts({ workerCode: VECTOR_WORKER, vectorStore: undefined }),
  );
  try {
    const res = await sandbox.fetch(new Request("http://x?op=no-store"));
    const body = await res.text();
    assertStrictEquals(body, "Vector store not configured");
  } finally {
    sandbox.terminate();
  }
});
