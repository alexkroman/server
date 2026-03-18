// Copyright 2025 the AAI authors. MIT license.
import { assertSnapshot } from "@std/testing/snapshot";
import { z } from "zod";
import { DeployBodySchema, EnvSchema } from "./_schemas.ts";

Deno.test("DeployBodySchema snapshot", async (t) => {
  await assertSnapshot(t, z.toJSONSchema(DeployBodySchema));
});

Deno.test("EnvSchema snapshot", async (t) => {
  await assertSnapshot(t, z.toJSONSchema(EnvSchema));
});
