// Copyright 2025 the AAI authors. MIT license.
import { STATUS_CODE } from "@std/http/status";
import { HttpError } from "./context.ts";
import { verifySlugOwner } from "./auth.ts";
import {
  type AgentScope,
  type ScopeKey,
  verifyScopeToken,
} from "./scope_token.ts";
import type { BundleStore } from "./bundle_store_tigris.ts";

const VALID_SLUG_REGEXP = /^[a-z0-9][a-z0-9_-]{0,62}[a-z0-9]$/;

function bearerToken(req: Request): string | null {
  return req.headers.get("Authorization")?.slice(7) || null;
}

/** Validate slug URL param and return it. */
export function validateSlug(slug: string): string {
  if (!VALID_SLUG_REGEXP.test(slug)) {
    throw new HttpError(STATUS_CODE.BadRequest, "Invalid slug");
  }
  return slug;
}

/** Verify the request has a valid owner credential for the slug. Returns the API key hash. */
export async function requireOwner(
  req: Request,
  opts: { slug: string; store: BundleStore },
): Promise<string> {
  const apiKey = bearerToken(req);
  if (!apiKey) {
    throw new HttpError(
      STATUS_CODE.Unauthorized,
      "Missing Authorization header (Bearer <API_KEY>)",
    );
  }
  const result = await verifySlugOwner(apiKey, {
    slug: opts.slug,
    store: opts.store,
  });
  if (result.status === "forbidden") {
    throw new HttpError(
      STATUS_CODE.Forbidden,
      `Slug "${opts.slug}" is owned by another user.`,
    );
  }
  return result.keyHash;
}

/** Require WebSocket upgrade header. */
export function requireUpgrade(req: Request): void {
  if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    throw new HttpError(STATUS_CODE.BadRequest, "Expected WebSocket upgrade");
  }
}

/** Only allow requests from loopback / private addresses (Fly internal network, etc.). */
export function requireInternal(
  req: Request,
  info: Deno.ServeHandlerInfo,
): void {
  const fly = req.headers.get("fly-client-ip");
  const addr = info?.remoteAddr;
  const ip = fly ?? (addr && "hostname" in addr ? addr.hostname : "") ?? "";
  if (!isPrivateIp(ip)) {
    throw new HttpError(STATUS_CODE.Forbidden, "Forbidden");
  }
}

function isPrivateIp(ip: string): boolean {
  if (!ip) return false;
  return (
    ip === "127.0.0.1" ||
    ip === "::1" ||
    ip.startsWith("10.") ||
    ip.startsWith("172.") ||
    ip.startsWith("192.168.") ||
    ip.startsWith("fdaa:") // Fly.io private network
  );
}

/** Verify scope token from Authorization header. Returns the decoded scope. */
export async function requireScopeToken(
  req: Request,
  scopeKey: ScopeKey,
): Promise<AgentScope> {
  const token = bearerToken(req);
  if (!token) {
    throw new HttpError(
      STATUS_CODE.Unauthorized,
      "Missing Authorization header",
    );
  }
  const scope = await verifyScopeToken(scopeKey, token);
  if (!scope) {
    throw new HttpError(
      STATUS_CODE.Forbidden,
      "Invalid or tampered scope token",
    );
  }
  return scope;
}
