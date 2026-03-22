// Copyright 2025 the AAI authors. MIT license.
import type { Context } from "hono";
import type { AgentSlot } from "./worker_pool.ts";
import type { BundleStore } from "./bundle_store_tigris.ts";
import type { Session } from "@aai/sdk/session";
import type { AgentScope, ScopeKey } from "./scope_token.ts";
import type { KvStore } from "./kv.ts";
import type { ServerVectorStore } from "./vector.ts";

export type Env = {
  Bindings: { info: Deno.ServeHandlerInfo };
  Variables: {
    state: AppState;
    slug: string;
    keyHash: string;
    scope: AgentScope;
  };
};

export type Handler = (c: Context<Env>) => Response | Promise<Response>;

export type AppState = {
  slots: Map<string, AgentSlot>;
  sessions: Map<string, Session>;
  store: BundleStore;
  scopeKey: ScopeKey;
  kvStore: KvStore;
  vectorStore?: ServerVectorStore | undefined;
};
