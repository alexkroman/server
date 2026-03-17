// Copyright 2025 the AAI authors. MIT license.
import { assertEquals, assertMatch, assertNotEquals } from "@std/assert";
import { hashApiKey } from "./auth.ts";

Deno.test("hashApiKey produces consistent hex output", async () => {
  const hash1 = await hashApiKey("test-key");
  const hash2 = await hashApiKey("test-key");
  assertEquals(hash1, hash2);
  assertMatch(hash1, /^[0-9a-f]{64}$/);
  assertNotEquals(await hashApiKey("other-key"), hash1);
});
