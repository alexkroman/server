// Copyright 2025 the AAI authors. MIT license.
import { Index } from "@upstash/vector";
import type { AgentScope } from "./scope_token.ts";
import type { VectorEntry } from "@aai/sdk/vector";

export type ServerVectorStore = {
  upsert(
    scope: AgentScope,
    id: string,
    data: string,
    metadata?: Record<string, unknown>,
  ): Promise<void>;
  query(
    scope: AgentScope,
    text: string,
    topK?: number,
    filter?: string,
  ): Promise<VectorEntry[]>;
  remove(scope: AgentScope, ids: string[]): Promise<void>;
};

function namespace(scope: AgentScope): string {
  return `${scope.keyHash}:${scope.slug}`;
}

export function createVectorStore(
  url: string,
  token: string,
): ServerVectorStore {
  const index = new Index({ url, token });

  return {
    async upsert(scope, id, data, metadata) {
      const ns = index.namespace(namespace(scope));
      await ns.upsert({
        id,
        data,
        metadata,
      });
    },

    async query(scope, text, topK = 10, filter?) {
      const ns = index.namespace(namespace(scope));
      const results = await ns.query({
        data: text,
        topK,
        includeData: true,
        includeMetadata: true,
        ...(filter ? { filter } : {}),
      });
      return results.map((r) => ({
        id: String(r.id),
        score: r.score,
        data: r.data as string | undefined,
        metadata: r.metadata as Record<string, unknown> | undefined,
      }));
    },

    async remove(scope, ids) {
      const ns = index.namespace(namespace(scope));
      await ns.delete(ids);
    },
  };
}
