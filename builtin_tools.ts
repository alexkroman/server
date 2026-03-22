// Copyright 2025 the AAI authors. MIT license.
/** SSRF guard: resolve hostname and block private/reserved IPs. */
import { isPrivateIp } from "./private_ip.ts";

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
