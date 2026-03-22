// Copyright 2025 the AAI authors. MIT license.
import * as log from "@std/log";
import type { Context } from "hono";
import type { Env } from "./context.ts";
import { EnvSchema } from "./_schemas.ts";
import { type AgentSlot, terminateSandbox } from "./worker_pool.ts";

export async function handleDeploy(c: Context<Env>): Promise<Response> {
  const state = c.get("state");
  const slug = c.get("slug");
  const keyHash = c.get("keyHash");
  const body = c.req.valid("json");

  const storedEnv = await state.store.getEnv(slug) ?? {};
  const env = body.env ? { ...storedEnv, ...body.env } : storedEnv;

  const envParsed = EnvSchema.safeParse(env);
  if (!envParsed.success) {
    return c.json(
      { error: `Invalid platform config: ${envParsed.error.message}` },
      400,
    );
  }

  const existing = state.slots.get(slug);
  if (existing) {
    log.info("Replacing existing deploy", { slug });
    terminateSandbox(existing);
  }

  await state.store.putAgent({
    slug,
    env,
    worker: body.worker,
    clientFiles: body.clientFiles,
    credential_hashes: [keyHash],
  });

  const slot: AgentSlot = {
    slug,
    keyHash,
  };
  state.slots.set(slug, slot);

  log.info("Deploy received", { slug });

  return c.json({ ok: true, message: `Deployed ${slug}` });
}
