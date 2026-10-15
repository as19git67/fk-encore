/**
 * Rule-based collections for every type (#1548, stage 5).
 *
 * Documents have dossiers (documents/dossiers.ts). The other types get the
 * same idea: a collection typed for one kind carries a rule, and whatever
 * matches it joins by itself. The rule is the filter the user already knows
 * from the type's list — a gallery filter for photos, the transaction list's
 * criteria for bookings — so "save this filter as a collection" is all it
 * takes to make one.
 *
 * What the rule added it may take away again (`joined_by = 'rule'`), and
 * nothing else: a member a person put in stays, and a member a person took
 * out is remembered in `excluded_ids` so the next run does not bring it back.
 * The rule is evaluated as the collection's owner: it never gathers what the
 * owner may not see, and readers still see only what they may open.
 */

import { and, eq, gte, ilike, inArray, lte, not, or, sql, type SQL } from "drizzle-orm";
import db from "../db/database";
import { dbAll, dbExec } from "../db/adapter";
import {
  collectionMembers,
  documentCollections,
  financeAccountAccess,
  financeDepotSecurity,
  financeTransaction,
  meters,
  type CollectionMemberType,
  type MeterType,
} from "../db/schema";
import type { CollectionRow } from "../documents/collection-access";
import { loadUserGroupIds } from "../documents/visibility";
import { parsePhotoFilterQuery, type PhotoFilterQuery } from "../photo/photo.filters";
import { listGalleryIdsLogic } from "../photo/gallery-grid.service";
import { visibleMetersWhere } from "../meter/meter.service";
import { taggedWithCondition, taxRelevantCondition } from "../finance/transaction-conditions";
import type { SecurityStatus } from "../finance/depot-securities";

export interface TransactionCriteria {
  account_ids?: number[];
  /** Every one of these tags (as the list's tag filter). */
  tags?: string[];
  /** Text in counterparty, purpose or notice. */
  text?: string;
  /** Booking date range, YYYY-MM-DD. */
  from?: string;
  to?: string;
  tax_relevant?: boolean;
}

export interface SecurityCriteria {
  /** Depots (finance accounts of kind depot); absent: every readable one. */
  account_ids?: number[];
  /** Master statuses that count; absent: confirmed only. */
  statuses?: SecurityStatus[];
}

export interface MeterCriteria {
  meter_types?: MeterType[];
  /** Text in the meter's location. */
  location?: string;
}

export type MemberRule =
  | { type: "photo"; filter: PhotoFilterQuery; excluded_ids?: number[] }
  | { type: "transaction"; criteria: TransactionCriteria; excluded_ids?: number[] }
  | { type: "security"; criteria: SecurityCriteria; excluded_ids?: number[] }
  | { type: "meter"; criteria: MeterCriteria; excluded_ids?: number[] };

export const RULE_TYPES: readonly CollectionMemberType[] = ["photo", "transaction", "security", "meter"];

const METER_TYPES: readonly MeterType[] = ["electricity", "water", "gas", "operating_hours"];
const SECURITY_STATUSES: readonly SecurityStatus[] = ["confirmed", "proposed", "ignored"];
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function ids(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = [...new Set(value.map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  return out.length ? out : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 200) : undefined;
}

/**
 * A rule as the API received it, checked and trimmed to what the evaluator
 * understands; null when it says nothing (a rule must narrow something, or
 * it would gather everything the owner can see).
 */
export function normalizeMemberRule(input: unknown, keepExcluded: number[] = []): MemberRule | null {
  if (!input || typeof input !== "object") return null;
  const raw = input as Record<string, unknown>;
  const excluded = keepExcluded.length ? { excluded_ids: [...keepExcluded] } : {};
  switch (raw.type) {
    case "photo": {
      const filter = coercePhotoFilter(raw.filter);
      // Only what the gallery filter parser accepts survives; a filter that
      // parses to nothing would be "every photo".
      const parsed = parsePhotoFilterQuery(filter);
      const meaningful = Object.entries(parsed).filter(([, v]) => v !== undefined);
      if (meaningful.length === 0) return null;
      return { type: "photo", filter, ...excluded };
    }
    case "transaction": {
      const c = (raw.criteria ?? {}) as Record<string, unknown>;
      const criteria: TransactionCriteria = {};
      const accounts = ids(c.account_ids);
      if (accounts) criteria.account_ids = accounts;
      const tags = Array.isArray(c.tags) ? [...new Set(c.tags.map(text).filter((t): t is string => !!t))] : [];
      if (tags.length) criteria.tags = tags;
      const t = text(c.text);
      if (t) criteria.text = t;
      if (typeof c.from === "string" && ISO_DATE.test(c.from)) criteria.from = c.from;
      if (typeof c.to === "string" && ISO_DATE.test(c.to)) criteria.to = c.to;
      if (typeof c.tax_relevant === "boolean") criteria.tax_relevant = c.tax_relevant;
      if (Object.keys(criteria).length === 0) return null;
      return { type: "transaction", criteria, ...excluded };
    }
    case "security": {
      const c = (raw.criteria ?? {}) as Record<string, unknown>;
      const criteria: SecurityCriteria = {};
      const accounts = ids(c.account_ids);
      if (accounts) criteria.account_ids = accounts;
      const statuses = Array.isArray(c.statuses)
        ? c.statuses.filter((s): s is SecurityStatus => SECURITY_STATUSES.includes(s as SecurityStatus))
        : [];
      if (statuses.length) criteria.statuses = [...new Set(statuses)];
      // "Every confirmed security in every depot" is a fair rule of its own.
      return { type: "security", criteria, ...excluded };
    }
    case "meter": {
      const c = (raw.criteria ?? {}) as Record<string, unknown>;
      const criteria: MeterCriteria = {};
      const types = Array.isArray(c.meter_types)
        ? c.meter_types.filter((t): t is MeterType => METER_TYPES.includes(t as MeterType))
        : [];
      if (types.length) criteria.meter_types = [...new Set(types)];
      const loc = text(c.location);
      if (loc) criteria.location = loc;
      if (Object.keys(criteria).length === 0) return null;
      return { type: "meter", criteria, ...excluded };
    }
    default:
      return null;
  }
}

const PHOTO_BOOLEAN_KEYS = new Set([
  "showHidden", "favorite", "albumHighlight", "groupHighlight", "inGroup", "othersFavorited",
  "othersHidden", "notInAnyAlbum", "hasGps", "hasFaces", "hasAssignedPerson", "showAiHidden",
]);
const PHOTO_NUMBER_KEYS = new Set([
  "qualityMin", "qualityMax", "importedDaysAgo", "sizeMin", "sizeMax", "nearLat", "nearLon", "nearRadiusKm",
]);
const PHOTO_STRING_KEYS = new Set([
  "hiddenMode", "albumIds", "albumMode", "personIds", "personMode", "mediaTypes", "dateFrom", "dateTo",
  "aiHiddenMode", "ownerIds",
]);

/**
 * A gallery filter as the gallery sends it in its URL (all strings) or as
 * JSON, turned into the typed query the photo filter parser reads. Keys that
 * would make the rule depend on a view (its own collection, an album page,
 * the variant mode) are dropped.
 */
export function coercePhotoFilter(input: unknown): PhotoFilterQuery {
  if (!input || typeof input !== "object") return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (value === undefined || value === null || value === "") continue;
    if (PHOTO_BOOLEAN_KEYS.has(key)) {
      if (value === true || value === "true" || value === "1") out[key] = true;
      else if (value === false || value === "false" || value === "0") out[key] = false;
    } else if (PHOTO_NUMBER_KEYS.has(key)) {
      const n = Number(value);
      if (Number.isFinite(n)) out[key] = n;
    } else if (PHOTO_STRING_KEYS.has(key)) {
      out[key] = String(value);
    }
  }
  return out as PhotoFilterQuery;
}

/** Accounts the owner may read through the ACL (rules run without admin rights). */
async function ownerAccountIds(ownerId: number): Promise<number[]> {
  const rows = await dbAll<{ id: number }>(
    db
      .select({ id: financeAccountAccess.account_id })
      .from(financeAccountAccess)
      .where(eq(financeAccountAccess.user_id, ownerId)),
  );
  return rows.map((r) => r.id);
}

function within(readable: number[], wanted?: number[]): number[] {
  return wanted ? readable.filter((id) => wanted.includes(id)) : readable;
}

/** The ids the rule matches today, seen as `ownerId`. */
export async function matchingIds(rule: MemberRule, ownerId: number): Promise<number[]> {
  switch (rule.type) {
    case "photo": {
      const params = parsePhotoFilterQuery(rule.filter);
      return (await listGalleryIdsLogic(ownerId, params, { sortBy: "taken_at", sortDir: "desc" })).ids;
    }
    case "transaction": {
      const c = rule.criteria;
      const accounts = within(await ownerAccountIds(ownerId), c.account_ids);
      if (accounts.length === 0) return [];
      const conds: SQL[] = [inArray(financeTransaction.account_id, accounts)];
      if (c.from) conds.push(gte(financeTransaction.booking_date, c.from));
      if (c.to) conds.push(lte(financeTransaction.booking_date, c.to));
      if (c.text) {
        const like = `%${c.text}%`;
        conds.push(
          or(
            ilike(financeTransaction.counterparty, like),
            ilike(financeTransaction.purpose, like),
            ilike(financeTransaction.notice, like),
          )!,
        );
      }
      if (c.tax_relevant !== undefined) {
        const flagged = taxRelevantCondition();
        conds.push(c.tax_relevant ? flagged : not(flagged));
      }
      for (const tag of c.tags ?? []) conds.push(taggedWithCondition(tag));
      const rows = await dbAll<{ id: number }>(
        db.select({ id: financeTransaction.id }).from(financeTransaction).where(and(...conds)),
      );
      return rows.map((r) => Number(r.id));
    }
    case "security": {
      const c = rule.criteria;
      const accounts = within(await ownerAccountIds(ownerId), c.account_ids);
      if (accounts.length === 0) return [];
      const rows = await dbAll<{ id: number }>(
        db
          .select({ id: financeDepotSecurity.id })
          .from(financeDepotSecurity)
          .where(
            and(
              inArray(financeDepotSecurity.account_id, accounts),
              inArray(financeDepotSecurity.status, c.statuses ?? ["confirmed"]),
            ),
          ),
      );
      return rows.map((r) => Number(r.id));
    }
    case "meter": {
      const c = rule.criteria;
      const groupIds = await loadUserGroupIds(ownerId);
      const conds: SQL[] = [visibleMetersWhere(ownerId, groupIds)];
      if (c.meter_types?.length) conds.push(inArray(meters.type, c.meter_types));
      if (c.location) conds.push(ilike(meters.location, `%${c.location}%`));
      const rows = await dbAll<{ id: number }>(db.select({ id: meters.id }).from(meters).where(and(...conds)));
      return rows.map((r) => r.id);
    }
  }
}

export function ruleOf(row: Pick<CollectionRow, "kind" | "rule">): MemberRule | null {
  if (row.kind !== "rule" || !row.rule) return null;
  const rule = row.rule as unknown as MemberRule;
  return RULE_TYPES.includes(rule.type) ? rule : null;
}

export interface RuleApplyResult {
  added: number;
  removed: number;
}

/**
 * Bring a rule collection up to date: add what matches and is neither in it
 * nor excluded, take out what the rule added and no longer matches.
 */
export async function applyMemberRule(row: CollectionRow): Promise<RuleApplyResult> {
  const rule = ruleOf(row);
  if (!rule) return { added: 0, removed: 0 };
  const excluded = new Set(rule.excluded_ids ?? []);
  const wanted = new Set((await matchingIds(rule, row.user_id)).filter((id) => !excluded.has(id)));

  const current = await dbAll<{ entity_id: number; joined_by: "user" | "rule" }>(
    db
      .select({ entity_id: collectionMembers.entity_id, joined_by: collectionMembers.joined_by })
      .from(collectionMembers)
      .where(and(eq(collectionMembers.collection_id, row.id), eq(collectionMembers.entity_type, rule.type))),
  );
  const present = new Set(current.map((m) => Number(m.entity_id)));
  const toAdd = [...wanted].filter((id) => !present.has(id));
  const toRemove = current
    .filter((m) => m.joined_by === "rule" && !wanted.has(Number(m.entity_id)))
    .map((m) => Number(m.entity_id));

  for (let i = 0; i < toAdd.length; i += 1000) {
    await dbExec(
      db
        .insert(collectionMembers)
        .values(
          toAdd.slice(i, i + 1000).map((entityId) => ({
            collection_id: row.id,
            entity_type: rule.type,
            entity_id: entityId,
            joined_by: "rule" as const,
          })),
        )
        .onConflictDoNothing(),
    );
  }
  if (toRemove.length) {
    await dbExec(
      db
        .delete(collectionMembers)
        .where(
          and(
            eq(collectionMembers.collection_id, row.id),
            eq(collectionMembers.entity_type, rule.type),
            inArray(collectionMembers.entity_id, toRemove),
          ),
        ),
    );
  }
  if (toAdd.length || toRemove.length) {
    await dbExec(
      db.update(documentCollections).set({ updated_at: sql`now()` }).where(eq(documentCollections.id, row.id)),
    );
  }
  return { added: toAdd.length, removed: toRemove.length };
}

/** Remember that a person took this member out, so the rule leaves it out. */
export async function excludeFromRule(row: CollectionRow, type: CollectionMemberType, id: number): Promise<void> {
  const rule = ruleOf(row);
  if (!rule || rule.type !== type) return;
  const excluded = new Set(rule.excluded_ids ?? []);
  if (excluded.has(id)) return;
  excluded.add(id);
  await dbExec(
    db
      .update(documentCollections)
      .set({ rule: { ...rule, excluded_ids: [...excluded] } as never })
      .where(eq(documentCollections.id, row.id)),
  );
}

/** Every rule collection, brought up to date (the hourly job). */
export async function applyAllMemberRules(): Promise<{ collections: number; added: number; removed: number }> {
  const rows = await dbAll<CollectionRow>(
    db.select().from(documentCollections).where(eq(documentCollections.kind, "rule")),
  );
  let added = 0;
  let removed = 0;
  for (const row of rows) {
    try {
      const r = await applyMemberRule(row);
      added += r.added;
      removed += r.removed;
    } catch (err) {
      console.warn(`[collections] rule of collection ${row.id} failed:`, err);
    }
  }
  return { collections: rows.length, added, removed };
}
