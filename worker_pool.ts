// Copyright 2025 the AAI authors. MIT license.
import * as log from "@std/log";
import { EnvSchema } from "./_schemas.ts";
import type { BundleStore } from "./bundle_store_tigris.ts";
import type { AgentMetadata } from "./_schemas.ts";
import type { KvStore } from "./kv.ts";
import type { ServerVectorStore } from "./vector.ts";
import type { AgentScope } from "./scope_token.ts";
import { createSandbox, type Sandbox } from "./sandbox.ts";

const IDLE_MS = 5 * 60 * 1000;

export type AgentSlot = {
  slug: string;
  keyHash: string;
  sandbox?: Sandbox;
  initializing?: Promise<Sandbox>;
  idleTimer?: ReturnType<typeof setTimeout>;
};

type AgentOpts = {
  getWorkerCode: (slug: string) => Promise<string | null>;
  kvCtx: { kvStore: KvStore; scope: AgentScope };
  vectorCtx?: { vectorStore: ServerVectorStore; scope: AgentScope } | undefined;
  getEnv: () => Promise<Record<string, string>>;
};

/** Terminate a running sandbox so it restarts on the next session. */
export function terminateSandbox(slot: AgentSlot): void {
  if (!slot.sandbox) return;
  slot.sandbox.terminate();
  delete slot.sandbox;
  delete slot.initializing;
}

function resetIdleTimer(slot: AgentSlot): void {
  if (slot.idleTimer) clearTimeout(slot.idleTimer);
  const id = setTimeout(() => {
    if (!slot.sandbox) return;
    log.info("Evicting idle sandbox", { slug: slot.slug });
    terminateSandbox(slot);
    delete slot.idleTimer;
  }, IDLE_MS);
  Deno.unrefTimer(id);
  slot.idleTimer = id;
}

/** Ensure a sandbox is running for the slot, coalescing concurrent calls. */
export function ensureAgent(
  slot: AgentSlot,
  opts: AgentOpts,
): Promise<Sandbox> {
  if (slot.sandbox) {
    resetIdleTimer(slot);
    return Promise.resolve(slot.sandbox);
  }
  if (slot.initializing) return slot.initializing;

  const t0 = performance.now();
  slot.initializing = (async () => {
    const code = await opts.getWorkerCode(slot.slug);
    if (!code) throw new Error(`Worker code not found for ${slot.slug}`);
    slot.sandbox = await createSandbox({
      workerCode: code,
      env: await opts.getEnv(),
      kvStore: opts.kvCtx.kvStore,
      scope: opts.kvCtx.scope,
      vectorStore: opts.vectorCtx?.vectorStore,
    });
    resetIdleTimer(slot);
    log.info("Agent sandbox ready", {
      slug: slot.slug,
      durationMs: Math.round(performance.now() - t0),
    });
    return slot.sandbox;
  })().catch((err) => {
    delete slot.initializing;
    throw err;
  });

  return slot.initializing;
}

/** Register an agent slot, validating env before accepting. */
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

/** Load (or reuse) a sandbox for the given agent, ready for sessions. */
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
