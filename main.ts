// Copyright 2025 the AAI authors. MIT license.
import * as log from "@std/log";
import { createOrchestrator } from "./orchestrator.ts";
import { createBundleStore, createS3Client } from "./bundle_store_tigris.ts";
import { createKvStore } from "./kv.ts";
import { createVectorStore } from "./vector.ts";
import { importScopeKey } from "./scope_token.ts";
import { deriveCredentialKey } from "./credentials.ts";

try {
  const { load } = await import("@std/dotenv");
  await load({ export: true });
} catch { /* .env not found — fine */ }

function requireEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) {
    log.error(`FATAL: ${name} must be set`);
    Deno.exit(1);
  }
  return value;
}

const isDev = !Deno.env.get("BUCKET_NAME");

let store;
let kvStore;
let vectorStore;
let scopeKey;

if (isDev) {
  log.info("DEV MODE — using in-memory stores (no S3/Redis required)");
  const { createTestStore, createTestKvStore, createTestVectorStore } =
    await import(
      "./_test_utils.ts"
    );
  store = createTestStore();
  kvStore = createTestKvStore();
  vectorStore = createTestVectorStore();
  scopeKey = await importScopeKey("dev-secret");
} else {
  const bucket = requireEnv("BUCKET_NAME");
  const kvSecret = requireEnv("KV_SCOPE_SECRET");
  const credentialKey = await deriveCredentialKey(kvSecret);
  const s3 = createS3Client();
  store = createBundleStore(s3, { bucket, credentialKey });
  kvStore = createKvStore(
    requireEnv("UPSTASH_REDIS_REST_URL"),
    requireEnv("UPSTASH_REDIS_REST_TOKEN"),
  );
  // Fly sets VECTOR_ENDPOINT/VECTOR_TOKEN via `fly ext vector create`
  let vectorUrl = Deno.env.get("UPSTASH_VECTOR_REST_URL") ??
    Deno.env.get("VECTOR_ENDPOINT");
  const vectorToken = Deno.env.get("UPSTASH_VECTOR_REST_TOKEN") ??
    Deno.env.get("VECTOR_TOKEN");
  if (vectorUrl && vectorToken) {
    // Fly's VECTOR_ENDPOINT omits the scheme — add http:// (Fly private network)
    if (!vectorUrl.startsWith("http")) {
      vectorUrl = `http://${vectorUrl}`;
    }
    vectorStore = createVectorStore(vectorUrl, vectorToken);
  }
  scopeKey = await importScopeKey(kvSecret);
}

const handler = createOrchestrator({ store, kvStore, vectorStore, scopeKey });

const port = parseInt(Deno.env.get("PORT") ?? "3100");
const abort = new AbortController();
Deno.addSignalListener("SIGTERM", () => {
  log.info("SIGTERM received — draining connections...");
  abort.abort();
});

const server = Deno.serve(
  { port, hostname: "0.0.0.0", signal: abort.signal, onListen: () => {} },
  handler,
);

log.info(`http://localhost:${port}`);

await server.finished;
log.info("Shutdown complete");
