// Copyright 2025 the AAI authors. MIT license.
import {
  assert,
  assertEquals,
  assertStrictEquals,
  assertStringIncludes,
} from "@std/assert";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Env } from "./context.ts";
import { handleKv } from "./kv_handler.ts";

// --- helpers ---

function createMockKvStore() {
  const store = new Map<string, string>();
  return {
    store,
    get: (_scope: unknown, key: string) =>
      Promise.resolve(store.get(key) ?? null),
    set: (_scope: unknown, key: string, value: string, _ttl?: number) => {
      store.set(key, value);
      return Promise.resolve();
    },
    del: (_scope: unknown, key: string) => {
      store.delete(key);
      return Promise.resolve();
    },
    keys: (_scope: unknown, _pattern?: string) =>
      Promise.resolve([...store.keys()]),
    list: (
      _scope: unknown,
      prefix: string,
      _opts?: { limit?: number; reverse?: boolean },
    ) =>
      Promise.resolve(
        [...store.entries()]
          .filter(([k]) => k.startsWith(prefix))
          .map(([key, value]) => ({ key, value })),
      ),
  };
}

const SCOPE = { slug: "test-agent", keyHash: "abc" };

function createTestApp(kvStore: ReturnType<typeof createMockKvStore>) {
  const app = new Hono<Env>();
  app.use("*", async (c, next) => {
    c.set("scope", SCOPE);
    await next();
  });
  app.onError((err, c) => {
    if (err instanceof HTTPException) {
      return c.json({ error: err.message }, err.status);
    }
    return c.json({ error: "unexpected" }, 500);
  });
  app.post("/kv", handleKv);
  return { app, kvStore };
}

async function postKv(
  kvStore: ReturnType<typeof createMockKvStore>,
  body: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const { app } = createTestApp(kvStore);
  const res = await app.request("/kv", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }, { kvStore } as Record<string, unknown>);
  return {
    status: res.status,
    json: (await res.json()) as Record<string, unknown>,
  };
}

// --- validation ---

Deno.test("kv: rejects invalid op", async () => {
  const kv = createMockKvStore();
  const { status, json } = await postKv(kv, { op: "invalid" });
  assertStrictEquals(status, 400);
  assert(json.error !== undefined);
});

Deno.test("kv: rejects missing key for get", async () => {
  const kv = createMockKvStore();
  const { status } = await postKv(kv, { op: "get" });
  assertStrictEquals(status, 400);
});

Deno.test("kv: rejects missing key for set", async () => {
  const kv = createMockKvStore();
  const { status } = await postKv(kv, { op: "set", value: "v" });
  assertStrictEquals(status, 400);
});

Deno.test("kv: rejects missing value for set", async () => {
  const kv = createMockKvStore();
  const { status } = await postKv(kv, { op: "set", key: "k" });
  assertStrictEquals(status, 400);
});

Deno.test("kv: rejects missing prefix for list", async () => {
  const kv = createMockKvStore();
  const { status } = await postKv(kv, { op: "list" });
  assertStrictEquals(status, 400);
});

// --- get ---

Deno.test("kv get: returns null for missing key", async () => {
  const kv = createMockKvStore();
  const { status, json } = await postKv(kv, { op: "get", key: "nope" });
  assertStrictEquals(status, 200);
  assertStrictEquals(json.result, null);
});

Deno.test("kv get: returns stored value", async () => {
  const kv = createMockKvStore();
  kv.store.set("mykey", "myval");
  const { status, json } = await postKv(kv, { op: "get", key: "mykey" });
  assertStrictEquals(status, 200);
  assertStrictEquals(json.result, "myval");
});

// --- set ---

Deno.test("kv set: stores value and returns OK", async () => {
  const kv = createMockKvStore();
  const { status, json } = await postKv(kv, {
    op: "set",
    key: "k1",
    value: "v1",
  });
  assertStrictEquals(status, 200);
  assertStrictEquals(json.result, "OK");
  assertStrictEquals(kv.store.get("k1"), "v1");
});

Deno.test("kv set: accepts optional ttl", async () => {
  const kv = createMockKvStore();
  const { status, json } = await postKv(kv, {
    op: "set",
    key: "k",
    value: "v",
    ttl: 3600,
  });
  assertStrictEquals(status, 200);
  assertStrictEquals(json.result, "OK");
});

// --- del ---

Deno.test("kv del: removes key and returns OK", async () => {
  const kv = createMockKvStore();
  kv.store.set("k1", "v1");
  const { status, json } = await postKv(kv, { op: "del", key: "k1" });
  assertStrictEquals(status, 200);
  assertStrictEquals(json.result, "OK");
  assertStrictEquals(kv.store.has("k1"), false);
});

Deno.test("kv del: succeeds even if key does not exist", async () => {
  const kv = createMockKvStore();
  const { status, json } = await postKv(kv, { op: "del", key: "nope" });
  assertStrictEquals(status, 200);
  assertStrictEquals(json.result, "OK");
});

// --- keys ---

Deno.test("kv keys: returns all keys", async () => {
  const kv = createMockKvStore();
  kv.store.set("a", "1");
  kv.store.set("b", "2");
  const { status, json } = await postKv(kv, { op: "keys" });
  assertStrictEquals(status, 200);
  assertEquals(json.result, ["a", "b"]);
});

Deno.test("kv keys: accepts optional pattern", async () => {
  const kv = createMockKvStore();
  const { status } = await postKv(kv, { op: "keys", pattern: "user:*" });
  assertStrictEquals(status, 200);
});

// --- list ---

Deno.test("kv list: returns entries matching prefix", async () => {
  const kv = createMockKvStore();
  kv.store.set("note:1", "a");
  kv.store.set("note:2", "b");
  kv.store.set("other:1", "c");
  const { status, json } = await postKv(kv, {
    op: "list",
    prefix: "note:",
  });
  assertStrictEquals(status, 200);
  const result = json.result as { key: string; value: string }[];
  assertStrictEquals(result.length, 2);
  assertStrictEquals(result.every((r) => r.key.startsWith("note:")), true);
});

Deno.test("kv list: accepts limit and reverse options", async () => {
  const kv = createMockKvStore();
  const { status } = await postKv(kv, {
    op: "list",
    prefix: "x:",
    limit: 10,
    reverse: true,
  });
  assertStrictEquals(status, 200);
});

// --- error handling ---

Deno.test("kv: returns 500 when store throws", async () => {
  const kvStore = {
    store: new Map(),
    get: () => Promise.reject(new Error("db down")),
    set: () => Promise.reject(new Error("db down")),
    del: () => Promise.reject(new Error("db down")),
    keys: () => Promise.reject(new Error("db down")),
    list: () => Promise.reject(new Error("db down")),
  };

  const { status, json } = await postKv(kvStore, { op: "get", key: "x" });
  assertStrictEquals(status, 500);
  assertStringIncludes(json.error as string, "KV operation failed");
  assertStringIncludes(json.error as string, "db down");
});
