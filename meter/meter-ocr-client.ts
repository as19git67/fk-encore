/**
 * Typed HTTP client for the `receipt-ocr-service` /meter-reading endpoint.
 *
 * Reuses the same service URL as documents/receipt-ocr-client.ts. The meter
 * reading OCR is simpler: no LLM, just PaddleOCR + digit heuristic.
 */

const RECEIPT_OCR_SERVICE_URL = (
  process.env.RECEIPT_OCR_SERVICE_URL || "http://localhost:8003"
).replace(/\/$/, "");

const DEFAULT_TIMEOUT_MS = parseInt(
  process.env.RECEIPT_OCR_TIMEOUT_MS ?? "60000",
  10,
);

export class MeterOcrUnavailableError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "MeterOcrUnavailableError";
  }
}

export interface MeterOcrResult {
  value: number | null;
  confidence: number;
  raw_text: string;
  processing_ms: number;
  corrected_image?: string | null;
}

export async function extractMeterReading(
  imageBuffer: Buffer,
  filename = "meter.jpg",
  mimeType = "image/jpeg",
  decimals = 0,
): Promise<MeterOcrResult> {
  const url = `${RECEIPT_OCR_SERVICE_URL}/meter-reading`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  const formData = new FormData();
  formData.append("file", new Blob([imageBuffer], { type: mimeType }), filename);
  formData.append("decimals", String(decimals));

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      body: formData,
      signal: controller.signal,
    });
  } catch (err: any) {
    throw new MeterOcrUnavailableError(
      `POST ${url} failed: ${err?.message ?? String(err)}`,
    );
  } finally {
    clearTimeout(timer);
  }

  if (res.status >= 500 || res.status === 408 || res.status === 429) {
    const detail = await safeBody(res);
    throw new MeterOcrUnavailableError(
      `POST ${url} returned ${res.status}: ${detail}`,
    );
  }
  if (!res.ok) {
    const detail = await safeBody(res);
    throw new Error(`POST ${url} returned ${res.status}: ${detail}`);
  }

  return (await res.json()) as MeterOcrResult;
}

async function safeBody(res: Response): Promise<string> {
  try {
    const text = await res.text();
    return text.slice(0, 500);
  } catch {
    return "<unreadable body>";
  }
}
