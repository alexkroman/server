// Copyright 2025 the AAI authors. MIT license.
/**
 * Host-side worker API — communicates with sandboxed agent workers via
 * Cap'n Web RPC over postMessage.
 *
 * @module
 */

import type { Message, StepInfo } from "@aai/sdk/types";
import { HOOK_TIMEOUT_MS } from "@aai/sdk/protocol";
import type {
  HostApi,
  KvRequest,
  TurnConfig,
  WorkerRpcApi,
} from "@aai/sdk/protocol";
import { withTimeout } from "@aai/sdk/timeout";
import { MAX_TOOL_RESULT_LENGTH, TurnConfigSchema } from "./_schemas.ts";
import { newMessagePortRpcSession, RpcTarget } from "capnweb";
import { asMessagePort } from "@aai/sdk/capnweb-transport";

export {
  type ExecuteTool,
  executeToolCall,
  TOOL_HANDLER_TIMEOUT,
} from "@aai/sdk/worker-entry";

/**
 * Cap'n Web RPC target that exposes host-side APIs (fetch, kv) to the worker.
 *
 * An instance of this class is passed as the second argument to
 * `newMessagePortRpcSession`, making it available to the worker at session creation.
 */
class HostApiTarget extends RpcTarget {
  #api: HostApi;

  constructor(api: HostApi) {
    super();
    this.#api = api;
  }

  fetch(req: {
    url: string;
    method: string;
    headers: Record<string, string>;
    body: string | null;
  }): Promise<{
    status: number;
    statusText: string;
    headers: Record<string, string>;
    body: string;
  }> {
    return this.#api.fetch(req);
  }

  kv(req: KvRequest): Promise<{ result: unknown }> {
    return this.#api.kv(req);
  }

  vectorSearch(req: { query: string; topK: number }): Promise<string> {
    return this.#api.vectorSearch(req);
  }
}

/**
 * High-level API for communicating with a sandboxed agent worker.
 *
 * This is the host-side interface returned by {@linkcode createWorkerApi}.
 * All methods support optional RPC timeouts. Environment variables are
 * set once at creation via the `withEnv` capability — no per-call env.
 */
export type WorkerApi = {
  executeTool(
    name: string,
    args: Readonly<Record<string, unknown>>,
    sessionId?: string,
    timeoutMs?: number,
    messages?: readonly Message[],
  ): Promise<string>;
  onConnect(sessionId: string, timeoutMs?: number): Promise<void>;
  onDisconnect(sessionId: string, timeoutMs?: number): Promise<void>;
  onTurn(
    sessionId: string,
    text: string,
    timeoutMs?: number,
  ): Promise<void>;
  onError(
    sessionId: string,
    error: { message: string; stack?: string },
    timeoutMs?: number,
  ): Promise<void>;
  onStep(
    sessionId: string,
    step: StepInfo,
    timeoutMs?: number,
  ): Promise<void>;
  resolveTurnConfig(
    sessionId: string,
    timeoutMs?: number,
  ): Promise<TurnConfig | null>;
  dispose?: () => void;
};

/**
 * Create a {@linkcode WorkerApi} backed by Cap'n Web RPC over a Worker.
 *
 * Both sides exchange targets at session creation: the host passes its
 * {@linkcode HostApiTarget} and receives a stub for the worker's
 * {@linkcode AgentWorkerTarget}. No separate init handshake is needed.
 *
 * If `env` is provided, the host calls `withEnv(env)` once to obtain
 * a scoped capability with env baked in. All subsequent calls are
 * pipelined through this scoped stub — no per-call env parameter.
 *
 * @param worker - The Worker (or any object with `postMessage` and event listeners).
 * @param hostApi - Optional host-side API to expose to the worker for fetch/kv proxy.
 * @param env - Optional environment variables to set once on the worker.
 * @returns A {@linkcode WorkerApi} instance with timeout-wrapped RPC methods.
 */
export function createWorkerApi(
  worker: {
    postMessage(msg: unknown): void;
    addEventListener(type: string, listener: (event: Event) => void): void;
    removeEventListener(type: string, listener: (event: Event) => void): void;
  },
  hostApi?: HostApi,
  env?: Record<string, string>,
): WorkerApi {
  const port = asMessagePort(worker);
  const hostTarget = hostApi ? new HostApiTarget(hostApi) : undefined;
  const stub = newMessagePortRpcSession<WorkerRpcApi>(port, hostTarget);

  // Set env once via capability pattern — returns a scoped stub.
  const scoped = env
    ? stub.withEnv(env) as unknown as import("capnweb").RpcStub<WorkerRpcApi>
    : stub;

  return {
    async executeTool(name, args, sessionId, timeoutMs, messages) {
      const result = await withTimeout(
        scoped.executeTool(name, args, sessionId, messages) as Promise<string>,
        timeoutMs,
      );
      if (result.length > MAX_TOOL_RESULT_LENGTH) {
        return result.slice(0, MAX_TOOL_RESULT_LENGTH) +
          "\n[truncated — result exceeded 1 MB]";
      }
      return result;
    },
    async onConnect(sessionId, timeoutMs) {
      await withTimeout(
        scoped.onConnect(sessionId) as Promise<void>,
        timeoutMs,
      );
    },
    async onDisconnect(sessionId, timeoutMs) {
      await withTimeout(
        scoped.onDisconnect(sessionId) as Promise<void>,
        timeoutMs,
      );
    },
    async onTurn(sessionId, text, timeoutMs) {
      await withTimeout(
        scoped.onTurn(sessionId, text) as Promise<void>,
        timeoutMs,
      );
    },
    async onError(sessionId, error, timeoutMs) {
      await withTimeout(
        scoped.onError(sessionId, error.message) as Promise<void>,
        timeoutMs,
      );
    },
    async onStep(sessionId, step, timeoutMs) {
      await withTimeout(
        scoped.onStep(sessionId, step) as Promise<void>,
        timeoutMs,
      );
    },
    async resolveTurnConfig(sessionId, timeoutMs) {
      const raw = await withTimeout(
        scoped.resolveTurnConfig(sessionId) as Promise<TurnConfig | null>,
        timeoutMs ?? HOOK_TIMEOUT_MS,
      );
      const parsed = TurnConfigSchema.safeParse(raw);
      if (!parsed.success) return null;
      return parsed.data as TurnConfig | null;
    },
    dispose() {
      stub[Symbol.dispose]();
    },
  };
}
