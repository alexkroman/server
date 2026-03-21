// Copyright 2025 the AAI authors. MIT license.
import * as log from "@std/log";
import { HTTPException } from "hono/http-exception";
import type { Context } from "hono";
import type { AppState, Env } from "./context.ts";
import { SecretUpdatesSchema } from "./_schemas.ts";

function restartSandbox(state: AppState, slug: string, reason: string): void {
  const slot = state.slots.get(slug);
  if (slot?.sandbox) {
    log.info(`Restarting sandbox for ${reason}`, { slug });
    slot.sandbox.terminate();
    delete slot.sandbox;
    delete slot.initializing;
  }
}

/**
 * GET /:slug/secret — list secret names (values masked).
 */
export async function handleSecretList(c: Context<Env>): Promise<Response> {
  const state = c.get("state");
  const slug = c.get("slug");

  const env = await state.store.getEnv(slug);
  if (!env) {
    throw new HTTPException(404, { message: `Agent ${slug} not found` });
  }

  // Return names only — never expose values over the wire
  return c.json({ vars: Object.keys(env) });
}

/**
 * PUT /:slug/secret — set one or more secrets.
 * Body: { "KEY": "value", "KEY2": "value2" }
 */
export async function handleSecretSet(c: Context<Env>): Promise<Response> {
  const state = c.get("state");
  const slug = c.get("slug");

  const parsed = SecretUpdatesSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    throw new HTTPException(400, {
      message: "Body must be a JSON object of string key-value pairs",
    });
  }
  const updates = parsed.data;

  // Merge with existing env
  const existing = await state.store.getEnv(slug) ?? {};
  const merged = { ...existing, ...updates };
  await state.store.putEnv(slug, merged);

  restartSandbox(state, slug, "secret update");
  log.info("Secret updated", { slug, keys: Object.keys(updates) });
  return c.json({ ok: true, keys: Object.keys(merged) });
}

/**
 * DELETE /:slug/secret/:key — remove a single secret.
 */
export async function handleSecretDelete(c: Context<Env>): Promise<Response> {
  const state = c.get("state");
  const slug = c.get("slug");
  const key = c.req.param("key")!;

  const existing = await state.store.getEnv(slug);
  if (!existing) {
    throw new HTTPException(404, { message: `Agent ${slug} not found` });
  }

  delete existing[key];
  await state.store.putEnv(slug, existing);
  restartSandbox(state, slug, "secret delete");
  log.info("Secret deleted", { slug, key });
  return c.json({ ok: true });
}
