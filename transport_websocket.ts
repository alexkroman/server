// Copyright 2025 the AAI authors. MIT license.
import * as log from "@std/log";
import { HTTPException } from "hono/http-exception";
import type { Context } from "hono";
import type { Env } from "./context.ts";
import { typeByExtension } from "@std/media-types";
import { type AgentSlot, prepareSession, registerSlot } from "./worker_pool.ts";
import type { BundleStore } from "./bundle_store_tigris.ts";

export const _internals = { prepareSession };

/**
 * Discovers an agent slot, lazily loading it from the bundle store if needed.
 *
 * If the slot is already registered in memory, returns it immediately.
 * Otherwise, checks the bundle store for a manifest and registers the slot.
 */
type SlotLookup = { slots: Map<string, AgentSlot>; store: BundleStore };

export async function discoverSlot(
  slug: string,
  opts: SlotLookup,
): Promise<AgentSlot | null> {
  const existing = opts.slots.get(slug);
  if (existing) return existing;

  const manifest = await opts.store.getManifest(slug);
  if (!manifest) return null;

  if (registerSlot(opts.slots, manifest)) {
    log.info("Lazy-discovered agent from store", { slug });
  }
  return opts.slots.get(slug) ?? null;
}

async function requireSlot(
  slug: string,
  opts: SlotLookup,
): Promise<AgentSlot> {
  const slot = await discoverSlot(slug, opts);
  if (!slot) throw new HTTPException(404, { message: `Not found: ${slug}` });
  return slot;
}

/** Handler for the agent health check endpoint (`GET /:slug/health`). */
export async function handleAgentHealth(c: Context<Env>): Promise<Response> {
  const state = c.get("state");
  const slug = c.get("slug");
  await requireSlot(slug, state);
  return c.json({ status: "ok", slug });
}

/** Handler for the agent landing page (`GET /:slug`). */
export async function handleAgentPage(c: Context<Env>): Promise<Response> {
  const state = c.get("state");
  const slug = c.get("slug");
  await requireSlot(slug, state);
  const page = await state.store.getClientFile(slug, "index.html");
  if (!page) throw new HTTPException(404, { message: "HTML not found" });
  return c.html(page);
}

/** Handler for serving client static assets (`GET /:slug/assets/*`). */
export async function handleClientAsset(c: Context<Env>): Promise<Response> {
  const state = c.get("state");
  const slug = c.get("slug");
  const assetPath = c.req.param("path")!;
  await requireSlot(slug, state);
  const content = await state.store.getClientFile(slug, `assets/${assetPath}`);
  if (!content) throw new HTTPException(404, { message: "Asset not found" });

  const ext = assetPath.split(".").pop()!;
  const contentType = typeByExtension(ext)!;

  return c.body(content, 200, {
    "Content-Type": contentType,
    "Cache-Control": "public, max-age=31536000, immutable",
  });
}

/** Handler that upgrades an HTTP request to a WebSocket session. */
export async function handleWebSocket(c: Context<Env>): Promise<Response> {
  const state = c.get("state");
  const slug = c.get("slug");
  const slot = await requireSlot(slug, state);
  const sandbox = await _internals.prepareSession(slot, {
    slug,
    store: state.store,
    kvStore: state.kvStore,
    vectorStore: state.vectorStore,
  });
  const resume = c.req.query("resume") !== undefined;

  const { socket, response } = Deno.upgradeWebSocket(c.req.raw);
  sandbox.startSession(socket, resume);

  return response;
}
