// Copyright 2025 the AAI authors. MIT license.
/**
 * Encrypts and decrypts agent env vars at rest using AES-256-GCM.
 * The encryption key is derived from KV_SCOPE_SECRET via HKDF.
 */

import { decodeBase64Url, encodeBase64Url } from "@std/encoding/base64url";
import { decryptAesGcm, encryptAesGcm } from "./_aes_gcm.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Opaque type for the credential encryption key. */
export type CredentialKey = CryptoKey;

/** Derive a 256-bit AES-GCM key from the scope secret via HKDF-SHA256. */
export async function deriveCredentialKey(
  secret: string,
): Promise<CredentialKey> {
  const ikm = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    "HKDF",
    false,
    ["deriveKey"],
  );
  return await crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: enc.encode("aai-credentials"),
      info: enc.encode("env-encryption"),
    },
    ikm,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** Encrypt an env record. Returns base64url(nonce ‖ ciphertext ‖ tag). */
export async function encryptEnv(
  key: CredentialKey,
  opts: { env: Record<string, string>; slug: string },
): Promise<string> {
  return encodeBase64Url(
    await encryptAesGcm(key, enc.encode(JSON.stringify(opts.env)), {
      additionalData: enc.encode(opts.slug),
    }),
  );
}

/** Decrypt a base64url blob back into an env record. */
export async function decryptEnv(
  key: CredentialKey,
  opts: { encrypted: string; slug: string },
): Promise<Record<string, string>> {
  return JSON.parse(
    dec.decode(
      await decryptAesGcm(key, decodeBase64Url(opts.encrypted), {
        additionalData: enc.encode(opts.slug),
      }),
    ),
  );
}
