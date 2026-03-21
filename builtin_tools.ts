// Copyright 2025 the AAI authors. MIT license.
/**
 * SSRF protection for the fetch proxy.
 *
 * Built-in tool definitions have moved to `@aai/sdk/builtin-tools`.
 * This module retains only the URL validation logic used by the host-side
 * fetch proxy in `sandbox.ts`.
 *
 * @module
 */
import { matchSubnets } from "@std/net/unstable-ip";

const BLOCKED_CIDRS = [
  // IPv4
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.0.0.0/24",
  "192.168.0.0/16",
  "198.18.0.0/15",
  "224.0.0.0/4",
  "240.0.0.0/4",
  // IPv6
  "::1/128",
  "::/128",
  "fc00::/7",
  "fe80::/10",
  "ff00::/8",
];

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
    if (matchSubnets(addr, BLOCKED_CIDRS)) {
      throw new Error(`Blocked request to private address: ${hostname}`);
    }
  }
}
