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
  /** Promise that resolves to the sandbox when initialization completes. */
  initializing?: Promise<Sandbox>;
  /** Timer handle for idle sandbox eviction. */
  idleTimer?: ReturnType<typeof setTimeout>;
};

type AgentOpts = {
  getWorkerCode: (slug: string) => Promise<string | null>;
  kvCtx: { kvStore: KvStore; scope: AgentScope };
  vectorCtx?: { vectorStore: ServerVectorStore; scope: AgentScope } | undefined;
  getEnv: () => Promise<Record<string, string>>;
};

async function spawnAgent(
  slot: AgentSlot,
  opts: AgentOpts,
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
 *
 * Returns the active sandbox.
 */
export function ensureAgent(
  slot: AgentSlot,
  opts: AgentOpts,
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
  const getEnv = async () => (await store.getEnv(slug)) ?? {};

  return await ensureAgent(slot, {
    getWorkerCode,
    kvCtx,
    vectorCtx,
    getEnv,
  });
}
