// Copyright 2025 the AAI authors. MIT license.
/**
 * WebSocket session lifecycle handler — thin wrapper injecting Deno logger.
 *
 * @module
 */
import * as log from "@std/log";
import {
  wireSessionSocket as _wireSessionSocket,
  type WsSessionOptions as _WsSessionOptions,
} from "@aai/sdk/ws-handler";
import type { Session } from "@aai/sdk/session";

export type { Session };

/** Options for wiring a WebSocket to a session. */
export type WsSessionOptions = Omit<_WsSessionOptions, "logger">;

const denoLogger = {
  info: (msg: string, ctx?: Record<string, unknown>) => log.info(msg, ctx),
  warn: (msg: string, ctx?: Record<string, unknown>) => log.warn(msg, ctx),
  error: (msg: string, ctx?: Record<string, unknown>) => log.error(msg, ctx),
  debug: (msg: string, ctx?: Record<string, unknown>) => log.debug(msg, ctx),
};

/**
 * Attaches session lifecycle handlers to a native WebSocket.
 *
 * Injects the Deno structured logger.
 */
export function wireSessionSocket(
  ws: WebSocket,
  opts: WsSessionOptions,
): void {
  _wireSessionSocket(ws, { ...opts, logger: denoLogger });
}
