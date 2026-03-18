// Copyright 2025 the AAI authors. MIT license.
import * as log from "@std/log";
import { EnvSchema } from "./_schemas.ts";
import type { BundleStore } from "./bundle_store_tigris.ts";
import type { AgentMetadata } from "./_schemas.ts";
import type { KvStore } from "./kv.ts";
import type { ServerVectorStore } from "./vector.ts";
import type { AgentScope } from "./scope_token.ts";
import { createSandbox, type Sandbox } from "./sandbox.ts";
export type { AgentMetadata } from "./_schemas.ts";

const IDLE_MS = 5 * 60 * 1000;

/**
 * Runtime state for a deployed agent, including its sandboxed worker and
 * cached configuration. Managed by the worker pool.
 */
export type AgentSlot = {
  /** The agent's unique slug identifier. */
  slug: string;
  /** Credential hash of the agent owner (for KV scoping). */
  keyHash: string;
  /** Active sandboxed worker running the agent. */
  sandbox?: Sandbox;
  /** Promise that resolves when the sandbox is done initializing. */
  initializing?: Promise<void>;
  /** Timer handle for idle sandbox eviction. */
  idleTimer?: ReturnType<typeof setTimeout>;
};

async function spawnAgent(
  slot: AgentSlot,
  opts: {
    getWorkerCode?: ((slug: string) => Promise<string | null>) | undefined;
    getClientHtml?: ((slug: string) => Promise<string | null>) | undefined;
    kvCtx?: { kvStore: KvStore; scope: AgentScope } | undefined;
    vectorCtx?:
      | { vectorStore: ServerVectorStore; scope: AgentScope }
      | undefined;
    getEnv: () => Promise<Record<string, string>>;
  },
): Promise<void> {
  const { slug } = slot;
  const { getWorkerCode, getClientHtml, kvCtx, vectorCtx, getEnv } = opts;

  log.info("Loading agent sandbox", { slug });

  if (!getWorkerCode) {
    throw new Error(`No worker code source for ${slug}`);
  }
  const code = await getWorkerCode(slug);
  if (!code) throw new Error(`Worker code not found for ${slug}`);

  const env = await getEnv();
  const clientHtml = getClientHtml
    ? (await getClientHtml(slug)) ?? undefined
    : undefined;

  if (!kvCtx) {
    throw new Error(`No KV context for ${slug}`);
  }

  slot.sandbox = await createSandbox({
    workerCode: code,
    env,
    clientHtml,
    kvStore: kvCtx.kvStore,
    scope: kvCtx.scope,
    vectorStore: vectorCtx?.vectorStore,
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
  opts: {
    getWorkerCode?: ((slug: string) => Promise<string | null>) | undefined;
    getClientHtml?: ((slug: string) => Promise<string | null>) | undefined;
    kvCtx?: { kvStore: KvStore; scope: AgentScope } | undefined;
    vectorCtx?:
      | { vectorStore: ServerVectorStore; scope: AgentScope }
      | undefined;
    getEnv: () => Promise<Record<string, string>>;
  },
): Promise<void> {
  const t0 = performance.now();

  if (slot.sandbox) {
    resetIdleTimer(slot);
    return Promise.resolve();
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
 * Validates that the metadata contains a valid env (ASSEMBLYAI_API_KEY)
 * before registering. Agents with missing or invalid config are skipped.
 */
export function registerSlot(
  slots: Map<string, AgentSlot>,
  metadata: AgentMetadata,
): boolean {
  const parsed = EnvSchema.safeParse(metadata.env);
  if (!parsed.success) {
    log.warn("Skipping deploy — missing platform config", {
      slug: metadata.slug,
      err: parsed.error,
    });
    return false;
  }

  slots.set(metadata.slug, {
    slug: metadata.slug,
    keyHash: metadata.credential_hashes[0] ?? "",
  });
  return true;
}

/**
 * Prepares a sandbox for handling sessions for an agent.
 *
 * Loads the agent bundle (if not already loaded), creates a sandbox,
 * and returns it ready to accept client connections.
 */
export async function prepareSession(
  slot: AgentSlot,
  opts: {
    slug: string;
    store: BundleStore;
    kvStore: KvStore;
    vectorStore?: ServerVectorStore | undefined;
  },
): Promise<Sandbox> {
  const { slug, store, kvStore, vectorStore } = opts;
  const scope = { keyHash: slot.keyHash, slug };
  const kvCtx = { kvStore, scope };
  const vectorCtx = vectorStore ? { vectorStore, scope } : undefined;
  const getWorkerCode = (s: string) => store.getFile(s, "worker");
  const getClientHtml = (s: string) => store.getFile(s, "html");
  const getEnv = async () => (await store.getEnv(slug)) ?? {};

  await ensureAgent(slot, {
    getWorkerCode,
    getClientHtml,
    kvCtx,
    vectorCtx,
    getEnv,
  });

  return slot.sandbox!;
}
