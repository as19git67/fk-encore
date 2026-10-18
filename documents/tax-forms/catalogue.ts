/**
 * The fields of the tax forms, per year (documentation/plans/
 * steuer-ausfuellhilfe.md, stage 1).
 *
 * Lines and Kennzahlen change every year, so each year is a file of its
 * own. A field's `key` stays the same across years: values read from the
 * evidence and the user's corrections are stored against the key, and the
 * year's catalogue says where the key sits on that year's form.
 *
 * `line` and `kennzahl` are `null` until checked against the official
 * Vordruck of the year; the worksheet then prints "Kennzahl prüfen" rather
 * than a number from memory. `source` names the edition they were taken
 * from once they are filled in.
 */

import type { TaxSectionSlug } from "../tax-sections";
import { FORM_FIELDS_2025 } from "./2025";

/**
 * Whose value a field holds under joint assessment:
 * - `person`: one value per spouse (Anlage N, KAP, R, AV, Vorsorgeaufwand);
 * - `return`: one value for the household (§ 35a, außergewöhnliche Belastungen, Spenden);
 * - `child`: one value per child (Anlage Kind);
 * - `property`: one value per rented property (Anlage V).
 */
export type FormScope = "person" | "return" | "child" | "property";

export type FormValueKind = "amount" | "count" | "flag";

export interface FormField {
  /** Stable across years: "n.bruttoarbeitslohn". */
  key: string;
  /** The section the Steuer page already sorts documents into. */
  anlage: TaxSectionSlug;
  /** Zeile on the year's Vordruck; null until checked. */
  line: number | null;
  /** Kennzahl on the year's Vordruck; null until checked. */
  kennzahl: string | null;
  /** The field as the form names it. */
  label: string;
  kind: FormValueKind;
  scope: FormScope;
  /**
   * The Finanzamt receives the value electronically (Lohnsteuerbescheinigung,
   * Rentenbezugsmitteilung, Basis-KV/PV): the household checks it rather
   * than enters it.
   */
  prefilled: boolean;
  /** Which Vordruck and edition `line` and `kennzahl` were taken from; null until checked. */
  source: string | null;
}

const CATALOGUES: Readonly<Record<number, readonly FormField[]>> = {
  2025: FORM_FIELDS_2025,
};

/** The years a catalogue exists for, newest first. */
export const CATALOGUE_YEARS: readonly number[] = Object.keys(CATALOGUES).map(Number).sort((a, b) => b - a);

/**
 * The catalogue of a year. A year without its own catalogue uses the newest
 * older one: the fields rarely change, only their lines and Kennzahlen, and
 * those are then shown as unchecked.
 */
export function formCatalogue(year: number): { year: number; fields: readonly FormField[]; exact: boolean } {
  const own = CATALOGUES[year];
  if (own) return { year, fields: own, exact: true };
  const fallback = CATALOGUE_YEARS.find((y) => y < year) ?? CATALOGUE_YEARS[CATALOGUE_YEARS.length - 1]!;
  const fields = CATALOGUES[fallback]!.map((f) => ({ ...f, line: null, kennzahl: null, source: null }));
  return { year: fallback, fields, exact: false };
}

export function findFormField(year: number, key: string): FormField | undefined {
  return formCatalogue(year).fields.find((f) => f.key === key);
}
