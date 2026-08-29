/**
 * Typed HTTP client for `llm-service`'s `POST /vision/transcribe`.
 *
 * Separate from `llm-client.ts` on purpose. That module owns classification,
 * carries the prompt push and the per-model timeout lookup, and is called once
 * per document; this one is called several times per *page*, inside the text
 * extraction budget, and must fail fast and silently. Mixing them would mean a
 * vision timeout inheriting a classification's minutes-long budget.
 */

console.log("[boot] documents/vlm-client.ts: all imports resolved");

const LLM_SERVICE_URL = (process.env.LLM_SERVICE_URL || "http://localhost:8002").replace(/\/$/, "");

/**
 * Per-crop budget. A crop is a few dozen tokens of output over one small
 * image, so this is generous for the work itself — the time goes into waiting
 * for the single inference worker, which a classification can hold for a
 * minute. Beyond that the resolver is better off leaving the OCR reading in
 * place than holding up the queue.
 */
const VLM_TIMEOUT_MS = parseInt(process.env.DOCUMENTS_OCR_VLM_TIMEOUT_MS ?? "90000", 10);

/**
 * Per-page budget for the field-assignment call. Longer than a crop's: the
 * image is a whole page, and prefilling it dominates the call.
 */
const FIELDS_TIMEOUT_MS = parseInt(
  process.env.DOCUMENTS_OCR_FIELD_VLM_TIMEOUT_MS ?? "180000",
  10,
);

export type VlmExpectedType = "date" | "amount" | "iban" | "document_number" | "text";

export interface VlmTranscription {
  text: string;
  /** The model's own certainty, 0..1. Not comparable to an OCR confidence. */
  confidence: number;
  model: string;
  processing_ms: number;
}

/**
 * Raised for every failure mode the caller treats identically: no projector
 * loaded, service down, busy, timed out. The resolver catches it and keeps the
 * OCR reading, so a vision path that is not deployed simply does nothing.
 */
export class VlmUnavailableError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "VlmUnavailableError";
  }
}

/**
 * Transcribe one crop.
 *
 * `hint` is the OCR reading. Passing it helps the model on genuinely ambiguous
 * glyphs, and the endpoint is explicit that it is unreliable — but it is
 * optional precisely so a measurement can ask the model *without* the hint and
 * see whether it is transcribing or merely agreeing.
 */
export async function transcribeCrop(
  imagePng: Buffer,
  options: { hint?: string; expectedType?: VlmExpectedType; timeoutMs?: number } = {},
): Promise<VlmTranscription> {
  const url = `${LLM_SERVICE_URL}/vision/transcribe`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? VLM_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        image_b64: imagePng.toString("base64"),
        image_mime: "image/png",
        ...(options.hint ? { hint: options.hint } : {}),
        ...(options.expectedType ? { expected_type: options.expectedType } : {}),
      }),
      signal: controller.signal,
    });
  } catch (err: any) {
    throw new VlmUnavailableError(`POST ${url} failed: ${err?.message ?? String(err)}`);
  } finally {
    clearTimeout(timer);
  }

  // 503 is the normal state of a deployment without a projector, not an error
  // worth escalating — it is the same class of "no second opinion available"
  // as the service being down.
  if (res.status >= 500 || res.status === 408 || res.status === 429) {
    throw new VlmUnavailableError(`POST ${url} returned ${res.status}`);
  }
  if (!res.ok) {
    throw new Error(`POST ${url} returned ${res.status}`);
  }

  return (await res.json()) as VlmTranscription;
}

export interface VlmField {
  label: string;
  value: string;
}

export interface VlmFieldAssignment {
  fields: VlmField[];
  model: string;
  processing_ms: number;
}

/**
 * Ask which value belongs to which label, over a whole page.
 *
 * The expensive call, and the one that needs the most care: a page image is a
 * large input, and a model looking at a whole document has far more room to
 * invent than one looking at a crop. Two things contain that — only labels the
 * caller could not pair are asked about, and the caller drops every returned
 * value that is not already present in the page's OCR text.
 *
 * Its own timeout, longer than a crop's: prefilling a page image takes
 * substantially more than a line of it.
 */
export async function assignFields(
  imagePng: Buffer,
  labels: string[],
  options: { timeoutMs?: number } = {},
): Promise<VlmFieldAssignment> {
  const url = `${LLM_SERVICE_URL}/vision/fields`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? FIELDS_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        image_b64: imagePng.toString("base64"),
        image_mime: "image/png",
        labels,
      }),
      signal: controller.signal,
    });
  } catch (err: any) {
    throw new VlmUnavailableError(`POST ${url} failed: ${err?.message ?? String(err)}`);
  } finally {
    clearTimeout(timer);
  }

  if (res.status >= 500 || res.status === 408 || res.status === 429) {
    throw new VlmUnavailableError(`POST ${url} returned ${res.status}`);
  }
  if (!res.ok) {
    throw new Error(`POST ${url} returned ${res.status}`);
  }

  return (await res.json()) as VlmFieldAssignment;
}

export interface VlmLetterhead {
  date: string | null;
  sender: string | null;
  model: string;
  processing_ms: number;
}

/**
 * Read the two fields a letterhead never labels.
 *
 * Unlike `assignFields` this is asked no labels — that is the point. The date
 * and the sender of a German business letter are identified by where they sit
 * on the page, and every label-driven route to them therefore comes up empty.
 *
 * The answer is a *claim*, not a value: the caller locates it in the page's
 * own OCR words and discards what cannot be found there. Same page-sized
 * budget as the field assignment, for the same reason — prefilling the image
 * dominates the call.
 */
export async function readLetterhead(
  imagePng: Buffer,
  options: { timeoutMs?: number } = {},
): Promise<VlmLetterhead> {
  const url = `${LLM_SERVICE_URL}/vision/letterhead`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? FIELDS_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        image_b64: imagePng.toString("base64"),
        image_mime: "image/png",
      }),
      signal: controller.signal,
    });
  } catch (err: any) {
    throw new VlmUnavailableError(`POST ${url} failed: ${err?.message ?? String(err)}`);
  } finally {
    clearTimeout(timer);
  }

  if (res.status >= 500 || res.status === 408 || res.status === 429) {
    throw new VlmUnavailableError(`POST ${url} returned ${res.status}`);
  }
  if (!res.ok) {
    throw new Error(`POST ${url} returned ${res.status}`);
  }

  return (await res.json()) as VlmLetterhead;
}

export async function isVlmAvailable(timeoutMs = 2000): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${LLM_SERVICE_URL}/healthz`, { signal: controller.signal });
    if (!res.ok) return false;
    const body = (await res.json()) as { llm_mmproj_path?: string | null };
    // Loaded weights are not enough: without the projector every crop would
    // come back 503 after paying the full round trip.
    return Boolean(body.llm_mmproj_path);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
