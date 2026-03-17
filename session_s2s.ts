// Copyright 2025 the AAI authors. MIT license.
/**
 * S2S session — thin wrapper injecting Deno logger, Prometheus metrics,
 * and the `ws` WebSocket factory.
 *
 * @module
 */
import * as log from "@std/log";
import type { PlatformConfig } from "./config.ts";
import type { ExecuteTool, WorkerApi } from "./_worker_entry.ts";
import {
  createS2sSession as _createS2sSession,
  type HookInvoker,
  type Session,
} from "@aai/sdk/session";
import type { ClientSink } from "@aai/sdk/protocol";
import type { AgentConfig, ToolSchema } from "@aai/sdk/internal-types";
import type { StepInfo } from "@aai/sdk/types";
import * as metrics from "./metrics.ts";
import { createWsFactory } from "./s2s.ts";

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
  getWorkerApi?: () => Promise<WorkerApi>;
  skipGreeting?: boolean;
};

const denoLogger = {
  info: (msg: string, ctx?: Record<string, unknown>) => log.info(msg, ctx),
  warn: (msg: string, ctx?: Record<string, unknown>) => log.warn(msg, ctx),
  error: (msg: string, ctx?: Record<string, unknown>) => log.error(msg, ctx),
  debug: (msg: string, ctx?: Record<string, unknown>) => log.debug(msg, ctx),
};

/** Adapt a WorkerApi to the generic HookInvoker interface. */
function workerApiToHookInvoker(
  getWorkerApi: () => Promise<WorkerApi>,
): HookInvoker {
  let cachedApi: WorkerApi | null = null;

  async function getApi(): Promise<WorkerApi> {
    cachedApi ??= await getWorkerApi();
    return cachedApi;
  }

  return {
    async onConnect(sessionId: string, timeoutMs?: number) {
      const api = await getApi();
      await api.onConnect(sessionId, timeoutMs);
    },
    async onDisconnect(sessionId: string, timeoutMs?: number) {
      const api = await getApi();
      await api.onDisconnect(sessionId, timeoutMs);
    },
    async onTurn(sessionId: string, text: string, timeoutMs?: number) {
      const api = await getApi();
      await api.onTurn(sessionId, text, timeoutMs);
    },
    async onError(
      sessionId: string,
      error: { message: string },
      timeoutMs?: number,
    ) {
      const api = await getApi();
      await api.onError(sessionId, error, timeoutMs);
    },
    async onStep(
      sessionId: string,
      step: StepInfo,
      timeoutMs?: number,
    ) {
      const api = await getApi();
      await api.onStep(sessionId, step, timeoutMs);
    },
    async resolveTurnConfig(sessionId: string, timeoutMs?: number) {
      const api = await getApi();
      return api.resolveTurnConfig(sessionId, timeoutMs);
    },
  };
}

/** Create an S2S-backed session with Deno logger and Prometheus metrics. */
export function createS2sSession(opts: SessionOptions): Session {
  const { platformConfig, getWorkerApi, ...rest } = opts;

  const hookInvoker = getWorkerApi
    ? workerApiToHookInvoker(getWorkerApi)
    : undefined;

  return _createS2sSession({
    ...rest,
    apiKey: platformConfig.apiKey,
    s2sConfig: platformConfig.s2sConfig,
    createWebSocket: createWsFactory(),
    ...(hookInvoker ? { hookInvoker } : {}),
    logger: denoLogger,
    metrics,
  });
}
