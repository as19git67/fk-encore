/**
 * Label module — HTTP endpoints.
 *
 *   GET /label/printers  → list CUPS printers + the user's saved selection.
 *   PUT /label/printer   → persist the user's selected printer.
 *   POST /label/print    → print a text label to a CUPS queue.
 *
 * Listing/selecting a printer needs `label.view`; printing needs
 * `label.print`. The CUPS server itself is configured via CUPS_SERVER_URL.
 */

import { api, APIError } from "encore.dev/api";
import type { Min, Max, MinLen } from "encore.dev/validate";
import { getAuthData } from "~encore/auth";
import { requirePermission } from "../user/auth-handler";
import * as svc from "./label.service";

function requireUser(permission: string): number {
  const auth = getAuthData();
  if (!auth) throw APIError.unauthenticated("Unauthorized");
  requirePermission(auth, permission);
  return parseInt(auth.userID, 10);
}

// ---------- List printers ----------

interface PrinterDto {
  name: string;
  info: string | null;
  location: string | null;
  state: number | null;
  stateLabel: string;
  makeAndModel: string | null;
}

interface ListPrintersResponse {
  printers: PrinterDto[];
  /** The user's previously selected printer, if any. */
  selected: string | null;
  /** Human-readable error if the CUPS server could not be reached. */
  cupsError: string | null;
}

export const listPrinters = api(
  { expose: true, method: "GET", path: "/label/printers", auth: true },
  async (): Promise<ListPrintersResponse> => {
    const userId = requireUser("label.view");
    const prefs = await svc.getLabelPrefs(userId);

    // The server being down must not blank the page — the user should
    // still see their saved selection and a clear error. So enumeration
    // failures are surfaced as `cupsError`, not thrown.
    try {
      const printers = await svc.listPrinters();
      return {
        printers: printers.map((p) => ({
          name: p.name,
          info: p.info,
          location: p.location,
          state: p.state,
          stateLabel: svc.stateLabel(p.state),
          makeAndModel: p.makeAndModel,
        })),
        selected: prefs.printer ?? null,
        cupsError: null,
      };
    } catch (err) {
      const message =
        err instanceof APIError ? err.message : (err as Error).message;
      return { printers: [], selected: prefs.printer ?? null, cupsError: message };
    }
  },
);

// ---------- Save selected printer ----------

interface SavePrinterRequest {
  printer: string & MinLen<1>;
}

interface SavePrinterResponse {
  selected: string;
}

export const savePrinter = api(
  { expose: true, method: "PUT", path: "/label/printer", auth: true },
  async (req: SavePrinterRequest): Promise<SavePrinterResponse> => {
    const userId = requireUser("label.view");
    const printer = req.printer?.trim();
    if (!printer) throw APIError.invalidArgument("printer darf nicht leer sein");
    await svc.setLabelPrefs(userId, { printer });
    return { selected: printer };
  },
);

// ---------- Print ----------

const MAX_COPIES = 50;

interface PrintRequest {
  text: string & MinLen<1>;
  /** Defaults to 1. Capped at 50. */
  copies?: number & (Min<1> & Max<typeof MAX_COPIES>);
  /** Override the saved printer for this job (also becomes the new default). */
  printer?: string;
  /** Characters per inch (font width). Lower = larger font. */
  cpi?: number & (Min<4> & Max<30>);
  /** Lines per inch (line height). Lower = fewer lines per label. */
  lpi?: number & (Min<2> & Max<16>);
  /** Horizontal text alignment on the label. Defaults to "left". */
  align?: "left" | "center";
  /** Printable label width in mm (from the selected label type), used to
   *  center text. Falls back to CUPS_LABEL_WIDTH_MM when omitted. */
  labelWidthMm?: number & (Min<10> & Max<300>);
}

interface PrintResponse {
  printed: number;
  printer: string;
}

export const print = api(
  { expose: true, method: "POST", path: "/label/print", auth: true },
  async (req: PrintRequest): Promise<PrintResponse> => {
    const userId = requireUser("label.print");

    const text = req.text ?? "";
    if (!text.trim()) {
      throw APIError.invalidArgument("Text darf nicht leer sein");
    }

    const copies =
      req.copies && req.copies > 0 ? Math.min(Math.floor(req.copies), MAX_COPIES) : 1;

    let printer = req.printer?.trim();
    if (!printer) {
      const prefs = await svc.getLabelPrefs(userId);
      printer = prefs.printer;
    }
    if (!printer) {
      throw APIError.failedPrecondition("Kein Drucker ausgewählt");
    }

    await svc.printLabel({
      printer,
      text,
      copies,
      user: `fk-encore-user-${userId}`,
      cpi: req.cpi,
      lpi: req.lpi,
      align: req.align === "center" ? "center" : "left",
      labelWidthMm: req.labelWidthMm,
    });

    // If the caller passed an explicit printer, remember it as the new
    // default so the next print prefills correctly.
    if (req.printer?.trim()) {
      await svc.setLabelPrefs(userId, { printer });
    }

    return { printed: copies, printer };
  },
);
