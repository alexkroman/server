// Copyright 2025 the AAI authors. MIT license.
import { assert, assertStrictEquals, assertStringIncludes } from "@std/assert";
import type { AppState } from "./context.ts";
import { handleVector } from "./vector_handler.ts";
import { createTestVectorStore } from "./_test_utils.ts";

// --- helpers ---

const SCOPE = { slug: "test-agent", keyHash: "abc" };

function makeReq(body: unknown): Request {
  return new Request("http://localhost/vector", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function makeState(
  vectorStore?: ReturnType<typeof createTestVectorStore> | undefined,
): AppState {
  return { vectorStore } as unknown as AppState;
}

async function postVector(
  body: unknown,
  vectorStore?: ReturnType<typeof createTestVectorStore>,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const vs = vectorStore ?? createTestVectorStore();
  const req = makeReq(body);
  const state = makeState(vs);
  let res: Response;
  try {
    res = await handleVector(req, state, SCOPE);
  } catch (err: unknown) {
    const status = (err as { status?: number }).status ?? 500;
    const message = (err as Error).message ?? "Unknown error";
    return { status, json: { error: message } };
  }
  return {
    status: res.status,
    json: (await res.json()) as Record<string, unknown>,
  };
}

// --- validation ---

Deno.test("vector: rejects when store not configured", async () => {
  const req = makeReq({ op: "query", text: "hello" });
  const state = makeState(undefined);
  let status = 0;
  try {
    await handleVector(req, state, SCOPE);
  } catch (err: unknown) {
    status = (err as { status?: number }).status ?? 500;
  }
  assertStrictEquals(status, 503);
});

Deno.test("vector: rejects invalid request body", async () => {
  const { status, json } = await postVector({ op: "badop" });
  assertStrictEquals(status, 400);
  assertStringIncludes(json.error as string, "Invalid");
});

Deno.test("vector: rejects missing text for query", async () => {
  const { status } = await postVector({ op: "query" });
  assertStrictEquals(status, 400);
});

Deno.test("vector: rejects missing id for upsert", async () => {
  const { status } = await postVector({ op: "upsert", data: "hello" });
  assertStrictEquals(status, 400);
});

// --- upsert ---

Deno.test("vector upsert: stores data and returns OK", async () => {
  const vs = createTestVectorStore();
  const { status, json } = await postVector(
    { op: "upsert", id: "doc1", data: "hello world" },
    vs,
  );
  assertStrictEquals(status, 200);
  assertStrictEquals(json.result, "OK");
});

Deno.test("vector upsert: accepts optional metadata", async () => {
  const vs = createTestVectorStore();
  const { status, json } = await postVector(
    { op: "upsert", id: "doc1", data: "hello", metadata: { tag: "test" } },
    vs,
  );
  assertStrictEquals(status, 200);
  assertStrictEquals(json.result, "OK");
});

// --- query ---

Deno.test("vector query: returns matching results", async () => {
  const vs = createTestVectorStore();
  await vs.upsert(SCOPE, "doc1", "hello world");
  await vs.upsert(SCOPE, "doc2", "goodbye world");

  const { status, json } = await postVector(
    { op: "query", text: "hello" },
    vs,
  );
  assertStrictEquals(status, 200);
  const result = json.result as { id: string; score: number }[];
  assert(result.length > 0);
  assertStrictEquals(result[0]!.id, "doc1");
});

Deno.test("vector query: returns empty for no matches", async () => {
  const vs = createTestVectorStore();
  const { status, json } = await postVector(
    { op: "query", text: "nothing" },
    vs,
  );
  assertStrictEquals(status, 200);
  const result = json.result as unknown[];
  assertStrictEquals(result.length, 0);
});

Deno.test("vector query: accepts optional topK", async () => {
  const vs = createTestVectorStore();
  await vs.upsert(SCOPE, "a", "word");
  await vs.upsert(SCOPE, "b", "word");
  await vs.upsert(SCOPE, "c", "word");

  const { status, json } = await postVector(
    { op: "query", text: "word", topK: 2 },
    vs,
  );
  assertStrictEquals(status, 200);
  const result = json.result as unknown[];
  assertStrictEquals(result.length, 2);
});

// --- error handling ---

Deno.test("vector: returns 500 when store throws", async () => {
  const failingStore = {
    upsert: () => Promise.reject(new Error("vec down")),
    query: () => Promise.reject(new Error("vec down")),
    remove: () => Promise.reject(new Error("vec down")),
  };
  const req = makeReq({ op: "query", text: "hello" });
  const state = makeState(
    failingStore as unknown as ReturnType<typeof createTestVectorStore>,
  );
  const res = await handleVector(req, state, SCOPE);
  assertStrictEquals(res.status, 500);
  const json = (await res.json()) as Record<string, unknown>;
  assertStringIncludes(json.error as string, "Vector operation failed");
  assertStringIncludes(json.error as string, "vec down");
});

Deno.test("vector upsert: returns 500 when store throws", async () => {
  const failingStore = {
    upsert: () => Promise.reject(new Error("write fail")),
    query: () => Promise.reject(new Error("write fail")),
    remove: () => Promise.reject(new Error("write fail")),
  };
  const req = makeReq({ op: "upsert", id: "x", data: "y" });
  const state = makeState(
    failingStore as unknown as ReturnType<typeof createTestVectorStore>,
  );
  const res = await handleVector(req, state, SCOPE);
  assertStrictEquals(res.status, 500);
  const json = (await res.json()) as Record<string, unknown>;
  assertStringIncludes(json.error as string, "write fail");
});
