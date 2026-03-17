// Copyright 2025 the AAI authors. MIT license.
import * as log from "@std/log";
import { STATUS_CODE } from "@std/http/status";
import { HttpError, json, type RouteContext } from "./context.ts";
import { VectorHttpRequestSchema } from "./_schemas.ts";
import type { AgentScope } from "./scope_token.ts";

/**
 * Handler for the vector operations endpoint (`POST /:slug/vector`).
 *
 * Dispatches `upsert` and `query` operations to the vector store,
 * scoped to the requesting agent. Used by `aai rag` to populate
 * the vector store and by external clients to query it.
 */
export async function handleVector(
  ctx: RouteContext,
  scope: AgentScope,
): Promise<Response> {
  const { vectorStore } = ctx.state;
  if (!vectorStore) {
    throw new HttpError(
      STATUS_CODE.ServiceUnavailable,
      "Vector store not configured",
    );
  }

  let msg: ReturnType<typeof VectorHttpRequestSchema.parse>;
  try {
    msg = VectorHttpRequestSchema.parse(await ctx.req.json());
  } catch {
    throw new HttpError(STATUS_CODE.BadRequest, "Invalid request");
  }

  try {
    switch (msg.op) {
      case "upsert":
        await vectorStore.upsert(scope, msg.id, msg.data, msg.metadata);
        return json({ result: "OK" });
      case "query":
        return json({
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
    return json({ error: `Vector operation failed: ${message}` }, {
      status: STATUS_CODE.InternalServerError,
    });
  }
}
