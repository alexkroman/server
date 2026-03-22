// Copyright 2025 the AAI authors. MIT license.
import { SignJWT, jwtVerify } from "jose";

export type AgentScope = { keyHash: string; slug: string };
export type ScopeKey = Uint8Array;

/** Encode a secret string as a signing key for scope tokens. */
export function importScopeKey(secret: string): ScopeKey {
  return new TextEncoder().encode(secret);
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
