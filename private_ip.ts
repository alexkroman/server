// Copyright 2025 the AAI authors. MIT license.
/**
 * Shared private/reserved IP detection using proper CIDR matching.
 * Used by SSRF protection (builtin_tools.ts) and internal-only
 * middleware (middleware.ts).
 *
 * @module
 */
import { matchSubnets } from "@std/net/unstable-ip";

const PRIVATE_CIDRS = [
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
  "fc00::/7", // includes Fly.io fdaa::/16
  "fe80::/10",
  "ff00::/8",
];

/** Check whether an IP address falls within a private or reserved range. */
export function isPrivateIp(ip: string): boolean {
  if (!ip) return false;
  return matchSubnets(ip, PRIVATE_CIDRS);
}
