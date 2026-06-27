/**
 * Typed HTTP client for the `receipt-ocr-service` container.
 *
 * Sends a receipt image and receives structured extraction results
 * (amount, date, store, items) within seconds.
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

const DEFAULT_TIMEOUT_MS = parseInt(
  process.env.RECEIPT_OCR_TIMEOUT_MS ?? "30000",
  10,
);

export class ReceiptOcrUnavailableError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "ReceiptOcrUnavailableError";
  }
}

export interface ReceiptOcrResult {
  amount: number | null;
  date: string | null;
  store: string | null;
  currency: string;
  items: { name: string; amount: number }[];
  raw_text: string;
  ocr_confidence: number;
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
