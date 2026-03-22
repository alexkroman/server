// Copyright 2025 the AAI authors. MIT license.
import * as log from "@std/log";
import { HTTPException } from "hono/http-exception";
import type { Context } from "hono";
import type { AppState, Env } from "./context.ts";
import { terminateSandbox } from "./worker_pool.ts";

function restartSandbox(state: AppState, slug: string, reason: string): void {
  const slot = state.slots.get(slug);
  if (slot) {
    log.info(`Restarting sandbox for ${reason}`, { slug });
    terminateSandbox(slot);
  }
}

export async function handleSecretList(c: Context<Env>): Promise<Response> {
  const state = c.get("state");
  const slug = c.get("slug");

  const env = await state.store.getEnv(slug);
  if (!env) {
    throw new HTTPException(404, { message: `Agent ${slug} not found` });
  }

  return c.json({ vars: Object.keys(env) });
}

export async function handleSecretSet(c: Context<Env>): Promise<Response> {
  const state = c.get("state");
  const slug = c.get("slug");
  const updates = c.req.valid("json") as Record<string, string>;

  const existing = await state.store.getEnv(slug) ?? {};
  const merged = { ...existing, ...updates };
  await state.store.putEnv(slug, merged);

  restartSandbox(state, slug, "secret update");
  log.info("Secret updated", { slug, keys: Object.keys(updates) });
  return c.json({ ok: true, keys: Object.keys(merged) });
}

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
