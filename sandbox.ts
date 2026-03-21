// Copyright 2025 the AAI authors. MIT license.
/**
 * Sandboxed agent runtime — spawns agent bundles in isolated Deno Workers
 * and manages their lifecycle (idle eviction, coalesced initialization).
 *
 * @module
 */

import * as log from "@std/log";
import { encodeBase64 } from "@std/encoding/base64";
import { bridgeWebSocketToPort, type CapnwebPort } from "@aai/sdk/capnweb";
import {
  createHostEndpoint,
  defaultHostFetch,
  type HostSandbox,
} from "@aai/sdk/host";
import WebSocket from "ws";
import { assertPublicUrl } from "./builtin_tools.ts";
import type { KvStore } from "./kv.ts";
import type { ServerVectorStore } from "./vector.ts";
import type { AgentScope } from "./scope_token.ts";
import type { DeployStore } from "./bundle_store_tigris.ts";
import type { AgentMetadata } from "./_schemas.ts";

export type { AgentMetadata } from "./_schemas.ts";

// ─── Sandbox types ──────────────────────────────────────────────────────────

/** Options for creating a sandboxed agent worker. */
export type SandboxOptions = {
  workerCode: string;
  env: Record<string, string>;
  kvStore: KvStore;
  scope: AgentScope;
  vectorStore?: ServerVectorStore | undefined;
};

/** A sandboxed agent worker with methods to manage sessions and lifecycle. */
export type Sandbox = {
  startSession(socket: WebSocket, skipGreeting?: boolean): void;
  fetch(request: Request): Promise<Response>;
  terminate(): void;
};

// ─── Scoped store adapters ──────────────────────────────────────────────────

function scopedKvOps(kvStore: KvStore, scope: AgentScope) {
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
    async set(key: string, value: unknown, expireIn?: number) {
      const ttl = expireIn ? Math.ceil(expireIn / 1000) : undefined;
      await kvStore.set(scope, key, JSON.stringify(value), ttl);
    },
    async del(key: string) {
      await kvStore.del(scope, key);
    },
    async list(prefix: string, limit?: number, reverse?: boolean) {
      return await kvStore.list(scope, prefix, {
        ...(limit !== undefined ? { limit } : {}),
        ...(reverse !== undefined ? { reverse } : {}),
      });
    },
    async keys(pattern?: string) {
      return await kvStore.keys(scope, pattern);
    },
  };
}

function scopedVectorOps(vectorStore: ServerVectorStore, scope: AgentScope) {
  return {
    async upsert(
      id: string,
      data: string,
      metadata?: Record<string, unknown>,
    ) {
      await vectorStore.upsert(scope, id, data, metadata);
    },
    async query(text: string, topK?: number, filter?: string) {
      return await vectorStore.query(scope, text, topK, filter);
    },
    async remove(ids: string[]) {
      await vectorStore.remove(scope, ids);
    },
  };
}

// ─── Sandbox creation ───────────────────────────────────────────────────────

/**
 * Create a sandboxed agent worker.
 *
 * Spawns a Deno Worker with all permissions disabled, registers host-side
 * RPC handlers as bindings, and initializes the worker.
 */
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
    worker as unknown as CapnwebPort,
    {
      env,
      kv: scopedKvOps(kvStore, scope),
      vector: vectorStore ? scopedVectorOps(vectorStore, scope) : undefined,
      async fetch(req) {
        await assertPublicUrl(req[0]);
        return defaultHostFetch(req);
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

/**
 * Runtime state for a deployed agent, including its sandboxed worker and
 * cached configuration. Managed as a single lifecycle unit.
 */
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

/**
 * Ensures an agent sandbox is running for the given slot.
 *
 * If a sandbox is already active, resets its idle eviction timer. If no
 * sandbox exists, loads the bundle and creates one. Concurrent calls for
 * the same slot coalesce into a single initialization promise.
 */
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

/**
 * Registers an agent slot from deploy metadata.
 * Unconditional — always registers. Env validation happens at sandbox creation.
 */
export function registerSlot(
  slots: Map<string, AgentSlot>,
  metadata: AgentMetadata,
): void {
  slots.set(metadata.slug, {
    slug: metadata.slug,
    keyHash: metadata.credential_hashes[0] ?? "",
  });
}

/**
 * Resolves a slug to a running sandbox in one call.
 *
 * Looks up or creates the slot (lazy-loading from the store if needed),
 * then ensures the sandbox is running. Returns null if the agent doesn't exist.
 */
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
