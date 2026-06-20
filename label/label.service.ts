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

import http from "node:http";
import https from "node:https";
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

/**
 * Base URL of the CUPS server, normalized: a scheme is added when missing
 * (CUPS speaks HTTP) and any trailing slash is stripped. So a bare
 * `scanner.schegg.net:631` becomes `http://scanner.schegg.net:631` rather
 * than a malformed URL that makes fetch() fail.
 */
export function getCupsBaseUrl(): string {
  const raw = process.env.CUPS_SERVER_URL?.trim();
  let url = raw && raw.length > 0 ? raw : DEFAULT_CUPS_URL;
  if (!/^https?:\/\//i.test(url)) {
    url = "http://" + url;
  }
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

const REQUEST_TIMEOUT_MS = 15_000;

/**
 * POST an IPP message to the CUPS server and return the raw response bytes.
 *
 * Uses node:http(s) rather than fetch on purpose: the global fetch (undici)
 * injects browser-oriented headers — `Accept-Language: *`, `Sec-Fetch-Mode`,
 * `Connection: keep-alive` — that older CUPS versions (e.g. 2.2.10 on a
 * Raspberry Pi) reject with HTTP 400 Bad Request. node:http lets us send a
 * minimal, IPP-client-style request with exactly the headers CUPS expects.
 */
function ippRequest(path: string, body: Buffer): Promise<Buffer> {
  const base = getCupsBaseUrl();
  const url = new URL(base + path);
  const transport = url.protocol === "https:" ? https : http;

  return new Promise<Buffer>((resolve, reject) => {
    const req = transport.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (url.protocol === "https:" ? 443 : 631),
        method: "POST",
        path: url.pathname + url.search,
        headers: {
          "Content-Type": "application/ipp",
          "Content-Length": body.length,
          // Single short-lived request per call — avoids keep-alive pooling
          // quirks with embedded/older IPP servers.
          Connection: "close",
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c as Buffer));
        res.on("end", () => {
          const buf = Buffer.concat(chunks);
          const status = res.statusCode ?? 0;
          if (status < 200 || status >= 300) {
            // CUPS/IPP servers put a human-readable reason in the error body.
            const text = buf.toString("utf8").trim().replace(/\s+/g, " ");
            const detail = text ? `: ${text.slice(0, 200)}` : "";
            reject(
              APIError.unavailable(
                `CUPS-Server antwortete mit HTTP ${status} ${res.statusMessage ?? ""}`.trim() +
                  detail,
              ),
            );
            return;
          }
          resolve(buf);
        });
      },
    );

    req.on("error", (err) => {
      // ENOTFOUND (DNS) / ECONNREFUSED (port closed) / ETIMEDOUT (firewall).
      const e = err as { code?: string; message?: string };
      const detail = e?.code || e?.message || String(err);
      reject(
        APIError.unavailable(`CUPS-Server nicht erreichbar (${base}): ${detail}`),
      );
    });

    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy(Object.assign(new Error("ETIMEDOUT"), { code: "ETIMEDOUT" }));
    });

    req.write(body);
    req.end();
  });
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
