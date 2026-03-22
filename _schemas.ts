// Copyright 2025 the AAI authors. MIT license.
// Zod validation schemas for server-side use.
// These validate untrusted input at HTTP/WebSocket boundaries.

import { z } from "zod";

/** Zod schema for validating the deploy request body. */
export const DeployBodySchema = z.object({
  env: z.record(z.string(), z.string()).optional(),
  worker: z.string().min(1).max(10_000_000),
  clientFiles: z.record(z.string(), z.string()),
});

/** Deploy request body sent by the CLI. */
export type DeployBody = z.infer<typeof DeployBodySchema>;

/** Zod schema for validating agent environment variables (requires `ASSEMBLYAI_API_KEY`). */
export const EnvSchema = z.object({
  ASSEMBLYAI_API_KEY: z.string().min(1),
}).catchall(z.string());

/** Zod schema for validating agent metadata from the bundle store. */
export const AgentMetadataSchema = z.object({
  slug: z.string(),
  env: z.record(z.string(), z.string()).default({}),
  credential_hashes: z.array(z.string()).default([]),
});

/** Metadata stored alongside an agent bundle in the bundle store. */
export type AgentMetadata = z.infer<typeof AgentMetadataSchema>;

// ─── KV schemas ─────────────────────────────────────────────────────────────

/** Zod schema for validating KV HTTP request bodies (get, set, del, list, keys). */
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

/** KV HTTP request type (core ops + server-only `keys`). */
export type KvHttpRequest = z.infer<typeof KvHttpRequestSchema>;

// ─── Vector schemas ──────────────────────────────────────────────────────────

/** Zod schema for validating Vector HTTP request bodies (upsert, query). */
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

/** Vector HTTP request type (upsert, query). */
export type VectorHttpRequest = z.infer<typeof VectorHttpRequestSchema>;

// ─── Secret schemas ─────────────────────────────────────────────────────────

/** Zod schema for validating secret update bodies (string key-value pairs). */
export const SecretUpdatesSchema = z.record(z.string(), z.string());
