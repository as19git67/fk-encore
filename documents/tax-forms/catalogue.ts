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
  /**
   * Kennzahl on the year's Vordruck; null until checked — or, once `source`
   * is set, because the Vordruck prints none for the field (Anlage V).
   */
  kennzahl: string | null;
  /**
   * The spouse's (Person B's) Kennzahl where one Vordruck holds both spouses
   * side by side (Anlage Vorsorgeaufwand, AV). Null where each spouse fills
   * an Anlage of their own (N, KAP, R) or the field is one per return.
   */
  kennzahlSpouse: string | null;
  /**
   * What the Vordruck says beyond line and Kennzahl, from the same source:
   * where the line depends on a fact the evidence does not settle, or why
   * the field is not entered at all.
   */
  formNote: string | null;
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
  const fields = CATALOGUES[fallback]!.map((f) => ({ ...f, line: null, kennzahl: null, kennzahlSpouse: null, formNote: null, source: null }));
  return { year: fallback, fields, exact: false };
}

export function findFormField(year: number, key: string): FormField | undefined {
  return formCatalogue(year).fields.find((f) => f.key === key);
}

/** The Kennzahl a value of `owner` goes under: the spouse's where the Vordruck has one. */
export function kennzahlFor(field: FormField, owner: string): string | null {
  return owner === "spouse" && field.kennzahlSpouse ? field.kennzahlSpouse : field.kennzahl;
}

/**
 * How the worksheet names where a field goes: "Zeile 5 · Kz 110", "Zeile 13
 * (ohne Kennzahl)", "siehe Hinweis zum Vordruck" where the line depends on
 * a fact the note names, or "Kennzahl prüfen" while the field is not
 * checked against the year's Vordruck.
 */
export function placeLabel(field: FormField, owner: string): string {
  if (!field.source) return "Kennzahl prüfen";
  const kz = kennzahlFor(field, owner);
  // The note says which line, or why there is none.
  if (field.line === null) return kz ? `Kz ${kz}` : field.formNote ? "siehe Hinweis zum Vordruck" : "nicht auf dem Vordruck";
  return kz ? `Zeile ${field.line} · Kz ${kz}` : `Zeile ${field.line} (ohne Kennzahl)`;
}
