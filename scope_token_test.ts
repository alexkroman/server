// Copyright 2025 the AAI authors. MIT license.
import {
  assertEquals,
  assertNotStrictEquals,
  assertStrictEquals,
} from "@std/assert";
import {
  importScopeKey,
  signScopeToken,
  verifyScopeToken,
} from "./scope_token.ts";

Deno.test("scope tokens", async (t) => {
  await t.step("sign and verify round-trip", async () => {
    const key = await importScopeKey("test-secret");
    const scope = { keyHash: "owner123", slug: "my-agent" };
    const token = await signScopeToken(key, scope);
    assertEquals(await verifyScopeToken(key, token), scope);
  });

  await t.step("verify returns null for tampered token", async () => {
    const key = await importScopeKey("test-secret");
    const scope = { keyHash: "owner123", slug: "my-agent" };
    const token = await signScopeToken(key, scope);
    const tampered = token.slice(0, -2) + "XX";
    assertStrictEquals(await verifyScopeToken(key, tampered), null);
  });

  await t.step("verify returns null for garbage input", async () => {
    const key = await importScopeKey("test-secret");
    assertStrictEquals(await verifyScopeToken(key, "not-base64!!!"), null);
  });

  await t.step("verify returns null for empty string", async () => {
    const key = await importScopeKey("test-secret");
    assertStrictEquals(await verifyScopeToken(key, ""), null);
  });

  await t.step("different secrets produce different tokens", async () => {
    const key1 = await importScopeKey("secret-a");
    const key2 = await importScopeKey("secret-b");
    const scope = { keyHash: "owner", slug: "agent" };
    assertNotStrictEquals(
      await signScopeToken(key1, scope),
      await signScopeToken(key2, scope),
    );
  });

  await t.step("token from different secret fails verification", async () => {
    const key1 = await importScopeKey("secret-a");
    const key2 = await importScopeKey("secret-b");
    const token = await signScopeToken(key1, { keyHash: "o", slug: "s" });
    assertStrictEquals(await verifyScopeToken(key2, token), null);
  });
});
