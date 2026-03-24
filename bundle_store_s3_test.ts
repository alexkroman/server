// Copyright 2025 the AAI authors. MIT license.
// Tests for createBundleStore with a mock S3 client that simulates real
// S3/Tigris behavior (ETags, 304 Not Modified, NoSuchKey).

import { assertEquals, assertStrictEquals } from "@std/assert";
import { S3Client } from "@aws-sdk/client-s3";
import { createBundleStore } from "./bundle_store_tigris.ts";
import { deriveCredentialKey } from "./credentials.ts";

/** In-memory S3 mock that behaves like real S3/Tigris. */
function createMockS3(): S3Client {
  const objects = new Map<string, { body: string; etag: string }>();
  let counter = 0;

  const client = new S3Client({ region: "us-east-1" });

  // Override send to intercept all commands
  client.send = (async (
    command: {
      constructor: { name: string };
      input: Record<string, unknown>;
    },
  ) => {
    const name = command.constructor.name;

    if (name === "PutObjectCommand") {
      const key = command.input.Key as string;
      const body = command.input.Body as string;
      const etag = `"etag-${++counter}"`;
      objects.set(key, { body, etag });
      return { ETag: etag };
    }

    if (name === "GetObjectCommand") {
      const key = command.input.Key as string;
      const ifNoneMatch = command.input.IfNoneMatch as string | undefined;
      const obj = objects.get(key);

      if (!obj) {
        const err = new Error("NoSuchKey");
        err.name = "NoSuchKey";
        // @ts-expect-error: simulate AWS SDK NoSuchKey
        err.$metadata = { httpStatusCode: 404 };
        throw err;
      }

      // Simulate 304 Not Modified — this is how real S3/Tigris responds
      // when the ETag matches. The AWS SDK may throw this as "NotModified"
      // or as "Unknown" depending on the SDK version.
      if (ifNoneMatch && ifNoneMatch === obj.etag) {
        const err = new Error("UnknownError");
        err.name = "Unknown";
        // @ts-expect-error: simulate AWS SDK $metadata for 304
        err.$metadata = { httpStatusCode: 304 };
        throw err;
      }

      return {
        Body: {
          transformToString: () => Promise.resolve(obj.body),
        },
        ETag: obj.etag,
      };
    }

    if (name === "ListObjectsV2Command") {
      const prefix = command.input.Prefix as string;
      const contents: { Key: string }[] = [];
      for (const key of objects.keys()) {
        if (key.startsWith(prefix)) contents.push({ Key: key });
      }
      return { Contents: contents.length > 0 ? contents : undefined };
    }

    if (name === "DeleteObjectsCommand") {
      const toDelete = (command.input.Delete as { Objects: { Key: string }[] })
        .Objects;
      for (const { Key } of toDelete) {
        objects.delete(Key);
      }
      return {};
    }

    throw new Error(`Unexpected S3 command: ${name}`);
  }) as typeof client.send;

  return client;
}

const credentialKey = deriveCredentialKey("test-secret");
const VALID_ENV = { ASSEMBLYAI_API_KEY: "test-key" };

Deno.test("createBundleStore with mock S3", async (t) => {
  await t.step("put + get round-trip through real store", async () => {
    const s3 = createMockS3();
    const store = createBundleStore(s3, {
      bucket: "test",
      credentialKey,
    });

    await store.putAgent({
      slug: "hello",
      env: VALID_ENV,
      worker: "console.log('worker');",
      clientFiles: { "index.html": "<html></html>" },
      credential_hashes: ["hash1"],
    });

    const manifest = await store.getManifest("hello");
    assertEquals(manifest?.slug, "hello");
    assertEquals(manifest?.env, VALID_ENV);
    assertEquals(manifest?.credential_hashes, ["hash1"]);

    assertStrictEquals(
      await store.getWorkerCode("hello"),
      "console.log('worker');",
    );
    assertStrictEquals(
      await store.getClientFile("hello", "index.html"),
      "<html></html>",
    );
  });

  await t.step("handles 304 Not Modified (ETag cache hit)", async () => {
    const s3 = createMockS3();
    const store = createBundleStore(s3, {
      bucket: "test",
      credentialKey,
    });

    await store.putAgent({
      slug: "cached",
      env: VALID_ENV,
      worker: "w",
      clientFiles: { "index.html": "<html></html>" },
      credential_hashes: [],
    });

    // First read populates the ETag cache
    const first = await store.getWorkerCode("cached");
    assertStrictEquals(first, "w");

    // Second read triggers IfNoneMatch → 304, should return cached data
    const second = await store.getWorkerCode("cached");
    assertStrictEquals(second, "w");
  });

  await t.step("missing key returns null", async () => {
    const s3 = createMockS3();
    const store = createBundleStore(s3, {
      bucket: "test",
      credentialKey,
    });

    assertStrictEquals(await store.getManifest("nope"), null);
    assertStrictEquals(await store.getWorkerCode("nope"), null);
    assertStrictEquals(await store.getClientFile("nope", "index.html"), null);
  });

  await t.step("deleteAgent removes all data", async () => {
    const s3 = createMockS3();
    const store = createBundleStore(s3, {
      bucket: "test",
      credentialKey,
    });

    await store.putAgent({
      slug: "gone",
      env: VALID_ENV,
      worker: "w",
      clientFiles: { "index.html": "<html></html>" },
      credential_hashes: [],
    });

    await store.deleteAgent("gone");
    assertStrictEquals(await store.getManifest("gone"), null);
    assertStrictEquals(await store.getWorkerCode("gone"), null);
  });

  await t.step("overwrite replaces existing agent", async () => {
    const s3 = createMockS3();
    const store = createBundleStore(s3, {
      bucket: "test",
      credentialKey,
    });

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
    assertStrictEquals(await store.getWorkerCode("x"), "new");
  });

  await t.step("getEnv + putEnv round-trip", async () => {
    const s3 = createMockS3();
    const store = createBundleStore(s3, {
      bucket: "test",
      credentialKey,
    });

    await store.putAgent({
      slug: "env-test",
      env: VALID_ENV,
      worker: "w",
      clientFiles: {},
      credential_hashes: [],
    });

    const env = await store.getEnv("env-test");
    assertEquals(env, VALID_ENV);

    await store.putEnv("env-test", { ...VALID_ENV, NEW_KEY: "new-val" });
    const updated = await store.getEnv("env-test");
    assertEquals(updated?.NEW_KEY, "new-val");
  });

  await t.step(
    "304 on manifest get still returns cached manifest",
    async () => {
      const s3 = createMockS3();
      const store = createBundleStore(s3, {
        bucket: "test",
        credentialKey,
      });

      await store.putAgent({
        slug: "m304",
        env: VALID_ENV,
        worker: "w",
        clientFiles: {},
        credential_hashes: ["h1"],
      });

      // First read caches
      const first = await store.getManifest("m304");
      assertEquals(first?.slug, "m304");

      // Second read hits 304, should still return data
      const second = await store.getManifest("m304");
      assertEquals(second?.slug, "m304");
    },
  );
});
