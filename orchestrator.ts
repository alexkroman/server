// Copyright 2025 the AAI authors. MIT license.
import * as log from "@std/log";
import { type Route, route } from "@std/http/unstable-route";
import { STATUS_CODE } from "@std/http/status";
import { type AppState, html, HttpError, json, text } from "./context.ts";
import { FAVICON_SVG, renderLandingPage } from "./html.tsx";
import { INSTALL_SCRIPT } from "./install.ts";
import { handleDeploy } from "./deploy.ts";
import { handleEnvDelete, handleEnvList, handleEnvSet } from "./env_handler.ts";
import {
  handleAgentHealth,
  handleAgentPage,
  handleWebSocket,
} from "./transport_websocket.ts";
import type { BundleStore } from "./bundle_store_tigris.ts";
import { handleKv } from "./kv_handler.ts";
import { handleVector } from "./vector_handler.ts";
import type { KvStore } from "./kv.ts";
import type { ServerVectorStore } from "./vector.ts";
import type { ScopeKey } from "./scope_token.ts";
import { serialize as serializeMetrics, serializeForAgent } from "./metrics.ts";
import {
  applyGlobalHeaders,
  handlePreflight,
  requireInternal,
  requireOwner,
  requireScopeToken,
  requireUpgrade,
  validateSlug,
} from "./middleware.ts";

/** Extract named groups from a URLPatternResult as a flat record. */
function params(match: URLPatternResult): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(match.pathname.groups)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/** Build a RouteContext from a handler's arguments. */
function ctx(
  req: Request,
  match: URLPatternResult,
  info: Deno.ServeHandlerInfo | undefined,
  state: AppState,
) {
  return {
    req,
    info: info!,
    params: params(match),
    state,
  };
}

/**
 * Creates the main HTTP request handler for the orchestrator server.
 *
 * Sets up all routes including agent deploy, WebSocket transport,
 * health checks, KV operations, and static file serving.
 */
export function createOrchestrator(opts: {
  store: BundleStore;
  kvStore: KvStore;
  vectorStore?: ServerVectorStore | undefined;
  scopeKey: ScopeKey;
}): Deno.ServeHandler {
  const state: AppState = {
    slots: new Map(),
    sessions: new Map(),
    store: opts.store,
    kvStore: opts.kvStore,
    vectorStore: opts.vectorStore,
    scopeKey: opts.scopeKey,
  };

  const serveFavicon = () =>
    new Response(FAVICON_SVG, {
      headers: {
        "Content-Type": "image/svg+xml",
        "Cache-Control": "public, max-age=86400",
      },
    });

  const routes: Route[] = [
    // --- Public routes ---
    {
      pattern: new URLPattern({ pathname: "/" }),
      method: "GET",
      handler: () => html(renderLandingPage()),
    },
    {
      pattern: new URLPattern({ pathname: "/health" }),
      method: "GET",
      handler: () => json({ status: "ok" }),
    },
    {
      pattern: new URLPattern({ pathname: "/metrics" }),
      method: "GET",
      handler: (req, _match, info) => {
        requireInternal(req, info!);
        return new Response(serializeMetrics(), {
          headers: { "Content-Type": "text/plain; version=0.0.4" },
        });
      },
    },
    {
      pattern: new URLPattern({ pathname: "/favicon.ico" }),
      method: "GET",
      handler: serveFavicon,
    },
    {
      pattern: new URLPattern({ pathname: "/favicon.svg" }),
      method: "GET",
      handler: serveFavicon,
    },
    {
      pattern: new URLPattern({ pathname: "/install" }),
      method: "GET",
      handler: () => text(INSTALL_SCRIPT),
    },

    // --- Agent page (trailing slash is canonical for relative URL resolution) ---
    {
      pattern: new URLPattern({ pathname: "/:slug" }),
      method: "GET",
      handler: (req) => {
        const url = new URL(req.url);
        url.pathname += "/";
        return Response.redirect(url.toString(), STATUS_CODE.MovedPermanently);
      },
    },

    // --- Agent routes ---
    {
      pattern: new URLPattern({ pathname: "/:slug/deploy" }),
      method: "POST",
      handler: async (req, match, info) => {
        const c = ctx(req, match, info, state);
        const slug = validateSlug(c.params);
        const keyHash = await requireOwner(req, {
          slug,
          store: state.store,
        });
        return handleDeploy(c, { slug, keyHash });
      },
    },
    // --- Env management (like `vercel env`) ---
    {
      pattern: new URLPattern({ pathname: "/:slug/env" }),
      method: "GET",
      handler: async (req, match, info) => {
        const c = ctx(req, match, info, state);
        const slug = validateSlug(c.params);
        await requireOwner(req, { slug, store: state.store });
        return handleEnvList(c, slug);
      },
    },
    {
      pattern: new URLPattern({ pathname: "/:slug/env" }),
      method: "PUT",
      handler: async (req, match, info) => {
        const c = ctx(req, match, info, state);
        const slug = validateSlug(c.params);
        await requireOwner(req, { slug, store: state.store });
        return handleEnvSet(c, slug);
      },
    },
    {
      pattern: new URLPattern({ pathname: "/:slug/env/:key" }),
      method: "DELETE",
      handler: async (req, match, info) => {
        const c = ctx(req, match, info, state);
        const slug = validateSlug(c.params);
        await requireOwner(req, { slug, store: state.store });
        const key = c.params.key!;
        return handleEnvDelete(c, { slug, key });
      },
    },
    {
      pattern: new URLPattern({ pathname: "/:slug/kv" }),
      method: "POST",
      handler: async (req, match, info) => {
        requireInternal(req, info!);
        const c = ctx(req, match, info, state);
        validateSlug(c.params);
        const scope = await requireScopeToken(req, state.scopeKey);
        return handleKv(c, scope);
      },
    },
    {
      pattern: new URLPattern({ pathname: "/:slug/vector" }),
      method: "POST",
      handler: async (req, match, info) => {
        const c = ctx(req, match, info, state);
        const slug = validateSlug(c.params);
        const keyHash = await requireOwner(req, {
          slug,
          store: state.store,
        });
        return handleVector(c, { keyHash, slug });
      },
    },
    {
      pattern: new URLPattern({ pathname: "/:slug/metrics" }),
      method: "GET",
      handler: async (req, match, info) => {
        const c = ctx(req, match, info, state);
        const slug = validateSlug(c.params);
        await requireOwner(req, { slug, store: state.store });
        return new Response(serializeForAgent(slug), {
          headers: { "Content-Type": "text/plain; version=0.0.4" },
        });
      },
    },
    {
      pattern: new URLPattern({ pathname: "/:slug/health" }),
      method: "GET",
      handler: (req, match, info) => {
        const c = ctx(req, match, info, state);
        const slug = validateSlug(c.params);
        return handleAgentHealth(c, slug);
      },
    },
    {
      pattern: new URLPattern({ pathname: "/:slug/websocket" }),
      handler: (req, match, info) => {
        requireUpgrade(req);
        const c = ctx(req, match, info, state);
        const slug = validateSlug(c.params);
        return handleWebSocket(c, slug);
      },
    },
    // --- Agent page (served at trailing-slash so relative URLs resolve correctly) ---
    {
      pattern: new URLPattern({ pathname: "/:slug/" }),
      method: "GET",
      handler: (req, match, info) => {
        const c = ctx(req, match, info, state);
        const slug = validateSlug(c.params);
        return handleAgentPage(c, slug);
      },
    },
  ];

  const handler = route(
    routes,
    () => json({ error: "Not found" }, { status: STATUS_CODE.NotFound }),
  );

  return async (req: Request, info: Deno.ServeHandlerInfo) => {
    if (req.method === "OPTIONS") {
      return handlePreflight();
    }

    try {
      const res = await handler(req, info);
      return applyGlobalHeaders(res);
    } catch (err) {
      if (err instanceof HttpError) {
        return applyGlobalHeaders(
          json({ error: err.message }, { status: err.status }),
        );
      }
      log.error("Unhandled error", {
        error: err instanceof Error ? err.message : String(err),
        path: new URL(req.url).pathname,
      });
      return applyGlobalHeaders(
        json({ error: "Internal server error" }, {
          status: STATUS_CODE.InternalServerError,
        }),
      );
    }
  };
}
