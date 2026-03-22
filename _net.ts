// Copyright 2025 the AAI authors. MIT license.
import { resolve } from "node:dns/promises";
import { matchSubnets } from "@std/net/unstable-ip";

// deno-fmt-ignore
const PRIVATE_CIDRS = [
  "0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8",
  "169.254.0.0/16", "172.16.0.0/12", "192.0.0.0/24", "192.168.0.0/16",
  "198.18.0.0/15", "224.0.0.0/4", "240.0.0.0/4",
  "::1/128", "::/128", "fc00::/7", "fe80::/10", "ff00::/8",
];

export function isPrivateIp(ip: string): boolean {
  return matchSubnets(ip, PRIVATE_CIDRS);
}

/** SSRF guard: resolve hostname and block private/reserved IPs. */
export async function assertPublicUrl(url: string): Promise<void> {
  const parsed = new URL(url);
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "");
  const addresses = await resolve(hostname).catch(() => [hostname]);
  for (const addr of addresses) {
    if (addr && isPrivateIp(addr)) {
      throw new Error(`Blocked request to private address: ${hostname}`);
    }
  }
}
