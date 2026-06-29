/**
 * Typed HTTP client for the `receipt-ocr-service` container.
 *
 * Two-stage extraction: `extractReceipt` returns the save-critical core fields
 * (amount, date, store, currency) fast; `extractReceiptItems` fetches the line
 * items from the OCR text in a separate, asynchronous call.
 */

// Default port is 8003 — deliberately distinct from the LLM service's 8002
// (see documents/llm-client.ts). They used to share localhost:8002, so an
// unset RECEIPT_OCR_SERVICE_URL silently routed receipt OCR calls to the LLM
// service, which answered 503/404. In Docker the URL is wired explicitly via
// compose (http://receipt_ocr_service:8000); this default only applies to
// local `encore run`.
const RECEIPT_OCR_SERVICE_URL = (
  process.env.RECEIPT_OCR_SERVICE_URL || "http://localhost:8003"
).replace(/\/$/, "");

// 120s default: PaddleOCR + the Qwen-3B extraction on a CPU-only box that
// shares its cores with the other ML services can take well over the old 30s.
// Keep this below the frontend's request timeout so a real timeout surfaces
// as a meaningful 502 here rather than the browser aborting first. Override
// via RECEIPT_OCR_TIMEOUT_MS on faster hardware.
const DEFAULT_TIMEOUT_MS = parseInt(
  process.env.RECEIPT_OCR_TIMEOUT_MS ?? "120000",
  10,
);

export class ReceiptOcrUnavailableError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "ReceiptOcrUnavailableError";
  }
}

export interface ReceiptItem {
  name: string;
  amount: number;
}

export interface ReceiptOcrResult {
  amount: number | null;
  date: string | null;
  store: string | null;
  currency: string;
  items: ReceiptItem[];
  raw_text: string;
  ocr_confidence: number;
  processing_ms: number;
  /**
   * Base64-encoded JPEG of the geometry-corrected receipt (cropped,
   * perspective-de-warped and rotated upright by the service). Present only
   * when the service actually changed the image; the worker uses it to replace
   * the stored PDF so the viewed document is straight and upright. Null/absent
   * when no correction was applied.
   */
  corrected_image?: string | null;
}

export interface ReceiptItemsResult {
  items: ReceiptItem[];
  processing_ms: number;
}

export async function extractReceipt(
  imageBuffer: Buffer,
  filename = "receipt.jpg",
  mimeType = "image/jpeg",
): Promise<ReceiptOcrResult> {
  const url = `${RECEIPT_OCR_SERVICE_URL}/extract`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  const formData = new FormData();
  formData.append("file", new Blob([imageBuffer], { type: mimeType }), filename);

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      body: formData,
      signal: controller.signal,
    });
  } catch (err: any) {
    throw new ReceiptOcrUnavailableError(
      `POST ${url} failed: ${err?.message ?? String(err)}`,
    );
  } finally {
    clearTimeout(timer);
  }

  if (res.status >= 500 || res.status === 408 || res.status === 429) {
    const detail = await safeBody(res);
    throw new ReceiptOcrUnavailableError(
      `POST ${url} returned ${res.status}: ${detail}`,
    );
  }
  if (!res.ok) {
    const detail = await safeBody(res);
    throw new Error(`POST ${url} returned ${res.status}: ${detail}`);
  }

  return (await res.json()) as ReceiptOcrResult;
}

/**
 * Second-stage extraction: line items from the already-OCR'd text returned by
 * `extractReceipt` (`raw_text`). Heavier than the core extraction, so it is run
 * asynchronously and must never block saving a transaction.
 */
export async function extractReceiptItems(text: string): Promise<ReceiptItemsResult> {
  const url = `${RECEIPT_OCR_SERVICE_URL}/extract/items`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
      signal: controller.signal,
    });
  } catch (err: any) {
    throw new ReceiptOcrUnavailableError(
      `POST ${url} failed: ${err?.message ?? String(err)}`,
    );
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const detail = await safeBody(res);
    throw new Error(`POST ${url} returned ${res.status}: ${detail}`);
  }

  return (await res.json()) as ReceiptItemsResult;
}

export async function isReceiptOcrHealthy(timeoutMs = 2000): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${RECEIPT_OCR_SERVICE_URL}/healthz`, {
      signal: controller.signal,
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function safeBody(res: Response): Promise<string> {
  try {
    const text = await res.text();
    return text.slice(0, 500);
  } catch {
    return "<unreadable body>";
  }
}
