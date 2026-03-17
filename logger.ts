// Copyright 2025 the AAI authors. MIT license.
/** Deno-specific logger adapter for `@aai/sdk/runtime` Logger interface. */
import * as log from "@std/log";
import type { Logger } from "@aai/sdk/runtime";

export const denoLogger: Logger = {
  info: (msg: string, ctx?: Record<string, unknown>) => log.info(msg, ctx),
  warn: (msg: string, ctx?: Record<string, unknown>) => log.warn(msg, ctx),
  error: (msg: string, ctx?: Record<string, unknown>) => log.error(msg, ctx),
  debug: (msg: string, ctx?: Record<string, unknown>) => log.debug(msg, ctx),
};
