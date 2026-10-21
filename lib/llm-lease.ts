/**
 * How long a caller may wait for the llm-service, given who has the GPU.
 *
 * At night the aesthetic run (or a CPU benchmark) borrows the card and the
 * llm-service answers from the CPU twin of its model, many times slower.
 * A caller that keeps its GPU budget gives up after a minute or two, but
 * llama-server goes on working on the abandoned request until its own
 * request timeout. The service has one inference slot, so every caller
 * after that gets 503 "inference busy" until the orphan is done. While the
 * GPU is lent, a caller therefore waits as long as the server works.
 *
 * Every client of the llm-service asks here before it sets its timer.
 */

/** llm-service's own default for how long llama-server works on one request. */
export const SERVER_REQUEST_TIMEOUT_MS = 900_000;

/** The lease changes twice a night; a stale half minute costs nothing. */
const CACHE_TTL_MS = 30_000;

const LLM_SERVICE_URL = (process.env.LLM_SERVICE_URL || "http://localhost:8002").replace(/\/$/, "");

interface LeaseSnapshot {
  lent: boolean;
  /** The server's per-request limit while lent. */
  serverLimitMs: number;
  at: number;
}

let cached: LeaseSnapshot | null = null;

/** Test seam: forget the cached lease so the next call asks again. */
export function resetLlmLeaseCache(): void {
  cached = null;
}

async function askLent(): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2000);
  try {
    const res = await fetch(`${LLM_SERVICE_URL}/reload/status`, { signal: controller.signal });
    if (!res.ok) return false;
    const body = (await res.json()) as { lease?: { active?: boolean } };
    return body.lease?.active === true;
  } catch {
    // An unreachable service is the caller's problem to report; here it only
    // means "no lease we know of".
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function activeRequestLimitMs(): Promise<number> {
  try {
    const { default: db } = await import("../db/database");
    const { llmModelConfig } = await import("../db/schema");
    const { eq } = await import("drizzle-orm");
    const [row] = await db
      .select({ request_timeout_s: llmModelConfig.request_timeout_s })
      .from(llmModelConfig)
      .where(eq(llmModelConfig.is_active, true));
    if (row?.request_timeout_s) return row.request_timeout_s * 1000;
  } catch {
    // Fall back to the service's default rather than failing the call.
  }
  return SERVER_REQUEST_TIMEOUT_MS;
}

async function snapshot(): Promise<LeaseSnapshot> {
  const now = Date.now();
  if (cached && now - cached.at < CACHE_TTL_MS) return cached;
  const lent = await askLent();
  const serverLimitMs = lent ? await activeRequestLimitMs() : SERVER_REQUEST_TIMEOUT_MS;
  cached = { lent, serverLimitMs, at: now };
  return cached;
}

/** Whether the llm-service runs on its CPU twin because the GPU is lent. */
export async function isGpuLent(): Promise<boolean> {
  return (await snapshot()).lent;
}

/** `normalMs` while the GPU is home; at least the server's own limit while it is lent. */
export async function llmBudgetMs(normalMs: number): Promise<number> {
  const s = await snapshot();
  return s.lent ? Math.max(normalMs, s.serverLimitMs) : normalMs;
}
