// Copyright 2025 the AAI authors. MIT license.
import * as log from "@std/log";
import type { Context } from "hono";
import type { Env } from "./context.ts";
import { type DeployBody, DeployBodySchema, EnvSchema } from "./_schemas.ts";

export async function handleDeploy(c: Context<Env>): Promise<Response> {
  const slug = c.get("slug");
  const keyHash = c.get("keyHash");

  let body: DeployBody;
  try {
    body = DeployBodySchema.parse(await c.req.json());
  } catch {
    return c.json({ error: "Invalid deploy body" }, 400);
  }

  // Merge env: deploy body env takes precedence, then stored env
  const storedEnv = await c.env.deployStore.getEnv(slug) ?? {};
  const env = body.env ? { ...storedEnv, ...body.env } : storedEnv;

  const envParsed = EnvSchema.safeParse(env);
  if (!envParsed.success) {
    return c.json(
      { error: `Invalid platform config: ${envParsed.error.message}` },
      400,
    );
  }

  const existing = c.env.slots.get(slug);
  if (existing?.sandbox || existing?.initializing) {
    log.info("Replacing existing deploy", { slug });
    if (existing.sandbox) {
      existing.sandbox.terminate();
    } else if (existing.initializing) {
      // Sandbox is still spinning up — wait for it then terminate
      existing.initializing.then((sb) => sb.terminate()).catch(() => {});
    }
    delete existing.sandbox;
    delete existing.initializing;
  }

  await c.env.deployStore.putAgent({
    slug,
    env,
    worker: body.worker,
    clientFiles: body.clientFiles,
    credential_hashes: [keyHash],
  });

  c.env.slots.set(slug, { slug, keyHash });

  log.info("Deploy received", { slug });

  return c.json({ ok: true, message: `Deployed ${slug}` });
}
