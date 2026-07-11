/**
 * Utility meters — photo-based reading capture via OCR (Etappe 4).
 *
 *   POST /meters/:id/readings/ocr
 *     Body: raw image bytes (JPEG/PNG)
 *     Headers: Content-Type, X-File-Name (optional)
 *     Returns: { value, confidence, photoPath, rawText }
 *
 * The endpoint stores the photo, sends it to the receipt-ocr-service for
 * digit recognition, and returns a *suggestion*. The frontend shows the
 * value for confirmation — OCR never saves a reading directly.
 */

import { api, APIError } from "encore.dev/api";
import type { IncomingMessage, ServerResponse } from "node:http";
import { getAuthData } from "~encore/auth";
import { requirePermission } from "../user/auth-handler";
import { loadVisibleMeter } from "./meter.service";
import { extractMeterReading, MeterOcrUnavailableError } from "./meter-ocr-client";
import { randomBytes } from "node:crypto";
import path from "node:path";
import fs from "node:fs/promises";

const METERS_DIR = path.resolve(
  process.env.METERS_DIR || "uploads/meters",
);

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

async function readRequestBuffer(req: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const raw of req) {
    const chunk = Buffer.isBuffer(raw)
      ? raw
      : typeof raw === "string"
        ? Buffer.from(raw, "utf8")
        : Buffer.from(raw as Uint8Array);
    size += chunk.length;
    if (size > MAX_IMAGE_BYTES) throw new Error("IMAGE_TOO_LARGE");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

function jsonResponse(
  res: ServerResponse,
  status: number,
  body: Record<string, unknown>,
): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function storePhoto(
  meterId: number,
  imageBuffer: Buffer,
  ext: string,
): Promise<string> {
  const dir = path.join(METERS_DIR, String(meterId));
  await fs.mkdir(dir, { recursive: true });
  const name = `${Date.now()}-${randomBytes(4).toString("hex")}${ext}`;
  const filePath = path.join(dir, name);
  await fs.writeFile(filePath, imageBuffer);
  return filePath;
}

export const ocrReading = api.raw(
  { expose: true, method: "POST", path: "/meters/:id/readings/ocr", auth: true, bodyLimit: null },
  async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const authData = getAuthData();
    if (!authData) {
      jsonResponse(res, 401, { error: "Unauthorized" });
      return;
    }
    try {
      requirePermission(authData, "meters.read_entry");
    } catch {
      jsonResponse(res, 403, { error: "Missing permission: meters.read_entry" });
      return;
    }

    const userId = parseInt(authData.userID, 10);
    const idMatch = (req.url ?? "").match(/\/meters\/(\d+)\/readings\/ocr/);
    const meterId = parseInt(idMatch?.[1] ?? "", 10);
    if (!meterId || isNaN(meterId)) {
      jsonResponse(res, 400, { error: "invalid meter id" });
      return;
    }

    try {
      await loadVisibleMeter(userId, meterId);
    } catch {
      jsonResponse(res, 404, { error: "meter not found" });
      return;
    }

    try {
      const raw = await readRequestBuffer(req);
      if (raw.length === 0) {
        jsonResponse(res, 400, { error: "empty file" });
        return;
      }

      const fileName = (req.headers["x-file-name"] as string) || "meter.jpg";
      const mimeType = ((req.headers["content-type"] as string) || "image/jpeg")
        .toLowerCase()
        .split(";")[0]
        .trim();

      const ext = mimeType === "image/png" ? ".png" : ".jpg";
      const photoPath = await storePhoto(meterId, raw, ext);

      const detail = await loadVisibleMeter(userId, meterId);
      const decimals = detail.decimals ?? 0;

      let ocrResult;
      try {
        ocrResult = await extractMeterReading(
          Buffer.from(raw),
          fileName,
          mimeType,
          decimals,
        );
      } catch (err) {
        if (err instanceof MeterOcrUnavailableError) {
          jsonResponse(res, 503, {
            error: "meter OCR service unavailable",
            message: "Zählerstand-OCR ist momentan nicht erreichbar. Bitte später erneut versuchen oder den Wert manuell eingeben.",
            detail: err.message,
            photoPath,
          });
          return;
        }
        throw err;
      }

      jsonResponse(res, 200, {
        value: ocrResult.value,
        confidence: ocrResult.confidence,
        photoPath,
        rawText: ocrResult.raw_text,
      });
    } catch (err: any) {
      if (err?.message === "IMAGE_TOO_LARGE") {
        jsonResponse(res, 413, {
          error: "image too large (max 20 MB)",
          message: "Das Foto ist zu groß. Bitte ein kleineres Bild verwenden.",
        });
        return;
      }
      console.error("[meter] OCR error:", err);
      jsonResponse(res, 502, {
        error: err?.message ?? "OCR service error",
        message: "Zählerstand-OCR ist fehlgeschlagen. Bitte erneut versuchen oder den Wert manuell eingeben.",
      });
    }
  },
);
