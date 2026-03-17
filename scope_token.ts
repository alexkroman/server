// Copyright 2025 the AAI authors. MIT license.
/**
 * Scope tokens are HMAC-SHA256 signed JWTs encoding agent ownership.
 * Uses crypto.subtle directly — no external dependencies.
 */

import { decodeBase64Url, encodeBase64Url } from "@std/encoding/base64url";

export type AgentScope = {
  keyHash: string;
  slug: string;
};

/** Opaque key type for scope token operations. */
export type ScopeKey = CryptoKey;

const enc = new TextEncoder();
const dec = new TextDecoder();

export async function importScopeKey(secret: string): Promise<ScopeKey> {
  const ikm = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    "HKDF",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: enc.encode("aai-scope-token"),
      info: enc.encode("scope-signing"),
    },
    ikm,
    256,
  );
  return await crypto.subtle.importKey(
    "raw",
    bits,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

const HEADER = encodeBase64Url(
  enc.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })),
);

export async function signScopeToken(
  key: ScopeKey,
  scope: AgentScope,
): Promise<string> {
  const payload = encodeBase64Url(
    enc.encode(JSON.stringify({ sub: scope.keyHash, scope: scope.slug })),
  );
  const signingInput = `${HEADER}.${payload}`;
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(signingInput));
  return `${signingInput}.${encodeBase64Url(sig)}`;
}

export async function verifyScopeToken(
  key: ScopeKey,
  token: string,
): Promise<AgentScope | null> {
  try {
    const [header, payload, signature, ...rest] = token.split(".");
    if (!header || !payload || !signature || rest.length > 0) return null;
    const signingInput = `${header}.${payload}`;
    const sig = decodeBase64Url(signature);
    const valid = await crypto.subtle.verify(
      "HMAC",
      key,
      sig,
      enc.encode(signingInput),
    );
    if (!valid) return null;

    const claims = JSON.parse(dec.decode(decodeBase64Url(payload)));
    const sub = claims.sub;
    const scope = claims.scope;
    if (
      typeof sub !== "string" || typeof scope !== "string" || !sub || !scope
    ) {
      return null;
    }
    return { keyHash: sub, slug: scope };
  } catch {
    return null;
  }
}
