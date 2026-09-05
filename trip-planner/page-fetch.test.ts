import { describe, expect, it, vi } from "vitest";
import {
  MAX_REDIRECTS,
  PageFetchError,
  assertFetchableUrl,
  fetchSharedPage,
  isBlockedAddress,
  resolveRedirect,
} from "./page-fetch";

/**
 * A fetcher that answers from a table of URL → Response, and records
 * what was asked for. No network, and the redirect chain is under the
 * test's control — which is the only way to exercise the hop that
 * matters, a public page pointing at an internal address.
 */
function stubFetcher(pages: Record<string, Response | (() => Response)>) {
  const asked: string[] = [];
  const fetcher = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    asked.push(url);
    const entry = pages[url];
    if (!entry) throw new Error(`no stub for ${url}`);
    return typeof entry === "function" ? entry() : entry;
  });
  return { fetcher: fetcher as unknown as typeof fetch, asked };
}

function redirect(to: string, status = 302): Response {
  return new Response(null, { status, headers: { location: to } });
}

/**
 * Every host resolves to one ordinary public address unless a test
 * says otherwise. Without this the suite would depend on `beispiel.test`
 * existing in DNS, which it does not.
 */
const publicDns = async () => ["93.184.216.34"];

function page(body: string): Response {
  return new Response(body, { status: 200, headers: { "content-type": "text/html" } });
}

describe("isBlockedAddress", () => {
  it("blocks every private and special IPv4 range", () => {
    for (const address of [
      "0.0.0.0",
      "10.1.2.3",
      "127.0.0.1",
      "100.64.0.1",       // carrier-grade NAT
      "169.254.169.254",  // the cloud metadata service
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "198.18.0.1",
      "224.0.0.1",
      "255.255.255.255",
    ]) {
      expect(isBlockedAddress(address), address).toBe(true);
    }
  });

  it("allows ordinary public addresses", () => {
    for (const address of ["1.1.1.1", "93.184.216.34", "172.32.0.1", "192.169.0.1"]) {
      expect(isBlockedAddress(address), address).toBe(false);
    }
  });

  it("blocks IPv6 loopback, unique-local and link-local", () => {
    for (const address of ["::1", "::", "fc00::1", "fd12:3456::1", "fe80::1", "ff02::1"]) {
      expect(isBlockedAddress(address), address).toBe(true);
    }
  });

  it("sees through IPv4 written as IPv6", () => {
    // "::ffff:127.0.0.1" is the classic way past a check that only
    // looks at the textual form.
    expect(isBlockedAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isBlockedAddress("::ffff:169.254.169.254")).toBe(true);
    expect(isBlockedAddress("::ffff:1.1.1.1")).toBe(false);
  });

  it("blocks anything that is not an address at all", () => {
    expect(isBlockedAddress("not-an-address")).toBe(true);
    expect(isBlockedAddress("")).toBe(true);
  });
});

describe("assertFetchableUrl", () => {
  it("takes an ordinary https page", () => {
    expect(assertFetchableUrl("https://beispiel.test/artikel").hostname).toBe("beispiel.test");
  });

  it("refuses everything that is not https", () => {
    for (const raw of [
      "http://beispiel.test/",
      "file:///etc/passwd",
      "ftp://beispiel.test/",
      "nicht einmal eine URL",
    ]) {
      expect(() => assertFetchableUrl(raw), raw).toThrow(PageFetchError);
    }
  });

  it("refuses credentials in the address", () => {
    expect(() => assertFetchableUrl("https://user:pass@beispiel.test/")).toThrow(PageFetchError);
  });

  it("refuses an internal name without asking DNS", () => {
    for (const raw of [
      "https://localhost/",
      "https://geo.internal/pois",
      "https://drucker.local/",
      "https://metadata.google.internal/",
    ]) {
      expect(() => assertFetchableUrl(raw), raw).toThrow(PageFetchError);
    }
  });

  it("refuses a literal internal address", () => {
    expect(() => assertFetchableUrl("https://169.254.169.254/latest/meta-data/"))
      .toThrow(PageFetchError);
    expect(() => assertFetchableUrl("https://[::1]:8080/")).toThrow(PageFetchError);
  });
});

describe("fetchSharedPage", () => {
  it("returns the body of a page it is allowed to read", async () => {
    const { fetcher } = stubFetcher({
      "https://beispiel.test/artikel": page("<p>Zehn Orte</p>"),
    });
    const result = await fetchSharedPage("https://beispiel.test/artikel", { fetcher, resolver: publicDns });
    expect(result.body).toBe("<p>Zehn Orte</p>");
    expect(result.finalUrl).toBe("https://beispiel.test/artikel");
    expect(result.truncated).toBe(false);
  });

  it("follows an ordinary redirect and reports where it ended up", async () => {
    const { fetcher } = stubFetcher({
      "https://beispiel.test/kurz": redirect("https://beispiel.test/artikel"),
      "https://beispiel.test/artikel": page("Text"),
    });
    const result = await fetchSharedPage("https://beispiel.test/kurz", { fetcher, resolver: publicDns });
    expect(result.finalUrl).toBe("https://beispiel.test/artikel");
  });

  it("refuses a redirect that points into the internal network", async () => {
    // The half that gets forgotten. The first page is perfectly public;
    // it is the hop that is hostile, and the runtime's own redirect
    // follower would have walked straight into it.
    const { fetcher, asked } = stubFetcher({
      "https://beispiel.test/artikel": redirect("https://169.254.169.254/latest/meta-data/"),
    });
    await expect(fetchSharedPage("https://beispiel.test/artikel", { fetcher, resolver: publicDns }))
      .rejects.toThrow(PageFetchError);
    expect(asked).toEqual(["https://beispiel.test/artikel"]);
  });

  it("refuses a redirect that drops to plain http", async () => {
    const { fetcher } = stubFetcher({
      "https://beispiel.test/artikel": redirect("http://beispiel.test/artikel"),
    });
    await expect(fetchSharedPage("https://beispiel.test/artikel", { fetcher, resolver: publicDns }))
      .rejects.toThrow(PageFetchError);
  });

  it("gives up on a redirect loop", async () => {
    const { fetcher, asked } = stubFetcher({
      "https://beispiel.test/a": redirect("https://beispiel.test/b"),
      "https://beispiel.test/b": redirect("https://beispiel.test/a"),
    });
    await expect(fetchSharedPage("https://beispiel.test/a", { fetcher, resolver: publicDns }))
      .rejects.toThrow(PageFetchError);
    expect(asked.length).toBe(MAX_REDIRECTS + 1);
  });

  it("cuts a body at the size cap instead of buffering it whole", async () => {
    const { fetcher } = stubFetcher({
      "https://beispiel.test/gross": () => page("x".repeat(5_000)),
    });
    const result = await fetchSharedPage("https://beispiel.test/gross", {
      fetcher,
      resolver: publicDns,
      maxBytes: 1_000,
    });
    expect(result.truncated).toBe(true);
    expect(result.body).toHaveLength(1_000);
  });

  it("reports an error status rather than returning the error page", async () => {
    const { fetcher } = stubFetcher({
      "https://beispiel.test/weg": () => new Response("nope", { status: 404 }),
    });
    await expect(fetchSharedPage("https://beispiel.test/weg", { fetcher, resolver: publicDns }))
      .rejects.toThrow(/HTTP 404/);
  });
});

describe("the DNS check", () => {
  it("refuses a public-looking name that resolves to a private address", async () => {
    // The case a name-based blocklist cannot catch: `beispiel.test`
    // says nothing about where it points, and an attacker controls
    // both the name and the answer.
    const { fetcher, asked } = stubFetcher({ "https://beispiel.test/": page("egal") });
    await expect(fetchSharedPage("https://beispiel.test/", {
      fetcher,
      resolver: async () => ["127.0.0.1"],
    })).rejects.toThrow(PageFetchError);
    // Nothing was fetched at all — the refusal came before the socket.
    expect(asked).toEqual([]);
  });

  it("refuses when only one of several answers is private", async () => {
    const { fetcher } = stubFetcher({ "https://beispiel.test/": page("egal") });
    await expect(fetchSharedPage("https://beispiel.test/", {
      fetcher,
      resolver: async () => ["93.184.216.34", "10.0.0.1"],
    })).rejects.toThrow(PageFetchError);
  });

  it("refuses a name that resolves to nothing", async () => {
    const { fetcher } = stubFetcher({ "https://beispiel.test/": page("egal") });
    await expect(fetchSharedPage("https://beispiel.test/", {
      fetcher,
      resolver: async () => [],
    })).rejects.toThrow(PageFetchError);
  });
});

describe("resolveRedirect", () => {
  it("answers where a short link points", async () => {
    const { fetcher } = stubFetcher({
      "https://beispiel.test/kurz": redirect("https://maps.beispiel.test/?ll=48.37,10.89"),
    });
    await expect(resolveRedirect("https://beispiel.test/kurz", { fetcher, resolver: publicDns }))
      .resolves.toBe("https://maps.beispiel.test/?ll=48.37,10.89");
  });

  it("answers null when the link does not redirect at all", async () => {
    const { fetcher } = stubFetcher({ "https://beispiel.test/kurz": page("nichts") });
    await expect(resolveRedirect("https://beispiel.test/kurz", { fetcher, resolver: publicDns })).resolves.toBeNull();
  });

  it("never hands back an internal target", async () => {
    const { fetcher } = stubFetcher({
      "https://beispiel.test/kurz": redirect("https://10.0.0.5/admin"),
    });
    await expect(resolveRedirect("https://beispiel.test/kurz", { fetcher, resolver: publicDns }))
      .rejects.toThrow(PageFetchError);
  });
});
