// Copyright 2025 the AAI authors. MIT license.
import { assertEquals, assertNotEquals } from "@std/assert";
import type { AgentScope } from "./scope_token.ts";
import {
  importScopeKey,
  signScopeToken,
  verifyScopeToken,
} from "./scope_token.ts";

Deno.test("scope tokens", async (t) => {
  const scope: AgentScope = { keyHash: "abc123", slug: "my-agent" };

  await t.step("round-trips a scope", async () => {
    const key = await importScopeKey("test-secret");
    const token = await signScopeToken(key, scope);
    assertEquals(await verifyScopeToken(key, token), scope);
  });

  await t.step("rejects tampered token", async () => {
    const key = await importScopeKey("test-secret");
    const token = await signScopeToken(key, scope);
    const mid = Math.floor(token.length / 2);
    const tampered = token.slice(0, mid) +
      (token[mid] === "A" ? "B" : "A") +
      token.slice(mid + 1);
    assertEquals(await verifyScopeToken(key, tampered), null);
  });

  await t.step("rejects garbage", async () => {
    const key = await importScopeKey("test-secret");
    assertEquals(await verifyScopeToken(key, "not-a-token"), null);
    assertEquals(await verifyScopeToken(key, ""), null);
  });

  await t.step("different scopes produce different tokens", async () => {
    const key = await importScopeKey("test-secret");
    const other: AgentScope = { keyHash: "abc123", slug: "other-agent" };
    assertNotEquals(
      await signScopeToken(key, scope),
      await signScopeToken(key, other),
    );
  });

  await t.step("wrong key rejects token", async () => {
    const key1 = await importScopeKey("key-one");
    const key2 = await importScopeKey("key-two");
    const token = await signScopeToken(key1, scope);
    assertEquals(await verifyScopeToken(key2, token), null);
  });
});
