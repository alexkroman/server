// Copyright 2025 the AAI authors. MIT license.
/**
 * Sandboxed agent runtime — spawns agent bundles in isolated Deno Workers
 * and manages their lifecycle (idle eviction, coalesced initialization).
 *
 * @module
 */

import * as log from "@std/log";
import { encodeBase64 } from "@std/encoding/base64";
import { bridgeWebSocketToPort, type WorkerPort } from "@aai/sdk/capnweb";
import {
  createHostEndpoint,
  defaultHostFetch,
  type HostSandbox,
} from "@aai/sdk/host";
import WebSocket from "ws";
import { assertPublicUrl } from "./_net.ts";
import type { KvEntry } from "@aai/sdk/kv";
import type { KvStore } from "./kv.ts";
import type { ServerVectorStore } from "./vector.ts";
import type { AgentScope } from "./scope_token.ts";
import type { DeployStore } from "./bundle_store_tigris.ts";
import type { AgentMetadata } from "./_schemas.ts";

export type { AgentMetadata } from "./_schemas.ts";

// ─── Sandbox types ──────────────────────────────────────────────────────────

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

// ─── Scoped store adapters ──────────────────────────────────────────────────

function scopedKv(kvStore: KvStore, scope: AgentScope) {
  return {
    async get(key: string) {
      const raw = await kvStore.get(scope, key);
      if (raw === null) return null;
      try {
        return JSON.parse(raw);
      } catch {
        return raw;
      }
    },
    async set(key: string, value: unknown, options?: { expireIn?: number }) {
      const ttl = options?.expireIn
        ? Math.ceil(options.expireIn / 1000)
        : undefined;
      await kvStore.set(scope, key, JSON.stringify(value), ttl);
    },
    async delete(key: string) {
      await kvStore.del(scope, key);
    },
    async list<T = unknown>(
      prefix: string,
      options?: { limit?: number; reverse?: boolean },
    ): Promise<KvEntry<T>[]> {
      return await kvStore.list(scope, prefix, options ?? {}) as KvEntry<T>[];
    },
    async keys(pattern?: string) {
      return await kvStore.keys(scope, pattern);
    },
  };
}

function scopedVector(vectorStore: ServerVectorStore, scope: AgentScope) {
  return {
    async upsert(id: string, data: string, metadata?: Record<string, unknown>) {
      await vectorStore.upsert(scope, id, data, metadata);
    },
    async query(text: string, options?: { topK?: number; filter?: string }) {
      return await vectorStore.query(
        scope,
        text,
        options?.topK,
        options?.filter,
      );
    },
    async remove(ids: string | string[]) {
      await vectorStore.remove(scope, Array.isArray(ids) ? ids : [ids]);
    },
  };
}

// ─── Sandbox creation ───────────────────────────────────────────────────────

export async function createSandbox(opts: SandboxOptions): Promise<Sandbox> {
  const { workerCode, env, kvStore, scope, vectorStore } = opts;

  const dataUrl = `data:application/javascript;base64,${
    encodeBase64(workerCode)
  }`;
  const worker = new Worker(dataUrl, {
    type: "module",
    // @ts-ignore Deno-specific Worker option for permission sandboxing
    deno: { permissions: "none" },
  });

  const host: HostSandbox = await createHostEndpoint(
    worker as unknown as WorkerPort,
    {
      env,
      kv: scopedKv(kvStore, scope),
      vector: vectorStore ? scopedVector(vectorStore, scope) : undefined,
      async fetch(url, method, headers, body) {
        await assertPublicUrl(url);
        return defaultHostFetch(url, method, headers, body);
      },
      createWebSocket(url, headers, port) {
        const ws = new WebSocket(url, { headers });
        bridgeWebSocketToPort(
          ws as unknown as Parameters<typeof bridgeWebSocketToPort>[0],
          port,
        );
      },
    },
  );

  log.info("Sandbox initialized", { slug: scope.slug });

  return {
    startSession(socket: WebSocket, skipGreeting?: boolean): void {
      host.startSession(
        socket as unknown as Parameters<typeof host.startSession>[0],
        skipGreeting,
      );
    },

    fetch: host.fetch,

    terminate(): void {
      worker.terminate();
    },
  };
}

// ─── Agent slot lifecycle ───────────────────────────────────────────────────

const IDLE_MS = 5 * 60 * 1000;

export type AgentSlot = {
  slug: string;
  keyHash: string;
  sandbox?: Sandbox;
  initializing?: Promise<Sandbox>;
  idleTimer?: ReturnType<typeof setTimeout>;
};

type EnsureOpts = {
  getWorkerCode: (slug: string) => Promise<string | null>;
  kvCtx: { kvStore: KvStore; scope: AgentScope };
  vectorCtx?: { vectorStore: ServerVectorStore; scope: AgentScope } | undefined;
  getEnv: () => Promise<Record<string, string>>;
};

async function spawnAgent(
  slot: AgentSlot,
  opts: EnsureOpts,
): Promise<void> {
  const { slug } = slot;
  log.info("Loading agent sandbox", { slug });

  const code = await opts.getWorkerCode(slug);
  if (!code) throw new Error(`Worker code not found for ${slug}`);

  slot.sandbox = await createSandbox({
    workerCode: code,
    env: await opts.getEnv(),
    kvStore: opts.kvCtx.kvStore,
    scope: opts.kvCtx.scope,
    vectorStore: opts.vectorCtx?.vectorStore,
  });
}

function resetIdleTimer(slot: AgentSlot): void {
  if (slot.idleTimer) clearTimeout(slot.idleTimer);
  const id = setTimeout(() => {
    if (!slot.sandbox) return;
    log.info("Evicting idle sandbox", { slug: slot.slug });
    slot.sandbox.terminate();
    delete slot.sandbox;
    delete slot.idleTimer;
  }, IDLE_MS);
  Deno.unrefTimer(id);
  slot.idleTimer = id;
}

export function ensureAgent(
  slot: AgentSlot,
  opts: EnsureOpts,
): Promise<Sandbox> {
  const t0 = performance.now();

  if (slot.sandbox) {
    resetIdleTimer(slot);
    return Promise.resolve(slot.sandbox);
  }
  if (slot.initializing) return slot.initializing;

  slot.initializing = spawnAgent(slot, opts).then(
    () => {
      delete slot.initializing;
      resetIdleTimer(slot);
      log.info("Agent sandbox ready", {
        slug: slot.slug,
        durationMs: Math.round(performance.now() - t0),
      });
      return slot.sandbox!;
    },
  ).catch((err) => {
    delete slot.initializing;
    throw err;
  });

  return slot.initializing;
}

export function registerSlot(
  slots: Map<string, AgentSlot>,
  metadata: AgentMetadata,
): void {
  slots.set(metadata.slug, {
    slug: metadata.slug,
    keyHash: metadata.credential_hashes[0] ?? "",
  });
}

export async function resolveSandbox(
  slug: string,
  opts: {
    slots: Map<string, AgentSlot>;
    store: DeployStore;
    kvStore: KvStore;
    vectorStore?: ServerVectorStore | undefined;
  },
): Promise<Sandbox | null> {
  let slot = opts.slots.get(slug);

  if (!slot) {
    const manifest = await opts.store.getManifest(slug);
    if (!manifest) return null;
    registerSlot(opts.slots, manifest);
    slot = opts.slots.get(slug)!;
    log.info("Lazy-discovered agent from store", { slug });
  }

  const scope = { keyHash: slot.keyHash, slug };

  return await ensureAgent(slot, {
    getWorkerCode: (s: string) => opts.store.getWorkerCode(s),
    kvCtx: { kvStore: opts.kvStore, scope },
    vectorCtx: opts.vectorStore
      ? { vectorStore: opts.vectorStore, scope }
      : undefined,
    getEnv: async () => (await opts.store.getEnv(slug)) ?? {},
  });
}
