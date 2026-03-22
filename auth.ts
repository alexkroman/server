// Copyright 2025 the AAI authors. MIT license.
import { encodeHex } from "@std/encoding/hex";
import type { BundleStore } from "./bundle_store_tigris.ts";

export async function hashApiKey(apiKey: string): Promise<string> {
  return encodeHex(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(apiKey)),
  );
}

export type OwnerResult =
  | { status: "unclaimed"; keyHash: string }
  | { status: "owned"; keyHash: string }
  | { status: "forbidden" };

export async function verifySlugOwner(
  apiKey: string,
  opts: { slug: string; store: BundleStore },
): Promise<OwnerResult> {
  const { slug, store } = opts;
  const keyHash = await hashApiKey(apiKey);
  const manifest = await store.getManifest(slug);

  if (!manifest) {
    return { status: "unclaimed", keyHash };
  }

  if (manifest.credential_hashes.includes(keyHash)) {
    return { status: "owned", keyHash };
  }

  return { status: "forbidden" };
}
