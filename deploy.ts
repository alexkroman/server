// Copyright 2025 the AAI authors. MIT license.
import * as log from "@std/log";
import { STATUS_CODE } from "@std/http/status";
import { json, type RouteContext } from "./context.ts";
import type { DeployBody } from "@aai/sdk/internal-types";
import { HttpError } from "./context.ts";
import { DeployBodySchema, EnvSchema } from "./_schemas.ts";
import type { AgentSlot } from "./worker_pool.ts";

/**
 * Handler for the agent deploy endpoint (`POST /:slug/deploy`).
 *
 * Env vars are managed separately via the /env endpoints (like `vercel env`).
 * If env is provided in the deploy body, it's merged with any existing
 * stored env. If not provided, the existing stored env is preserved.
 */
export async function handleDeploy(
  ctx: RouteContext,
  opts: { slug: string; keyHash: string },
): Promise<Response> {
  const { state } = ctx;
  const { slug, keyHash } = opts;
  let body: DeployBody;
  try {
    body = DeployBodySchema.parse(await ctx.req.json());
  } catch {
    throw new HttpError(STATUS_CODE.BadRequest, "Invalid deploy body");
  }

  // Merge env: deploy body env takes precedence, then stored env
  const storedEnv = await state.store.getEnv(slug) ?? {};
  const env = body.env ? { ...storedEnv, ...body.env } : storedEnv;

  const envParsed = EnvSchema.safeParse(env);
  if (!envParsed.success) {
    return json(
      { error: `Invalid platform config: ${envParsed.error.message}` },
      { status: STATUS_CODE.BadRequest },
    );
  }

  const existing = state.slots.get(slug);
  if (existing?.sandbox) {
    log.info("Replacing existing deploy", { slug });
    existing.sandbox.terminate();
    delete existing.sandbox;
    delete existing.initializing;
  }

  const transport = body.transport ?? ["websocket"];

  await state.store.putAgent({
    slug,
    env,
    transport,
    worker: body.worker,
    html: body.html,
    credential_hashes: [keyHash],
    config: body.config,
    toolSchemas: body.toolSchemas,
  });

  const slot: AgentSlot = {
    slug,
    transport,
    keyHash,
    config: body.config,
    name: body.config.name,
    toolSchemas: body.toolSchemas,
  };
  state.slots.set(slug, slot);

  log.info("Deploy received", { slug, transport });

  return json({ ok: true, message: `Deployed ${slug}` });
}
