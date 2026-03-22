// Copyright 2025 the AAI authors. MIT license.
// Zod schemas — validate untrusted input at HTTP/WebSocket boundaries.

import { z } from "zod";

export const DeployBodySchema = z.object({
  env: z.record(z.string(), z.string()).optional(),
  worker: z.string().min(1).max(10_000_000),
  clientFiles: z.record(z.string(), z.string()),
});

export const EnvSchema = z.object({
  ASSEMBLYAI_API_KEY: z.string().min(1),
}).catchall(z.string());

export type AgentMetadata = {
  slug: string;
  env: Record<string, string>;
  "credential_hashes": string[];
};

export const AgentMetadataSchema: z.ZodType<AgentMetadata> = z.object({
  slug: z.string(),
  env: z.record(z.string(), z.string()).default({}),
  credential_hashes: z.array(z.string()).default([]),
});

// ─── KV ─────────────────────────────────────────────────────────────────────

export const KvHttpRequestSchema = z
  .discriminatedUnion("op", [
    z.object({ op: z.literal("get"), key: z.string().min(1) }),
    z.object({
      op: z.literal("set"),
      key: z.string().min(1),
      value: z.string(),
      ttl: z.number().int().positive().optional(),
    }),
    z.object({ op: z.literal("del"), key: z.string().min(1) }),
    z.object({
      op: z.literal("list"),
      prefix: z.string(),
      limit: z.number().int().positive().optional(),
      reverse: z.boolean().optional(),
    }),
    z.object({ op: z.literal("keys"), pattern: z.string().optional() }),
  ]);

// ─── Vector ─────────────────────────────────────────────────────────────────

export const VectorHttpRequestSchema = z
  .discriminatedUnion("op", [
    z.object({
      op: z.literal("upsert"),
      id: z.string().min(1),
      data: z.string().min(1),
      metadata: z.record(z.string(), z.unknown()).optional(),
    }),
    z.object({
      op: z.literal("query"),
      text: z.string().min(1),
      topK: z.number().int().positive().max(100).optional(),
      filter: z.string().optional(),
    }),
  ]);

// ─── Secrets ────────────────────────────────────────────────────────────────

export const SecretUpdatesSchema = z.record(z.string(), z.string());
