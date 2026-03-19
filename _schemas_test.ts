// Copyright 2025 the AAI authors. MIT license.
import { assertEquals, assertStrictEquals } from "@std/assert";
import {
  AgentMetadataSchema,
  DeployBodySchema,
  EnvSchema,
} from "./_schemas.ts";

Deno.test("DeployBodySchema", async (t) => {
  await t.step("accepts valid deploy body", () => {
    const result = DeployBodySchema.safeParse({
      env: { ASSEMBLYAI_API_KEY: "test" },
      worker: "code",
      clientFiles: { "index.html": "<html></html>" },
    });
    assertStrictEquals(result.success, true);
  });

  await t.step("rejects empty worker", () => {
    const result = DeployBodySchema.safeParse({
      env: {},
      worker: "",
      clientFiles: { "index.html": "<html></html>" },
    });
    assertStrictEquals(result.success, false);
  });
});

Deno.test("EnvSchema", async (t) => {
  await t.step("accepts valid env", () => {
    const result = EnvSchema.safeParse({ ASSEMBLYAI_API_KEY: "key123" });
    assertStrictEquals(result.success, true);
  });

  await t.step("rejects empty ASSEMBLYAI_API_KEY", () => {
    const result = EnvSchema.safeParse({ ASSEMBLYAI_API_KEY: "" });
    assertStrictEquals(result.success, false);
  });

  await t.step("allows extra keys via passthrough", () => {
    const result = EnvSchema.safeParse({
      ASSEMBLYAI_API_KEY: "key",
      CUSTOM: "val",
    });
    assertStrictEquals(result.success, true);
  });
});

Deno.test("AgentMetadataSchema", async (t) => {
  await t.step("accepts minimal metadata", () => {
    const result = AgentMetadataSchema.safeParse({
      slug: "test",
    });
    assertStrictEquals(result.success, true);
    if (result.success) {
      assertEquals(result.data.env, {});
    }
  });

  await t.step("accepts full metadata", () => {
    const result = AgentMetadataSchema.safeParse({
      slug: "my-agent",
      env: { KEY: "val" },
      credential_hashes: ["abc123"],
    });
    assertStrictEquals(result.success, true);
  });

  await t.step("rejects missing slug", () => {
    const result = AgentMetadataSchema.safeParse({ env: {} });
    assertStrictEquals(result.success, false);
  });
});
