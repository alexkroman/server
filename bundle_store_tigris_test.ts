// Copyright 2025 the AAI authors. MIT license.
import { assertEquals, assertStrictEquals } from "@std/assert";
import { createTestStore, VALID_ENV } from "./_test_utils.ts";

Deno.test("TigrisBundleStore", async (t) => {
  await t.step("put + get round-trip", async () => {
    using store = createTestStore();
    await store.putAgent({
      slug: "hello",
      env: VALID_ENV,
      worker: "console.log('worker');",
      clientFiles: { "index.html": "<html></html>" },
      credential_hashes: ["hash1"],
    });

    const manifest = await store.getManifest("hello");
    assertEquals(manifest, {
      slug: "hello",
      env: VALID_ENV,
      credential_hashes: ["hash1"],
    });

    const worker = await store.getFile("hello", "worker");
    assertStrictEquals(worker, "console.log('worker');");

    const html = await store.getClientFile("hello", "index.html");
    assertStrictEquals(html, "<html></html>");
  });

  await t.step("deleteAgent removes all data", async () => {
    using store = createTestStore();
    await store.putAgent({
      slug: "gone",
      env: VALID_ENV,
      worker: "w",
      clientFiles: { "index.html": "<html></html>" },
      credential_hashes: [],
    });
    await store.deleteAgent("gone");

    assertStrictEquals(await store.getManifest("gone"), null);
    assertStrictEquals(await store.getFile("gone", "worker"), null);
    assertStrictEquals(await store.getClientFile("gone", "index.html"), null);
  });

  await t.step("overwrite replaces existing agent", async () => {
    using store = createTestStore();
    await store.putAgent({
      slug: "x",
      env: VALID_ENV,
      worker: "old",
      clientFiles: { "index.html": "<html></html>" },
      credential_hashes: [],
    });
    await store.putAgent({
      slug: "x",
      env: { ...VALID_ENV, EXTRA: "val" },
      worker: "new",
      clientFiles: { "index.html": "<html></html>" },
      credential_hashes: [],
    });

    const manifest = await store.getManifest("x");
    assertStrictEquals(manifest!.env.EXTRA, "val");
    assertStrictEquals(await store.getFile("x", "worker"), "new");
  });

  await t.step("handles large strings without chunking", async () => {
    using store = createTestStore();
    const big = "x".repeat(150_000);
    await store.putAgent({
      slug: "big",
      env: VALID_ENV,
      worker: big,
      clientFiles: { "index.html": "<html></html>" },
      credential_hashes: [],
    });

    const result = await store.getFile("big", "worker");
    assertStrictEquals(result, big);
    assertStrictEquals(result!.length, 150_000);
  });

  await t.step("missing slug returns null", async () => {
    using store = createTestStore();
    assertStrictEquals(await store.getManifest("nope"), null);
    assertStrictEquals(await store.getFile("nope", "worker"), null);
    assertStrictEquals(await store.getClientFile("nope", "index.html"), null);
  });
});
