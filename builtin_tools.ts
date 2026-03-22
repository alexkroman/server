// Copyright 2025 the AAI authors. MIT license.
/**
 * SSRF protection for the fetch proxy.
 *
 * Built-in tool definitions have moved to `@aai/sdk/builtin-tools`.
 * This module retains only the URL validation logic used by the host-side
 * fetch proxy in `worker_pool.ts`.
 *
 * @module
 */
import { isPrivateIp } from "./private_ip.ts";

/**
 * Validates that a URL resolves to a public (non-private) IP address.
 *
 * Used as an SSRF guard for the fetch proxy. Resolves the hostname via DNS
 * and checks all addresses against blocked CIDR ranges (private, loopback,
 * link-local, multicast).
 *
 * @param url - The URL to validate.
 * @throws If the URL's hostname resolves to a private or blocked IP address.
 */
export async function assertPublicUrl(url: string): Promise<void> {
  const parsed = new URL(url);
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "");
  const { resolve } = await import("node:dns/promises");
  const addresses = await resolve(hostname).catch(() => [hostname]);
  for (const addr of addresses) {
    if (isPrivateIp(addr)) {
      throw new Error(`Blocked request to private address: ${hostname}`);
    }
  }
}
