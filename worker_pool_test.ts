// Copyright 2025 the AAI authors. MIT license.
import { assertStrictEquals } from "@std/assert";
import { type AgentSlot, registerSlot } from "./worker_pool.ts";
import { VALID_ENV } from "./_test_utils.ts";

// --- registerSlot ---

Deno.test("registerSlot with valid env", () => {
  const slots = new Map<string, AgentSlot>();
  const ok = registerSlot(slots, {
    slug: "hello",
    env: VALID_ENV,
    credential_hashes: ["hash1"],
  });
  assertStrictEquals(ok, true);
  assertStrictEquals(slots.has("hello"), true);
});

Deno.test("registerSlot returns false for invalid env", () => {
  const slots = new Map<string, AgentSlot>();
  const ok = registerSlot(slots, {
    slug: "bad",
    env: {},
    credential_hashes: [],
  });
  assertStrictEquals(ok, false);
  assertStrictEquals(slots.has("bad"), false);
});

Deno.test("registerSlot overwrites existing slot", () => {
  const slots = new Map<string, AgentSlot>();
  registerSlot(slots, {
    slug: "x",
    env: VALID_ENV,
    credential_hashes: ["h"],
  });
  registerSlot(slots, {
    slug: "x",
    env: VALID_ENV,
    credential_hashes: ["h"],
  });
  assertStrictEquals(slots.size, 1);
});
