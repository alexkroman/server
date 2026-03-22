// Copyright 2025 the AAI authors. MIT license.
import { assertEquals, assertStrictEquals, assertThrows } from "@std/assert";
import { HTTPException } from "hono/http-exception";
import {
  requireInternal,
  requireOwner,
  requireScopeToken,
  requireUpgrade,
  validateSlug,
} from "./middleware.ts";
import {
  createTestScopeKey,
  createTestStore,
  DUMMY_INFO,
  VALID_ENV,
} from "./_test_utils.ts";
import { hashApiKey } from "./auth.ts";
import { signScopeToken } from "./scope_token.ts";

function assertHttpException(fn: () => void, status: number): void {
  const err = assertThrows(fn, HTTPException);
  assertStrictEquals(err.status, status);
}

// =============================================================================
// validateSlug
// =============================================================================

Deno.test("validateSlug accepts valid slugs", () => {
  assertStrictEquals(validateSlug("my-agent"), "my-agent");
  assertStrictEquals(validateSlug("agent_1"), "agent_1");
  assertStrictEquals(validateSlug("a1"), "a1");
  assertStrictEquals(validateSlug("hello-world-123"), "hello-world-123");
});

Deno.test("validateSlug rejects invalid slugs", () => {
  const invalid = [
    "A", // uppercase
    "-bad", // starts with hyphen
    "bad-", // ends with hyphen
    "_bad", // starts with underscore
    "bad_", // ends with underscore
    "a", // too short (1 char, need at least 2)
    "has spaces", // spaces
    "UPPER", // all uppercase
    "has.dot", // dots
    "", // empty
  ];
  for (const slug of invalid) {
    assertHttpException(() => validateSlug(slug), 400);
  }
});

// =============================================================================
// requireUpgrade
// =============================================================================

Deno.test("requireUpgrade passes with websocket header", () => {
  requireUpgrade(
    new Request("http://localhost/ws", { headers: { upgrade: "websocket" } }),
  );
});

Deno.test("requireUpgrade throws without upgrade header", () => {
  assertHttpException(
    () => requireUpgrade(new Request("http://localhost/ws")),
    400,
  );
});

Deno.test("requireUpgrade throws for non-websocket upgrade", () => {
  assertHttpException(
    () =>
      requireUpgrade(
        new Request("http://localhost/ws", { headers: { upgrade: "h2c" } }),
      ),
    400,
  );
});

// =============================================================================
// requireInternal
// =============================================================================

Deno.test("requireInternal passes for loopback IP", () => {
  requireInternal(new Request("http://localhost/metrics"), DUMMY_INFO);
});

Deno.test("requireInternal passes for private 10.x IP", () => {
  const info: Deno.ServeHandlerInfo = {
    remoteAddr: { transport: "tcp" as const, hostname: "10.0.0.5", port: 0 },
    completed: Promise.resolve(),
  };
  requireInternal(new Request("http://localhost/metrics"), info);
});

Deno.test("requireInternal passes for Fly.io fdaa: prefix", () => {
  requireInternal(
    new Request("http://localhost/metrics", {
      headers: { "fly-client-ip": "fdaa:0:1::2" },
    }),
    DUMMY_INFO,
  );
});

Deno.test("requireInternal rejects public IP", () => {
  const info: Deno.ServeHandlerInfo = {
    remoteAddr: { transport: "tcp" as const, hostname: "8.8.8.8", port: 0 },
    completed: Promise.resolve(),
  };
  assertHttpException(
    () => requireInternal(new Request("http://localhost/metrics"), info),
    403,
  );
});

// =============================================================================
// requireOwner
// =============================================================================

Deno.test("requireOwner throws 401 without Authorization header", async () => {
  const store = createTestStore();
  try {
    await requireOwner(
      new Request("http://localhost/deploy"),
      { slug: "my-agent", store },
    );
    throw new Error("Expected to throw");
  } catch (err) {
    if (!(err instanceof HTTPException)) throw err;
    assertStrictEquals(err.status, 401);
  }
});

Deno.test("requireOwner returns keyHash for unclaimed slug", async () => {
  const store = createTestStore();
  const req = new Request("http://localhost/deploy", {
    headers: { Authorization: "Bearer key1" },
  });
  const keyHash = await requireOwner(req, { slug: "new-agent", store });
  assertStrictEquals(keyHash, await hashApiKey("key1"));
});

Deno.test("requireOwner throws 403 for wrong owner", async () => {
  const store = createTestStore();
  await store.putAgent({
    slug: "my-agent",
    env: VALID_ENV,
    worker: "w",
    clientFiles: { "index.html": "<html></html>" },
    credential_hashes: [await hashApiKey("key1")],
  });
  try {
    await requireOwner(
      new Request("http://localhost/deploy", {
        headers: { Authorization: "Bearer key2" },
      }),
      { slug: "my-agent", store },
    );
    throw new Error("Expected to throw");
  } catch (err) {
    if (!(err instanceof HTTPException)) throw err;
    assertStrictEquals(err.status, 403);
  }
});

// =============================================================================
// requireScopeToken
// =============================================================================

Deno.test("requireScopeToken throws 401 without header", async () => {
  const scopeKey = await createTestScopeKey();
  try {
    await requireScopeToken(new Request("http://localhost/kv"), scopeKey);
    throw new Error("Expected to throw");
  } catch (err) {
    if (!(err instanceof HTTPException)) throw err;
    assertStrictEquals(err.status, 401);
  }
});

Deno.test("requireScopeToken throws 403 for invalid token", async () => {
  const scopeKey = await createTestScopeKey();
  try {
    await requireScopeToken(
      new Request("http://localhost/kv", {
        headers: { Authorization: "Bearer garbage-token" },
      }),
      scopeKey,
    );
    throw new Error("Expected to throw");
  } catch (err) {
    if (!(err instanceof HTTPException)) throw err;
    assertStrictEquals(err.status, 403);
  }
});

Deno.test("requireScopeToken returns scope for valid token", async () => {
  const scopeKey = await createTestScopeKey();
  const scope = { keyHash: "h", slug: "my-agent" };
  const token = await signScopeToken(scopeKey, scope);
  const req = new Request("http://localhost/kv", {
    headers: { Authorization: `Bearer ${token}` },
  });
  const result = await requireScopeToken(req, scopeKey);
  assertEquals(result, scope);
});
