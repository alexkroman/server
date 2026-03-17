// Copyright 2025 the AAI authors. MIT license.
/**
 * S2S session — thin wrapper injecting Deno logger, Prometheus metrics,
 * and the `ws` WebSocket factory.
 *
 * @module
 */
import type { PlatformConfig } from "./config.ts";
import type { ExecuteTool } from "@aai/sdk/worker-entry";
import {
  createS2sSession as _createS2sSession,
  type HookInvoker,
  type Session,
} from "@aai/sdk/session";
import type { ClientSink } from "@aai/sdk/protocol";
import type { AgentConfig, ToolSchema } from "@aai/sdk/internal-types";
import * as metrics from "./metrics.ts";
import { createWsFactory } from "./s2s.ts";
import { denoLogger } from "./logger.ts";

export type { Session };

/** Configuration options for creating a new session. */
export type SessionOptions = {
  id: string;
  agent: string;
  client: ClientSink;
  agentConfig: AgentConfig;
  toolSchemas: readonly ToolSchema[];
  platformConfig: PlatformConfig;
  executeTool: ExecuteTool;
  env?: Record<string, string | undefined>;
  hookInvoker?: HookInvoker;
  skipGreeting?: boolean;
};

/** Create an S2S-backed session with Deno logger and Prometheus metrics. */
export function createS2sSession(opts: SessionOptions): Session {
  const { platformConfig, ...rest } = opts;

  return _createS2sSession({
    ...rest,
    apiKey: platformConfig.apiKey,
    s2sConfig: platformConfig.s2sConfig,
    createWebSocket: createWsFactory(),
    logger: denoLogger,
    metrics,
  });
}
