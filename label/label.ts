/**
 * Label module — HTTP endpoints.
 *
 *   GET /label/printers  → list CUPS printers + the user's saved selection.
 *   PUT /label/printer   → persist the user's selected printer.
 *   GET /label/templates → list the user's reusable label templates.
 *   PUT /label/templates → persist templates and the last-used template.
 *   POST /label/print    → print a pre-rendered label image to a CUPS queue.
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
    await svc.patchLabelPrefs(userId, { printer });
    return { selected: printer };
  },
);

// ---------- Templates ----------

const MAX_TEMPLATES = 50;
const MAX_TEMPLATE_NAME = 80;
const MAX_TEMPLATE_TEXT = 4_000;
const VALID_FONT_KEYS = new Set(["small", "medium", "large"]);
const VALID_ALIGNS = new Set(["left", "center"]);
const VALID_LABEL_CODES = new Set([
  "99012", "99010", "99014", "11356", "11354", "11352", "99015", "11355", "99017",
]);

interface TemplatesResponse {
  templates: svc.LabelTemplate[];
  lastTemplateId: string | null;
}

interface SaveTemplatesRequest {
  templates: svc.LabelTemplate[];
  lastTemplateId?: string | null;
}

function normalizeTemplates(input: svc.LabelTemplate[]): svc.LabelTemplate[] {
  if (!Array.isArray(input)) {
    throw APIError.invalidArgument("templates muss eine Liste sein");
  }
  if (input.length > MAX_TEMPLATES) {
    throw APIError.invalidArgument(`Maximal ${MAX_TEMPLATES} Vorlagen sind erlaubt`);
  }
  const ids = new Set<string>();
  return input.map((template) => {
    const id = template?.id?.trim();
    const name = template?.name?.trim();
    const labelCode = template?.labelCode?.trim();
    if (!id || id.length > 100 || ids.has(id)) {
      throw APIError.invalidArgument("Vorlagen benötigen eine eindeutige ID");
    }
    ids.add(id);
    if (!name || name.length > MAX_TEMPLATE_NAME) {
      throw APIError.invalidArgument(`Vorlagenname muss 1 bis ${MAX_TEMPLATE_NAME} Zeichen lang sein`);
    }
    if (typeof template.text !== "string" || template.text.length > MAX_TEMPLATE_TEXT) {
      throw APIError.invalidArgument(`Vorlagentext darf maximal ${MAX_TEMPLATE_TEXT} Zeichen lang sein`);
    }
    if (!labelCode || !VALID_LABEL_CODES.has(labelCode)) {
      throw APIError.invalidArgument("Ungültiger Etikettentyp");
    }
    if (!VALID_FONT_KEYS.has(template.fontKey)) {
      throw APIError.invalidArgument("Ungültige Schriftgröße");
    }
    if (!VALID_ALIGNS.has(template.align)) {
      throw APIError.invalidArgument("Ungültige Ausrichtung");
    }
    if (template.bold !== undefined && typeof template.bold !== "boolean") {
      throw APIError.invalidArgument("Ungültiger Fett-Wert");
    }
    return {
      id,
      name,
      text: template.text,
      labelCode,
      fontKey: template.fontKey,
      align: template.align,
      bold: Boolean(template.bold),
    };
  });
}

export const listTemplates = api(
  { expose: true, method: "GET", path: "/label/templates", auth: true },
  async (): Promise<TemplatesResponse> => {
    const userId = requireUser("label.view");
    const prefs = await svc.getLabelPrefs(userId);
    const templates = Array.isArray(prefs.templates) ? prefs.templates : [];
    const lastTemplateId =
      prefs.lastTemplateId && templates.some((template) => template.id === prefs.lastTemplateId)
        ? prefs.lastTemplateId
        : null;
    return { templates, lastTemplateId };
  },
);

export const saveTemplates = api(
  { expose: true, method: "PUT", path: "/label/templates", auth: true },
  async (req: SaveTemplatesRequest): Promise<TemplatesResponse> => {
    const userId = requireUser("label.view");
    const templates = normalizeTemplates(req.templates);
    const requestedLastId = req.lastTemplateId?.trim() || null;
    if (requestedLastId && !templates.some((template) => template.id === requestedLastId)) {
      throw APIError.invalidArgument("Die zuletzt verwendete Vorlage existiert nicht");
    }
    await svc.patchLabelPrefs(userId, {
      templates,
      lastTemplateId: requestedLastId,
    });
    return { templates, lastTemplateId: requestedLastId };
  },
);

// ---------- Print ----------

const MAX_COPIES = 50;

// PNG magic number — the first 8 bytes of every PNG file.
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

interface PrintRequest {
  /** The label rendered to a PNG image, base64-encoded (no data: prefix). */
  imageBase64: string & MinLen<1>;
  /** Defaults to 1. Capped at 50. */
  copies?: number & (Min<1> & Max<typeof MAX_COPIES>);
  /** Override the saved printer for this job (also becomes the new default). */
  printer?: string;
}

interface PrintResponse {
  printed: number;
  printer: string;
}

export const print = api(
  { expose: true, method: "POST", path: "/label/print", auth: true },
  async (req: PrintRequest): Promise<PrintResponse> => {
    const userId = requireUser("label.print");

    const image = Buffer.from(req.imageBase64 ?? "", "base64");
    if (image.length < PNG_SIGNATURE.length || !image.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
      throw APIError.invalidArgument("Ungültiges Label-Bild (kein PNG)");
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
      image,
      copies,
      user: `fk-encore-user-${userId}`,
    });

    // If the caller passed an explicit printer, remember it as the new
    // default so the next print prefills correctly.
    if (req.printer?.trim()) {
      await svc.patchLabelPrefs(userId, { printer });
    }

    return { printed: copies, printer };
  },
);
