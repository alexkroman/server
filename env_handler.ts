// Copyright 2025 the AAI authors. MIT license.
import * as log from "@std/log";
import { STATUS_CODE } from "@std/http/status";
import { json, type RouteContext } from "./context.ts";
import { HttpError } from "./context.ts";

/**
 * GET /:slug/env — list env var names (values masked).
 */
export async function handleEnvList(
  ctx: RouteContext,
  slug: string,
): Promise<Response> {
  const env = await ctx.state.store.getEnv(slug);
  if (!env) {
    throw new HttpError(STATUS_CODE.NotFound, `Agent ${slug} not found`);
  }

  // Return names only — never expose values over the wire
  return json({ vars: Object.keys(env) });
}

/**
 * PUT /:slug/env — set one or more env vars.
 * Body: { "KEY": "value", "KEY2": "value2" }
 */
export async function handleEnvSet(
  ctx: RouteContext,
  slug: string,
): Promise<Response> {
  const updates = await ctx.req.json();
  if (
    typeof updates !== "object" || updates === null || Array.isArray(updates)
  ) {
    throw new HttpError(
      STATUS_CODE.BadRequest,
      "Body must be a JSON object of key-value pairs",
    );
  }

  for (const [k, v] of Object.entries(updates)) {
    if (typeof v !== "string") {
      throw new HttpError(
        STATUS_CODE.BadRequest,
        `Value for "${k}" must be a string`,
      );
    }
  }

  // Merge with existing env
  const existing = await ctx.state.store.getEnv(slug) ?? {};
  const merged = { ...existing, ...updates };
  await ctx.state.store.putEnv(slug, merged);

  // Terminate worker so it restarts with fresh env from store
  const slot = ctx.state.slots.get(slug);
  if (slot?.worker) {
    log.info("Restarting worker for env update", { slug });
    slot.worker.handle.terminate();
    delete slot.worker;
    delete slot.initializing;
  }

  log.info("Env updated", { slug, keys: Object.keys(updates) });
  return json({ ok: true, keys: Object.keys(merged) });
}

/**
 * DELETE /:slug/env/:key — remove a single env var.
 */
export async function handleEnvDelete(
  ctx: RouteContext,
  opts: { slug: string; key: string },
): Promise<Response> {
  const { slug, key } = opts;
  const existing = await ctx.state.store.getEnv(slug);
  if (!existing) {
    throw new HttpError(STATUS_CODE.NotFound, `Agent ${slug} not found`);
  }

  delete existing[key];
  await ctx.state.store.putEnv(slug, existing);

  // Terminate worker so it restarts with fresh env from store
  const slot = ctx.state.slots.get(slug);
  if (slot?.worker) {
    log.info("Restarting worker for env delete", { slug });
    slot.worker.handle.terminate();
    delete slot.worker;
    delete slot.initializing;
  }

  log.info("Env var deleted", { slug, key });
  return json({ ok: true });
}
