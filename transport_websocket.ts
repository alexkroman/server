// Copyright 2025 the AAI authors. MIT license.
import * as log from "@std/log";
import { html, HttpError, json, type RouteContext } from "./context.ts";
import { STATUS_CODE } from "@std/http/status";
import { wireSessionSocket } from "./ws_handler.ts";
import { createS2sSession } from "./session_s2s.ts";
import { type AgentSlot, prepareSession, registerSlot } from "./worker_pool.ts";
import type { BundleStore } from "./bundle_store_tigris.ts";
import { AUDIO_FORMAT, PROTOCOL_VERSION } from "@aai/sdk/protocol";

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

/**
 * Resolves an agent slot that supports the WebSocket transport.
 */
export async function resolveSlot(
  slug: string,
  opts: SlotLookup,
): Promise<AgentSlot | null> {
  const slot = await discoverSlot(slug, opts);
  if (!slot?.transport.includes("websocket")) return null;
  return slot;
}

async function requireSlot(
  slug: string,
  opts: SlotLookup,
): Promise<AgentSlot> {
  const slot = await resolveSlot(slug, opts);
  if (!slot) throw new HttpError(STATUS_CODE.NotFound, `Not found: ${slug}`);
  return slot;
}

/** Handler for the agent health check endpoint (`GET /:slug/health`). */
export async function handleAgentHealth(
  ctx: RouteContext,
  slug: string,
): Promise<Response> {
  const slot = await requireSlot(slug, ctx.state);
  return json({ status: "ok", slug, name: slot.name ?? slug });
}

/** Handler for the agent landing page (`GET /:slug`). */
export async function handleAgentPage(
  ctx: RouteContext,
  slug: string,
): Promise<Response> {
  await requireSlot(slug, ctx.state);
  const page = await ctx.state.store.getFile(slug, "html");
  if (!page) throw new HttpError(STATUS_CODE.NotFound, "HTML not found");
  return html(page);
}

/**
 * Handler that upgrades an HTTP request to a WebSocket session.
 *
 * Prepares the agent worker and session, then delegates to
 * {@linkcode wireSessionSocket} for WebSocket lifecycle management.
 */
export async function handleWebSocket(
  ctx: RouteContext,
  slug: string,
): Promise<Response> {
  const slot = await requireSlot(slug, ctx.state);
  const setup = await _internals.prepareSession(slot, {
    slug,
    store: ctx.state.store,
    kvStore: ctx.state.kvStore,
    vectorStore: ctx.state.vectorStore ?? undefined,
  });
  const resume = new URL(ctx.req.url).searchParams.has("resume");

  const { socket, response } = Deno.upgradeWebSocket(ctx.req);

  wireSessionSocket(socket, {
    sessions: ctx.state.sessions,
    createSession: (sessionId, client) =>
      createS2sSession({
        id: sessionId,
        agent: slug,
        client,
        ...setup,
        skipGreeting: resume,
      }),
    readyConfig: {
      protocolVersion: PROTOCOL_VERSION,
      audioFormat: AUDIO_FORMAT,
      sampleRate: setup.platformConfig.s2sConfig.inputSampleRate,
      ttsSampleRate: setup.platformConfig.s2sConfig.outputSampleRate,
      mode: "s2s",
    },
    logContext: { slug },
  });

  return response;
}
