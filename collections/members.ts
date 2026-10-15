/**
 * What a collection member is, and whether the reader may see it (#1548).
 *
 * A collection holds references; each reference belongs to a module that
 * alone knows who may open the row and how to name it. This file asks each
 * module's own access rule — documents and meters by owner or group, photos
 * and albums by ownership and album shares, transactions and securities by
 * the account ACL — and turns a visible row into one display shape.
 *
 * A member the reader may not open is left out, never shown as a stub: in a
 * group collection two readers can therefore see different members, as they
 * already see different documents in a group folder's PDF.
 */

import { and, eq, inArray, or, sql, type SQL } from "drizzle-orm";
import db from "../db/database";
import { dbAll } from "../db/adapter";
import {
  albumShares,
  albums,
  documents,
  financeAccount,
  financeDepotSecurity,
  financeTransaction,
  meterDevices,
  meterReadings,
  meters,
  photos,
  type CollectionEntityType,
} from "../db/schema";
import { accessiblePhotoCondition } from "../photo/photo-file-access";
import { readableFinanceAccountIds } from "../finance/account-acl";
import { visibleMetersWhere } from "../meter/meter.service";
import { loadUserGroupIds, visibleDocumentsWhere } from "../documents/visibility";

export const COLLECTION_ENTITY_TYPES: readonly CollectionEntityType[] = [
  "document",
  "photo",
  "album",
  "transaction",
  "security",
  "meter",
  "meter_reading",
];

export function isCollectionEntityType(value: unknown): value is CollectionEntityType {
  return typeof value === "string" && (COLLECTION_ENTITY_TYPES as readonly string[]).includes(value);
}

export interface Caller {
  userId: number;
  permissions: string[];
}

/** How a member looks in a list, whatever its type. */
export interface MemberDisplay {
  title: string;
  /** A second line: sender, account, meter location, album event. */
  subtitle: string | null;
  /** The date the member is about (taken, booked, read), ISO. */
  date: string | null;
  /** Transactions only: signed amount as text, and its currency. */
  amount: string | null;
  currency: string | null;
}

/**
 * The permissions a caller needs before any member of this type is theirs to
 * see. Without them the type is invisible, as its module is.
 */
const REQUIRED_PERMISSIONS: Record<CollectionEntityType, string[]> = {
  document: ["module.documents", "documents.view"],
  photo: ["module.photos", "photos.view"],
  album: ["module.photos", "photos.view"],
  transaction: ["finance.view"],
  security: ["finance.view"],
  meter: ["meters.view"],
  meter_reading: ["meters.view"],
};

export function mayUseType(caller: Caller, type: CollectionEntityType): boolean {
  return REQUIRED_PERMISSIONS[type].every((p) => caller.permissions.includes(p));
}

function display(partial: Partial<MemberDisplay> & { title: string }): MemberDisplay {
  return { subtitle: null, date: null, amount: null, currency: null, ...partial };
}

function nonEmpty(...values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

/** "1234.500" → "1234.5": the column's scale, not the reading's precision. */
export function trimDecimals(value: string): string {
  return value.includes(".") ? value.replace(/\.?0+$/, "") : value;
}

type Resolver = (caller: Caller, ids: number[]) => Promise<Map<number, MemberDisplay>>;

const resolveDocuments: Resolver = async (caller, ids) => {
  const isAdmin = caller.permissions.includes("data.manage");
  const groupIds = isAdmin ? [] : await loadUserGroupIds(caller.userId);
  const where = isAdmin
    ? inArray(documents.id, ids)
    : and(inArray(documents.id, ids), visibleDocumentsWhere(caller.userId, groupIds))!;
  const rows = await dbAll<{
    id: number;
    title: string | null;
    original_filename: string;
    sender: string | null;
    doc_date: string | null;
  }>(
    db
      .select({
        id: documents.id,
        title: documents.title,
        original_filename: documents.original_filename,
        sender: documents.sender,
        doc_date: documents.doc_date,
      })
      .from(documents)
      .where(where),
  );
  return new Map(
    rows.map((r) => [
      r.id,
      display({
        title: nonEmpty(r.title, r.original_filename) ?? `#${r.id}`,
        subtitle: r.sender,
        date: r.doc_date,
      }),
    ]),
  );
};

const resolvePhotos: Resolver = async (caller, ids) => {
  const rows = await dbAll<{
    id: number;
    original_name: string;
    location_short: string | null;
    taken_at: string | null;
    created_at: string | null;
  }>(
    db
      .select({
        id: photos.id,
        original_name: photos.original_name,
        location_short: photos.location_short,
        taken_at: photos.taken_at,
        created_at: photos.created_at,
      })
      .from(photos)
      .where(and(inArray(photos.id, ids), accessiblePhotoCondition(caller.userId))),
  );
  return new Map(
    rows.map((r) => [
      r.id,
      display({ title: r.original_name, subtitle: r.location_short, date: r.taken_at ?? r.created_at }),
    ]),
  );
};

/** Same rule as the photo module: the owner, or anyone the album is shared with. */
function readableAlbumsWhere(userId: number): SQL {
  return or(
    eq(albums.user_id, userId),
    sql`EXISTS (SELECT 1 FROM ${albumShares} s WHERE s.album_id = ${albums.id} AND s.user_id = ${userId})`,
  )!;
}

const resolveAlbums: Resolver = async (caller, ids) => {
  const rows = await dbAll<{
    id: number;
    name: string;
    event_name: string | null;
    created_at: string | null;
  }>(
    db
      .select({
        id: albums.id,
        name: albums.name,
        event_name: albums.event_name,
        created_at: albums.created_at,
      })
      .from(albums)
      .where(and(inArray(albums.id, ids), readableAlbumsWhere(caller.userId))),
  );
  return new Map(
    rows.map((r) => [r.id, display({ title: r.name, subtitle: r.event_name, date: r.created_at })]),
  );
};

async function readableAccounts(caller: Caller): Promise<number[] | null> {
  return await readableFinanceAccountIds({
    userID: String(caller.userId),
    permissions: caller.permissions,
  });
}

const resolveTransactions: Resolver = async (caller, ids) => {
  const accountIds = await readableAccounts(caller);
  if (accountIds !== null && accountIds.length === 0) return new Map();
  const conditions = [inArray(financeTransaction.id, ids)];
  if (accountIds !== null) conditions.push(inArray(financeTransaction.account_id, accountIds));
  const rows = await dbAll<{
    id: number;
    counterparty: string | null;
    purpose: string | null;
    booking_date: string | null;
    amount: string;
    currency_code: string | null;
    account_name: string | null;
  }>(
    db
      .select({
        id: financeTransaction.id,
        counterparty: financeTransaction.counterparty,
        purpose: financeTransaction.purpose,
        booking_date: financeTransaction.booking_date,
        amount: financeTransaction.amount,
        currency_code: financeTransaction.currency_code,
        account_name: financeAccount.label,
      })
      .from(financeTransaction)
      .leftJoin(financeAccount, eq(financeAccount.id, financeTransaction.account_id))
      .where(and(...conditions)),
  );
  return new Map(
    rows.map((r) => [
      r.id,
      display({
        title: nonEmpty(r.counterparty, r.purpose) ?? `#${r.id}`,
        subtitle: r.account_name,
        date: r.booking_date,
        amount: r.amount,
        currency: r.currency_code ?? "EUR",
      }),
    ]),
  );
};

const resolveSecurities: Resolver = async (caller, ids) => {
  const accountIds = await readableAccounts(caller);
  if (accountIds !== null && accountIds.length === 0) return new Map();
  const conditions = [inArray(financeDepotSecurity.id, ids)];
  if (accountIds !== null) conditions.push(inArray(financeDepotSecurity.account_id, accountIds));
  const rows = await dbAll<{
    id: number;
    name: string | null;
    isin: string | null;
    wkn: string | null;
    first_seen_at: string | null;
    account_name: string | null;
  }>(
    db
      .select({
        id: financeDepotSecurity.id,
        name: financeDepotSecurity.name,
        isin: financeDepotSecurity.isin,
        wkn: financeDepotSecurity.wkn,
        first_seen_at: financeDepotSecurity.first_seen_at,
        account_name: financeAccount.label,
      })
      .from(financeDepotSecurity)
      .leftJoin(financeAccount, eq(financeAccount.id, financeDepotSecurity.account_id))
      .where(and(...conditions)),
  );
  return new Map(
    rows.map((r) => [
      r.id,
      display({
        title: nonEmpty(r.name, r.isin, r.wkn) ?? `#${r.id}`,
        subtitle: r.account_name,
        date: r.first_seen_at,
      }),
    ]),
  );
};

const resolveMeters: Resolver = async (caller, ids) => {
  const groupIds = await loadUserGroupIds(caller.userId);
  const rows = await dbAll<{
    id: number;
    name: string;
    location: string | null;
    created_at: string | null;
  }>(
    db
      .select({
        id: meters.id,
        name: meters.name,
        location: meters.location,
        created_at: meters.created_at,
      })
      .from(meters)
      .where(and(inArray(meters.id, ids), visibleMetersWhere(caller.userId, groupIds))),
  );
  return new Map(
    rows.map((r) => [r.id, display({ title: r.name, subtitle: r.location, date: r.created_at })]),
  );
};

const resolveMeterReadings: Resolver = async (caller, ids) => {
  const groupIds = await loadUserGroupIds(caller.userId);
  const rows = await dbAll<{
    id: number;
    value: string;
    taken_at: string | null;
    meter_name: string;
    unit: string | null;
  }>(
    db
      .select({
        id: meterReadings.id,
        value: meterReadings.value,
        taken_at: meterReadings.taken_at,
        meter_name: meters.name,
        unit: meters.unit,
      })
      .from(meterReadings)
      .innerJoin(meterDevices, eq(meterDevices.id, meterReadings.device_id))
      .innerJoin(meters, eq(meters.id, meterDevices.meter_id))
      .where(and(inArray(meterReadings.id, ids), visibleMetersWhere(caller.userId, groupIds))),
  );
  return new Map(
    rows.map((r) => [
      r.id,
      display({
        title: `${r.meter_name}: ${trimDecimals(r.value)}${r.unit ? ` ${r.unit}` : ""}`,
        subtitle: r.meter_name,
        date: r.taken_at,
      }),
    ]),
  );
};

const RESOLVERS: Record<CollectionEntityType, Resolver> = {
  document: resolveDocuments,
  photo: resolvePhotos,
  album: resolveAlbums,
  transaction: resolveTransactions,
  security: resolveSecurities,
  meter: resolveMeters,
  meter_reading: resolveMeterReadings,
};

/**
 * The members of one type the caller may see, by id, with how they look.
 * Ids the caller may not see, or that no longer exist, are absent.
 */
export async function resolveMembers(
  caller: Caller,
  type: CollectionEntityType,
  ids: number[],
): Promise<Map<number, MemberDisplay>> {
  const wanted = [...new Set(ids.filter((id) => Number.isInteger(id) && id > 0))];
  if (wanted.length === 0 || !mayUseType(caller, type)) return new Map();
  return await RESOLVERS[type](caller, wanted);
}
