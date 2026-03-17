// Copyright 2025 the AAI authors. MIT license.
// Zod validation schemas for server-side use.
// These validate untrusted input at HTTP/WebSocket boundaries.
// Protocol schemas (ClientEvent, KV) live in @aai/sdk/protocol.

import { z } from "zod";
import type { BuiltinTool, ToolChoice, Transport } from "@aai/sdk/types";
import type {
  AgentConfig,
  AgentEnv,
  DeployBody,
} from "@aai/sdk/internal-types";

export {
  ClientEventSchema,
  KvRequestBaseSchema,
  SessionErrorCodeSchema,
} from "@aai/sdk/protocol";
import type { KvRequest } from "@aai/sdk/protocol";

/** Zod schema for validating transport type values. */
export const TransportSchema: z.ZodType<Transport> = z.enum([
  "websocket",
]);

/** Zod schema for validating builtin tool name values. */
export const BuiltinToolSchema: z.ZodType<BuiltinTool> = z.enum([
  "web_search",
  "visit_webpage",
  "fetch_json",
  "run_code",
  "vector_search",
]);

/** Zod schema for validating tool choice configuration values. */
export const ToolChoiceSchema: z.ZodType<ToolChoice> = z.union([
  z.enum(["auto", "required", "none"]),
  z.object({ type: z.literal("tool"), toolName: z.string().min(1) }),
]);

/** Zod schema for validating the full agent configuration object. */
export const AgentConfigSchema: z.ZodType<AgentConfig> = z.object({
  name: z.string().min(1),
  instructions: z.string(),
  greeting: z.string(),
  voice: z.string(),
  mode: z.enum(["s2s"]).optional(),
  sttPrompt: z.string().min(1).optional(),
  maxSteps: z.number().int().positive().optional(),
  toolChoice: ToolChoiceSchema.optional(),
  transport: z.array(TransportSchema).min(1).optional(),
  builtinTools: z.array(BuiltinToolSchema).optional(),
  activeTools: z.array(z.string().min(1)).optional(),
});

/** Zod schema for validating a tool's JSON schema definition. */
export const ToolSchemaSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  parameters: z.object({
    type: z.literal("object"),
    properties: z.record(z.string(), z.unknown()).optional(),
    required: z.array(z.string()).optional(),
  }).catchall(z.unknown()),
});

/** Zod schema for validating the deploy request body. */
export const DeployBodySchema = z.object({
  env: z.record(z.string(), z.string()).optional(),
  worker: z.string().min(1).max(10_000_000),
  html: z.string().min(1).max(10_000_000),
  transport: z.array(TransportSchema).min(1).optional(),
  config: AgentConfigSchema,
  toolSchemas: z.array(ToolSchemaSchema),
}) as unknown as z.ZodType<DeployBody>;

/** Zod schema for validating agent environment variables (requires `ASSEMBLYAI_API_KEY`). */
export const EnvSchema: z.ZodType<AgentEnv> = z.object({
  ASSEMBLYAI_API_KEY: z.string().min(1),
}).catchall(z.string());

/** Metadata stored alongside an agent bundle in the bundle store. */
export type AgentMetadata = {
  /** The agent's unique slug identifier. */
  slug: string;
  /** Environment variables provided at deploy time. */
  env: Record<string, string>;
  /** Supported transport types for this agent. */
  transport: readonly Transport[];
  /** SHA-256 hashes of API keys authorized to manage this agent. */
  "credential_hashes": string[];
  /** Agent configuration extracted at build time. */
  config: AgentConfig;
  /** Tool schemas extracted at build time. */
  toolSchemas: import("@aai/sdk/internal-types").ToolSchema[];
};

/** Zod schema for validating agent metadata from the bundle store. */
export const AgentMetadataSchema = z.object({
  slug: z.string(),
  env: z.record(z.string(), z.string()).default({}),
  transport: z.array(TransportSchema).default(["websocket"]),
  credential_hashes: z.array(z.string()).default([]),
  config: AgentConfigSchema,
  toolSchemas: z.array(ToolSchemaSchema),
}) as unknown as z.ZodType<AgentMetadata>;

// ─── Browser input validation ───────────────────────────────────────────────

/** Zod schema for a single history message from the browser (sendHistory RPC). */
export const HistoryMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  text: z.string().max(100_000),
});

/** Zod schema for the full sendHistory payload from the browser. */
export const SendHistorySchema = z.array(HistoryMessageSchema).max(200);

/** Max size for a single audio chunk from the browser (1 MB). */
export const MAX_AUDIO_CHUNK_BYTES = 1_048_576;

/**
 * Validate a PCM16 audio chunk from the browser.
 *
 * Checks size bounds and byte alignment (PCM16 = 2 bytes per sample).
 * Returns `true` if the chunk is valid and should be forwarded to STT.
 */
export function isValidAudioChunk(data: Uint8Array): boolean {
  return data.byteLength > 0 &&
    data.byteLength <= MAX_AUDIO_CHUNK_BYTES &&
    data.byteLength % 2 === 0;
}

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
