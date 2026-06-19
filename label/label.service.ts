/**
 * Label module business logic.
 *
 * Talks to a remote CUPS server (e.g. a Raspberry Pi with a DYMO
 * LabelWriter 450) over IPP-via-HTTP to:
 *   - enumerate the printers CUPS exposes, and
 *   - submit text/plain print jobs to a chosen queue (CUPS rasterizes the
 *     text onto the loaded label via the printer's driver/PPD).
 *
 * The CUPS server address is infrastructure, shared by all users, so it
 * comes from the CUPS_SERVER_URL env var (consistent with the other
 * service URLs in .env.example). The per-user printer *selection* is
 * persisted in users.label_prefs.
 */

import { APIError } from "encore.dev/api";
import { eq } from "drizzle-orm";
import db from "../db/database";
import { dbExec, dbFirst } from "../db/adapter";
import { users } from "../db/schema";
import {
  buildGetPrintersRequest,
  buildPrintJobRequest,
  parseIppResponse,
  parsePrinters,
  IPP_STATUS_OK_MAX,
  type CupsPrinter,
} from "./ipp";

const DEFAULT_CUPS_URL = "http://localhost:631";

/** Base URL of the CUPS server, normalized without a trailing slash. */
export function getCupsBaseUrl(): string {
  const raw = process.env.CUPS_SERVER_URL?.trim();
  const url = raw && raw.length > 0 ? raw : DEFAULT_CUPS_URL;
  return url.replace(/\/+$/, "");
}

/** Map an IPP printer-state enum to a German label for the UI. */
export function stateLabel(state: number | null): string {
  switch (state) {
    case 3:
      return "Bereit";
    case 4:
      return "Druckt";
    case 5:
      return "Gestoppt";
    default:
      return "Unbekannt";
  }
}

let requestCounter = 0;
function nextRequestId(): number {
  // Wrap before 2^31 so it always fits an unsigned 32-bit field.
  requestCounter = (requestCounter + 1) % 0x7fffffff;
  return requestCounter + 1;
}

/** POST an IPP message to the CUPS server and return the raw response bytes. */
async function ippRequest(path: string, body: Buffer): Promise<Buffer> {
  const url = getCupsBaseUrl() + path;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/ipp" },
      body,
    });
  } catch (err) {
    throw APIError.unavailable(
      `CUPS-Server nicht erreichbar (${getCupsBaseUrl()}): ${(err as Error).message}`,
    );
  }
  if (!res.ok) {
    throw APIError.unavailable(
      `CUPS-Server antwortete mit HTTP ${res.status} ${res.statusText}`,
    );
  }
  const arr = await res.arrayBuffer();
  return Buffer.from(arr);
}

/** List the printers the configured CUPS server exposes. */
export async function listPrinters(): Promise<CupsPrinter[]> {
  const respBuf = await ippRequest("/", buildGetPrintersRequest(nextRequestId()));
  return parsePrinters(parseIppResponse(respBuf));
}

export interface PrintLabelInput {
  printer: string;
  text: string;
  copies: number;
  user: string;
}

/** Submit a text label to a CUPS queue. Throws on rejection. */
export async function printLabel(input: PrintLabelInput): Promise<void> {
  const base = getCupsBaseUrl();
  const host = new URL(base).host;
  const printerUri = `ipp://${host}/printers/${input.printer}`;

  const reqBuf = buildPrintJobRequest({
    printerUri,
    user: input.user,
    jobName: "fk-encore label",
    text: input.text,
    copies: input.copies,
    requestId: nextRequestId(),
  });

  const respBuf = await ippRequest(
    `/printers/${encodeURIComponent(input.printer)}`,
    reqBuf,
  );
  const resp = parseIppResponse(respBuf);
  if (resp.statusCode > IPP_STATUS_OK_MAX) {
    throw APIError.internal(
      `Druckauftrag abgelehnt (IPP-Status 0x${resp.statusCode
        .toString(16)
        .padStart(4, "0")})`,
    );
  }
}

// ---------- Per-user preferences ----------

export interface LabelPrefs {
  /** The CUPS queue name the user last selected. */
  printer?: string;
}

export async function getLabelPrefs(userId: number): Promise<LabelPrefs> {
  const row = await dbFirst<{ label_prefs: unknown }>(
    db.select({ label_prefs: users.label_prefs }).from(users).where(eq(users.id, userId)),
  );
  if (!row || typeof row.label_prefs !== "object" || row.label_prefs === null) {
    return {};
  }
  return row.label_prefs as LabelPrefs;
}

export async function setLabelPrefs(userId: number, prefs: LabelPrefs): Promise<void> {
  await dbExec(
    db.update(users).set({ label_prefs: prefs }).where(eq(users.id, userId)),
  );
}
