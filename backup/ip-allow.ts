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
 * Source-IP resolution:
 *   - Encore.ts' Rust HTTP layer proxies requests into Node, so inside an
 *     `api.raw` handler `req.socket.remoteAddress` is either unset or the
 *     internal proxy socket, never the real TCP peer. The verified peer
 *     IP is relayed via `X-Forwarded-For` (same mechanism the existing
 *     `user/rateLimiter.ts` relies on).
 *   - We therefore read the left-most `X-Forwarded-For` entry by default,
 *     and fall back to the socket address only when no XFF is present.
 *     Set `BACKUP_TRUST_XFF=false` to disable XFF use entirely (useful in
 *     test rigs that bypass Encore).
 *
 * Typical peer addresses inside Docker:
 *   - Host→container via the published port: the bridge gateway, e.g.
 *     172.17.0.1 (default bridge) or 172.18.0.1 / 172.19.0.1 for
 *     Compose-created networks. Covered by the default `172.16.0.0/12`.
 *   - Container→container on the same network: a RFC1918 address in the
 *     same subnet as the bridge. Also covered by the defaults.
 *   - External client via a reverse proxy: the proxy's public address,
 *     which will usually be outside the defaults and must be added to
 *     `BACKUP_ALLOW_CIDRS` explicitly.
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
 * Placeholder socket addresses that Encore.ts fills in when no real peer is
 * available to the Node handler. Treating them as "no peer IP" is what
 * lets `isPeerAddressUsable` tell the auth layer to skip the CIDR check.
 */
const UNUSABLE_SOCKET_ADDRS = new Set(["0.0.0.0", "::", "::0"]);

/**
 * Returns true when the CIDR check has a real IP to match against.
 * Returns false when the runtime only gave us a placeholder / loopback-ish
 * value that carries no network-origin signal (Encore.ts' `api.raw`
 * handler is the motivating case — its socket is reported as `0.0.0.0`
 * and there are no forwarding headers). In that situation we cannot
 * enforce BACKUP_ALLOW_CIDRS and must fall back to the bearer token.
 */
export function isPeerAddressUsable(addr: string | undefined | null): boolean {
  const ip = normaliseIp(addr);
  if (!ip) return false;
  if (UNUSABLE_SOCKET_ADDRS.has(ip)) return false;
  return net.isIP(ip) !== 0;
}

/**
 * Pick the effective remote address for authorisation.
 *
 * Encore.ts runs the Node handler behind its Rust HTTP layer, which means
 * `req.socket.remoteAddress` inside an `api.raw` handler is a placeholder
 * (observed: `"0.0.0.0"`) — never the real TCP peer. Encore also does
 * not relay the peer IP via `X-Forwarded-For` / `X-Real-IP` for raw
 * endpoints. When that happens `isPeerAddressUsable(returned)` will be
 * false and the caller should skip the CIDR check.
 *
 * If an upstream reverse proxy (nginx, Caddy, Traefik, ...) *does*
 * populate `X-Forwarded-For` and Encore preserves it, we read the
 * left-most entry — matching `user/rateLimiter.ts`. Set
 * `BACKUP_TRUST_XFF=false` to disable that behaviour in test rigs.
 */
export function effectiveRemoteAddress(
  socketAddr: string | undefined | null,
  xForwardedFor: string | string[] | undefined,
): string | null {
  const trustXff = process.env.BACKUP_TRUST_XFF !== "false";
  if (trustXff && xForwardedFor) {
    const raw = Array.isArray(xForwardedFor) ? xForwardedFor[0] : xForwardedFor;
    const first = raw.split(",")[0]?.trim();
    if (first) return first;
  }
  return socketAddr ?? null;
}
