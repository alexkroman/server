// Copyright 2025 the AAI authors. MIT license.
/**
 * Host-side sandbox manager for running agent bundles in isolated Deno Workers.
 *
 * Spawns a Deno Worker with all permissions false, sets up capnweb RPC
 * for fetch proxy (SSRF-protected), KV, vector search, and S2S WebSocket,
 * then initializes the worker with environment variables and client HTML.
 *
 * @module
 */

import * as log from "@std/log";
import { encodeBase64 } from "@std/encoding/base64";
import {
  bridgeS2sWebSocketToPort,
  bridgeWebSocketToPort,
  CapnwebEndpoint,
  type CapnwebPort,
} from "@aai/sdk/capnweb";
import WebSocket from "ws";
import type { S2sWebSocket } from "@aai/sdk/s2s";
import { assertPublicUrl } from "./builtin_tools.ts";
import type { KvStore } from "./kv.ts";
import type { ServerVectorStore } from "./vector.ts";
import type { AgentScope } from "./scope_token.ts";

/** Options for creating a sandboxed agent worker. */
export type SandboxOptions = {
  /** Bundled worker.js source code. */
  workerCode: string;
  /** Environment variables to pass to the worker. */
  env: Record<string, string>;
  /** Server KV store for scoped operations. */
  kvStore: KvStore;
  /** Agent scope for KV/vector isolation. */
  scope: AgentScope;
  /** Server vector store for scoped operations. */
  vectorStore?: ServerVectorStore | undefined;
};

/** A sandboxed agent worker with methods to manage sessions and lifecycle. */
export type Sandbox = {
  /** Bridge a client WebSocket into the sandbox as a new session. */
  startSession(socket: WebSocket, skipGreeting?: boolean): void;
  /** Forward an HTTP request to the worker's WinterTC fetch handler. */
  fetch(request: Request): Promise<Response>;
  /** Terminate the worker and release resources. */
  terminate(): void;
};

/**
 * Create a sandboxed agent worker.
 *
 * Spawns a Deno Worker with all permissions disabled, sets up capnweb RPC
 * handlers for host-side capabilities, and initializes the worker with the
 * agent's environment and configuration.
 */
export async function createSandbox(
  opts: SandboxOptions,
): Promise<Sandbox> {
  const { workerCode, env, kvStore, scope, vectorStore } = opts;

  const dataUrl = `data:application/javascript;base64,${
    encodeBase64(workerCode)
  }`;
  const worker = new Worker(dataUrl, {
    type: "module",
    // @ts-ignore Deno-specific Worker option for permission sandboxing
    deno: { permissions: "none" },
  });

  const endpoint = new CapnwebEndpoint(
    worker as unknown as CapnwebPort,
  );

  // ─── Host-side RPC handlers ──────────────────────────────────────────

  // Fetch proxy with SSRF protection
  endpoint.handle("host.fetch", async (args) => {
    const [fetchUrl, method, headers, body] = args as [
      string,
      string,
      Record<string, string>,
      string?,
    ];
    await assertPublicUrl(fetchUrl);
    const response = await fetch(fetchUrl, { method, headers, body });
    return {
      status: response.status,
      headers: Object.fromEntries(response.headers),
      body: await response.text(),
    };
  });

  // Scoped KV operations
  endpoint.handle("host.kv.get", async (args) => {
    const [key] = args as [string];
    const raw = await kvStore.get(scope, key);
    if (raw === null) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  });

  endpoint.handle("host.kv.set", async (args) => {
    const [key, value, expireIn] = args as [string, unknown, number?];
    const ttl = expireIn ? Math.ceil(expireIn / 1000) : undefined;
    await kvStore.set(scope, key, JSON.stringify(value), ttl);
    return null;
  });

  endpoint.handle("host.kv.del", async (args) => {
    const [key] = args as [string];
    await kvStore.del(scope, key);
    return null;
  });

  endpoint.handle("host.kv.list", async (args) => {
    const [prefix, limit, reverse] = args as [string, number?, boolean?];
    const opts: { limit?: number; reverse?: boolean } = {};
    if (limit !== undefined) opts.limit = limit;
    if (reverse !== undefined) opts.reverse = reverse;
    return await kvStore.list(scope, prefix, opts);
  });

  // Scoped vector operations
  endpoint.handle("host.vector.upsert", async (args) => {
    if (!vectorStore) throw new Error("Vector store not configured");
    const [id, data, metadata] = args as [
      string,
      string,
      Record<string, unknown>?,
    ];
    await vectorStore.upsert(scope, id, data, metadata);
    return null;
  });

  endpoint.handle("host.vector.query", async (args) => {
    if (!vectorStore) throw new Error("Vector store not configured");
    const [text, topK, filter] = args as [string, number?, string?];
    return await vectorStore.query(scope, text, topK, filter);
  });

  endpoint.handle("host.vector.remove", async (args) => {
    if (!vectorStore) throw new Error("Vector store not configured");
    const [ids] = args as [string[]];
    await vectorStore.remove(scope, ids);
    return null;
  });

  // S2S WebSocket creation — receives transferred port and bridges
  endpoint.handle("host.createWebSocket", (args, ports) => {
    const [url, headers] = args as [string, Record<string, string>];
    const port = ports[0];
    if (!port) throw new Error("No port transferred for WebSocket");

    const ws = new WebSocket(url, { headers }) as unknown as S2sWebSocket;
    bridgeS2sWebSocketToPort(ws, port);
    return null;
  });

  // ─── Initialize worker ───────────────────────────────────────────────

  await endpoint.call("worker.init", [env]);
  log.info("Sandbox initialized", { slug: scope.slug });

  return {
    startSession(socket: WebSocket, skipGreeting?: boolean): void {
      const { port1, port2 } = new MessageChannel();
      bridgeWebSocketToPort(socket, port1);
      endpoint.notify(
        "worker.handleWebSocket",
        [skipGreeting ?? false],
        [port2],
      );
    },

    async fetch(request: Request): Promise<Response> {
      const result = (await endpoint.call("worker.fetch", [
        request.url,
        request.method,
        Object.fromEntries(request.headers),
        request.body ? await request.text() : undefined,
      ])) as {
        status: number;
        headers: Record<string, string>;
        body: string;
      };

      return new Response(result.body, {
        status: result.status,
        headers: result.headers,
      });
    },

    terminate(): void {
      worker.terminate();
    },
  };
}
