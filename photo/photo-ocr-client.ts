/**
 * Typed HTTP client for the photo OCR endpoint of `receipt-ocr-service`.
 *
 * The same container serves receipts, document pages and photos, but the
 * photo endpoint (`POST /ocr`) is the only one that answers in coordinates
 * relative to the image — which is what lets a caller put a box around a word
 * without knowing what resolution the recognition ran at.
 *
 * The bearer token for the service is attached by lib/internal-service-auth,
 * which patches fetch for exactly these origins; there is no auth code here.
 */

// Same default as documents/receipt-ocr-client.ts — 8003, deliberately not the
// LLM service's 8002. In Docker the URL comes from compose.
const RECEIPT_OCR_SERVICE_URL = (
  process.env.RECEIPT_OCR_SERVICE_URL || "http://localhost:8003"
).replace(/\/$/, "");

// Photo OCR is background work: nothing interactive waits for it, but the
// service serialises inference at concurrency 1, so a call may well sit in
// that queue behind a receipt before it starts.
const PHOTO_OCR_TIMEOUT_MS = parseInt(
  process.env.PHOTO_OCR_TIMEOUT_MS ?? "120000",
  10,
);

/** The service is down, busy or overloaded — retry later, don't fail the photo. */
export class PhotoOcrUnavailableError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "PhotoOcrUnavailableError";
  }
}

/** One recognised line, geometry relative to the image (0..1 on both axes). */
export interface PhotoOcrLine {
  text: string;
  confidence: number;
  /** Four [x, y] corner points — the detector's quad, not an aligned box. */
  polygon: [number, number][];
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface PhotoOcrResponse {
  lines: PhotoOcrLine[];
  full_text: string;
  mean_confidence: number;
  processing_ms: number;
}

/**
 * Recognise the text in a photo.
 *
 * Throws `PhotoOcrUnavailableError` for a service that is down or busy (the
 * caller requeues), and a plain Error for a request this photo will never
 * survive (an undecodable or oversized image), which counts as an attempt.
 */
export async function ocrPhoto(
  imageBuffer: Buffer,
  opts: {
    filename?: string;
    mimeType?: string;
    /** Long edge the service scales the photo to before recognition. */
    maxLongSide?: number;
    timeoutMs?: number;
  } = {},
): Promise<PhotoOcrResponse> {
  const url = `${RECEIPT_OCR_SERVICE_URL}/ocr`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? PHOTO_OCR_TIMEOUT_MS);

  const formData = new FormData();
  formData.append(
    "file",
    new Blob([imageBuffer], { type: opts.mimeType ?? "image/jpeg" }),
    opts.filename ?? "photo.jpg",
  );
  // Sent explicitly rather than left to the service's own default, so the
  // budget the row records is the budget that was actually used.
  if (opts.maxLongSide !== undefined) {
    formData.append("max_long_side", String(opts.maxLongSide));
  }

  let res: Response;
  try {
    res = await fetch(url, { method: "POST", body: formData, signal: controller.signal });
  } catch (err: any) {
    throw new PhotoOcrUnavailableError(`POST ${url} failed: ${err?.message ?? String(err)}`);
  } finally {
    clearTimeout(timer);
  }

  // 503 is what the service answers when its single inference slot stayed
  // taken for 30 s, so it belongs with the other "come back later" codes.
  if (res.status >= 500 || res.status === 408 || res.status === 429) {
    throw new PhotoOcrUnavailableError(`POST ${url} returned ${res.status}: ${await safeBody(res)}`);
  }
  if (!res.ok) {
    throw new Error(`POST ${url} returned ${res.status}: ${await safeBody(res)}`);
  }

  return (await res.json()) as PhotoOcrResponse;
}

export async function isPhotoOcrHealthy(timeoutMs = 2000): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${RECEIPT_OCR_SERVICE_URL}/healthz`, { signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function safeBody(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 500);
  } catch {
    return "<unreadable>";
  }
}
