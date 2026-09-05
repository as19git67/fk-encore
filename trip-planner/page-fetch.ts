/**
 * Fetching a page the user pointed at (§9.3, stage 1 — the fallback).
 *
 * The good path never comes here: the share extension runs a script in
 * the already-open page and hands over its visible text, which has
 * solved JavaScript rendering, cookie walls, logins and bot blocks
 * before we ever see it. This is for the case where only a URL arrived
 * — out of a message, say — and for following a shortened map link.
 *
 * **A service that fetches arbitrary user-supplied URLs is a new attack
 * surface**, and the concept names the precautions rather than leaving
 * them implied. All of them are here:
 *
 *   - `https` only. No `file:`, no `gopher:`, no `http:` that a
 *     man-in-the-middle could answer.
 *   - No private, loopback, link-local or unique-local address — **and
 *     not after a redirect either**, which is the half that gets
 *     forgotten. Otherwise a page under someone else's control can
 *     bounce us at the geo container on the internal network, or at a
 *     cloud metadata service on 169.254.169.254.
 *   - A timeout and a size cap, so a slow or endless response cannot
 *     hold a request open or fill memory.
 *
 * One honest limitation. Node's `fetch` offers no way to pin the socket
 * to the address we checked, so between the DNS answer we validate and
 * the connection the runtime makes, a hostile resolver could return a
 * different address (a DNS rebind). Every hostname is resolved and
 * every resulting address checked, and every redirect hop is checked
 * again, which is as far as this can go without a custom HTTP agent.
 * The remaining window is narrow and is written down here rather than
 * left for someone to discover.
 */

import { isIP } from "node:net";
import { lookup } from "node:dns/promises";

/** Long enough for a slow blog, short enough not to hold a request. */
export const FETCH_TIMEOUT_MS = 10_000;
/** A travel article is tens of kilobytes; past this it is not one. */
export const MAX_PAGE_BYTES = 2_000_000;
/** Enough for the usual canonical-URL bounce, not enough for a loop. */
export const MAX_REDIRECTS = 4;

export class PageFetchError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "PageFetchError";
  }
}

/**
 * Host names that are never a public web page, whatever DNS says.
 *
 * Checked before resolution as well as after: it costs nothing and it
 * makes the intent legible in a log line.
 */
const BLOCKED_HOST_SUFFIXES = [".local", ".internal", ".localhost", ".home.arpa"];
const BLOCKED_HOSTS = new Set(["localhost", "metadata", "metadata.google.internal"]);

/**
 * Is this address one we must never connect to?
 *
 * Pure and exported, because it is the part worth testing exhaustively
 * — a range missed here is the whole guard missed.
 */
export function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isBlockedIPv4(address);
  if (family === 6) return isBlockedIPv6(address);
  // Not an address at all: refuse rather than let it through.
  return true;
}

function isBlockedIPv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
    return true;
  }
  const [a, b] = parts;
  if (a === 0) return true;                          // "this network"
  if (a === 10) return true;                         // private
  if (a === 127) return true;                        // loopback
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
  if (a === 169 && b === 254) return true;           // link-local, incl. metadata
  if (a === 172 && b >= 16 && b <= 31) return true;  // private
  if (a === 192 && b === 0) return true;             // protocol assignments
  if (a === 192 && b === 168) return true;           // private
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a >= 224) return true;                         // multicast and reserved
  return false;
}

function isBlockedIPv6(address: string): boolean {
  const lower = address.toLowerCase().split("%")[0];
  if (lower === "::" || lower === "::1") return true;
  // IPv4 written as IPv6 is still IPv4, and "::ffff:127.0.0.1" is a
  // classic way past a check that only looks at the textual form.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mapped) return isBlockedIPv4(mapped[1]);
  const first = lower.split(":")[0];
  const leading = parseInt(first || "0", 16);
  if (!Number.isFinite(leading)) return true;
  if ((leading & 0xfe00) === 0xfc00) return true; // unique local (fc00::/7)
  if ((leading & 0xffc0) === 0xfe80) return true; // link-local (fe80::/10)
  if ((leading & 0xff00) === 0xff00) return true; // multicast
  return false;
}

/**
 * Syntactic checks, before anything is resolved or connected.
 *
 * Throws rather than returning a flag: every one of these is a refusal
 * the caller has to report, and there is nothing to fall back to.
 */
export function assertFetchableUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new PageFetchError("das ist keine gültige Adresse");
  }
  if (url.protocol !== "https:") {
    throw new PageFetchError("nur https-Adressen werden geladen");
  }
  if (url.username || url.password) {
    throw new PageFetchError("Adressen mit Zugangsdaten werden nicht geladen");
  }
  const host = url.hostname.toLowerCase();
  if (BLOCKED_HOSTS.has(host) || BLOCKED_HOST_SUFFIXES.some((s) => host.endsWith(s))) {
    throw new PageFetchError("diese Adresse liegt im internen Netz");
  }
  // A literal address needs no DNS and can be judged right here. The
  // brackets IPv6 URLs carry are not part of the address.
  const literal = host.startsWith("[") ? host.slice(1, -1) : host;
  if (isIP(literal) && isBlockedAddress(literal)) {
    throw new PageFetchError("diese Adresse liegt im internen Netz");
  }
  return url;
}

/**
 * How a host name becomes addresses. Injectable so the guard itself
 * can be tested — the interesting case is a name that resolves to
 * 127.0.0.1, and no public name will do that on demand.
 */
export type HostResolver = (host: string) => Promise<string[]>;

const dnsResolver: HostResolver = async (host) =>
  (await lookup(host, { all: true })).map((entry) => entry.address);

/**
 * Resolve the host and refuse if *any* address it answers with is one
 * we must not reach.
 *
 * All of them, not just the first: a host that resolves to a public
 * address and a private one is a host trying something.
 */
async function assertHostIsPublic(url: URL, resolver: HostResolver): Promise<void> {
  const host = url.hostname.startsWith("[")
    ? url.hostname.slice(1, -1)
    : url.hostname;
  if (isIP(host)) {
    if (isBlockedAddress(host)) {
      throw new PageFetchError("diese Adresse liegt im internen Netz");
    }
    return;
  }
  let addresses: string[];
  try {
    addresses = await resolver(host);
  } catch {
    throw new PageFetchError(`der Name ${host} ließ sich nicht auflösen`);
  }
  if (addresses.length === 0) {
    throw new PageFetchError(`der Name ${host} ließ sich nicht auflösen`);
  }
  if (addresses.some(isBlockedAddress)) {
    throw new PageFetchError("diese Adresse zeigt ins interne Netz");
  }
}

export interface FetchedPage {
  /** Where we ended up, which may differ from where we started. */
  finalUrl: string;
  contentType: string | null;
  body: string;
  /** True when the body was cut at the size cap. */
  truncated: boolean;
}

export interface FetchOptions {
  fetcher?: typeof fetch;
  /** Defaults to DNS. See `HostResolver`. */
  resolver?: HostResolver;
  timeoutMs?: number;
  maxBytes?: number;
}

/**
 * Fetch a page, following redirects **by hand** so every hop can be
 * checked. `redirect: "manual"` is the whole point: the built-in
 * follower would happily walk from a public page to 169.254.169.254.
 */
export async function fetchSharedPage(
  rawUrl: string,
  opts: FetchOptions = {},
): Promise<FetchedPage> {
  const fetcher = opts.fetcher ?? fetch;
  const resolver = opts.resolver ?? dnsResolver;
  const timeoutMs = opts.timeoutMs ?? FETCH_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? MAX_PAGE_BYTES;

  let url = assertFetchableUrl(rawUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      await assertHostIsPublic(url, resolver);
      let response: Response;
      try {
        response = await fetcher(url.toString(), {
          method: "GET",
          redirect: "manual",
          headers: {
            accept: "text/html,application/xhtml+xml",
            "accept-language": "de,en;q=0.8",
            "user-agent": USER_AGENT,
          },
          signal: controller.signal,
        });
      } catch (err) {
        throw new PageFetchError(
          `die Seite ließ sich nicht laden: ${(err as Error)?.message ?? err}`,
        );
      }

      const location = redirectTarget(response, url);
      if (location) {
        url = assertFetchableUrl(location.toString());
        continue;
      }
      if (!response.ok) {
        throw new PageFetchError(`die Seite antwortete mit HTTP ${response.status}`);
      }
      const { text, truncated } = await readCapped(response, maxBytes);
      return {
        finalUrl: url.toString(),
        contentType: response.headers.get("content-type"),
        body: text,
        truncated,
      };
    }
    throw new PageFetchError("die Seite leitet im Kreis weiter");
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Follow one hop of a shortened link and answer where it points.
 *
 * Same guards, and deliberately only one hop: a short link that
 * redirects to another short link is not a map link, it is a
 * redirector chain.
 */
export async function resolveRedirect(
  rawUrl: string,
  opts: FetchOptions = {},
): Promise<string | null> {
  const fetcher = opts.fetcher ?? fetch;
  const url = assertFetchableUrl(rawUrl);
  await assertHostIsPublic(url, opts.resolver ?? dnsResolver);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? FETCH_TIMEOUT_MS);
  try {
    const response = await fetcher(url.toString(), {
      method: "GET",
      redirect: "manual",
      headers: { "user-agent": USER_AGENT },
      signal: controller.signal,
    });
    const target = redirectTarget(response, url);
    if (!target) return null;
    // Validated before it is handed back, so a caller cannot be handed
    // an internal address to fetch.
    return assertFetchableUrl(target.toString()).toString();
  } catch (err) {
    if (err instanceof PageFetchError) throw err;
    throw new PageFetchError(
      `dem Kurzlink konnte nicht gefolgt werden: ${(err as Error)?.message ?? err}`,
    );
  } finally {
    clearTimeout(timer);
  }
}

const USER_AGENT =
  "fk-encore/trip-planner (+https://github.com/as19git67/fk-encore) Node.js";

function redirectTarget(response: Response, from: URL): URL | null {
  if (response.status < 300 || response.status >= 400) return null;
  const location = response.headers.get("location");
  if (!location) return null;
  try {
    return new URL(location, from);
  } catch {
    return null;
  }
}

/**
 * Read the body, stopping at the cap.
 *
 * The stream is read chunk by chunk rather than `await response.text()`
 * because the latter would buffer a hostile ten-gigabyte response in
 * full before anything could object to its size.
 */
async function readCapped(
  response: Response,
  maxBytes: number,
): Promise<{ text: string; truncated: boolean }> {
  const reader = response.body?.getReader();
  if (!reader) return { text: "", truncated: false };

  const decoder = new TextDecoder("utf-8");
  let text = "";
  let seen = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      seen += value.byteLength;
      if (seen > maxBytes) {
        const keep = value.subarray(0, value.byteLength - (seen - maxBytes));
        text += decoder.decode(keep);
        truncated = true;
        break;
      }
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  if (!truncated) text += decoder.decode();
  return { text, truncated };
}
