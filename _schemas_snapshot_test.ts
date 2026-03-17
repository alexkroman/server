// Copyright 2025 the AAI authors. MIT license.
import { assertSnapshot } from "@std/testing/snapshot";
import { z } from "zod";
import {
  AgentConfigSchema,
  DeployBodySchema,
  EnvSchema,
  ToolSchemaSchema,
  TransportSchema,
} from "./_schemas.ts";

Deno.test("TransportSchema snapshot", async (t) => {
  await assertSnapshot(t, z.toJSONSchema(TransportSchema));
});

Deno.test("AgentConfigSchema snapshot", async (t) => {
  await assertSnapshot(t, z.toJSONSchema(AgentConfigSchema));
});

Deno.test("ToolSchemaSchema snapshot", async (t) => {
  await assertSnapshot(t, z.toJSONSchema(ToolSchemaSchema));
});

Deno.test("DeployBodySchema snapshot", async (t) => {
  await assertSnapshot(t, z.toJSONSchema(DeployBodySchema));
});

Deno.test("EnvSchema snapshot", async (t) => {
  await assertSnapshot(t, z.toJSONSchema(EnvSchema));
});
