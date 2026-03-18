// Copyright 2025 the AAI authors. MIT license.
// Zod validation schemas for server-side use.
// These validate untrusted input at HTTP/WebSocket boundaries.

import { z } from "zod";
import type { DeployBody } from "@aai/sdk/internal-types";

import type { KvRequest } from "@aai/sdk/protocol";

/** Zod schema for validating the deploy request body. */
export const DeployBodySchema = z.object({
  env: z.record(z.string(), z.string()).optional(),
  worker: z.string().min(1).max(10_000_000),
  html: z.string().min(1).max(10_000_000),
}) as unknown as z.ZodType<DeployBody>;

/** Zod schema for validating agent environment variables (requires `ASSEMBLYAI_API_KEY`). */
export const EnvSchema = z.object({
  ASSEMBLYAI_API_KEY: z.string().min(1),
}).catchall(z.string());

/** Metadata stored alongside an agent bundle in the bundle store. */
export type AgentMetadata = {
  /** The agent's unique slug identifier. */
  slug: string;
  /** Environment variables provided at deploy time. */
  env: Record<string, string>;
  /** SHA-256 hashes of API keys authorized to manage this agent. */
  "credential_hashes": string[];
};

/** Zod schema for validating agent metadata from the bundle store. */
export const AgentMetadataSchema = z.object({
  slug: z.string(),
  env: z.record(z.string(), z.string()).default({}),
  credential_hashes: z.array(z.string()).default([]),
}) as unknown as z.ZodType<AgentMetadata>;

// ─── KV schemas ─────────────────────────────────────────────────────────────

/**
 * KV HTTP request type extending the core KV operations with the
 * server-only `keys` operation.
 */
export type KvHttpRequest =
  | KvRequest
  | { op: "keys"; pattern?: string | undefined };

/** Zod schema for validating KV HTTP request bodies (get, set, del, list, keys). */
export const KvHttpRequestSchema: z.ZodType<KvHttpRequest> = z
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

// ─── Vector schemas ──────────────────────────────────────────────────────────

/**
 * Vector HTTP request type for the external `POST /:slug/vector` endpoint.
 * Supports upsert (used by `aai rag`) and query.
 */
export type VectorHttpRequest =
  | {
    op: "upsert";
    id: string;
    data: string;
    metadata?: Record<string, unknown> | undefined;
  }
  | {
    op: "query";
    text: string;
    topK?: number | undefined;
    filter?: string | undefined;
  };

/** Zod schema for validating Vector HTTP request bodies (upsert, query). */
export const VectorHttpRequestSchema: z.ZodType<VectorHttpRequest> = z
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
