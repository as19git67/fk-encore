/**
 * The worksheet for filling in the tax return, straight from the Steuer
 * page (no chat needed): `GET /assistant/tax-worksheet` reads it, `POST
 * /assistant/tax-worksheet/pdf` stores it as a document, the same PDF the
 * assistant's `tax_worksheet_pdf` proposal makes. Figures come from
 * `tax-worksheet.ts`; recognised amounts are read from the documents' text
 * and unchecked, which the page says.
 */

import { api, APIError, Query } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import { requirePermission } from "../user/auth-handler";
import { buildTaxWorksheet, type TaxWorksheet } from "./tax-worksheet";
import { storeTaxWorksheetPdf } from "./tools/tax";

const MIN_YEAR = 1990;
const MAX_YEAR = 2100;

function worksheetUser() {
  const auth = getAuthData()!;
  requirePermission(auth, "documents.view");
  return auth;
}

function mayFinance(auth: { permissions: string[] }): boolean {
  return ["module.finance", "finance.view"].every((p) => auth.permissions.includes(p));
}

function checkYear(year: number | undefined): number {
  if (year === undefined || !Number.isInteger(year) || year < MIN_YEAR || year > MAX_YEAR) {
    throw APIError.invalidArgument(`year must be between ${MIN_YEAR} and ${MAX_YEAR}`);
  }
  return year;
}

function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export interface TaxWorksheetParams {
  year: Query<number>;
  /** The Steuerakte of a household member with their own tax return. */
  person_id?: Query<number>;
}

export const getTaxWorksheet = api(
  { expose: true, method: "GET", path: "/assistant/tax-worksheet", auth: true },
  async ({ year, person_id }: TaxWorksheetParams): Promise<TaxWorksheet> => {
    const auth = worksheetUser();
    return buildTaxWorksheet({ year: checkYear(year), personId: person_id, mayFinance: mayFinance(auth) });
  },
);

export interface TaxWorksheetPdfRequest {
  year: number;
  person_id?: number;
}

export interface TaxWorksheetPdfResponse {
  document_id: number;
  route: string;
  sections: number;
  bookings: number;
}

export const storeTaxWorksheetPdfDocument = api(
  { expose: true, method: "POST", path: "/assistant/tax-worksheet/pdf", auth: true },
  async ({ year, person_id }: TaxWorksheetPdfRequest): Promise<TaxWorksheetPdfResponse> => {
    const auth = worksheetUser();
    const w = await buildTaxWorksheet({ year: checkYear(year), personId: person_id, mayFinance: mayFinance(auth) });
    if (!w.documentCount && !w.bookingCount) {
      throw APIError.failedPrecondition(`Für das Steuerjahr ${w.year} ist nichts markiert. Markiere zuerst Dokumente auf der Steuer-Seite.`);
    }
    const stored = await storeTaxWorksheetPdf(w, today());
    return { document_id: stored.id, route: `/dokumente/${stored.id}`, sections: w.sections.length, bookings: w.bookingCount };
  },
);
