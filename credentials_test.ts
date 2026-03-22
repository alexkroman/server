// Copyright 2025 the AAI authors. MIT license.
import {
  assert,
  assertEquals,
  assertNotStrictEquals,
  assertStrictEquals,
  assertThrows,
} from "@std/assert";
import { decryptEnv, deriveCredentialKey, encryptEnv } from "./credentials.ts";

Deno.test("credentials", async (t) => {
  await t.step("encrypt and decrypt round-trip", () => {
    const key = deriveCredentialKey("test-secret");
    const env = { ASSEMBLYAI_API_KEY: "sk-123", MY_SECRET: "hunter2" };
    const jwe = encryptEnv(key, { env, slug: "my-agent" });
    assertStrictEquals(typeof jwe, "string");
    assert(!jwe.includes("sk-123"));
    assertEquals(
      decryptEnv(key, { encrypted: jwe, slug: "my-agent" }),
      env,
    );
  });

  await t.step("different secrets cannot decrypt", () => {
    const key1 = deriveCredentialKey("secret-a");
    const key2 = deriveCredentialKey("secret-b");
    const jwe = encryptEnv(key1, {
      env: { KEY: "val" },
      slug: "my-agent",
    });
    assertThrows(
      () => decryptEnv(key2, { encrypted: jwe, slug: "my-agent" }),
    );
  });

  await t.step("wrong slug cannot decrypt", () => {
    const key = deriveCredentialKey("test-secret");
    const jwe = encryptEnv(key, { env: { KEY: "val" }, slug: "agent-a" });
    assertThrows(
      () => decryptEnv(key, { encrypted: jwe, slug: "agent-b" }),
    );
  });

  await t.step("empty env round-trips", () => {
    const key = deriveCredentialKey("test-secret");
    const jwe = encryptEnv(key, { env: {}, slug: "my-agent" });
    assertEquals(
      decryptEnv(key, { encrypted: jwe, slug: "my-agent" }),
      {},
    );
  });

  await t.step("same input produces different JWEs (unique IVs)", () => {
    const key = deriveCredentialKey("test-secret");
    const env = { KEY: "value" };
    const jwe1 = encryptEnv(key, { env, slug: "my-agent" });
    const jwe2 = encryptEnv(key, { env, slug: "my-agent" });
    assertNotStrictEquals(jwe1, jwe2);
  });
});
