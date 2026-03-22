// Copyright 2025 the AAI authors. MIT license.
import * as log from "@std/log";
import { HTTPException } from "hono/http-exception";
import type { Context } from "hono";
import type { Env } from "./context.ts";

export async function handleVector(c: Context<Env>): Promise<Response> {
  const { vectorStore } = c.get("state");
  const scope = { keyHash: c.get("keyHash"), slug: c.get("slug") };

  if (!vectorStore) {
    throw new HTTPException(503, {
      message: "Vector store not configured",
    });
  }

  const msg = c.req.valid("json");

  try {
    switch (msg.op) {
      case "upsert":
        await vectorStore.upsert(scope, msg.id, msg.data, msg.metadata);
        return c.json({ result: "OK" });
      case "query":
        return c.json({
          result: await vectorStore.query(
            scope,
            msg.text,
            msg.topK,
            msg.filter,
          ),
        });
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.error("Vector operation failed", {
      op: msg.op,
      slug: scope.slug,
      error: message,
    });
    return c.json({ error: `Vector operation failed: ${message}` }, 500);
  }
}
