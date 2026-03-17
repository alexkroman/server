// Copyright 2025 the AAI authors. MIT license.
/**
 * WebSocket session lifecycle handler — thin wrapper injecting Deno logger.
 *
 * @module
 */
import {
  type SessionWebSocket,
  wireSessionSocket as _wireSessionSocket,
  type WsSessionOptions as _WsSessionOptions,
} from "@aai/sdk/ws-handler";
import type { Session } from "@aai/sdk/session";
import { denoLogger } from "./logger.ts";

export type { Session, SessionWebSocket };

/** Options for wiring a WebSocket to a session. */
export type WsSessionOptions = Omit<_WsSessionOptions, "logger">;

/**
 * Attaches session lifecycle handlers to a WebSocket.
 *
 * Injects the Deno structured logger.
 */
export function wireSessionSocket(
  ws: SessionWebSocket,
  opts: WsSessionOptions,
): void {
  _wireSessionSocket(ws, { ...opts, logger: denoLogger });
}
