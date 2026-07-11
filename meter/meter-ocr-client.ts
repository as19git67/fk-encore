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

interface ReceiptExtractFallbackResult {
  raw_text?: string;
  ocr_confidence?: number;
  processing_ms?: number;
  corrected_image?: string | null;
}

function buildImageFormData(
  imageBuffer: Buffer,
  filename: string,
  mimeType: string,
  decimals?: number,
): FormData {
  const formData = new FormData();
  formData.append("file", new Blob([new Uint8Array(imageBuffer)], { type: mimeType }), filename);
  if (decimals !== undefined) formData.append("decimals", String(decimals));
  return formData;
}

function extractMeterValue(text: string): { value: number | null; confidence: number } {
  const candidates: Array<{ value: number; digitCount: number; confidence: number }> = [];
  const matches = text.matchAll(/\b(\d{3,})(?:[.,](\d{1,3}))?\b/g);
  for (const match of matches) {
    const integerPart = match[1] ?? "";
    const decimalPart = match[2] ?? "";
    const fullMatch = match[0] ?? "";
    if (/^\d{1,2}[.,]\d{1,2}[.,]\d{2,4}$/.test(fullMatch)) continue;
    const value = Number(decimalPart ? `${integerPart}.${decimalPart}` : integerPart);
    if (!Number.isFinite(value)) continue;
    const digitCount = integerPart.length + decimalPart.length;
    candidates.push({
      value,
      digitCount,
      confidence: Math.min(0.95, 0.5 + 0.07 * digitCount),
    });
  }
  candidates.sort((a, b) => b.digitCount - a.digitCount);
  const best = candidates[0];
  return best ? { value: best.value, confidence: best.confidence } : { value: null, confidence: 0 };
}

async function postForm(url: string, formData: FormData): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    return await fetch(url, {
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
}

async function extractViaReceiptFallback(
  imageBuffer: Buffer,
  filename = "meter.jpg",
  mimeType = "image/jpeg",
): Promise<MeterOcrResult> {
  const url = `${RECEIPT_OCR_SERVICE_URL}/extract`;
  const res = await postForm(url, buildImageFormData(imageBuffer, filename, mimeType));
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

  const fallback = (await res.json()) as ReceiptExtractFallbackResult;
  const rawText = fallback.raw_text ?? "";
  const extracted = extractMeterValue(rawText);
  return {
    value: extracted.value,
    confidence: extracted.value === null ? 0 : Math.max(extracted.confidence, fallback.ocr_confidence ?? 0),
    raw_text: rawText,
    processing_ms: fallback.processing_ms ?? 0,
    corrected_image: fallback.corrected_image ?? null,
  };
}

export async function extractMeterReading(
  imageBuffer: Buffer,
  filename = "meter.jpg",
  mimeType = "image/jpeg",
  decimals = 0,
): Promise<MeterOcrResult> {
  const url = `${RECEIPT_OCR_SERVICE_URL}/meter-reading`;
  const res = await postForm(url, buildImageFormData(imageBuffer, filename, mimeType, decimals));

  if (res.status >= 500 || res.status === 408 || res.status === 429) {
    const detail = await safeBody(res);
    throw new MeterOcrUnavailableError(
      `POST ${url} returned ${res.status}: ${detail}`,
    );
  }
  if (res.status === 404 || res.status === 405) {
    return await extractViaReceiptFallback(imageBuffer, filename, mimeType);
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
