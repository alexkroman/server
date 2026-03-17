// Copyright 2025 the AAI authors. MIT license.
import * as log from "@std/log";
import { STATUS_CODE } from "@std/http/status";
import { HttpError, json, type RouteContext } from "./context.ts";
import { type KvHttpRequest, KvHttpRequestSchema } from "./_schemas.ts";
import type { AgentScope } from "./scope_token.ts";

/**
 * Handler for the KV operations endpoint (`POST /:slug/kv`).
 *
 * Dispatches `get`, `set`, `del`, `keys`, and `list` operations to the
 * KV store, scoped to the requesting agent.
 */
export async function handleKv(
  ctx: RouteContext,
  scope: AgentScope,
): Promise<Response> {
  const { kvStore } = ctx.state;
  let msg: KvHttpRequest;
  try {
    msg = KvHttpRequestSchema.parse(await ctx.req.json());
  } catch {
    throw new HttpError(STATUS_CODE.BadRequest, "Invalid request");
  }

  try {
    switch (msg.op) {
      case "get":
        return json({ result: await kvStore.get(scope, msg.key) });
      case "set":
        await kvStore.set(scope, msg.key, msg.value, msg.ttl);
        return json({ result: "OK" });
      case "del":
        await kvStore.del(scope, msg.key);
        return json({ result: "OK" });
      case "keys":
        return json({ result: await kvStore.keys(scope, msg.pattern) });
      case "list":
        return json({
          result: await kvStore.list(scope, msg.prefix, {
            ...(msg.limit !== undefined && { limit: msg.limit }),
            ...(msg.reverse !== undefined && { reverse: msg.reverse }),
          }),
        });
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.error("KV operation failed", {
      op: msg.op,
      slug: scope.slug,
      error: message,
    });
    return json({ error: `KV operation failed: ${message}` }, {
      status: STATUS_CODE.InternalServerError,
    });
  }
}
