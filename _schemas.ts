// Copyright 2025 the AAI authors. MIT license.
// Zod schemas — validate untrusted input at HTTP/WebSocket boundaries.

import { z } from "zod";
import {
  type KvRequest,
  KvRequestSchema,
  type VectorRequest,
  VectorRequestSchema,
} from "@aai/sdk/protocol";

export const DeployBodySchema = z.object({
  env: z.record(z.string(), z.string()).optional(),
  worker: z.string().min(1).max(10_000_000),
  clientFiles: z.record(z.string(), z.string()),
});

export type DeployBody = z.infer<typeof DeployBodySchema>;

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

/** KV HTTP request — re-exported from the SDK protocol. */
export type KvHttpRequest = KvRequest;

/** Zod schema for validating KV HTTP request bodies. */
export const KvHttpRequestSchema: z.ZodType<KvHttpRequest> = KvRequestSchema;

// ─── Vector ─────────────────────────────────────────────────────────────────

/** Vector HTTP request — re-exported from the SDK protocol. */
export type VectorHttpRequest = VectorRequest;

/** Zod schema for validating Vector HTTP request bodies. */
export const VectorHttpRequestSchema: z.ZodType<VectorHttpRequest> =
  VectorRequestSchema;

// ─── Secrets ────────────────────────────────────────────────────────────────

export const SecretUpdatesSchema = z.record(z.string(), z.string());
