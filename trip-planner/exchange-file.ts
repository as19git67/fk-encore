/**
 * The exchange files as a ZIP archive, named with date and time
 * (format in `exchange-format.ts`, rows in `exchange.ts`).
 *
 *   - `POST /trip-planner/export-file` — one trip, the ideas or
 *     everything, as `Beispielreise 2026-11-14 23-40.zip` holding the
 *     same name with `.json`, indented so a person can read it.
 *   - `POST /trip-planner/import-file` — takes the ZIP (or the bare
 *     JSON inside it), finds what it holds by its `format` and imports
 *     it the way the JSON endpoints do.
 *
 * Bytes travel as base64 inside the JSON body: one typed endpoint
 * each, the same client call as everywhere else in the app.
 */

import { api, APIError } from "encore.dev/api";
import JSZip from "jszip";
import { and, eq } from "drizzle-orm";
import db from "../db/database";
import { tripPlans } from "../db/schema";
import { isOnTrip } from "./plan-access";
import { requireAccess } from "./ideas";
import {
  ExchangeFileError,
  IDEAS_FORMAT,
  PLANNER_FORMAT,
  readIdeasFile,
  readPlannerFile,
  readTripFile,
  TRIP_FORMAT,
} from "./exchange-format";
import {
  exportIdeas,
  exportPlanner,
  exportTrip,
  importIdeas,
  importPlanner,
  importTrip,
  refuse,
  requireUser,
  type IdeasImportResult,
} from "./exchange";

export type ExchangeKind = "trip" | "ideas" | "all";

/** Past this the file is not a trip planner export. */
const MAX_FILE_BYTES = 50 * 1024 * 1024;

/** "2026-11-14 23-40" in the person's own time; colons are not allowed in a file name. */
export function fileStamp(now: Date, timeZone?: string): string {
  let zone = "Europe/Berlin";
  if (timeZone) {
    try {
      new Intl.DateTimeFormat("de-DE", { timeZone });
      zone = timeZone;
    } catch {
      // An unknown zone falls back rather than failing the export.
    }
  }
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("de-DE", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(now).map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}-${parts.minute}`;
}

/** A name that every disk accepts: no slashes, colons or control characters. */
export function safeBaseName(name: string | null | undefined, fallback: string): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = (name ?? "").replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "-").replace(/\s+/g, " ").trim();
  return (cleaned || fallback).slice(0, 80);
}

/** The JSON, indented, in a ZIP of its own name. */
export async function packFile(file: unknown, baseName: string): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(`${baseName}.json`, JSON.stringify(file, null, 2) + "\n");
  return await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 9 } });
}

/** The JSON value in a ZIP or a bare JSON file. Throws `ExchangeFileError`. */
export async function unpackFile(bytes: Buffer): Promise<unknown> {
  if (bytes.length === 0) throw new ExchangeFileError(["Die Datei ist leer."]);
  if (bytes.length > MAX_FILE_BYTES) throw new ExchangeFileError(["Die Datei ist größer als 50 MB."]);
  let text: string;
  // "PK\x03\x04" starts every ZIP archive.
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
    let zip: JSZip;
    try {
      zip = await JSZip.loadAsync(bytes);
    } catch {
      throw new ExchangeFileError(["Die ZIP-Datei lässt sich nicht öffnen."]);
    }
    const entries = Object.values(zip.files).filter((f) =>
      !f.dir && f.name.toLowerCase().endsWith(".json") && !f.name.startsWith("__MACOSX/")
      && !f.name.split("/").pop()!.startsWith("."));
    if (entries.length === 0) throw new ExchangeFileError(["In der ZIP-Datei ist keine JSON-Datei."]);
    if (entries.length > 1) {
      throw new ExchangeFileError([`In der ZIP-Datei sind ${entries.length} JSON-Dateien, erwartet wird eine.`]);
    }
    text = await entries[0].async("string");
  } else {
    text = bytes.toString("utf8");
  }
  try {
    return JSON.parse(text.replace(/^﻿/, ""));
  } catch {
    throw new ExchangeFileError(["Die Datei ist weder eine ZIP-Datei noch gültiges JSON."]);
  }
}

/** Which kind of export a parsed file says it is; null when it says none we know. */
export function kindOf(value: unknown): ExchangeKind | null {
  const format = value !== null && typeof value === "object" ? (value as { format?: unknown }).format : undefined;
  if (format === TRIP_FORMAT) return "trip";
  if (format === IDEAS_FORMAT) return "ideas";
  if (format === PLANNER_FORMAT) return "all";
  return null;
}

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

export interface ExportFileRequest {
  /** One trip (`planId`), the idea collection, or every trip and the ideas. */
  what: ExchangeKind;
  planId?: number;
  /** Whose ideas; your own by default. */
  ownerId?: number;
  /** IANA zone for the time in the file name; Europe/Berlin by default. */
  timeZone?: string;
}

export interface ExportFileResponse {
  /** "Beispielreise 2026-11-14 23-40.zip" */
  fileName: string;
  /** The ZIP archive, base64. */
  zip: string;
}

export const exportTripFile = api(
  { expose: true, method: "POST", path: "/trip-planner/export-file", auth: true },
  async (req: ExportFileRequest): Promise<ExportFileResponse> => {
    const userId = requireUser();
    const now = new Date();
    const stamp = fileStamp(now, req.timeZone);
    let file: unknown;
    let base: string;
    if (req.what === "trip") {
      if (req.planId === undefined) throw APIError.invalidArgument("planId fehlt");
      if (!(await isOnTrip(req.planId, userId))) throw APIError.notFound("plan not found");
      const trip = await exportTrip(req.planId, now);
      if (!trip) throw APIError.notFound("plan not found");
      file = trip;
      base = `${safeBaseName(trip.trip.title, "Reise")} ${stamp}`;
    } else if (req.what === "ideas") {
      const ownerId = req.ownerId === undefined ? userId : await requireAccess(req.ownerId, userId);
      file = await exportIdeas(ownerId, now);
      base = `Ideen ${stamp}`;
    } else if (req.what === "all") {
      file = await exportPlanner(userId, now);
      base = `Reiseplaner ${stamp}`;
    } else {
      throw APIError.invalidArgument("what muss trip, ideas oder all sein");
    }
    const zip = await packFile(file, base);
    return { fileName: `${base}.zip`, zip: zip.toString("base64") };
  },
);

export interface ImportFileRequest {
  /** The ZIP archive (or the bare JSON file), base64. */
  file: string;
  /** What the screen expects; a file of another kind is refused by name. Any kind when absent. */
  expect?: ExchangeKind;
  /** Into whose idea collection; your own by default. */
  ownerId?: number;
}

export interface ImportFileResponse {
  kind: ExchangeKind;
  /** The new trips, in the order of the file. */
  trips: { planId: number; title: string | null }[];
  /** What happened to the ideas; null for a file of one trip. */
  ideas: IdeasImportResult | null;
}

export const importTripFile = api(
  { expose: true, method: "POST", path: "/trip-planner/import-file", auth: true },
  async (req: ImportFileRequest): Promise<ImportFileResponse> => {
    const userId = requireUser();
    let value: unknown;
    try {
      value = await unpackFile(Buffer.from(req.file ?? "", "base64"));
    } catch (error) {
      refuse(error);
    }
    const kind = req.expect ?? kindOf(value) ?? "all";
    try {
      if (kind === "trip") {
        const file = readTripFile(value);
        const planId = await importTrip(file, userId);
        const [row] = await db.select({ title: tripPlans.title }).from(tripPlans)
          .where(and(eq(tripPlans.id, planId), eq(tripPlans.owner_id, userId)));
        return { kind, trips: [{ planId, title: row?.title ?? null }], ideas: null };
      }
      if (kind === "ideas") {
        const file = readIdeasFile(value);
        const ownerId = req.ownerId === undefined ? userId : await requireAccess(req.ownerId, userId);
        return { kind, trips: [], ideas: await importIdeas(file, ownerId, userId) };
      }
      const file = readPlannerFile(value);
      const result = await importPlanner(file, userId);
      return { kind: "all", trips: result.trips, ideas: result.ideas };
    } catch (error) {
      refuse(error);
    }
  },
);
