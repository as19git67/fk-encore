/**
 * CIDR-based allow-list for the /internal/backup/* endpoints.
 *
 * Rationale: the bearer token alone is strong (256-bit random, constant-time
 * compare), but layering a network-origin check protects against leaked
 * tokens and against accidental public exposure of port 8080. An attacker
 * coming from the public internet will show up with a source IP outside
 * RFC1918 / loopback and will be rejected before the token is even
 * inspected.
 *
 * Source-IP behaviour inside Docker:
 *   - Requests from the host via the published port are SNAT-ed to the
 *     bridge gateway (e.g. 172.17.0.1), which is why the default list
 *     includes the private RFC1918 ranges, not just 127.0.0.1.
 *   - Requests from other containers on the same Docker network also
 *     arrive from a private range and are allowed.
 *   - External requests forwarded by a reverse proxy should include
 *     X-Forwarded-For; if `BACKUP_TRUST_XFF` is truthy the left-most
 *     entry is checked instead of the socket address.
 *
 * Override the default list via `BACKUP_ALLOW_CIDRS` (comma-separated).
 */

import net from "net";

const DEFAULT_CIDRS = [
  // Loopback
  "127.0.0.0/8",
  "::1/128",
  // RFC1918 + Docker bridge defaults
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
  // IPv6 Unique Local Addresses
  "fc00::/7",
];

function parseCidrs(): Array<{ range: string; bits: number; family: 4 | 6 }> {
  const raw = process.env.BACKUP_ALLOW_CIDRS?.trim();
  const list = raw && raw.length > 0 ? raw.split(",").map((s) => s.trim()) : DEFAULT_CIDRS;
  return list.flatMap((entry) => {
    const [range, bitsStr] = entry.split("/");
    const bits = parseInt(bitsStr ?? "", 10);
    const family = net.isIP(range);
    if (!family || Number.isNaN(bits)) {
      // Skip malformed entries rather than fail the whole service.
      // eslint-disable-next-line no-console
      console.warn(`[backup.ip-allow] ignoring malformed CIDR: "${entry}"`);
      return [];
    }
    return [{ range, bits, family: family as 4 | 6 }];
  });
}

/**
 * Normalise an IP string:
 *   - strip the "::ffff:" prefix that Node appends for IPv4-mapped IPv6
 *   - lower-case for IPv6 hex consistency
 */
export function normaliseIp(addr: string | undefined | null): string | null {
  if (!addr) return null;
  const stripped = addr.startsWith("::ffff:") ? addr.slice("::ffff:".length) : addr;
  return stripped.toLowerCase();
}

function ipv4ToNumber(ip: string): number {
  const parts = ip.split(".").map((s) => parseInt(s, 10));
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) {
    return -1;
  }
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function ipv6ToBytes(ip: string): Uint8Array | null {
  // Expand shorthand via Node's built-in parser: round-trip through URL with brackets.
  try {
    const bytes = new Uint8Array(16);
    const parts = ip.split("::");
    const head = parts[0] ? parts[0].split(":") : [];
    const tail = parts[1] ? parts[1].split(":") : [];
    const missing = 8 - head.length - tail.length;
    if (missing < 0) return null;
    const groups = [...head, ...Array(missing).fill("0"), ...tail];
    if (groups.length !== 8) return null;
    for (let i = 0; i < 8; i++) {
      const v = parseInt(groups[i], 16);
      if (Number.isNaN(v) || v < 0 || v > 0xffff) return null;
      bytes[i * 2] = (v >> 8) & 0xff;
      bytes[i * 2 + 1] = v & 0xff;
    }
    return bytes;
  } catch {
    return null;
  }
}

function ipv4InCidr(ip: string, range: string, bits: number): boolean {
  const ipNum = ipv4ToNumber(ip);
  const rangeNum = ipv4ToNumber(range);
  if (ipNum < 0 || rangeNum < 0) return false;
  if (bits === 0) return true;
  if (bits < 0 || bits > 32) return false;
  const mask = (~0 << (32 - bits)) >>> 0;
  return (ipNum & mask) === (rangeNum & mask);
}

function ipv6InCidr(ip: string, range: string, bits: number): boolean {
  const ipBytes = ipv6ToBytes(ip);
  const rangeBytes = ipv6ToBytes(range);
  if (!ipBytes || !rangeBytes) return false;
  if (bits < 0 || bits > 128) return false;
  const fullBytes = Math.floor(bits / 8);
  for (let i = 0; i < fullBytes; i++) {
    if (ipBytes[i] !== rangeBytes[i]) return false;
  }
  const rem = bits % 8;
  if (rem === 0) return true;
  const mask = (0xff << (8 - rem)) & 0xff;
  return (ipBytes[fullBytes] & mask) === (rangeBytes[fullBytes] & mask);
}

let cached: ReturnType<typeof parseCidrs> | null = null;
function getCidrs(): ReturnType<typeof parseCidrs> {
  if (!cached) cached = parseCidrs();
  return cached;
}

/** Reset the cached CIDR list — intended for tests. */
export function resetIpAllowCache(): void {
  cached = null;
}

/**
 * Returns true when the given remote address matches any entry in the
 * allow-list. An unparseable address fails closed.
 */
export function isRemoteAllowed(remoteAddr: string | undefined | null): boolean {
  const ip = normaliseIp(remoteAddr);
  if (!ip) return false;
  const family = net.isIP(ip);
  if (!family) return false;
  for (const entry of getCidrs()) {
    if (entry.family !== family) continue;
    const ok = family === 4 ? ipv4InCidr(ip, entry.range, entry.bits) : ipv6InCidr(ip, entry.range, entry.bits);
    if (ok) return true;
  }
  return false;
}

/**
 * Pick the effective remote address for authorisation. Prefers
 * X-Forwarded-For (left-most entry) when BACKUP_TRUST_XFF is truthy,
 * otherwise returns the socket address as-is.
 */
export function effectiveRemoteAddress(
  socketAddr: string | undefined | null,
  xForwardedFor: string | string[] | undefined,
): string | null {
  if (process.env.BACKUP_TRUST_XFF === "true" && xForwardedFor) {
    const raw = Array.isArray(xForwardedFor) ? xForwardedFor[0] : xForwardedFor;
    const first = raw.split(",")[0]?.trim();
    if (first) return first;
  }
  return socketAddr ?? null;
}
