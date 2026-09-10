/**
 * Outbound authentication for the five internal Python services.
 *
 * llm-service, embedding_service, insightface-service, receipt-ocr-service
 * and taxonomy-tools each bind 0.0.0.0:8000 in their container and had no
 * authentication of any kind. In the production stack they publish no host
 * ports, so nothing outside the compose network could reach them — but any
 * container that landed on the same bridge got full access, and
 * taxonomy_tools is the worst case: it spawns scripts and holds
 * ANTHROPIC_API_KEY. They now require `Authorization: Bearer
 * $INTERNAL_SERVICE_SECRET` and refuse to start without one.
 *
 * The header is attached here rather than at the ~30 call sites that talk
 * to them, spread over sixteen client modules. That is not tidiness: a
 * missed call site is a feature that returns 401 in production and nowhere
 * else, since no test exercises the real services. One rule keyed on the
 * destination cannot be missed, and it covers the modules that take an
 * injected `fetcher` (which defaults to global fetch) as well as any client
 * written later.
 *
 * Only requests to those origins are touched, and only when they do not
 * already carry an Authorization header. Everything else — the geo service,
 * outbound calls to the internet — passes through untouched.
 *
 * Imported for its side effect from the encore.service.ts of every service
 * that calls out. Installing twice is a no-op.
 */

// Trimmed, because the Python side trims too (`service_auth.py` does
// `os.environ.get(...).strip()`). A value that picked up a trailing
// newline — read out of a file, pasted into a shell — would otherwise
// make the two ends disagree about a secret they both hold, and the
// symptom is a 401 that no amount of comparing the values explains.
const SECRET = (process.env.INTERNAL_SERVICE_SECRET ?? "").trim();

/**
 * Where those services live. Both the configured value and the fallback are
 * listed, because the clients themselves fall back the same way when the
 * variable is unset — a header attached to one but not the other would be
 * worse than either.
 */
const SERVICE_URLS: ReadonlyArray<readonly [string | undefined, string]> = [
  [process.env.LLM_SERVICE_URL, "http://localhost:8002"],
  [process.env.EMBEDDING_SERVICE_URL, "http://localhost:8001"],
  [process.env.INSIGHTFACE_SERVICE_URL, "http://localhost:8000"],
  [process.env.RECEIPT_OCR_SERVICE_URL, "http://localhost:8003"],
  [process.env.TAXONOMY_TOOLS_SERVICE_URL, "http://taxonomy_tools:8000"],
];

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** Exported for the test; the set is computed once at import. */
export function internalOrigins(): Set<string> {
  const origins = new Set<string>();
  for (const [configured, fallback] of SERVICE_URLS) {
    for (const candidate of [configured, fallback]) {
      if (!candidate) continue;
      const origin = originOf(candidate);
      if (origin) origins.add(origin);
    }
  }
  return origins;
}

const ORIGINS = internalOrigins();

function targetOrigin(input: RequestInfo | URL): string | null {
  if (typeof input === "string") return originOf(input);
  if (input instanceof URL) return input.origin;
  // A Request object. Nothing in this codebase builds one, but rebuilding it
  // to inject a header risks its body, so let it through unchanged rather
  // than half-handling it.
  return null;
}

/** Marker so a second import does not wrap the wrapper. */
const INSTALLED = Symbol.for("fk-encore.internal-service-auth");

function install(): void {
  const current = globalThis.fetch as typeof fetch & { [INSTALLED]?: true };
  if (current?.[INSTALLED]) return;

  if (!SECRET) {
    // Not fatal here on purpose: the app does far more than talk to these
    // five services, and refusing to boot the whole thing over a missing
    // AI-service secret would be a worse failure than the 401s. The stack
    // itself refuses to come up without it (docker-compose uses `:?`), and
    // each service refuses to start, so this line is for someone running
    // the app outside compose.
    console.warn(
      "[internal-service-auth] INTERNAL_SERVICE_SECRET is not set — calls to " +
        "the llm / embedding / insightface / receipt-ocr / taxonomy-tools " +
        "services will be rejected with 401.",
    );
    return;
  }

  const original = current;
  const wrapped = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const origin = targetOrigin(input);
    if (!origin || !ORIGINS.has(origin)) return original(input, init);

    const headers = new Headers(init?.headers);
    if (!headers.has("authorization")) {
      headers.set("authorization", `Bearer ${SECRET}`);
    }
    return original(input, { ...init, headers });
  }) as typeof fetch & { [INSTALLED]?: true };

  wrapped[INSTALLED] = true;
  globalThis.fetch = wrapped;
  console.log(
    `[internal-service-auth] attaching credentials for ${ORIGINS.size} internal origin(s)`,
  );
}

install();
