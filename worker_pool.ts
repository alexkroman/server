// Copyright 2025 the AAI authors. MIT license.
import * as log from "@std/log";
import { encodeBase64 } from "@std/encoding/base64";
import { loadPlatformConfig } from "./config.ts";
import type { AgentConfig, ToolSchema } from "@aai/sdk/internal-types";
import type { ExecuteTool } from "@aai/sdk/worker-entry";
import { getBuiltinToolSchemas } from "@aai/sdk/builtin-tools";
import {
  createDirectExecutor,
  type DirectExecutor,
} from "@aai/sdk/direct-executor";
import type { HookInvoker } from "@aai/sdk/session";
import type { Kv } from "@aai/sdk/kv";
import type { BundleStore } from "./bundle_store_tigris.ts";
import type { AgentMetadata } from "./_schemas.ts";
import type { KvStore } from "./kv.ts";
import type { ServerVectorStore } from "./vector.ts";
import type { AgentScope } from "./scope_token.ts";
export type { AgentMetadata } from "./_schemas.ts";

const IDLE_MS = 5 * 60 * 1000;

/**
 * Runtime state for a deployed agent, including its in-process executor and
 * cached configuration. Managed by the worker pool.
 */
export type AgentSlot = {
  /** The agent's unique slug identifier. */
  slug: string;
  /** Supported transport types for this agent. */
  transport: readonly ("websocket")[];
  /** Agent configuration extracted at build time. */
  config: AgentConfig;
  /** Human-readable agent name from the configuration. */
  name: string;
  /** Tool schemas extracted at build time. */
  toolSchemas: ToolSchema[];
  /** Credential hash of the agent owner (for KV scoping). */
  keyHash: string;
  /** Active in-process executor for tool calls and hooks. */
  executor?: DirectExecutor;
  /** Promise that resolves when the executor is done initializing. */
  initializing?: Promise<void>;
  /** Timer handle for idle executor eviction. */
  idleTimer?: ReturnType<typeof setTimeout>;
};

/** Adapt the server's scoped KvStore to the SDK's Kv interface. */
function createScopedKv(kvStore: KvStore, scope: AgentScope): Kv {
  return {
    async get<T = unknown>(key: string): Promise<T | null> {
      const raw = await kvStore.get(scope, key);
      if (raw === null) return null;
      try {
        return JSON.parse(raw) as T;
      } catch {
        return raw as unknown as T;
      }
    },
    async set(
      key: string,
      value: unknown,
      options?: { expireIn?: number },
    ): Promise<void> {
      const ttl = options?.expireIn
        ? Math.ceil(options.expireIn / 1000)
        : undefined;
      await kvStore.set(scope, key, JSON.stringify(value), ttl);
    },
    async delete(key: string): Promise<void> {
      await kvStore.del(scope, key);
    },
    async list<T = unknown>(
      prefix: string,
      options?: { limit?: number; reverse?: boolean },
    ): Promise<{ key: string; value: T }[]> {
      const entries = await kvStore.list(scope, prefix, options);
      return entries.map((e) => ({ key: e.key, value: e.value as T }));
    },
  };
}

async function spawnAgent(
  slot: AgentSlot,
  opts: {
    getWorkerCode?: ((slug: string) => Promise<string | null>) | undefined;
    kvCtx?: { kvStore: KvStore; scope: AgentScope } | undefined;
    vectorCtx?:
      | { vectorStore: ServerVectorStore; scope: AgentScope }
      | undefined;
    getEnv: () => Promise<Record<string, string>>;
  },
): Promise<void> {
  const { slug } = slot;
  const { getWorkerCode, kvCtx, vectorCtx, getEnv } = opts;

  log.info("Loading agent module", { slug });

  if (!getWorkerCode) {
    throw new Error(`No worker code source for ${slug}`);
  }
  const code = await getWorkerCode(slug);
  if (!code) throw new Error(`Worker code not found for ${slug}`);

  const dataUrl = `data:application/javascript;base64,${encodeBase64(code)}`;
  const mod = await import(dataUrl);
  const agent = mod.default;
  if (!agent) throw new Error(`Bundle for ${slug} has no default export`);

  const env = await getEnv();

  const kv = kvCtx ? createScopedKv(kvCtx.kvStore, kvCtx.scope) : undefined;

  const vectorSearch = vectorCtx
    ? async (query: string, topK: number): Promise<string> => {
      const results = await vectorCtx.vectorStore.query(
        vectorCtx.scope,
        query,
        topK,
      );
      if (results.length === 0) return "No relevant results found.";
      return JSON.stringify(
        results.map((r) => ({
          score: r.score,
          text: r.data,
          metadata: r.metadata,
        })),
      );
    }
    : undefined;

  slot.executor = createDirectExecutor({
    agent,
    env,
    ...(kv ? { kv } : {}),
    ...(vectorSearch ? { vectorSearch } : {}),
  });
}

function resetIdleTimer(slot: AgentSlot): void {
  if (slot.idleTimer) clearTimeout(slot.idleTimer);
  const id = setTimeout(() => {
    if (!slot.executor) return;
    log.info("Evicting idle executor", { slug: slot.slug });
    delete slot.executor;
    delete slot.idleTimer;
  }, IDLE_MS);
  Deno.unrefTimer(id);
  slot.idleTimer = id;
}

/**
 * Ensures an agent executor is running for the given slot.
 *
 * If an executor is already active, resets its idle eviction timer. If no
 * executor exists, loads the bundle and creates one. Concurrent calls for
 * the same slot coalesce into a single initialization promise.
 */
export function ensureAgent(
  slot: AgentSlot,
  opts: {
    getWorkerCode?: ((slug: string) => Promise<string | null>) | undefined;
    kvCtx?: { kvStore: KvStore; scope: AgentScope } | undefined;
    vectorCtx?:
      | { vectorStore: ServerVectorStore; scope: AgentScope }
      | undefined;
    getEnv: () => Promise<Record<string, string>>;
  },
): Promise<void> {
  const t0 = performance.now();

  if (slot.executor) {
    resetIdleTimer(slot);
    return Promise.resolve();
  }
  if (slot.initializing) return slot.initializing;

  slot.initializing = spawnAgent(slot, opts).then(
    () => {
      delete slot.initializing;
      resetIdleTimer(slot);
      log.info("Agent ready", {
        slug: slot.slug,
        name: slot.name,
        durationMs: Math.round(performance.now() - t0),
      });
    },
  ).catch((err) => {
    delete slot.initializing;
    throw err;
  });

  return slot.initializing;
}

/**
 * Registers an agent slot from deploy metadata.
 *
 * Validates that the metadata contains a valid platform config before
 * registering. Agents with missing or invalid config are skipped.
 */
export function registerSlot(
  slots: Map<string, AgentSlot>,
  metadata: AgentMetadata,
): boolean {
  try {
    loadPlatformConfig(metadata.env); // validate only
  } catch (err: unknown) {
    log.warn("Skipping deploy — missing platform config", {
      slug: metadata.slug,
      err,
    });
    return false;
  }

  slots.set(metadata.slug, {
    slug: metadata.slug,
    transport: metadata.transport,
    keyHash: metadata.credential_hashes[0] ?? "",
    config: metadata.config,
    name: metadata.config.name,
    toolSchemas: metadata.toolSchemas,
  });
  return true;
}

/** Everything needed to create a {@linkcode Session} for an agent. */
export type SessionSetup = {
  /** The agent's configuration from `defineAgent()`. */
  agentConfig: AgentConfig;
  /** All tool schemas (custom + builtin) from the worker. */
  toolSchemas: ToolSchema[];
  /** Platform-level configuration (API keys, model, STT/TTS settings). */
  platformConfig: ReturnType<typeof loadPlatformConfig>;
  /** Function to execute a tool call in the agent worker. */
  executeTool: ExecuteTool;
  /** Hook invoker for lifecycle callbacks. */
  hookInvoker: HookInvoker;
  /** Environment variables available to the agent. */
  env?: Record<string, string | undefined>;
};

/**
 * Prepares all dependencies needed to create a session for an agent.
 *
 * Loads the agent bundle (if not already loaded), creates a direct executor,
 * and assembles tool schemas, platform config, and tool execution functions.
 */
export async function prepareSession(
  slot: AgentSlot,
  opts: {
    slug: string;
    store: BundleStore;
    kvStore: KvStore;
    vectorStore?: ServerVectorStore | undefined;
  },
): Promise<SessionSetup> {
  const { slug, store, kvStore, vectorStore } = opts;
  const scope = { keyHash: slot.keyHash, slug };
  const kvCtx = { kvStore, scope };
  const vectorCtx = vectorStore ? { vectorStore, scope } : undefined;
  const getWorkerCode = (s: string) => store.getFile(s, "worker");
  const getEnv = async () => await store.getEnv(slug) ?? {};

  // Load bundle and create executor
  await ensureAgent(slot, { getWorkerCode, kvCtx, vectorCtx, getEnv });
  const executor = slot.executor!;
  const config = slot.config;

  // Decrypt env for platform config and session — plaintext is not persisted.
  const env = await getEnv();
  // Tool schemas include both custom and builtin tools
  const builtinSchemas = getBuiltinToolSchemas(config.builtinTools ?? []);
  const toolSchemas = [...slot.toolSchemas, ...builtinSchemas];

  return {
    agentConfig: config,
    toolSchemas,
    platformConfig: loadPlatformConfig(env),
    executeTool: executor.executeTool,
    hookInvoker: executor.hookInvoker,
    env,
  };
}
