// Copyright 2025 the AAI authors. MIT license.
import * as log from "@std/log";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { AppState, Env } from "./context.ts";
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
import {
  httpRequestDurationSeconds,
  httpRequestsTotal,
  serialize as serializeMetrics,
  serializeForAgent,
} from "./metrics.ts";
import {
  requireInternal,
  requireOwner,
  requireScopeToken,
  requireUpgrade,
  validateSlug,
} from "./middleware.ts";

export function createOrchestrator(opts: {
  store: BundleStore;
  kvStore: KvStore;
  vectorStore?: ServerVectorStore | undefined;
  scopeKey: ScopeKey;
}): Hono<Env> {
  const state: AppState = {
    slots: new Map(),
    store: opts.store,
    kvStore: opts.kvStore,
    vectorStore: opts.vectorStore,
    scopeKey: opts.scopeKey,
  };

  const app = new Hono<Env>();

  const slugMw = createMiddleware<Env>(async (c, next) => {
    c.set("slug", validateSlug(c.req.param("slug")!));
    await next();
  });

  const ownerMw = createMiddleware<Env>(async (c, next) => {
    c.set(
      "keyHash",
      await requireOwner(c.req.raw, {
        slug: c.get("slug"),
        store: state.store,
      }),
    );
    await next();
  });

  const internalMw = createMiddleware<Env>(async (c, next) => {
    requireInternal(c.req.raw, c.env.info);
    await next();
  });

  const upgradeMw = createMiddleware<Env>(async (c, next) => {
    requireUpgrade(c.req.raw);
    await next();
  });

  const scopeTokenMw = createMiddleware<Env>(async (c, next) => {
    c.set("scope", await requireScopeToken(c.req.raw, state.scopeKey));
    await next();
  });

  app.use("*", cors());
  app.use(
    "*",
    secureHeaders({
      crossOriginOpenerPolicy: "same-origin",
      crossOriginEmbedderPolicy: "credentialless",
    }),
  );
  app.use("*", async (c, next) => {
    c.set("state", state);
    await next();
  });
  app.use("*", async (c, next) => {
    const start = performance.now();
    try {
      await next();
    } finally {
      const labels = {
        method: c.req.method,
        route: c.req.routePath,
        status: String(c.res.status),
        ok: String(c.res.ok),
      };
      httpRequestDurationSeconds.observe(
        (performance.now() - start) / 1000,
        labels,
      );
      httpRequestsTotal.inc(labels);
    }
  });

  app.onError((err, c) => {
    if (err instanceof HTTPException) {
      return c.json({ error: err.message }, err.status);
    }
    if (err instanceof z.ZodError) {
      return c.json({ error: err.message }, 400);
    }
    log.error("Unhandled error", {
      error: err instanceof Error ? err.message : String(err),
      path: new URL(c.req.url).pathname,
    });
    return c.json({ error: "Internal server error" }, 500);
  });

  app.get("/health", (c) => c.json({ status: "ok" }));

  app.get("/metrics", internalMw, (c) => {
    return c.text(serializeMetrics(), 200, {
      "Content-Type": "text/plain; version=0.0.4",
    });
  });

  app.get("/:slug{[a-z0-9][a-z0-9_-]*[a-z0-9]}", (c) => {
    const url = new URL(c.req.url);
    url.pathname += "/";
    return c.redirect(url.toString(), 301);
  });

  app.post("/:slug/deploy", slugMw, ownerMw, handleDeploy);
  app.get("/:slug/secret", slugMw, ownerMw, handleSecretList);
  app.put("/:slug/secret", slugMw, ownerMw, handleSecretSet);
  app.delete("/:slug/secret/:key", slugMw, ownerMw, handleSecretDelete);
  app.post("/:slug/kv", internalMw, slugMw, scopeTokenMw, handleKv);
  app.post("/:slug/vector", slugMw, ownerMw, handleVector);

  app.get("/:slug/metrics", slugMw, ownerMw, (c) => {
    return c.text(serializeForAgent(c.get("slug")), 200, {
      "Content-Type": "text/plain; version=0.0.4",
    });
  });

  app.get("/:slug/health", slugMw, handleAgentHealth);
  app.get("/:slug/websocket", upgradeMw, slugMw, handleWebSocket);
  app.get("/:slug/assets/:path{.+}", slugMw, handleClientAsset);
  app.get("/:slug/", slugMw, handleAgentPage);

  return app;
}
