/**
 * The values of a year's tax return, by form field
 * (documentation/plans/steuer-ausfuellhilfe.md, stage 3).
 *
 * The values read off the evidence (`document_tax_value`, stage 2) of the
 * documents the caller may see are summed per form field and owner by
 * `mapToForm`, with the law applied there. Each form value lists what fed
 * it — document, amount, the line it was read from — so the user can check
 * it against the evidence, confirm it, or correct it. A correction is
 * stored on the evidence value and survives a re-read.
 *
 * Joint assessment is assumed while the household has a spouse without a
 * tax return of their own for the year; a household member's own
 * Steuerakte (`tax_return_person`) is always assessed alone.
 */

import { and, eq, inArray, isNull, or, sql, gt } from "drizzle-orm";
import { api, APIError, Query } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import db from "../db/database";
import {
  documentTaxReading,
  documentTaxValue,
  documents,
  userSubjectPersons,
} from "../db/schema";
import { requirePermission } from "../user/auth-handler";
import { findEvidenceKind } from "./tax-evidence-kinds";
import { mapToForm, type EvidenceValue, type EvidenceValueStatus, type ValueOwner } from "./tax-form-mapping";
import { formCatalogue, placeLabel } from "./tax-forms/catalogue";
import { TAX_SECTIONS } from "./tax-sections";
import { loadUserGroupIds, visibleDocumentsWhere } from "./visibility";

/** Corrections above this are typing errors, not tax values (10 Mio. €). */
const MAX_CENTS = 1_000_000_000;

export interface TaxFormContribution {
  /** The stored evidence value: what confirm and correct act on. */
  value_id: number;
  document_id: number;
  document_title: string;
  evidence_kind: string;
  evidence_kind_name: string;
  /** The evidence field as the document names it. */
  field_label: string;
  /** What this document adds to the form value (half of a shared value). */
  cents: number;
  /** The value as stored on the evidence. */
  value_cents: number;
  printed: string | null;
  quote: string | null;
  page: number | null;
  status: EvidenceValueStatus;
  note: string | null;
}

export interface TaxFormValue {
  key: string;
  anlage: string;
  anlage_name: string;
  label: string;
  /** `self`, `spouse`, `return`, `child:<id>`, `property:<id>`, `child:?`, `property:?`. */
  owner: string;
  owner_label: string;
  line: number | null;
  kennzahl: string | null;
  /** "Zeile 5 · Kz 110", "Zeile 13 (ohne Kennzahl)", "Kennzahl prüfen". */
  place: string;
  /** Line and Kennzahl were checked against the year's Vordruck. */
  checked: boolean;
  source: string | null;
  form_note: string | null;
  prefilled: boolean;
  cents: number;
  contributions: TaxFormContribution[];
  notes: string[];
  /** Contributions neither confirmed nor corrected by the user yet. */
  open: number;
}

export interface TaxFormSkipped {
  value_id: number;
  document_id: number;
  document_title: string;
  evidence_kind_name: string;
  field_label: string;
  /** The form field it would feed, if any. */
  form_label: string | null;
  value_cents: number;
  printed: string | null;
  quote: string | null;
  status: EvidenceValueStatus;
  reason: string;
  note: string | null;
}

export interface TaxFormValuesResponse {
  year: number;
  /** The catalogue the lines come from; differs from `year` when that year has none yet. */
  catalogue_year: number;
  /** The year has a catalogue of its own. */
  exact: boolean;
  joint: boolean;
  values: TaxFormValue[];
  /** Read values that feed no field: rejected ones (correctable) and those a rule left out. */
  skipped: TaxFormSkipped[];
  /** Evidence documents of the year that were read, and those still waiting to be read. */
  documents_read: number;
  documents_unread: number;
}

interface StoredValue {
  id: number;
  document_id: number;
  owner: string;
  evidence_kind: string;
  field_key: string;
  value: number;
  printed: string | null;
  quote: string | null;
  page: number | null;
  status: EvidenceValueStatus;
  note: string | null;
  title: string | null;
  original_filename: string;
}

const SECTION_NAMES = new Map<string, string>(TAX_SECTIONS.map((s) => [s.slug, s.name]));

function fieldLabel(kind: string, key: string): string {
  return findEvidenceKind(kind)?.fields.find((f) => f.key === key)?.label ?? key;
}

function returnCondition(personId: number | null) {
  return personId === null ? isNull(documents.tax_return_person_id) : eq(documents.tax_return_person_id, personId);
}

/** The subject person must be the caller's, else the Steuerakte is not theirs to read. */
async function checkOwnPerson(userId: number, personId: number | null): Promise<void> {
  if (personId === null) return;
  const [row] = await db
    .select({ id: userSubjectPersons.id })
    .from(userSubjectPersons)
    .where(and(eq(userSubjectPersons.id, personId), eq(userSubjectPersons.user_id, userId)));
  if (!row) throw APIError.notFound("subject person not found");
}

/** A spouse without a tax return of their own for the year means a joint return. */
export async function isJointReturn(userId: number, year: number, personId: number | null): Promise<boolean> {
  if (personId !== null) return false;
  const rows = await db
    .select({ id: userSubjectPersons.id })
    .from(userSubjectPersons)
    .where(and(
      eq(userSubjectPersons.user_id, userId),
      eq(userSubjectPersons.relation_kind, "spouse"),
      or(isNull(userSubjectPersons.own_tax_return_from_tax_year), gt(userSubjectPersons.own_tax_return_from_tax_year, year)),
    ));
  return rows.length > 0;
}

async function ownerNames(userId: number, owners: Iterable<string>): Promise<Map<string, string>> {
  const ids = [...new Set([...owners].filter((o) => o.startsWith("child:") && o !== "child:?").map((o) => Number(o.slice(6))))]
    .filter((n) => Number.isInteger(n));
  const out = new Map<string, string>();
  if (!ids.length) return out;
  const rows = await db
    .select({ id: userSubjectPersons.id, name: userSubjectPersons.full_name })
    .from(userSubjectPersons)
    .where(and(eq(userSubjectPersons.user_id, userId), inArray(userSubjectPersons.id, ids)));
  for (const r of rows) out.set(`child:${r.id}`, r.name);
  return out;
}

export function ownerLabel(owner: string, joint: boolean, names: ReadonlyMap<string, string> = new Map()): string {
  if (owner === "self") return joint ? "Person A (Sie)" : "Sie";
  if (owner === "spouse") return "Person B (Ehegatte)";
  if (owner === "return") return joint ? "Gemeinsam" : "Erklärung";
  if (owner === "child:?") return "Kind nicht zugeordnet";
  if (owner === "property:?") return "Objekt nicht zugeordnet";
  if (owner.startsWith("child:")) return names.get(owner) ?? `Kind ${owner.slice(6)}`;
  if (owner.startsWith("property:")) return `Objekt ${owner.slice(9)}`;
  return owner;
}

async function storedValues(userId: number, year: number, personId: number | null): Promise<StoredValue[]> {
  const groupIds = await loadUserGroupIds(userId);
  return db
    .select({
      id: documentTaxValue.id,
      document_id: documentTaxValue.document_id,
      owner: documentTaxValue.owner,
      evidence_kind: documentTaxValue.evidence_kind,
      field_key: documentTaxValue.field_key,
      value: documentTaxValue.value,
      printed: documentTaxValue.printed,
      quote: documentTaxValue.quote,
      page: documentTaxValue.page,
      status: documentTaxValue.status,
      note: documentTaxValue.note,
      title: documents.title,
      original_filename: documents.original_filename,
    })
    .from(documentTaxValue)
    .innerJoin(documents, eq(documents.id, documentTaxValue.document_id))
    .where(and(
      eq(documentTaxValue.tax_year, year),
      visibleDocumentsWhere(userId, groupIds),
      returnCondition(personId),
    ))
    .orderBy(documentTaxValue.document_id, documentTaxValue.id) as Promise<StoredValue[]>;
}

/** Evidence of the year the caller may see: how many were read, how many still wait. */
async function readingCounts(userId: number, year: number, personId: number | null): Promise<{ read: number; unread: number }> {
  const groupIds = await loadUserGroupIds(userId);
  const [row] = await db
    .select({
      read: sql<number>`COUNT(*) FILTER (WHERE ${documentTaxReading.document_id} IS NOT NULL)::int`,
      unread: sql<number>`COUNT(*) FILTER (WHERE ${documentTaxReading.document_id} IS NULL)::int`,
    })
    .from(documents)
    .leftJoin(documentTaxReading, eq(documentTaxReading.document_id, documents.id))
    .where(and(
      eq(documents.tax_role, "beleg"),
      eq(documents.tax_year, year),
      eq(documents.status, "ready"),
      visibleDocumentsWhere(userId, groupIds),
      returnCondition(personId),
    ));
  return { read: Number(row?.read ?? 0), unread: Number(row?.unread ?? 0) };
}

/** The year's values by form field, for the caller (or one of their Steuerakten). */
export async function buildTaxFormValues(userId: number, year: number, personId: number | null = null): Promise<TaxFormValuesResponse> {
  await checkOwnPerson(userId, personId);
  const [rows, joint, counts] = await Promise.all([
    storedValues(userId, year, personId),
    isJointReturn(userId, year, personId),
    readingCounts(userId, year, personId),
  ]);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const evidence: EvidenceValue[] = rows.map((r) => ({
    id: r.id,
    documentId: r.document_id,
    evidenceKind: r.evidence_kind,
    field: r.field_key,
    value: Number(r.value),
    owner: r.owner as ValueOwner,
    status: r.status,
  }));
  const mapping = mapToForm(year, evidence, { joint });
  const catalogue = formCatalogue(year);
  const names = await ownerNames(userId, mapping.values.map((v) => v.owner));
  const title = (r: StoredValue) => r.title ?? r.original_filename;

  const values: TaxFormValue[] = mapping.values.map((v) => {
    const contributions = v.contributions.map((c): TaxFormContribution => {
      const r = byId.get(c.valueId!)!;
      return {
        value_id: r.id,
        document_id: r.document_id,
        document_title: title(r),
        evidence_kind: r.evidence_kind,
        evidence_kind_name: findEvidenceKind(r.evidence_kind)?.name ?? r.evidence_kind,
        field_label: fieldLabel(r.evidence_kind, r.field_key),
        cents: c.cents,
        value_cents: Number(r.value),
        printed: r.printed,
        quote: r.quote,
        page: r.page,
        status: r.status,
        note: r.note,
      };
    });
    return {
      key: v.field.key,
      anlage: v.field.anlage,
      anlage_name: SECTION_NAMES.get(v.field.anlage) ?? v.field.anlage,
      label: v.field.label,
      owner: v.owner,
      owner_label: ownerLabel(v.owner, joint, names),
      line: v.field.line,
      kennzahl: v.kennzahl,
      place: placeLabel(v.field, v.owner),
      checked: v.field.source !== null,
      source: v.field.source,
      form_note: v.field.formNote,
      prefilled: v.field.prefilled,
      cents: v.cents,
      contributions,
      notes: v.notes,
      open: contributions.filter((c) => c.status === "read").length,
    };
  });

  const skipped: TaxFormSkipped[] = mapping.skipped
    // Values that only steer a rule (material, invoice total) are no loss.
    .filter((s) => s.reason !== "feeds no form field")
    .map((s) => {
      const r = byId.get(s.value.id!)!;
      const formKey = findEvidenceKind(r.evidence_kind)?.fields.find((f) => f.key === r.field_key)?.formKey ?? null;
      return {
        value_id: r.id,
        document_id: r.document_id,
        document_title: title(r),
        evidence_kind_name: findEvidenceKind(r.evidence_kind)?.name ?? r.evidence_kind,
        field_label: fieldLabel(r.evidence_kind, r.field_key),
        form_label: formKey ? catalogue.fields.find((f) => f.key === formKey)?.label ?? null : null,
        value_cents: Number(r.value),
        printed: r.printed,
        quote: r.quote,
        status: r.status,
        reason: s.reason === "rejected" ? (r.note ?? "nicht aus dem Text belegt") : s.reason,
        note: r.note,
      };
    });

  return {
    year,
    catalogue_year: mapping.catalogueYear,
    exact: catalogue.exact,
    joint,
    values,
    skipped,
    documents_read: counts.read,
    documents_unread: counts.unread,
  };
}

/** The stored value, if the document it was read from is visible to the caller. */
async function loadOwnValue(userId: number, valueId: number) {
  const groupIds = await loadUserGroupIds(userId);
  const [row] = await db
    .select({ id: documentTaxValue.id, status: documentTaxValue.status, value: documentTaxValue.value })
    .from(documentTaxValue)
    .innerJoin(documents, eq(documents.id, documentTaxValue.document_id))
    .where(and(eq(documentTaxValue.id, valueId), visibleDocumentsWhere(userId, groupIds)));
  if (!row) throw APIError.notFound("tax value not found");
  return row;
}

export interface TaxValueChange {
  id: number;
  status: EvidenceValueStatus;
  value_cents: number;
}

/** The user confirms the value as read: it stays as it is through a re-read. */
export async function confirmTaxValue(userId: number, valueId: number): Promise<TaxValueChange> {
  const row = await loadOwnValue(userId, valueId);
  // A correction already says what the value is; confirming it again keeps the correction.
  const status: EvidenceValueStatus = row.status === "corrected" ? "corrected" : "confirmed";
  await db
    .update(documentTaxValue)
    .set({ status, corrected_by: userId, updated_at: sql`now()` })
    .where(eq(documentTaxValue.id, valueId));
  return { id: valueId, status, value_cents: Number(row.value) };
}

/** The user states the value: it replaces what was read and survives a re-read. */
export async function correctTaxValue(userId: number, valueId: number, cents: number): Promise<TaxValueChange> {
  if (!Number.isInteger(cents) || cents < 0 || cents > MAX_CENTS) {
    throw APIError.invalidArgument("value_cents must be a whole number of cents between 0 and 1,000,000,000");
  }
  await loadOwnValue(userId, valueId);
  await db
    .update(documentTaxValue)
    .set({ status: "corrected", value: cents, corrected_by: userId, updated_at: sql`now()` })
    .where(eq(documentTaxValue.id, valueId));
  return { id: valueId, status: "corrected", value_cents: cents };
}

// -----------------------------------------------------------------------
// Endpoints
// -----------------------------------------------------------------------

function caller(permission: "documents.view" | "documents.edit"): number {
  const auth = getAuthData();
  if (!auth) throw APIError.unauthenticated("Unauthorized");
  requirePermission(auth, "module.documents");
  requirePermission(auth, permission);
  return parseInt(auth.userID, 10);
}

function checkYear(year: number | undefined): number {
  if (year === undefined || !Number.isInteger(year) || year < 1990 || year > 2100) {
    throw APIError.invalidArgument("year must be between 1990 and 2100");
  }
  return year;
}

export interface TaxFormValuesParams {
  year: Query<number>;
  /** A household member's own Steuerakte; the caller's own return when absent. */
  tax_return_person?: Query<number>;
}

export const getTaxFormValues = api(
  { expose: true, method: "GET", path: "/documents/tax/form-values", auth: true },
  async ({ year, tax_return_person }: TaxFormValuesParams): Promise<TaxFormValuesResponse> => {
    const userId = caller("documents.view");
    return buildTaxFormValues(userId, checkYear(year), tax_return_person ?? null);
  },
);

export const confirmDocumentTaxValue = api(
  { expose: true, method: "POST", path: "/documents/tax/values/:id/confirm", auth: true },
  async ({ id }: { id: number }): Promise<TaxValueChange> => confirmTaxValue(caller("documents.edit"), id),
);

export interface CorrectTaxValueRequest {
  id: number;
  /** The value as it should be, in cents. */
  value_cents: number;
}

export const correctDocumentTaxValue = api(
  { expose: true, method: "POST", path: "/documents/tax/values/:id/correct", auth: true },
  async ({ id, value_cents }: CorrectTaxValueRequest): Promise<TaxValueChange> =>
    correctTaxValue(caller("documents.edit"), id, value_cents),
);
