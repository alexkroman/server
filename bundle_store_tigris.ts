// Copyright 2025 the AAI authors. MIT license.
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import type { AgentMetadata } from "./worker_pool.ts";
import { AgentMetadataSchema } from "./_schemas.ts";
import { type CredentialKey, decryptEnv, encryptEnv } from "./credentials.ts";
import { typeByExtension } from "@std/media-types";

export type FileKey = "worker" | "html";

export type BundleStore = {
  putAgent(bundle: {
    slug: string;
    env: Record<string, string>;
    worker: string;
    clientFiles: Record<string, string>;
    credential_hashes: string[];
  }): Promise<void>;
  getManifest(slug: string): Promise<AgentMetadata | null>;
  getFile(slug: string, file: FileKey): Promise<string | null>;
  /** Get a client build file by relative path (e.g. "index.html", "assets/index-abc.js"). */
  getClientFile(slug: string, filePath: string): Promise<string | null>;
  deleteAgent(slug: string): Promise<void>;
  /** Read env vars for a slug from the stored manifest. */
  getEnv(slug: string): Promise<Record<string, string> | null>;
  /** Update env vars for a slug without redeploying the worker. */
  putEnv(slug: string, env: Record<string, string>): Promise<void>;
};

type CacheEntry = {
  data: string;
  etag: string;
};

const FILE_NAMES: Record<FileKey, string> = {
  worker: "worker.js",
  html: "index.html",
};

function objectKey(slug: string, file: string): string {
  return `agents/${slug}/${file}`;
}

export function createS3Client(): S3Client {
  const endpoint = Deno.env.get("AWS_ENDPOINT_URL_S3");
  return new S3Client({
    region: "auto",
    ...(endpoint ? { endpoint } : {}),
    credentials: {
      accessKeyId: Deno.env.get("AWS_ACCESS_KEY_ID") ?? "",
      secretAccessKey: Deno.env.get("AWS_SECRET_ACCESS_KEY") ?? "",
    },
  });
}

function isS3Error(err: unknown, codeOrStatus: string): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as Record<string, unknown>;
  return (
    e.name === codeOrStatus ||
    e.Code === codeOrStatus ||
    String(
        e.$metadata && (e.$metadata as Record<string, unknown>).httpStatusCode,
      ) === codeOrStatus
  );
}

export function createBundleStore(
  s3: S3Client,
  opts: { bucket: string; credentialKey: CredentialKey },
): BundleStore {
  const { bucket, credentialKey } = opts;
  const cache = new Map<string, CacheEntry>();

  async function put(
    key: string,
    body: string,
    contentType: string,
  ): Promise<void> {
    const result = await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );

    if (result.ETag) {
      cache.set(key, { data: body, etag: result.ETag });
    }
  }

  async function get(key: string): Promise<string | null> {
    const cached = cache.get(key);

    try {
      const result = await s3.send(
        new GetObjectCommand({
          Bucket: bucket,
          Key: key,
          ...(cached ? { IfNoneMatch: cached.etag } : {}),
        }),
      );

      const data = await result.Body!.transformToString();
      if (result.ETag) {
        cache.set(key, { data, etag: result.ETag });
      }
      return data;
    } catch (err: unknown) {
      if (isS3Error(err, "304") || isS3Error(err, "NotModified")) {
        return cached!.data;
      }
      if (isS3Error(err, "NoSuchKey") || isS3Error(err, "404")) {
        return null;
      }
      throw err;
    }
  }

  async function deleteAgent(slug: string): Promise<void> {
    const prefix = `agents/${slug}/`;
    const listed = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
      }),
    );

    const objects = listed.Contents;
    if (!objects || objects.length === 0) return;

    await s3.send(
      new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: {
          Objects: objects.map((o) => ({ Key: o.Key })),
        },
      }),
    );

    for (const o of objects) {
      if (o.Key) cache.delete(o.Key);
    }
  }

  const store: BundleStore = {
    async putAgent(bundle) {
      await deleteAgent(bundle.slug);

      const manifest = {
        slug: bundle.slug,
        env: await encryptEnv(credentialKey, {
          env: bundle.env,
          slug: bundle.slug,
        }),
        "credential_hashes": bundle.credential_hashes,
        envEncrypted: true,
      };
      await put(
        objectKey(bundle.slug, "manifest.json"),
        JSON.stringify(manifest),
        "application/json",
      );

      await put(
        objectKey(bundle.slug, "worker.js"),
        bundle.worker,
        "application/javascript",
      );

      // Store client build files under agents/{slug}/client/
      await Promise.all(
        Object.entries(bundle.clientFiles).map(([filePath, content]) => {
          const ext = filePath.split(".").pop() ?? "";
          const contentType = typeByExtension(ext) ??
            "application/octet-stream";
          return put(
            objectKey(bundle.slug, `client/${filePath}`),
            content,
            contentType,
          );
        }),
      );
    },

    async getManifest(slug) {
      const data = await get(objectKey(slug, "manifest.json"));
      if (data === null) return null;
      const raw = JSON.parse(data);

      raw.env = await decryptEnv(credentialKey, { encrypted: raw.env, slug });
      delete raw.envEncrypted;

      const parsed = AgentMetadataSchema.safeParse(raw);
      if (!parsed.success) return null;
      return parsed.data as AgentMetadata;
    },

    async getFile(slug, file) {
      const fileName = FILE_NAMES[file];
      return await get(objectKey(slug, fileName));
    },

    async getClientFile(slug, filePath) {
      return await get(objectKey(slug, `client/${filePath}`));
    },

    deleteAgent,

    async getEnv(slug) {
      const data = await get(objectKey(slug, "manifest.json"));
      if (data === null) return null;
      const raw = JSON.parse(data);
      return await decryptEnv(credentialKey, { encrypted: raw.env, slug });
    },

    async putEnv(slug, env) {
      const data = await get(objectKey(slug, "manifest.json"));
      if (data === null) throw new Error(`Agent ${slug} not found`);
      const raw = JSON.parse(data);
      raw.env = await encryptEnv(credentialKey, { env, slug });
      raw.envEncrypted = true;
      await put(
        objectKey(slug, "manifest.json"),
        JSON.stringify(raw),
        "application/json",
      );
    },
  };

  return store;
}
