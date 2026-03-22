// Copyright 2025 the AAI authors. MIT license.
import { SignJWT, jwtVerify } from "jose";

export type AgentScope = { keyHash: string; slug: string };
export type ScopeKey = CryptoKey;

const enc = new TextEncoder();

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

export async function signScopeToken(
  key: ScopeKey,
  scope: AgentScope,
): Promise<string> {
  return await new SignJWT({ scope: scope.slug })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(scope.keyHash)
    .sign(key);
}

export async function verifyScopeToken(
  key: ScopeKey,
  token: string,
): Promise<AgentScope | null> {
  try {
    const { payload } = await jwtVerify(token, key, {
      algorithms: ["HS256"],
    });
    const sub = payload.sub;
    const scope = payload.scope;
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
