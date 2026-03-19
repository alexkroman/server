// Copyright 2025 the AAI authors. MIT license.
import * as log from "@std/log";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { STATUS_CODE } from "@std/http/status";
import { type AppState, HttpError } from "./context.ts";
import { handleDeploy } from "./deploy.ts";
import {
  handleSecretDelete,
  handleSecretList,
  handleSecretSet,
} from "./secret_handler.ts";
import {
  handleAgentHealth,
  handleAgentPage,
  handleClientAsset,
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
  requireInternal,
  requireOwner,
  requireScopeToken,
  requireUpgrade,
  validateSlug,
} from "./middleware.ts";

type Env = {
  Bindings: { info: Deno.ServeHandlerInfo };
};

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
}): Hono<Env> {
  const state: AppState = {
    slots: new Map(),
    sessions: new Map(),
    store: opts.store,
    kvStore: opts.kvStore,
    vectorStore: opts.vectorStore,
    scopeKey: opts.scopeKey,
  };

  const app = new Hono<Env>();

  // --- Global middleware ---
  app.use("*", cors());
  app.use("*", async (c, next) => {
    await next();
    c.header("Cross-Origin-Opener-Policy", "same-origin");
    c.header("Cross-Origin-Embedder-Policy", "credentialless");
  });

  // --- Global error handler ---
  app.onError((err, c) => {
    if (err instanceof HttpError) {
      return c.json({ error: err.message }, err.status as 400);
    }
    log.error("Unhandled error", {
      error: err instanceof Error ? err.message : String(err),
      path: new URL(c.req.url).pathname,
    });
    return c.json(
      { error: "Internal server error" },
      STATUS_CODE.InternalServerError as 500,
    );
  });

  // --- Public routes ---
  app.get("/health", (c) => c.json({ status: "ok" }));

  app.get("/metrics", (c) => {
    requireInternal(c.req.raw, c.env.info);
    return new Response(serializeMetrics(), {
      headers: { "Content-Type": "text/plain; version=0.0.4" },
    });
  });

  // --- Agent page redirect (bare slug → trailing slash) ---
  app.get("/:slug{[a-z0-9][a-z0-9_-]*[a-z0-9]}", (c) => {
    // Only match if there's no sub-path (handled by more specific routes)
    const url = new URL(c.req.url);
    url.pathname += "/";
    return c.redirect(url.toString(), STATUS_CODE.MovedPermanently);
  });

  // --- Agent routes ---
  app.post("/:slug/deploy", async (c) => {
    const slug = validateSlug(c.req.param("slug"));
    const keyHash = await requireOwner(c.req.raw, {
      slug,
      store: state.store,
    });
    return handleDeploy(c.req.raw, state, { slug, keyHash });
  });

  app.get("/:slug/secret", async (c) => {
    const slug = validateSlug(c.req.param("slug"));
    await requireOwner(c.req.raw, { slug, store: state.store });
    return handleSecretList(state, slug);
  });

  app.put("/:slug/secret", async (c) => {
    const slug = validateSlug(c.req.param("slug"));
    await requireOwner(c.req.raw, { slug, store: state.store });
    return handleSecretSet(c.req.raw, state, slug);
  });

  app.delete("/:slug/secret/:key", async (c) => {
    const slug = validateSlug(c.req.param("slug"));
    await requireOwner(c.req.raw, { slug, store: state.store });
    const key = c.req.param("key");
    return handleSecretDelete(state, { slug, key });
  });

  app.post("/:slug/kv", async (c) => {
    requireInternal(c.req.raw, c.env.info);
    validateSlug(c.req.param("slug"));
    const scope = await requireScopeToken(c.req.raw, state.scopeKey);
    return handleKv(c.req.raw, state, scope);
  });

  app.post("/:slug/vector", async (c) => {
    const slug = validateSlug(c.req.param("slug"));
    const keyHash = await requireOwner(c.req.raw, {
      slug,
      store: state.store,
    });
    return handleVector(c.req.raw, state, { keyHash, slug });
  });

  app.get("/:slug/metrics", async (c) => {
    const slug = validateSlug(c.req.param("slug"));
    await requireOwner(c.req.raw, { slug, store: state.store });
    return new Response(serializeForAgent(slug), {
      headers: { "Content-Type": "text/plain; version=0.0.4" },
    });
  });

  app.get("/:slug/health", (c) => {
    const slug = validateSlug(c.req.param("slug"));
    return handleAgentHealth(state, slug);
  });

  app.get("/:slug/websocket", (c) => {
    requireUpgrade(c.req.raw);
    const slug = validateSlug(c.req.param("slug"));
    return handleWebSocket(c.req.raw, state, slug);
  });

  app.get("/:slug/assets/:path{.+}", (c) => {
    const slug = validateSlug(c.req.param("slug"));
    const assetPath = c.req.param("path");
    return handleClientAsset(state, slug, assetPath);
  });

  app.get("/:slug/", (c) => {
    const slug = validateSlug(c.req.param("slug"));
    return handleAgentPage(state, slug);
  });

  return app;
}
