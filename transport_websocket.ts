// Copyright 2025 the AAI authors. MIT license.
import * as log from "@std/log";
import { type AppState, html, HttpError, json } from "./context.ts";
import { STATUS_CODE } from "@std/http/status";
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
  if (!slot) throw new HttpError(STATUS_CODE.NotFound, `Not found: ${slug}`);
  return slot;
}

/** Handler for the agent health check endpoint (`GET /:slug/health`). */
export async function handleAgentHealth(
  state: AppState,
  slug: string,
): Promise<Response> {
  await requireSlot(slug, state);
  return json({ status: "ok", slug });
}

/** Handler for the agent landing page (`GET /:slug`). */
export async function handleAgentPage(
  state: AppState,
  slug: string,
): Promise<Response> {
  await requireSlot(slug, state);
  const page = await state.store.getClientFile(slug, "index.html");
  if (!page) throw new HttpError(STATUS_CODE.NotFound, "HTML not found");
  return html(page);
}

const ASSET_MIME_TYPES: Record<string, string> = {
  js: "application/javascript",
  css: "text/css",
  svg: "image/svg+xml",
  json: "application/json",
  png: "image/png",
  ico: "image/x-icon",
  woff: "font/woff",
  woff2: "font/woff2",
};

/** Handler for serving client static assets (`GET /:slug/assets/*`). */
export async function handleClientAsset(
  state: AppState,
  slug: string,
  assetPath: string,
): Promise<Response> {
  await requireSlot(slug, state);
  const content = await state.store.getClientFile(slug, `assets/${assetPath}`);
  if (!content) throw new HttpError(STATUS_CODE.NotFound, "Asset not found");

  const ext = assetPath.split(".").pop() ?? "";
  const contentType = ASSET_MIME_TYPES[ext] ?? "application/octet-stream";

  return new Response(content, {
    headers: {
      "Content-Type": contentType,
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
}

/**
 * Handler that upgrades an HTTP request to a WebSocket session.
 *
 * Prepares the agent worker and session, then delegates to
 * {@linkcode wireSessionSocket} for WebSocket lifecycle management.
 */
export async function handleWebSocket(
  req: Request,
  state: AppState,
  slug: string,
): Promise<Response> {
  const slot = await requireSlot(slug, state);
  const sandbox = await _internals.prepareSession(slot, {
    slug,
    store: state.store,
    kvStore: state.kvStore,
    vectorStore: state.vectorStore ?? undefined,
  });
  const resume = new URL(req.url).searchParams.has("resume");

  const { socket, response } = Deno.upgradeWebSocket(req);
  sandbox.startSession(socket, resume);

  return response;
}
