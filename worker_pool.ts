// Copyright 2025 the AAI authors. MIT license.
import * as log from "@std/log";
import { encodeBase64 } from "@std/encoding/base64";
import { loadPlatformConfig } from "./config.ts";
import type { AgentConfig, ToolSchema } from "@aai/sdk/internal-types";
import { createWorkerApi, type WorkerApi } from "./_worker_entry.ts";
import type { ExecuteTool } from "./_worker_entry.ts";
import type { HostApi, KvRequest } from "@aai/sdk/protocol";
import { TOOL_EXECUTION_TIMEOUT_MS } from "@aai/sdk/protocol";
import type { BundleStore } from "./bundle_store_tigris.ts";
import type { AgentMetadata } from "./_schemas.ts";
import { createDenoWorker, LOCKED_PERMISSIONS } from "./_deno_worker.ts";
import { assertPublicUrl } from "./builtin_tools.ts";
import { getBuiltinToolSchemas } from "@aai/sdk/builtin-tools";
import type { KvStore } from "./kv.ts";
import type { ServerVectorStore } from "./vector.ts";
import type { AgentScope } from "./scope_token.ts";
import { KvRequestBaseSchema, WorkerFetchRequestSchema } from "./_schemas.ts";
export type { AgentMetadata } from "./_schemas.ts";

const IDLE_MS = 5 * 60 * 1000;

/**
 * Runtime state for a deployed agent, including its worker process and
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
  /** Active worker handle and RPC API proxy. */
  worker?: { handle: { terminate(): void }; api: WorkerApi };
  /** Promise that resolves when the worker is done initializing. */
  initializing?: Promise<void>;
  /** Timer handle for idle worker eviction. */
  idleTimer?: ReturnType<typeof setTimeout>;
};

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

  log.info("Spawning agent worker", { slug });

  if (!getWorkerCode) {
    throw new Error(`No worker code source for ${slug}`);
  }
  const code = await getWorkerCode(slug);
  if (!code) throw new Error(`Worker code not found for ${slug}`);
  const workerUrl = `data:application/javascript;base64,${encodeBase64(code)}`;

  const worker = createDenoWorker(workerUrl, slug, LOCKED_PERMISSIONS);

  let lastCrash = 0;
  worker.addEventListener(
    "error",
    ((event: ErrorEvent) => {
      log.error("Worker died", { slug, error: event.message });
      if (slot.worker?.handle !== worker) return;
      delete slot.worker;

      const now = Date.now();
      if (now - lastCrash < 5_000) {
        log.error("Worker crash loop, not respawning", { slug });
        return;
      }
      lastCrash = now;
      log.info("Respawning worker", { slug });
      spawnAgent(slot, opts).catch(
        (err: unknown) => {
          log.error("Worker respawn failed", {
            slug,
            error: err instanceof Error ? err.message : String(err),
          });
        },
      );
    }) as EventListener,
  );

  // Decrypt env on demand — plaintext only lives for the duration of this call.
  const env = await getEnv();
  const api = createWorkerApi(worker, createHostApi(kvCtx, vectorCtx), env);
  slot.worker = { handle: worker, api };
}

function createHostApi(
  kvCtx?: { kvStore: KvStore; scope: AgentScope },
  vectorCtx?: { vectorStore: ServerVectorStore; scope: AgentScope },
): HostApi {
  return {
    async fetch(req: Parameters<HostApi["fetch"]>[0]) {
      const parsed = WorkerFetchRequestSchema.parse(req);
      await assertPublicUrl(parsed.url);
      const resp = await fetch(parsed.url, {
        method: parsed.method,
        headers: parsed.headers,
        body: parsed.body,
        signal: AbortSignal.timeout(5_000),
      });
      const body = await resp.text();
      const headers: Record<string, string> = {};
      resp.headers.forEach((v, k) => {
        headers[k] = v;
      });
      return {
        status: resp.status,
        statusText: resp.statusText,
        headers,
        body,
      };
    },

    async kv(req: KvRequest): Promise<{ result: unknown }> {
      if (!kvCtx) throw new Error("KV not configured for this agent");
      const validated = KvRequestBaseSchema.parse(req);
      const { kvStore, scope } = kvCtx;
      switch (validated.op) {
        case "get":
          return { result: await kvStore.get(scope, validated.key) };
        case "set":
          await kvStore.set(
            scope,
            validated.key,
            validated.value,
            validated.ttl,
          );
          return { result: "OK" };
        case "del":
          await kvStore.del(scope, validated.key);
          return { result: "OK" };
        case "list":
          return {
            result: await kvStore.list(scope, validated.prefix, {
              ...(validated.limit !== undefined && {
                limit: validated.limit,
              }),
              ...(validated.reverse !== undefined && {
                reverse: validated.reverse,
              }),
            }),
          };
        default:
          throw new Error(
            `Unknown KV operation: ${(validated as { op: string }).op}`,
          );
      }
    },

    async vectorSearch(req: {
      query: string;
      topK: number;
    }): Promise<string> {
      if (!vectorCtx) {
        return JSON.stringify({ error: "Vector store not configured" });
      }
      const results = await vectorCtx.vectorStore.query(
        vectorCtx.scope,
        req.query,
        req.topK,
      );
      if (results.length === 0) return "No relevant results found.";
      return JSON.stringify(
        results.map((r) => ({
          score: r.score,
          text: r.data,
          metadata: r.metadata,
        })),
      );
    },
  };
}

function resetIdleTimer(slot: AgentSlot): void {
  if (slot.idleTimer) clearTimeout(slot.idleTimer);
  const id = setTimeout(() => {
    if (!slot.worker) return;
    log.info("Evicting idle worker", { slug: slot.slug });
    slot.worker.handle.terminate();
    delete slot.worker;
    delete slot.idleTimer;
  }, IDLE_MS);
  Deno.unrefTimer(id);
  slot.idleTimer = id;
}

/**
 * Ensures an agent worker is running for the given slot.
 *
 * If a worker is already active, resets its idle eviction timer. If no worker
 * exists, spawns a new one and extracts its configuration. Concurrent calls
 * for the same slot coalesce into a single initialization promise.
 *
 * @param slot - The agent slot to ensure has a running worker.
 * @param getWorkerCode - Async function to retrieve the bundled worker JS by slug.
 * @param kvCtx - Optional KV context for agents with KV access.
 * @returns A promise that resolves when the worker is ready.
 * @throws If the worker code cannot be found or the worker fails to initialize.
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
  const { getWorkerCode, kvCtx, vectorCtx, getEnv } = opts;
  const t0 = performance.now();

  if (slot.worker) {
    resetIdleTimer(slot);
    return Promise.resolve();
  }
  if (slot.initializing) return slot.initializing;

  slot.initializing = spawnAgent(slot, {
    getWorkerCode,
    kvCtx,
    vectorCtx,
    getEnv,
  }).then(
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
 *
 * @param slots - The map of active agent slots to register into.
 * @param metadata - Agent metadata from the bundle store.
 * @returns `true` if the slot was registered, `false` if skipped due to invalid config.
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
  /** Factory to lazily obtain the worker API. */
  getWorkerApi: () => Promise<WorkerApi>;
  /** Environment variables available to the agent. */
  env?: Record<string, string | undefined>;
};

/**
 * Prepares all dependencies needed to create a session for an agent.
 *
 * Boots the agent worker (if not already running), extracts its configuration,
 * and assembles tool schemas, platform config, and tool execution functions.
 *
 * @param slot - The agent slot to prepare a session for.
 * @param slug - The agent's slug identifier.
 * @param store - Bundle store for retrieving worker code.
 * @param kvStore - Key-value store for agent state persistence.
 * @returns A {@linkcode SessionSetup} with everything needed to create a session.
 * @throws If the worker cannot be spawned or config cannot be extracted.
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
  const getWorkerApi = async () => {
    await ensureAgent(slot, { getWorkerCode, kvCtx, vectorCtx, getEnv });
    return slot.worker!.api;
  };
  const executeTool: ExecuteTool = async (name, args, sessionId, messages) => {
    const api = await getWorkerApi();
    return api.executeTool(
      name,
      args,
      sessionId,
      TOOL_EXECUTION_TIMEOUT_MS,
      messages,
    );
  };

  // Boot worker and extract config from agent definition
  await getWorkerApi();
  const config = slot.config;

  // Decrypt env for platform config and session — plaintext is not persisted.
  const env = await getEnv();
  // Tool schemas include both custom and builtin tools (registered in the worker)
  const builtinSchemas = getBuiltinToolSchemas(config.builtinTools ?? []);
  const toolSchemas = [...slot.toolSchemas, ...builtinSchemas];

  return {
    agentConfig: config,
    toolSchemas,
    platformConfig: loadPlatformConfig(env),
    executeTool,
    getWorkerApi,
    env,
  };
}
