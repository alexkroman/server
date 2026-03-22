// Copyright 2025 the AAI authors. MIT license.
import { decodeBase64Url, encodeBase64Url } from "@std/encoding/base64url";
import { gcm } from "@noble/ciphers/aes";
import { managedNonce } from "@noble/ciphers/webcrypto";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha2";

const enc = new TextEncoder();
const dec = new TextDecoder();

export type CredentialKey = Uint8Array;

export function deriveCredentialKey(secret: string): CredentialKey {
  return hkdf(
    sha256,
    enc.encode(secret),
    enc.encode("aai-credentials"),
    enc.encode("env-encryption"),
    32,
  );
}

export function encryptEnv(
  key: CredentialKey,
  opts: { env: Record<string, string>; slug: string },
): string {
  const aad = enc.encode(opts.slug);
  const plaintext = enc.encode(JSON.stringify(opts.env));
  return encodeBase64Url(managedNonce(gcm)(key, aad).encrypt(plaintext));
}

export function decryptEnv(
  key: CredentialKey,
  opts: { encrypted: string; slug: string },
): Record<string, string> {
  const aad = enc.encode(opts.slug);
  return JSON.parse(
    dec.decode(
      managedNonce(gcm)(key, aad).decrypt(decodeBase64Url(opts.encrypted)),
    ),
  );
}
