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

import { isValidTaxSectionSlug, type TaxSectionGroup } from "./tax-sections";

console.log("[boot] documents/llm-client.ts: all imports resolved");

const LLM_SERVICE_URL = (process.env.LLM_SERVICE_URL || "http://localhost:8002").replace(/\/$/, "");
const DEFAULT_TIMEOUT_MS = parseInt(process.env.LLM_SERVICE_TIMEOUT_MS ?? "120000", 10);

const TAX_YEAR_MIN = 2000;
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
  // When provided, the classifier additionally decides tax-relevance,
  // tax year, and a list of matching sections. Omit/empty to disable.
  tax_sections?: TaxSectionRequestEntry[];
  // Per-user "Bezugspersonen" — name → relationship tag mappings.
  // When the OCR text mentions one of these names the classifier is
  // instructed to add the corresponding relation_tag to its `tags`
  // output. Omit/empty to disable that behaviour entirely.
  subject_persons?: SubjectPersonRequestEntry[];
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
    ...parseTaxFields(r),
  };
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
