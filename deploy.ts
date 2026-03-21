// Copyright 2025 the AAI authors. MIT license.
import * as log from "@std/log";
import { HTTPException } from "hono/http-exception";
import type { Context } from "hono";
import type { Env } from "./context.ts";
import { type DeployBody, DeployBodySchema, EnvSchema } from "./_schemas.ts";
import type { AgentSlot } from "./worker_pool.ts";

/**
 * Handler for the agent deploy endpoint (`POST /:slug/deploy`).
 *
 * Env vars are managed separately via the /env endpoints (like `vercel env`).
 * If env is provided in the deploy body, it's merged with any existing
 * stored env. If not provided, the existing stored env is preserved.
 */
export async function handleDeploy(c: Context<Env>): Promise<Response> {
  const state = c.get("state");
  const slug = c.get("slug");
  const keyHash = c.get("keyHash");

  let body: DeployBody;
  try {
    body = DeployBodySchema.parse(await c.req.json());
  } catch {
    throw new HTTPException(400, { message: "Invalid deploy body" });
  }

  // Merge env: deploy body env takes precedence, then stored env
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
  if (existing?.sandbox) {
    log.info("Replacing existing deploy", { slug });
    existing.sandbox.terminate();
    delete existing.sandbox;
    delete existing.initializing;
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
