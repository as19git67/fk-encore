/**
 * Typed HTTP client for the `llm-service` FastAPI container.
 *
 * Two endpoints are consumed:
 *   POST /classify — Llama chat completion in JSON mode, returns the
 *                    category slug + title + date + sender + summary +
 *                    tags + confidence.
 *   POST /embed    — sentence-transformers multilingual-e5-base, 768-d
 *                    embeddings suitable for pgvector.
 *
 * Both calls throw `LlmServiceUnavailableError` on network/5xx failure
 * so the scan-worker can defer (not fail) the job and retry later.
 */

const LLM_SERVICE_URL = (process.env.LLM_SERVICE_URL || "http://localhost:8002").replace(/\/$/, "");
const DEFAULT_TIMEOUT_MS = parseInt(process.env.LLM_SERVICE_TIMEOUT_MS ?? "120000", 10);

export class LlmServiceUnavailableError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "LlmServiceUnavailableError";
  }
}

export interface TaxonomyEntry {
  slug: string;
  name: string;
  parent_slug: string | null;
}

export interface Classification {
  category_slug: string;
  title: string;
  doc_date: string | null;
  sender: string | null;
  summary: string;
  tags: string[];
  confidence: number;
}

export interface ClassifyRequest {
  text: string;
  taxonomy: TaxonomyEntry[];
}

export interface EmbedRequest {
  texts: string[];
}

export interface EmbedResponse {
  embeddings: number[][];
  dim: number;
}

async function postJson<T>(endpoint: string, body: unknown, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T> {
  const url = `${LLM_SERVICE_URL}${endpoint}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err: any) {
    // Network-level failure or timeout — treat as "service unavailable"
    // so the worker defers the job instead of marking it failed.
    throw new LlmServiceUnavailableError(
      `POST ${url} failed: ${err?.message ?? String(err)}`,
    );
  } finally {
    clearTimeout(timer);
  }

  if (res.status >= 500 || res.status === 408 || res.status === 429) {
    const detail = await safeBody(res);
    throw new LlmServiceUnavailableError(
      `POST ${url} returned ${res.status}: ${detail}`,
    );
  }
  if (!res.ok) {
    const detail = await safeBody(res);
    throw new Error(`POST ${url} returned ${res.status}: ${detail}`);
  }
  return (await res.json()) as T;
}

async function safeBody(res: Response): Promise<string> {
  try {
    const text = await res.text();
    return text.slice(0, 500);
  } catch {
    return "<unreadable body>";
  }
}

export async function classifyDocument(req: ClassifyRequest): Promise<Classification> {
  const raw = await postJson<unknown>("/classify", req);
  return parseClassification(raw);
}

export async function embedTexts(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const res = await postJson<EmbedResponse>("/embed", { texts } satisfies EmbedRequest);
  if (!Array.isArray(res.embeddings)) {
    throw new Error("/embed response is missing `embeddings` array");
  }
  return res.embeddings;
}

export async function isLlmServiceHealthy(timeoutMs = 2000): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${LLM_SERVICE_URL}/healthz`, { signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Validate + normalise the classifier response without pulling in
 * Zod — the shape is small enough to hand-check and keeps the
 * dependency surface tiny.
 */
function parseClassification(raw: unknown): Classification {
  if (!raw || typeof raw !== "object") {
    throw new Error("classify: response was not an object");
  }
  const r = raw as Record<string, unknown>;
  const slug = typeof r.category_slug === "string" ? r.category_slug.trim().toLowerCase() : "";
  if (!slug) throw new Error("classify: missing category_slug");

  const title = typeof r.title === "string" ? r.title.trim() : "";
  const docDate = typeof r.doc_date === "string" && r.doc_date.trim() !== "" ? r.doc_date.trim() : null;
  const sender = typeof r.sender === "string" && r.sender.trim() !== "" ? r.sender.trim() : null;
  const summary = typeof r.summary === "string" ? r.summary.trim() : "";
  const tagsRaw = Array.isArray(r.tags) ? r.tags : [];
  const tags = tagsRaw
    .filter((t): t is string => typeof t === "string")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  const conf = typeof r.confidence === "number" && Number.isFinite(r.confidence)
    ? Math.max(0, Math.min(1, r.confidence))
    : 0;

  return {
    category_slug: slug,
    title,
    doc_date: docDate,
    sender,
    summary,
    tags,
    confidence: conf,
  };
}
