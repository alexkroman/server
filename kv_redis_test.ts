// Copyright 2025 the AAI authors. MIT license.
// Tests for createKvStore with a mock Upstash Redis HTTP server.

import { assertEquals, assertStrictEquals } from "@std/assert";
import { createKvStore } from "./kv.ts";
import type { AgentScope } from "./scope_token.ts";

function createMockRedisServer() {
  const data = new Map<string, string>();

  function execCommand(parts: string[]): unknown {
    const cmd = parts[0]!.toUpperCase();

    if (cmd === "GET") {
      return data.get(parts[1]!) ?? null;
    }
    if (cmd === "SET") {
      data.set(parts[1]!, parts[2]!);
      return "OK";
    }
    if (cmd === "DEL") {
      const existed = data.has(parts[1]!);
      data.delete(parts[1]!);
      return existed ? 1 : 0;
    }
    if (cmd === "SCAN") {
      // parts: ["scan", cursor, "match", pattern]
      const pattern = parts[3] ?? "*";
      const regex = new RegExp(
        "^" + pattern.replace(/\*/g, ".*").replace(/\?/g, ".") + "$",
      );
      const keys = [...data.keys()].filter((k) => regex.test(k));
      return ["0", keys];
    }
    return null;
  }

  const handler = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);

    // Upstash sends commands as POST with JSON body
    if (req.method === "POST") {
      const body = await req.json();

      // Pipeline: array of arrays
      if (url.pathname === "/pipeline") {
        const results = (body as string[][]).map((cmdParts) => ({
          result: execCommand(cmdParts),
        }));
        return Response.json(results);
      }

      // Single command: flat array like ["GET", "key"]
      if (Array.isArray(body)) {
        return Response.json({ result: execCommand(body as string[]) });
      }
    }

    // Some commands use GET with URL path: /CMD/arg1/arg2
    const parts = decodeURIComponent(url.pathname).split("/").filter(Boolean);
    if (parts.length > 0) {
      return Response.json({ result: execCommand(parts) });
    }

    return Response.json({ error: "Unknown request" }, { status: 400 });
  };

  const server = Deno.serve({ port: 0, onListen: () => {} }, handler);
  const store = createKvStore(
    `http://localhost:${server.addr.port}`,
    "fake-token",
  );

  return { store, server, data };
}

const scope: AgentScope = { keyHash: "test-hash", slug: "test-agent" };

Deno.test({
  name: "createKvStore with mock Redis",
  sanitizeResources: false,
  async fn(t) {
    const { store, server } = createMockRedisServer();

    try {
      await t.step("set and get round-trip", async () => {
        await store.set(scope, "greeting", "hello");
        const val = await store.get(scope, "greeting");
        assertStrictEquals(val, "hello");
      });

      await t.step("get missing key returns null", async () => {
        const val = await store.get(scope, "nonexistent");
        assertStrictEquals(val, null);
      });

      await t.step("del removes key", async () => {
        await store.set(scope, "to-delete", "val");
        await store.del(scope, "to-delete");
        const val = await store.get(scope, "to-delete");
        assertStrictEquals(val, null);
      });

      await t.step("keys returns scoped keys", async () => {
        await store.set(scope, "a", "1");
        await store.set(scope, "b", "2");
        const keys = await store.keys(scope);
        assertEquals(keys.includes("a"), true);
        assertEquals(keys.includes("b"), true);
      });
    } finally {
      await server.shutdown();
    }
  },
});
