// Copyright 2025 the AAI authors. MIT license.
import type { AgentSlot } from "./sandbox.ts";
import type { ScopeKey } from "./scope_token.ts";
import type { KvStore } from "./kv.ts";
import type { ServerVectorStore } from "./vector.ts";
import type { AgentScope } from "./scope_token.ts";
import type { AssetStore, DeployStore } from "./bundle_store_tigris.ts";

/** Hono environment type shared across all routes and handlers. */
export type Env = {
  Bindings: {
    info: Deno.ServeHandlerInfo;
    slots: Map<string, AgentSlot>;
    deployStore: DeployStore;
    assetStore: AssetStore;
    scopeKey: ScopeKey;
    kvStore: KvStore;
    vectorStore?: ServerVectorStore | undefined;
  };
  Variables: {
    slug: string;
    keyHash: string;
    scope: AgentScope;
  };
};
