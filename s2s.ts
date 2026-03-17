// Copyright 2025 the AAI authors. MIT license.
/**
 * Speech-to-Speech WebSocket client — thin wrapper injecting Deno logger
 * and the `ws` npm package.
 *
 * @module
 */
import * as log from "@std/log";
import type { S2SConfig } from "./types.ts";
import WebSocket from "ws";
import {
  connectS2s as _connectS2s,
  type ConnectS2sOptions,
  type S2sHandle,
  type S2sSessionConfig,
  type S2sToolCall,
  type S2sToolSchema,
  type S2sWebSocket,
} from "@aai/sdk/s2s";

export type {
  ConnectS2sOptions,
  S2sHandle,
  S2sSessionConfig,
  S2sToolCall,
  S2sToolSchema,
};

const denoLogger = {
  info: (msg: string, ctx?: Record<string, unknown>) => log.info(msg, ctx),
  warn: (msg: string, ctx?: Record<string, unknown>) => log.warn(msg, ctx),
  error: (msg: string, ctx?: Record<string, unknown>) => log.error(msg, ctx),
  debug: (msg: string, ctx?: Record<string, unknown>) => log.debug(msg, ctx),
};

/** Create a `ws`-backed WebSocket factory for the S2S client. */
export function createWsFactory() {
  return (url: string, opts: { headers: Record<string, string> }) =>
    new WebSocket(url, { headers: opts.headers }) as unknown as S2sWebSocket;
}

/**
 * Connect to AssemblyAI's Speech-to-Speech WebSocket API.
 *
 * Backward-compatible wrapper that injects the Deno logger and `ws` package.
 */
export function connectS2s(
  apiKey: string,
  config: S2SConfig,
): Promise<S2sHandle> {
  return _connectS2s({
    apiKey,
    config,
    createWebSocket: createWsFactory(),
    logger: denoLogger,
  });
}
