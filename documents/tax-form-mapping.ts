/**
 * From values read off the evidence to the values of the form
 * (documentation/plans/steuer-ausfuellhilfe.md, stage 1).
 *
 * Every evidence value names the form field it feeds; here they are summed
 * per field and per owner (the taxpayer, the spouse, the household, a child
 * or a property) and the law is applied where a value is not entered as it
 * was read. Each rule cites its paragraph; what the law only limits after
 * the return is assessed (caps, zumutbare Belastung) is a note beside the
 * value, never a changed number — the form takes the expense, the
 * Finanzamt applies the cap.
 *
 * Pure: no database, no model. Stage 2 feeds it the stored values.
 */

import { findEvidenceKind } from "./tax-evidence-kinds";
import { formCatalogue, kennzahlFor, type FormField } from "./tax-forms/catalogue";

export type EvidenceValueStatus = "read" | "rejected" | "confirmed" | "corrected";

/**
 * Whose value it is: `self` / `spouse` (the two of a joint return), `joint`
 * (a shared account, a household invoice), `child:<id>`, `property:<id>`,
 * or `none` when the document names neither spouse.
 */
export type ValueOwner = "self" | "spouse" | "joint" | "none" | `child:${number}` | `property:${number}`;

export interface EvidenceValue {
  /** The stored row (`document_tax_value.id`), carried through so a value can be confirmed or corrected. */
  id?: number;
  documentId: number;
  evidenceKind: string;
  /** The evidence field's key within its kind. */
  field: string;
  /** Cents for amounts; 0 or 1 for flags. */
  value: number;
  owner: ValueOwner;
  status: EvidenceValueStatus;
}

export interface Contribution {
  /** The stored evidence value, when the input carried it. */
  valueId?: number;
  documentId: number;
  evidenceKind: string;
  field: string;
  /** What this document adds to the form value, in cents (half of a shared value). */
  cents: number;
  status: EvidenceValueStatus;
}

export interface FormValue {
  field: FormField;
  /** `self`, `spouse`, `return`, `child:<id>`, `property:<id>`, or `person:?` / `child:?` / `property:?` while unassigned. */
  owner: string;
  /** The Kennzahl this owner's value goes under (the spouse's column where the Vordruck has one). */
  kennzahl: string | null;
  cents: number;
  contributions: Contribution[];
  notes: string[];
}

export interface FormMapping {
  year: number;
  /** The catalogue used; differs from `year` when that year has none yet. */
  catalogueYear: number;
  values: FormValue[];
  /** Values that feed no field of the catalogue, or were rejected. */
  skipped: { value: EvidenceValue; reason: string }[];
}

const euro = (cents: number): string =>
  `${(cents / 100).toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;

/** Flags of one document, by evidence field key. */
function flagsByDocument(values: readonly EvidenceValue[]): Map<number, Map<string, number>> {
  const out = new Map<number, Map<string, number>>();
  for (const v of values) {
    if (v.status === "rejected") continue;
    const kind = findEvidenceKind(v.evidenceKind);
    if (kind?.fields.find((f) => f.key === v.field)?.kind !== "flag") continue;
    const flags = out.get(v.documentId) ?? new Map<string, number>();
    flags.set(v.field, v.value);
    out.set(v.documentId, flags);
  }
  return out;
}

/** The form field a value feeds, after the rules that redirect it. */
function targetKey(v: EvidenceValue, flags: Map<string, number> | undefined): string | null {
  const field = findEvidenceKind(v.evidenceKind)?.fields.find((f) => f.key === v.field);
  if (!field || field.kind !== "amount" || !field.formKey) return null;
  // § 34g EStG: donations to a party are a field of their own.
  if (v.evidenceKind === "zuwendungsbestaetigung" && flags?.get("partei") === 1) return "sonder.spenden_parteien";
  return field.formKey;
}

/** The owners a value lands on for a field's scope, with each one's share. */
function owners(field: FormField, owner: ValueOwner, joint: boolean): { owner: string; share: number; note?: string }[] {
  switch (field.scope) {
    case "return":
      return [{ owner: "return", share: 1 }];
    case "child":
      return [{ owner: owner.startsWith("child:") ? owner : "child:?", share: 1 }];
    case "property":
      return [{ owner: owner.startsWith("property:") ? owner : "property:?", share: 1 }];
    case "person":
      if (owner === "self" || owner === "spouse") return [{ owner, share: 1 }];
      // A shared account under joint assessment: each spouse enters half.
      if (owner === "joint" && joint) {
        const note = "Gemeinsamer Beleg: jedem Ehegatten zur Hälfte zugeordnet.";
        return [{ owner: "self", share: 0.5, note }, { owner: "spouse", share: 0.5, note }];
      }
      // Under joint assessment a document that names neither spouse could be
      // either one's: never guess, the user assigns it.
      if (owner === "none" && joint) return [{ owner: "person:?", share: 1 }];
      return [{ owner: "self", share: 1 }];
  }
}

/** Notes the law adds to a summed value. */
function lawNotes(f: FormValue, year: number, joint: boolean, all: readonly FormValue[]): string[] {
  const n: string[] = [];
  const c = f.cents;
  switch (f.field.key) {
    case "haushaltsnahe.dienstleistungen":
      n.push(`§ 35a Abs. 2 EStG: Steuerermäßigung 20 % davon, höchstens 4.000 € (hier ${euro(Math.min(Math.round(c * 0.2), 400000))}).`);
      break;
    case "haushaltsnahe.handwerker":
      n.push(`§ 35a Abs. 3 EStG: Steuerermäßigung 20 % der Arbeitskosten, höchstens 1.200 € (hier ${euro(Math.min(Math.round(c * 0.2), 120000))}). Material zählt nicht.`);
      break;
    case "kap.sparer_pauschbetrag": {
      if (c > 100000) n.push("§ 20 Abs. 9 EStG: mehr als 1.000 € Sparer-Pauschbetrag für eine Person in Anspruch genommen; Freistellungsaufträge prüfen.");
      if (joint && f.owner === "spouse") {
        const total = all.filter((x) => x.field.key === f.field.key).reduce((s, x) => s + x.cents, 0);
        if (total > 200000) n.push("§ 20 Abs. 9 EStG: zusammen mehr als 2.000 € Sparer-Pauschbetrag in Anspruch genommen.");
      }
      break;
    }
    case "kind.betreuungskosten":
      n.push(year >= 2025
        ? `§ 10 Abs. 1 Nr. 5 EStG: abziehbar 80 %, höchstens 4.800 € je Kind (hier ${euro(Math.min(Math.round(c * 0.8), 480000))}). Verpflegung zählt nicht.`
        : `§ 10 Abs. 1 Nr. 5 EStG: abziehbar zwei Drittel, höchstens 4.000 € je Kind (hier ${euro(Math.min(Math.round((c * 2) / 3), 400000))}). Verpflegung zählt nicht.`);
      break;
    case "kind.schulgeld":
      n.push(`§ 10 Abs. 1 Nr. 9 EStG: abziehbar 30 %, höchstens 5.000 € je Kind (hier ${euro(Math.min(Math.round(c * 0.3), 500000))}).`);
      break;
    case "sonder.spenden":
      n.push("§ 10b Abs. 1 EStG: abziehbar bis 20 % des Gesamtbetrags der Einkünfte.");
      break;
    case "sonder.spenden_parteien":
      n.push(`§ 34g EStG: Steuerermäßigung 50 %, höchstens ${joint ? "1.650" : "825"} €; der Rest ist Sonderausgabe nach § 10b Abs. 2.`);
      break;
    case "agb.krankheitskosten":
    case "agb.pflegekosten":
      n.push("§ 33 Abs. 3 EStG: die zumutbare Belastung wird abgezogen; sie hängt vom Gesamtbetrag der Einkünfte und der Zahl der Kinder ab.");
      break;
  }
  if (f.field.key.startsWith("werbungskosten.")) {
    const total = all.filter((x) => x.owner === f.owner && x.field.key.startsWith("werbungskosten.")).reduce((s, x) => s + x.cents, 0);
    if (total < 123000) n.push(`§ 9a Satz 1 Nr. 1a EStG: Werbungskosten dieser Person zusammen ${euro(total)}, unter dem Arbeitnehmer-Pauschbetrag von 1.230 €, der ohnehin abgezogen wird.`);
  }
  if (f.field.prefilled) n.push("Vom Finanzamt elektronisch vorausgefüllt: nur prüfen.");
  if (f.owner === "person:?") n.push("Person zuordnen: der Beleg ist mit keinem der Ehegatten als Bezugsperson verknüpft.");
  if (f.owner === "child:?") n.push("Kind zuordnen: der Beleg nennt kein Kind des Haushalts.");
  if (f.owner === "property:?") n.push("Objekt zuordnen: der Beleg nennt kein vermietetes Objekt.");
  return n;
}

/**
 * Sum the evidence values of a year into form values.
 * `joint`: the year is a joint assessment (Zusammenveranlagung).
 */
export function mapToForm(year: number, values: readonly EvidenceValue[], opts: { joint: boolean }): FormMapping {
  const catalogue = formCatalogue(year);
  const fields = new Map(catalogue.fields.map((f) => [f.key, f]));
  const order = new Map(catalogue.fields.map((f, i) => [f.key, i]));
  const flags = flagsByDocument(values);
  const byKey = new Map<string, FormValue>();
  const skipped: FormMapping["skipped"] = [];

  for (const v of values) {
    const kind = findEvidenceKind(v.evidenceKind);
    const evidenceField = kind?.fields.find((f) => f.key === v.field);
    if (evidenceField?.kind === "flag") continue;
    if (v.status === "rejected") {
      skipped.push({ value: v, reason: "rejected" });
      continue;
    }
    const key = targetKey(v, flags.get(v.documentId));
    const field = key ? fields.get(key) : undefined;
    if (!field) {
      skipped.push({ value: v, reason: key ? `no field ${key} in the ${catalogue.year} catalogue` : "feeds no form field" });
      continue;
    }
    // § 35a Abs. 5 Satz 3 EStG: only a non-cash payment to the provider's account counts.
    const docFlags = flags.get(v.documentId);
    const is35a = field.key.startsWith("haushaltsnahe.") && v.evidenceKind !== "nebenkostenabrechnung";
    if (is35a && docFlags?.get("bargeld") === 1) {
      skipped.push({ value: v, reason: "§ 35a Abs. 5 EStG: bar bezahlt, zählt nicht" });
      continue;
    }
    for (const target of owners(field, v.owner, opts.joint)) {
      const id = `${field.key}|${target.owner}`;
      const entry = byKey.get(id) ?? { field, owner: target.owner, kennzahl: kennzahlFor(field, target.owner), cents: 0, contributions: [], notes: [] };
      const cents = Math.round(v.value * target.share);
      entry.cents += cents;
      entry.contributions.push({ ...(v.id !== undefined ? { valueId: v.id } : {}), documentId: v.documentId, evidenceKind: v.evidenceKind, field: v.field, cents, status: v.status });
      if (target.note && !entry.notes.includes(target.note)) entry.notes.push(target.note);
      if (is35a && docFlags?.get("bargeld") === undefined) {
        const note = "Zahlungsart prüfen: nach § 35a Abs. 5 EStG zählt nur unbare Zahlung.";
        if (!entry.notes.includes(note)) entry.notes.push(note);
      }
      byKey.set(id, entry);
    }
  }

  const ownerRank = (o: string) => (o === "self" ? 0 : o === "spouse" ? 1 : o === "person:?" ? 2 : o === "return" ? 3 : 4);
  const result = [...byKey.values()].sort((a, b) =>
    (order.get(a.field.key)! - order.get(b.field.key)!) || ownerRank(a.owner) - ownerRank(b.owner) || a.owner.localeCompare(b.owner));
  for (const f of result) f.notes.push(...lawNotes(f, year, opts.joint, result));
  return { year, catalogueYear: catalogue.year, values: result, skipped };
}
