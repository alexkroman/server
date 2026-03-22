// Copyright 2025 the AAI authors. MIT license.
import { encodeHex } from "@std/encoding/hex";
import { matchSubnets } from "@std/net/unstable-ip";
import { HTTPException } from "hono/http-exception";
import {
  type AgentScope,
  type ScopeKey,
  verifyScopeToken,
} from "./scope_token.ts";
import type { BundleStore } from "./bundle_store_tigris.ts";

// deno-fmt-ignore
const PRIVATE_CIDRS = [
  "0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8",
  "169.254.0.0/16", "172.16.0.0/12", "192.0.0.0/24", "192.168.0.0/16",
  "198.18.0.0/15", "224.0.0.0/4", "240.0.0.0/4",
  "::1/128", "::/128", "fc00::/7", "fe80::/10", "ff00::/8",
];

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
  if (!manifest) return { status: "unclaimed", keyHash };
  if (manifest.credential_hashes.includes(keyHash)) return { status: "owned", keyHash };
  return { status: "forbidden" };
}

const VALID_SLUG_REGEXP = /^[a-z0-9][a-z0-9_-]{0,62}[a-z0-9]$/;

function bearerToken(req: Request): string | null {
  const header = req.headers.get("Authorization");
  if (!header?.startsWith("Bearer ")) return null;
  return header.slice(7) || null;
}

export function validateSlug(slug: string): string {
  if (!VALID_SLUG_REGEXP.test(slug)) {
    throw new HTTPException(400, { message: "Invalid slug" });
  }
  return slug;
}

export async function requireOwner(
  req: Request,
  opts: { slug: string; store: BundleStore },
): Promise<string> {
  const apiKey = bearerToken(req);
  if (!apiKey) {
    throw new HTTPException(401, {
      message: "Missing Authorization header (Bearer <API_KEY>)",
    });
  }
  const result = await verifySlugOwner(apiKey, {
    slug: opts.slug,
    store: opts.store,
  });
  if (result.status === "forbidden") {
    throw new HTTPException(403, {
      message: `Slug "${opts.slug}" is owned by another user.`,
    });
  }
  return result.keyHash;
}

export function requireUpgrade(req: Request): void {
  if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    throw new HTTPException(400, { message: "Expected WebSocket upgrade" });
  }
}

export function requireInternal(
  req: Request,
  info: Deno.ServeHandlerInfo,
): void {
  const fly = req.headers.get("fly-client-ip");
  const addr = info?.remoteAddr;
  const ip = fly ?? (addr && "hostname" in addr ? addr.hostname : "") ?? "";
  if (!ip || !matchSubnets(ip, PRIVATE_CIDRS)) {
    throw new HTTPException(403, { message: "Forbidden" });
  }
}

export async function requireScopeToken(
  req: Request,
  scopeKey: ScopeKey,
): Promise<AgentScope> {
  const token = bearerToken(req);
  if (!token) {
    throw new HTTPException(401, {
      message: "Missing Authorization header",
    });
  }
  const scope = await verifyScopeToken(scopeKey, token);
  if (!scope) {
    throw new HTTPException(403, {
      message: "Invalid or tampered scope token",
    });
  }
  return scope;
}
