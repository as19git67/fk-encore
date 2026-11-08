/**
 * Scanner labels — HTTP endpoints (layout in scanner-sheet.ts).
 *
 *   GET    /label/scanner                → next number, offset and the sheets
 *   PUT    /label/scanner/settings       → set the next number and the offset
 *   POST   /label/scanner/sheets         → create a sheet, advance the number
 *   GET    /label/scanner/sheets/:id/pdf → the sheet as PDF
 *   DELETE /label/scanner/sheets/:id     → remove it from the list
 *   GET    /label/scanner/test-pdf       → one page with outlines, no numbers used
 *
 * Seeing the list needs `label.view`; anything that uses up numbers or
 * changes the settings needs `label.print`. Numbers and sheets are per user.
 */

import { api, APIError } from "encore.dev/api";
import type { IncomingMessage, ServerResponse } from "node:http";
import { and, desc, eq } from "drizzle-orm";
import { getAuthData } from "~encore/auth";
import db from "../db/database";
import { labelScannerSheets, users } from "../db/schema";
import { requirePermission } from "../user/auth-handler";
import type { LabelPrefs } from "./label.service";
import {
  LABELS_PER_PAGE,
  MAX_NUMBER,
  MAX_OFFSET_MM,
  MAX_PAGES,
  SHEET,
  labelText,
  lastNumber,
  renderSheetPdf,
} from "./scanner-sheet";

function requireUser(permission: string): number {
  const auth = getAuthData();
  if (!auth) throw APIError.unauthenticated("Unauthorized");
  requirePermission(auth, permission);
  return parseInt(auth.userID, 10);
}

export interface ScannerSettings {
  nextNumber: number;
  offsetXMm: number;
  offsetYMm: number;
}

function settingsOf(prefs: LabelPrefs): ScannerSettings {
  const n = prefs.scannerNextNumber;
  return {
    nextNumber: Number.isInteger(n) && n! >= 1 ? n! : 1,
    offsetXMm: clampOffset(prefs.scannerOffsetXMm),
    offsetYMm: clampOffset(prefs.scannerOffsetYMm),
  };
}

function clampOffset(v: unknown): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return 0;
  return Math.max(-MAX_OFFSET_MM, Math.min(MAX_OFFSET_MM, Math.round(v * 10) / 10));
}

async function readSettings(userId: number): Promise<ScannerSettings> {
  const [row] = await db.select({ prefs: users.label_prefs }).from(users).where(eq(users.id, userId));
  return settingsOf((row?.prefs ?? {}) as LabelPrefs);
}

export interface ScannerSheetDto {
  id: number;
  firstNumber: number;
  lastNumber: number;
  /** "#0001 – #0189", as printed. */
  range: string;
  pages: number;
  labels: number;
  createdAt: string;
}

function toDto(row: { id: number; first_number: number; pages: number; created_at: string }): ScannerSheetDto {
  const last = lastNumber({ firstNumber: row.first_number, pages: row.pages });
  return {
    id: row.id,
    firstNumber: row.first_number,
    lastNumber: last,
    range: `${labelText(row.first_number)} – ${labelText(last)}`,
    pages: row.pages,
    labels: row.pages * LABELS_PER_PAGE,
    createdAt: row.created_at,
  };
}

interface ScannerOverview extends ScannerSettings {
  sheet: { name: string; columns: number; rows: number; labelsPerPage: number; maxPages: number };
  sheets: ScannerSheetDto[];
}

const LIST_LIMIT = 100;

export const scannerOverview = api(
  { expose: true, method: "GET", path: "/label/scanner", auth: true },
  async (): Promise<ScannerOverview> => {
    const userId = requireUser("label.view");
    const settings = await readSettings(userId);
    const rows = await db
      .select()
      .from(labelScannerSheets)
      .where(eq(labelScannerSheets.user_id, userId))
      .orderBy(desc(labelScannerSheets.created_at), desc(labelScannerSheets.id))
      .limit(LIST_LIMIT);
    return {
      ...settings,
      sheet: {
        name: SHEET.name,
        columns: SHEET.columns,
        rows: SHEET.rows,
        labelsPerPage: LABELS_PER_PAGE,
        maxPages: MAX_PAGES,
      },
      sheets: rows.map(toDto),
    };
  },
);

interface SaveSettingsRequest {
  nextNumber?: number;
  offsetXMm?: number;
  offsetYMm?: number;
}

export const saveScannerSettings = api(
  { expose: true, method: "PUT", path: "/label/scanner/settings", auth: true },
  async (req: SaveSettingsRequest): Promise<ScannerSettings> => {
    const userId = requireUser("label.print");
    const patch: Partial<LabelPrefs> = {};
    if (req.nextNumber !== undefined) {
      if (!Number.isInteger(req.nextNumber) || req.nextNumber < 1 || req.nextNumber > MAX_NUMBER) {
        throw APIError.invalidArgument(`Die nächste Nummer muss zwischen 1 und ${MAX_NUMBER} liegen`);
      }
      patch.scannerNextNumber = req.nextNumber;
    }
    for (const key of ["offsetXMm", "offsetYMm"] as const) {
      const v = req[key];
      if (v === undefined) continue;
      if (typeof v !== "number" || !Number.isFinite(v) || Math.abs(v) > MAX_OFFSET_MM) {
        throw APIError.invalidArgument(`Der Versatz muss zwischen −${MAX_OFFSET_MM} und ${MAX_OFFSET_MM} mm liegen`);
      }
      patch[key === "offsetXMm" ? "scannerOffsetXMm" : "scannerOffsetYMm"] = clampOffset(v);
    }
    return db.transaction(async (tx) => {
      const [row] = await tx
        .select({ prefs: users.label_prefs })
        .from(users)
        .where(eq(users.id, userId))
        .for("update");
      const next = { ...((row?.prefs ?? {}) as LabelPrefs), ...patch };
      await tx.update(users).set({ label_prefs: next }).where(eq(users.id, userId));
      return settingsOf(next);
    });
  },
);

interface CreateSheetRequest {
  /** Defaults to 1. */
  pages?: number;
}

interface CreateSheetResponse {
  sheet: ScannerSheetDto;
  nextNumber: number;
}

export const createScannerSheet = api(
  { expose: true, method: "POST", path: "/label/scanner/sheets", auth: true },
  async (req: CreateSheetRequest): Promise<CreateSheetResponse> => {
    const userId = requireUser("label.print");
    const pages = req.pages ?? 1;
    if (!Number.isInteger(pages) || pages < 1 || pages > MAX_PAGES) {
      throw APIError.invalidArgument(`Es gehen 1 bis ${MAX_PAGES} Seiten auf einmal`);
    }
    // Locking the user row makes two quick clicks take consecutive ranges
    // instead of the same one.
    return db.transaction(async (tx) => {
      const [row] = await tx
        .select({ prefs: users.label_prefs })
        .from(users)
        .where(eq(users.id, userId))
        .for("update");
      const prefs = (row?.prefs ?? {}) as LabelPrefs;
      const first = settingsOf(prefs).nextNumber;
      const last = lastNumber({ firstNumber: first, pages });
      if (last > MAX_NUMBER) {
        throw APIError.failedPrecondition(`Die Nummern reichen nur bis ${labelText(MAX_NUMBER)}`);
      }
      const [sheet] = await tx
        .insert(labelScannerSheets)
        .values({ user_id: userId, first_number: first, pages })
        .returning();
      await tx
        .update(users)
        .set({ label_prefs: { ...prefs, scannerNextNumber: last + 1 } })
        .where(eq(users.id, userId));
      return { sheet: toDto(sheet!), nextNumber: last + 1 };
    });
  },
);

export const deleteScannerSheet = api(
  { expose: true, method: "DELETE", path: "/label/scanner/sheets/:id", auth: true },
  async ({ id }: { id: number }): Promise<{ deleted: boolean }> => {
    const userId = requireUser("label.print");
    const removed = await db
      .delete(labelScannerSheets)
      .where(and(eq(labelScannerSheets.id, id), eq(labelScannerSheets.user_id, userId)))
      .returning({ id: labelScannerSheets.id });
    if (removed.length === 0) throw APIError.notFound("Etikettenblatt nicht gefunden");
    return { deleted: true };
  },
);

function sendError(res: ServerResponse, err: unknown): void {
  const status =
    err instanceof APIError
      ? ({ not_found: 404, unauthenticated: 401, permission_denied: 403, invalid_argument: 400 } as Record<
          string,
          number
        >)[err.code] ?? 500
      : 500;
  res.statusCode = status;
  res.end(err instanceof Error ? err.message : "error");
}

function sendPdf(res: ServerResponse, filename: string, doc: PDFKit.PDFDocument): void {
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
  );
  doc.pipe(res);
  doc.end();
}

/** File name of a sheet, without "#" (a fragment marker in URLs and shells). */
export function sheetFilename(first: number, last: number): string {
  const pad = (n: number) => String(n).padStart(4, "0");
  return `Scanner-Etiketten ${pad(first)}-${pad(last)}.pdf`;
}

export const scannerSheetPdf = api.raw(
  { expose: true, method: "GET", path: "/label/scanner/sheets/:id/pdf", auth: true },
  async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const userId = requireUser("label.view");
      const id = Number((req.url ?? "").split("?")[0]!.split("/").at(-2));
      if (!Number.isInteger(id)) throw APIError.invalidArgument("Ungültige ID");
      const [row] = await db
        .select()
        .from(labelScannerSheets)
        .where(and(eq(labelScannerSheets.id, id), eq(labelScannerSheets.user_id, userId)));
      if (!row) throw APIError.notFound("Etikettenblatt nicht gefunden");
      const settings = await readSettings(userId);
      const spec = {
        firstNumber: row.first_number,
        pages: row.pages,
        offsetXMm: settings.offsetXMm,
        offsetYMm: settings.offsetYMm,
      };
      sendPdf(res, sheetFilename(spec.firstNumber, lastNumber(spec)), renderSheetPdf(spec));
    } catch (err) {
      sendError(res, err);
    }
  },
);

export const scannerTestPdf = api.raw(
  { expose: true, method: "GET", path: "/label/scanner/test-pdf", auth: true },
  async (_req: IncomingMessage, res: ServerResponse) => {
    try {
      const userId = requireUser("label.view");
      const settings = await readSettings(userId);
      const doc = renderSheetPdf(
        {
          firstNumber: settings.nextNumber,
          pages: 1,
          offsetXMm: settings.offsetXMm,
          offsetYMm: settings.offsetYMm,
          outlines: true,
        },
        "Probeseite Scanner-Etiketten",
      );
      sendPdf(res, "Scanner-Etiketten Probeseite.pdf", doc);
    } catch (err) {
      sendError(res, err);
    }
  },
);
