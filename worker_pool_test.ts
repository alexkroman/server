// Copyright 2025 the AAI authors. MIT license.
import { assertStrictEquals } from "@std/assert";
import { type AgentSlot, registerSlot } from "./worker_pool.ts";
import { makeConfig, VALID_ENV } from "./_test_utils.ts";

const TEST_CONFIG = makeConfig();

// --- registerSlot ---

Deno.test("registerSlot with valid env", () => {
  const slots = new Map<string, AgentSlot>();
  const ok = registerSlot(slots, {
    slug: "hello",
    env: VALID_ENV,
    transport: ["websocket"],
    credential_hashes: ["hash1"],
    config: TEST_CONFIG,
    toolSchemas: [],
  });
  assertStrictEquals(ok, true);
  assertStrictEquals(slots.has("hello"), true);
});

Deno.test("registerSlot returns false for invalid env", () => {
  const slots = new Map<string, AgentSlot>();
  const ok = registerSlot(slots, {
    slug: "bad",
    env: {},
    transport: ["websocket"],
    credential_hashes: [],
    config: TEST_CONFIG,
    toolSchemas: [],
  });
  assertStrictEquals(ok, false);
  assertStrictEquals(slots.has("bad"), false);
});

Deno.test("registerSlot overwrites existing slot", () => {
  const slots = new Map<string, AgentSlot>();
  registerSlot(slots, {
    slug: "x",
    env: VALID_ENV,
    transport: ["websocket"],
    credential_hashes: ["h"],
    config: TEST_CONFIG,
    toolSchemas: [],
  });
  registerSlot(slots, {
    slug: "x",
    env: VALID_ENV,
    transport: ["websocket"],
    credential_hashes: ["h"],
    config: TEST_CONFIG,
    toolSchemas: [],
  });
  assertStrictEquals(slots.size, 1);
});
