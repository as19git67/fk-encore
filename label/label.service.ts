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
import net from "node:net";
import dns from "node:dns/promises";
import { APIError } from "encore.dev/api";
import log from "encore.dev/log";
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
 * Resolve the CUPS host to an IP. CUPS protects against DNS rebinding by
 * rejecting any request (HTTP 400 Bad Request) whose Host header is not one
 * of: a loopback name *on a loopback connection*, the server's own listening
 * IP addresses, or a configured ServerName/ServerAlias. A remote client that
 * sends `Host: scanner.schegg.net` is therefore refused unless the admin adds
 * a ServerAlias. By connecting to the resolved IP, node sets `Host: <ip>:<port>`
 * — the server's own address — which CUPS accepts without any server config.
 */
async function resolveHost(hostname: string): Promise<{ ip: string; family: number }> {
  const literal = net.isIP(hostname);
  if (literal) return { ip: hostname, family: literal };
  const { address, family } = await dns.lookup(hostname);
  return { ip: address, family };
}

/**
 * POST an IPP message to the CUPS server and return the raw response bytes.
 *
 * Uses node:http(s) rather than fetch on purpose: the global fetch (undici)
 * injects browser-oriented headers — Accept-Language: *, Sec-Fetch-Mode,
 * Connection: keep-alive — that older CUPS versions reject with HTTP 400.
 * node:http lets us send a minimal, IPP-client-style request, and connecting
 * by IP makes the Host header pass CUPS' rebinding check (see resolveHost).
 */
async function ippRequest(path: string, body: Buffer): Promise<Buffer> {
  const base = getCupsBaseUrl();
  const url = new URL(base + path);
  const isHttps = url.protocol === "https:";
  const transport = isHttps ? https : http;
  const port = Number(url.port) || (isHttps ? 443 : 631);

  let ip: string;
  let family: number;
  try {
    ({ ip, family } = await resolveHost(url.hostname));
  } catch (err) {
    const e = err as { code?: string; message?: string };
    throw APIError.unavailable(
      `CUPS-Server nicht erreichbar (${base}): ${e?.code || e?.message || String(err)}`,
    );
  }

  const hostHeader = family === 6 ? `[${ip}]:${port}` : `${ip}:${port}`;

  return new Promise<Buffer>((resolve, reject) => {
    const req = transport.request(
      {
        host: ip,
        port,
        method: "POST",
        path: url.pathname + url.search,
        // Connect by IP but keep TLS SNI / cert validation against the real
        // name for https.
        servername: isHttps ? url.hostname : undefined,
        headers: {
          // The server's own IP — accepted by CUPS' Host validation.
          Host: hostHeader,
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
  const resp = parseIppResponse(respBuf);
  const printers = parsePrinters(resp);
  if (printers.length === 0) {
    // Diagnostic: distinguishes "CUPS has no queues" (IPP 0x0406 / no
    // printer-attributes groups) from a parsing mismatch. The hex head lets
    // us inspect the exact wire format of older CUPS versions if needed.
    log.warn("CUPS-Get-Printers returned no printers", {
      cups_url: getCupsBaseUrl(),
      ipp_status: "0x" + resp.statusCode.toString(16).padStart(4, "0"),
      group_tags: resp.groups.map((g) => g.tag),
      response_bytes: respBuf.length,
      response_hex_head: respBuf.subarray(0, 96).toString("hex"),
    });
  }
  return printers;
}

export interface PrintLabelInput {
  printer: string;
  text: string;
  copies: number;
  user: string;
  /** Characters per inch (font width). Clamped to [4, 30]. */
  cpi?: number;
  /** Lines per inch (line height). Clamped to [2, 16]. */
  lpi?: number;
  /** Horizontal alignment of the text on the label. */
  align?: "left" | "center";
  /** Printable label width in mm; overrides CUPS_LABEL_WIDTH_MM for centering. */
  labelWidthMm?: number;
}

const DEFAULT_LEFT_MARGIN_PT = 1;
const DEFAULT_LABEL_WIDTH_MM = 85; // ~ DYMO large address label printable width
const DEFAULT_CPI = 10; // CUPS text-filter default

/**
 * Left print margin in points (1 pt ≈ 4 px at 300 dpi) so the text isn't
 * flush against the label's left edge. Configurable via
 * CUPS_LABEL_LEFT_MARGIN_PT; set it to 0 to disable. Defaults to 1 pt.
 */
export function getLeftMarginPt(): number {
  const raw = process.env.CUPS_LABEL_LEFT_MARGIN_PT?.trim();
  if (raw === undefined || raw === "") return DEFAULT_LEFT_MARGIN_PT;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Printable label width in millimetres, used to center text (columns =
 * width × cpi). Configurable via CUPS_LABEL_WIDTH_MM. Defaults to 85 mm.
 */
export function getLabelWidthMm(): number {
  const raw = process.env.CUPS_LABEL_WIDTH_MM?.trim();
  const n = raw ? parseFloat(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_LABEL_WIDTH_MM;
}

function clampInt(value: number | undefined, min: number, max: number): number | undefined {
  if (value === undefined || value === null) return undefined;
  const n = Math.floor(value);
  if (!Number.isFinite(n)) return undefined;
  return Math.min(Math.max(n, min), max);
}

/** Center each line by left-padding with spaces to the given column width. */
export function centerText(text: string, columns: number): string {
  if (columns <= 0) return text;
  return text
    .split("\n")
    .map((line) => {
      const len = line.length;
      if (len >= columns) return line;
      return " ".repeat(Math.floor((columns - len) / 2)) + line;
    })
    .join("\n");
}

/** Submit a text label to a CUPS queue. Throws on rejection. */
export async function printLabel(input: PrintLabelInput): Promise<void> {
  const base = getCupsBaseUrl();
  const host = new URL(base).host;
  const printerUri = `ipp://${host}/printers/${input.printer}`;

  const cpi = clampInt(input.cpi, 4, 30);
  const lpi = clampInt(input.lpi, 2, 16);
  const centered = input.align === "center";

  let text = input.text;
  if (centered) {
    const widthMm = clampInt(input.labelWidthMm, 10, 300) ?? getLabelWidthMm();
    const columns = Math.floor((widthMm / 25.4) * (cpi ?? DEFAULT_CPI));
    text = centerText(text, columns);
  }

  const reqBuf = buildPrintJobRequest({
    printerUri,
    user: input.user,
    jobName: "fk-encore label",
    text,
    copies: input.copies,
    cpi,
    lpi,
    // A left margin would offset the space-based centering, so drop it when
    // centering.
    leftMarginPt: centered ? 0 : getLeftMarginPt(),
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
