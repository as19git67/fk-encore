/**
 * Typed HTTP client for the `llm-service` FastAPI container.
 *
 * Two endpoints are consumed:
 *   POST /classify — Llama chat completion in JSON mode, returns the
 *                    category slug + title + date + sender + summary +
 *                    tags + confidence.
 *   POST /embed    — sentence-transformers multilingual-e5-base, 768-d
 *                    embeddings suitable for pgvector. The caller passes
 *                    `kind: "passage" | "query"` so the server can apply
 *                    the e5 prefix that the model was trained with.
 *
 * Both calls throw `LlmServiceUnavailableError` on network/5xx failure
 * so the scan-worker can defer (not fail) the job and retry later.
 */

import { CLASSIFY_PROMPTS } from "./classify-prompts";
import { isValidTaxSectionSlug, type TaxSectionGroup } from "./tax-sections";
import { isValidDocumentTypeSlug } from "./document-types";

console.log("[boot] documents/llm-client.ts: all imports resolved");

const LLM_SERVICE_URL = (process.env.LLM_SERVICE_URL || "http://localhost:8002").replace(/\/$/, "");
const ENV_TIMEOUT_MS = parseInt(process.env.LLM_SERVICE_TIMEOUT_MS ?? "120000", 10);

// How long the activated configuration's app_timeout_ms is trusted before we
// look again. A model swap changes it at most a few times a day, and the swap
// itself takes minutes, so a stale minute costs nothing — while a query per
// classify would be pure overhead.
const TIMEOUT_CACHE_TTL_MS = 60_000;

let cachedTimeoutMs: number | null = null;
let cachedTimeoutAt = 0;

/**
 * Per-request budget for a call to the llm-service.
 *
 * A slow model needs a longer one — a MoE model with its experts in system RAM
 * is minutes per document where the dense default is seconds — so the value
 * belongs with the model rather than in the container's environment. The
 * activated configuration supplies it; `LLM_SERVICE_TIMEOUT_MS` remains the
 * fallback for a deployment that has not activated anything, and for the
 * moments when the lookup fails.
 */
export async function resolveTimeoutMs(): Promise<number> {
  const now = Date.now();
  if (cachedTimeoutMs !== null && now - cachedTimeoutAt < TIMEOUT_CACHE_TTL_MS) {
    return cachedTimeoutMs;
  }
  let resolved = ENV_TIMEOUT_MS;
  try {
    const { default: db } = await import("../db/database");
    const { llmModelConfig } = await import("../db/schema");
    const { eq } = await import("drizzle-orm");
    const [row] = await db
      .select({ app_timeout_ms: llmModelConfig.app_timeout_ms })
      .from(llmModelConfig)
      .where(eq(llmModelConfig.is_active, true));
    if (row?.app_timeout_ms) resolved = row.app_timeout_ms;
  } catch {
    // The database being unreachable is the scan-worker's problem, not this
    // function's — fall back rather than turning it into a classify failure.
  }
  cachedTimeoutMs = resolved;
  cachedTimeoutAt = now;
  return resolved;
}

/** Test seam: drop the cached value so the next call queries again. */
export function resetTimeoutCache(): void {
  cachedTimeoutMs = null;
  cachedTimeoutAt = 0;
}

// Lower bound 1970 (not e.g. 2000): household documents legitimately span
// decades — a 1997 Jahresdepotauszug is a real, unremarkable case. Must match
// the ClassifyResponse.tax_year bound in llm-service/main.py.
const TAX_YEAR_MIN = 1970;
const TAX_YEAR_MAX = 2100;

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
  // Optional disambiguation hint rendered into the classifier prompt as
  // "slug: Name — Hinweis". Omit when the category name speaks for itself.
  hint?: string;
}

export interface TaxSectionRequestEntry {
  slug: string;
  name: string;
  group: TaxSectionGroup;
  hint?: string;
}

export interface DocumentTypeRequestEntry {
  slug: string;
  name: string;
  hint?: string;
}

export interface TaxAssignment {
  slug: string;
  confidence: number;
}

export interface Classification {
  category_slug: string;
  title: string;
  doc_date: string | null;
  sender: string | null;
  document_number: string | null;
  summary: string;
  tags: string[];
  confidence: number;
  // Document-type facet. `null` when type detection was off (no
  // `document_types` list was sent) or the LLM returned no valid slug.
  document_type: string | null;
  document_type_confidence: number;
  // Tax-return metadata. `tax_sections` is empty when tax detection was
  // off (no `tax_sections` list was sent) or when the LLM didn't find
  // a match.
  tax_relevant: boolean;
  tax_year: number | null;
  tax_year_confidence: number;
  tax_sections: TaxAssignment[];
}

export interface SubjectPersonRequestEntry {
  full_name: string;
  relation_tag: string;
  relation_kind?: string;
  // Who carries the cost of this person's bills ("user" | "person" |
  // "unknown"). The tax prompt otherwise has to infer the payer from the
  // document text — a question the household data already answers.
  tax_cost_bearer?: string;
  // Member of the user's tax household. Together with `relation_kind`
  // "child" this decides whether a deduction is unambiguously the user's.
  in_household?: boolean;
}

/**
 * One already-classified, content-similar document of the same household,
 * sent to the classifier as a few-shot anchor (retrieval-augmented
 * classification, see `few-shot.ts`). The model is told to treat these as
 * orientation, not as a binding label.
 */
export interface ClassifyExample {
  sender: string | null;
  title: string;
  category_slug: string;
  category_name: string;
}

export interface ClassifyRequest {
  text: string;
  taxonomy: TaxonomyEntry[];
  // When provided, the classifier additionally picks the single best-matching
  // document type from this fixed set. Omit/empty to disable.
  document_types?: DocumentTypeRequestEntry[];
  // When provided, the classifier additionally decides tax-relevance,
  // tax year, and a list of matching sections. Omit/empty to disable.
  tax_sections?: TaxSectionRequestEntry[];
  // Per-user "Bezugspersonen" — name → relationship tag mappings.
  // When the OCR text mentions one of these names the classifier is
  // instructed to add the corresponding relation_tag to its `tags`
  // output. Omit/empty to disable that behaviour entirely.
  subject_persons?: SubjectPersonRequestEntry[];
  // Joint vs. separate assessment ("zusammen" | "einzeln" | "unknown").
  // Decides whether a spouse's deduction belongs on the user's return —
  // see the PERSONENBEZUG block in CLASSIFY_TAX_PROMPT. Omit when unknown.
  assessment_type?: string;
  // The k nearest already-classified documents (by embedding similarity),
  // rendered into the prompt as orientation. Omit/empty to disable few-shot.
  examples?: ClassifyExample[];
}

/**
 * Whether the embedded text is corpus content (`passage`) or a search
 * query (`query`). Drives the e5-family prefix on the service side —
 * see `_apply_embedding_prefix` in `llm-service/main.py`.
 */
export type EmbedKind = "passage" | "query";

export interface EmbedRequest {
  texts: string[];
  kind?: EmbedKind;
}

export interface EmbedResponse {
  embeddings: number[][];
  dim: number;
}

class PromptsNotConfiguredError extends Error {
  constructor() {
    super("llm-service: prompts not configured (412)");
    this.name = "PromptsNotConfiguredError";
  }
}

async function fetchJson<T>(
  method: "POST" | "PUT",
  endpoint: string,
  body: unknown,
  timeoutMs?: number,
): Promise<T> {
  const url = `${LLM_SERVICE_URL}${endpoint}`;
  const controller = new AbortController();
  const budget = timeoutMs ?? (await resolveTimeoutMs());
  const timer = setTimeout(() => controller.abort(), budget);
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err: any) {
    throw new LlmServiceUnavailableError(
      `${method} ${url} failed: ${err?.message ?? String(err)}`,
    );
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 412) {
    throw new PromptsNotConfiguredError();
  }
  // >=500/408/429 are treated as transient — scan-worker.ts defers the job for
  // an unbounded retry (no attempt cap, see scan-queue.ts deferJob). A 422
  // ("classify" schema-mismatch, see llm-service/main.py) deliberately falls
  // through to the plain Error below instead: it reflects a real fact about
  // the document (e.g. an out-of-range tax_year) rather than a transient
  // outage, so it must surface as a hard failure — not loop forever.
  if (res.status >= 500 || res.status === 408 || res.status === 429) {
    const detail = await safeBody(res);
    throw new LlmServiceUnavailableError(
      `${method} ${url} returned ${res.status}: ${detail}`,
    );
  }
  if (!res.ok) {
    const detail = await safeBody(res);
    throw new Error(`${method} ${url} returned ${res.status}: ${detail}`);
  }
  return (await res.json()) as T;
}

function postJson<T>(endpoint: string, body: unknown, timeoutMs?: number): Promise<T> {
  return fetchJson("POST", endpoint, body, timeoutMs);
}

async function safeBody(res: Response): Promise<string> {
  try {
    const text = await res.text();
    return text.slice(0, 500);
  } catch {
    return "<unreadable body>";
  }
}

async function pushPrompts(): Promise<void> {
  await fetchJson("PUT", "/prompts", CLASSIFY_PROMPTS);
}

// The llm-service caches the prompts it was last given (in-memory
// `_CLASSIFY_PROMPTS`) and only reports "not configured" (412) until the first
// push. A long-running service therefore keeps STALE prompts across an app
// redeploy — so a prompt edit (classify-prompts.ts) would silently not take
// effect until the service happened to restart, contradicting this module's
// "iterating on prompts needs only an app redeploy" design. To make that true,
// each app process pushes the current prompts once, lazily, before its first
// classify, overwriting whatever the service had. Idempotent; the guard makes
// concurrent first-calls share a single push.
let promptSync: Promise<void> | null = null;
function ensurePromptsFresh(): Promise<void> {
  if (!promptSync) {
    promptSync = pushPrompts().catch((err) => {
      // Don't cache a failure: a transient outage (service still loading its
      // model) must not permanently skip the refresh. The 412 path below still
      // configures a genuinely-unconfigured service.
      promptSync = null;
      throw err;
    });
  }
  return promptSync;
}

export async function classifyDocument(req: ClassifyRequest): Promise<Classification> {
  // Best-effort one-time refresh so this process's prompts win over whatever a
  // long-running service cached. Non-fatal on failure — fall through to the
  // classify call, whose 412 handler still configures an unconfigured service.
  try {
    await ensurePromptsFresh();
  } catch {
    /* handled by the 412 path below if the service is truly unconfigured */
  }

  let raw: unknown;
  try {
    raw = await postJson<unknown>("/classify", req);
  } catch (err) {
    if (!(err instanceof PromptsNotConfiguredError)) throw err;
    await pushPrompts();
    raw = await postJson<unknown>("/classify", req);
  }
  return parseClassification(raw);
}

export async function embedTexts(
  texts: string[],
  kind: EmbedKind = "passage",
): Promise<number[][]> {
  if (texts.length === 0) return [];
  const res = await postJson<EmbedResponse>("/embed", { texts, kind } satisfies EmbedRequest);
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
export function parseClassification(raw: unknown): Classification {
  if (!raw || typeof raw !== "object") {
    throw new Error("classify: response was not an object");
  }
  const r = raw as Record<string, unknown>;
  const slug = typeof r.category_slug === "string" ? r.category_slug.trim().toLowerCase() : "";
  if (!slug) throw new Error("classify: missing category_slug");

  const title = typeof r.title === "string" ? r.title.trim() : "";
  const docDate = typeof r.doc_date === "string" && r.doc_date.trim() !== "" ? r.doc_date.trim() : null;
  const sender = typeof r.sender === "string" && r.sender.trim() !== "" ? r.sender.trim() : null;
  const documentNumber = typeof r.document_number === "string" && r.document_number.trim() !== "" ? r.document_number.trim() : null;
  const summary = typeof r.summary === "string" ? r.summary.trim() : "";
  const tagsRaw = Array.isArray(r.tags) ? r.tags : [];
  const tags = tagsRaw
    .filter((t): t is string => typeof t === "string")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  const conf = clamp01(r.confidence);

  return {
    category_slug: slug,
    title,
    doc_date: docDate,
    sender,
    document_number: documentNumber,
    summary,
    tags,
    confidence: conf,
    ...parseDocumentType(r),
    ...parseTaxFields(r),
  };
}

/** Validate the single document-type slug the classifier returned against the
 *  fixed vocabulary. An invalid/absent slug yields `null` (type unknown) rather
 *  than a forced fallback, so the document stays untyped instead of mislabelled. */
function parseDocumentType(r: Record<string, unknown>): {
  document_type: string | null;
  document_type_confidence: number;
} {
  const raw = typeof r.document_type === "string" ? r.document_type.trim().toLowerCase() : "";
  if (!raw || !isValidDocumentTypeSlug(raw)) {
    return { document_type: null, document_type_confidence: 0 };
  }
  return { document_type: raw, document_type_confidence: clamp01(r.document_type_confidence) };
}

function parseTaxFields(r: Record<string, unknown>): {
  tax_relevant: boolean;
  tax_year: number | null;
  tax_year_confidence: number;
  tax_sections: TaxAssignment[];
} {
  const tax_relevant = r.tax_relevant === true;

  const yr = r.tax_year;
  const tax_year =
    typeof yr === "number" && Number.isInteger(yr) && yr >= TAX_YEAR_MIN && yr <= TAX_YEAR_MAX
      ? yr
      : null;

  const tax_year_confidence = clamp01(r.tax_year_confidence);

  const sectionsRaw = Array.isArray(r.tax_sections) ? r.tax_sections : [];
  const bySlug = new Map<string, TaxAssignment>();
  for (const entry of sectionsRaw) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const s = typeof e.slug === "string" ? e.slug.trim().toLowerCase() : "";
    if (!s || !isValidTaxSectionSlug(s)) continue;
    const c = clamp01(e.confidence);
    const prev = bySlug.get(s);
    if (!prev || c > prev.confidence) bySlug.set(s, { slug: s, confidence: c });
  }

  // Drop sections with 0 confidence and keep the order deterministic.
  const tax_sections = Array.from(bySlug.values())
    .filter((s) => s.confidence > 0)
    .sort((a, b) => b.confidence - a.confidence || a.slug.localeCompare(b.slug));

  // If nothing passed validation, don't pretend the document is tax-relevant —
  // a `tax_relevant=true` without any section is useless downstream.
  const coercedRelevant = tax_sections.length === 0 ? false : tax_relevant;

  return {
    tax_relevant: coercedRelevant,
    tax_year: coercedRelevant ? tax_year : null,
    tax_year_confidence: coercedRelevant ? tax_year_confidence : 0,
    tax_sections,
  };
}

function clamp01(v: unknown): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return 0;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}
