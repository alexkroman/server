// Copyright 2025 the AAI authors. MIT license.
import type { Context } from "hono";
import type { AgentSlot } from "./worker_pool.ts";
import type { BundleStore } from "./bundle_store_tigris.ts";
import type { Session } from "@aai/sdk/session";
import type { ScopeKey } from "./scope_token.ts";
import type { KvStore } from "./kv.ts";
import type { ServerVectorStore } from "./vector.ts";
import type { AgentScope } from "./scope_token.ts";

/** Hono environment type shared across all routes and handlers. */
export type Env = {
  Bindings: { info: Deno.ServeHandlerInfo };
  Variables: {
    state: AppState;
    slug: string;
    keyHash: string;
    scope: AgentScope;
  };
};

/** Hono handler type shorthand. */
export type Handler = (c: Context<Env>) => Response | Promise<Response>;

/** Shared server state passed to all route handlers. */
export type AppState = {
  slots: Map<string, AgentSlot>;
  sessions: Map<string, Session>;
  store: BundleStore;
  scopeKey: ScopeKey;
  kvStore: KvStore;
  vectorStore?: ServerVectorStore | undefined;
};
