// Copyright 2025 the AAI authors. MIT license.
/**
 * WebSocket factory for the S2S client — wraps the `ws` npm package.
 *
 * @module
 */
import WebSocket from "ws";
import type { S2sWebSocket } from "@aai/sdk/s2s";

/** Create a `ws`-backed WebSocket factory for the S2S client. */
export function createWsFactory() {
  return (url: string, opts: { headers: Record<string, string> }) =>
    new WebSocket(url, { headers: opts.headers }) as unknown as S2sWebSocket;
}
