// Copyright 2025 the AAI authors. MIT license.
import * as log from "@std/log";
import { HTTPException } from "hono/http-exception";
import type { Context } from "hono";
import type { Env } from "./context.ts";
import { type KvHttpRequest, KvHttpRequestSchema } from "./_schemas.ts";

export async function handleKv(c: Context<Env>): Promise<Response> {
  const { kvStore } = c.get("state");
  const scope = c.get("scope");

  let msg: KvHttpRequest;
  try {
    msg = KvHttpRequestSchema.parse(await c.req.json());
  } catch {
    throw new HTTPException(400, { message: "Invalid request" });
  }

  try {
    switch (msg.op) {
      case "get":
        return c.json({ result: await kvStore.get(scope, msg.key) });
      case "set":
        await kvStore.set(scope, msg.key, msg.value, msg.ttl);
        return c.json({ result: "OK" });
      case "del":
        await kvStore.del(scope, msg.key);
        return c.json({ result: "OK" });
      case "keys":
        return c.json({ result: await kvStore.keys(scope, msg.pattern) });
      case "list":
        return c.json({
          result: await kvStore.list(scope, msg.prefix, {
            limit: msg.limit,
            reverse: msg.reverse,
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
    return c.json({ error: `KV operation failed: ${message}` }, 500);
  }
}
