// Copyright 2025 the AAI authors. MIT license.
/** @module Host-side sandbox: Deno Worker with all permissions false + capnweb RPC. */

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
import type { KvStore } from "./kv.ts";
import type { ServerVectorStore } from "./vector.ts";
import type { AgentScope } from "./scope_token.ts";
import { assertPublicUrl } from "./_net.ts";
export { assertPublicUrl } from "./_net.ts";

export type SandboxOptions = {
  workerCode: string;
  env: Record<string, string>;
  kvStore: KvStore;
  scope: AgentScope;
  vectorStore?: ServerVectorStore | undefined;
};

export type Sandbox = {
  startSession(socket: WebSocket, skipGreeting?: boolean): void;
  fetch(request: Request): Promise<Response>;
  terminate(): void;
};
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

  const wsFactory = (url: string, opts: { headers: Record<string, string> }) =>
    new WebSocket(url, { headers: opts.headers }) as unknown as S2sWebSocket;

  // ─── Host-side RPC handlers ──────────────────────────────────────────

  endpoint.handle("host.fetch", async (args) => {
    const [url, method, headers, body] = args as [
      string,
      string,
      Record<string, string>,
      string?,
    ];
    await assertPublicUrl(url);
    const res = await fetch(url, {
      method,
      headers,
      ...(body ? { body } : {}),
    });
    return {
      status: res.status,
      headers: Object.fromEntries(res.headers),
      body: await res.text(),
    };
  });

  endpoint.handle("host.kv", async (args) => {
    const [op, ...rest] = args as [string, ...unknown[]];
    switch (op) {
      case "get": {
        const raw = await kvStore.get(scope, rest[0] as string);
        if (raw === null) return null;
        try {
          return JSON.parse(raw);
        } catch {
          return raw;
        }
      }
      case "set": {
        const [key, value, expireIn] = rest as [string, unknown, number?];
        await kvStore.set(
          scope,
          key,
          JSON.stringify(value),
          expireIn ? Math.ceil(expireIn / 1000) : undefined,
        );
        return null;
      }
      case "del":
        await kvStore.del(scope, rest[0] as string);
        return null;
      case "list": {
        const [prefix, limit, reverse] = rest as [string, number?, boolean?];
        return (await kvStore.list(scope, prefix, {
          ...(limit !== undefined && { limit }),
          ...(reverse !== undefined && { reverse }),
        })).map((e) => ({ key: e.key, value: e.value }));
      }
      default:
        throw new Error(`Unknown KV op: ${op}`);
    }
  });

  endpoint.handle("host.vector", async (args) => {
    const [op, ...rest] = args as [string, ...unknown[]];
    if (!vectorStore) throw new Error("Vector store not configured");
    switch (op) {
      case "upsert": {
        const [id, data, metadata] = rest as [
          string,
          string,
          Record<string, unknown>?,
        ];
        await vectorStore.upsert(scope, id, data, metadata);
        return null;
      }
      case "query": {
        const [text, topK, filter] = rest as [string, number?, string?];
        return await vectorStore.query(scope, text, topK, filter);
      }
      case "remove":
        await vectorStore.remove(scope, rest[0] as string[]);
        return null;
      default:
        throw new Error(`Unknown vector op: ${op}`);
    }
  });

  endpoint.handle("host.createWebSocket", (_args, ports) => {
    const [url, headersJson] = _args as [string, string];
    const port = ports[0];
    if (!port) throw new Error("No port transferred for WebSocket");
    bridgeS2sWebSocketToPort(
      wsFactory(url, { headers: JSON.parse(headersJson) }),
      port,
    );
    return null;
  });

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
