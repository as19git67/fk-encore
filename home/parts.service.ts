/**
 * Haus › Ersatzteile — the household's catalog of spare parts and
 * consumables (documentation/plans/haus-anlagen.md, stage 3).
 *
 * A part (`home_parts`) says what it is (name, manufacturer, part number,
 * EAN, specification, where to buy it), where it is stored and how many are
 * left (`stock`, null = not counted). It fits any number of systems
 * (`home_system_parts`), and an item in place may name the part it takes
 * (`home_system_items.part_id`). There is no reorder logic: a part with
 * stock 0 is only marked.
 *
 * Visibility as for the systems (lib/household.ts): the owner and every
 * member of the part's group; a new part without a choice goes to the
 * creator's household. Everybody who sees a part may change its data and
 * stock (shared knowledge, like guides); sharing and deleting stay with its
 * owner and the owners of its group. Outside the scope a part is `not_found`.
 */

import { and, asc, eq, ilike, inArray, or, sql, type SQL } from "drizzle-orm";
import { APIError } from "encore.dev/api";
import db from "../db/database";
import { dbAll, dbFirst } from "../db/adapter";
import { groups, homeParts, homeSystemItems, homeSystemParts, homeSystems, users } from "../db/schema";
import {
  loadOwnedGroupIds,
  loadUserGroupIds,
  mayManageShared,
  resolveShareGroup,
} from "../lib/household";
import { likePattern, optionalText, requiredText } from "./input";
import { listPartMedia, partCovers, removeMediaOfTarget, type HomeMedia } from "./media-store";

type PartRow = typeof homeParts.$inferSelect;

/** Highest stock a part can carry — a box of screws, not a warehouse. */
export const MAX_STOCK = 100_000;

// ── Access ──────────────────────────────────────────────────────────────────

/** WHERE fragment selecting every part visible to `userId`. */
export function visiblePartsWhere(userId: number, groupIds: number[]): SQL {
  const own = eq(homeParts.owner_user_id, userId);
  if (groupIds.length === 0) return own;
  return or(own, inArray(homeParts.group_id, groupIds))!;
}

/** The same condition for a raw query over `home_parts <alias>`. */
export function visiblePartsSql(alias: string, userId: number, groupIds: number[]): SQL {
  const owner = sql.raw(`${alias}.owner_user_id`);
  if (groupIds.length === 0) return sql`${owner} = ${userId}`;
  const group = sql.raw(`${alias}.group_id`);
  return sql`(${owner} = ${userId} OR ${group} IN (${sql.join(
    groupIds.map((id) => sql`${id}`),
    sql`, `,
  )}))`;
}

/** A part the caller sees, else `not_found` (existence stays hidden). */
export async function loadVisiblePart(userId: number, partId: number): Promise<PartRow> {
  const groupIds = await loadUserGroupIds(userId);
  const row = await dbFirst<PartRow>(
    db
      .select()
      .from(homeParts)
      .where(and(eq(homeParts.id, partId), visiblePartsWhere(userId, groupIds))),
  );
  if (!row) throw APIError.notFound("part not found");
  return row;
}

async function loadManageablePart(userId: number, partId: number): Promise<PartRow> {
  const row = await loadVisiblePart(userId, partId);
  if (!mayManageShared(userId, row, await loadOwnedGroupIds(userId))) {
    throw APIError.permissionDenied("only the part's owner or an owner of its group can do this");
  }
  return row;
}

// ── Normalising input ───────────────────────────────────────────────────────

function normalizeStock(value: number | null | undefined): number | null {
  if (value === undefined || value === null) return null;
  if (!Number.isInteger(value) || value < 0 || value > MAX_STOCK) {
    throw APIError.invalidArgument(`stock must be a whole number from 0 to ${MAX_STOCK}`);
  }
  return value;
}

/** Only http(s) addresses: the link is opened from the page. */
export function normalizeUrl(value: string | null | undefined): string | null {
  const text = optionalText(value, "supplierUrl", 2000);
  if (!text) return null;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw APIError.invalidArgument("supplierUrl is not a web address");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw APIError.invalidArgument("supplierUrl must start with http:// or https://");
  }
  return url.toString();
}

/** EAN/GTIN: 8 to 14 digits, spaces dropped. */
export function normalizeEan(value: string | null | undefined): string | null {
  const text = (value ?? "").replace(/\s+/g, "");
  if (!text) return null;
  if (!/^\d{8,14}$/.test(text)) throw APIError.invalidArgument("ean must have 8 to 14 digits");
  return text;
}

// ── Reading ─────────────────────────────────────────────────────────────────

interface PartSharing {
  groupId: number | null;
  groupName: string | null;
  household: boolean;
  ownerUserId: number;
  ownerName: string;
  /** The caller may share or delete the part. */
  canManage: boolean;
}

export interface HomePartSystemRef {
  id: number;
  name: string;
}

export interface HomePartListItem extends PartSharing {
  id: number;
  name: string;
  manufacturer: string | null;
  partNumber: string | null;
  specification: string | null;
  storageLocation: string | null;
  stock: number | null;
  /** Systems the part fits, only those the caller sees. */
  systems: HomePartSystemRef[];
  coverMediaId: number | null;
  updatedAt: string;
}

export interface HomePartItemRef {
  systemId: number;
  systemName: string;
  itemId: number;
  label: string;
  location: string | null;
}

export interface HomePartDetail extends HomePartListItem {
  ean: string | null;
  supplierUrl: string | null;
  notes: string | null;
  createdAt: string;
  /** Items in place that take this part, in systems the caller sees. */
  items: HomePartItemRef[];
  media: HomeMedia[];
}

type PartWithSharing = PartRow & {
  owner_name: string;
  group_name: string | null;
  group_household: boolean | null;
};

const partColumns = {
  id: homeParts.id,
  name: homeParts.name,
  manufacturer: homeParts.manufacturer,
  part_number: homeParts.part_number,
  ean: homeParts.ean,
  specification: homeParts.specification,
  supplier_url: homeParts.supplier_url,
  storage_location: homeParts.storage_location,
  stock: homeParts.stock,
  notes: homeParts.notes,
  owner_user_id: homeParts.owner_user_id,
  group_id: homeParts.group_id,
  created_at: homeParts.created_at,
  updated_at: homeParts.updated_at,
  owner_name: users.name,
  group_name: groups.name,
  group_household: groups.household,
};

/** Systems each part fits, among the systems `userId` sees. */
async function systemsOf(
  userId: number,
  groupIds: number[],
  partIds: number[],
): Promise<Map<number, HomePartSystemRef[]>> {
  const result = new Map<number, HomePartSystemRef[]>();
  if (partIds.length === 0) return result;
  const own = eq(homeSystems.owner_user_id, userId);
  const visible = groupIds.length ? or(own, inArray(homeSystems.group_id, groupIds))! : own;
  const rows = await dbAll<{ part_id: number; id: number; name: string }>(
    db
      .select({ part_id: homeSystemParts.part_id, id: homeSystems.id, name: homeSystems.name })
      .from(homeSystemParts)
      .innerJoin(homeSystems, eq(homeSystems.id, homeSystemParts.system_id))
      .where(and(inArray(homeSystemParts.part_id, partIds), visible))
      .orderBy(asc(homeSystems.name), asc(homeSystems.id)),
  );
  for (const r of rows) {
    const list = result.get(r.part_id) ?? [];
    list.push({ id: r.id, name: r.name });
    result.set(r.part_id, list);
  }
  return result;
}

function toListItem(
  userId: number,
  row: PartWithSharing,
  ownedGroupIds: number[],
  systems: HomePartSystemRef[],
  coverMediaId: number | null,
): HomePartListItem {
  return {
    id: row.id,
    name: row.name,
    manufacturer: row.manufacturer,
    partNumber: row.part_number,
    specification: row.specification,
    storageLocation: row.storage_location,
    stock: row.stock,
    systems,
    coverMediaId,
    updatedAt: row.updated_at,
    groupId: row.group_id,
    groupName: row.group_name,
    household: row.group_household === true,
    ownerUserId: row.owner_user_id,
    ownerName: row.owner_name,
    canManage: mayManageShared(userId, row, ownedGroupIds),
  };
}

export interface ListPartsOptions {
  q?: string;
  /** Only parts with stock 0. */
  empty?: boolean;
  /** Only parts that fit this system. */
  systemId?: number;
}

export async function listParts(userId: number, opts: ListPartsOptions = {}): Promise<HomePartListItem[]> {
  const groupIds = await loadUserGroupIds(userId);
  const ownedGroupIds = await loadOwnedGroupIds(userId);
  const conditions: SQL[] = [visiblePartsWhere(userId, groupIds)];
  if (opts.empty) conditions.push(eq(homeParts.stock, 0));
  if (opts.systemId !== undefined) {
    conditions.push(
      sql`EXISTS (SELECT 1 FROM home_system_parts sp WHERE sp.part_id = ${homeParts.id}
            AND sp.system_id = ${opts.systemId})`,
    );
  }
  const term = (opts.q ?? "").trim();
  if (term) {
    const pattern = likePattern(term);
    conditions.push(
      or(
        ilike(homeParts.name, pattern),
        ilike(homeParts.manufacturer, pattern),
        ilike(homeParts.part_number, pattern),
        ilike(homeParts.ean, pattern),
        ilike(homeParts.specification, pattern),
        ilike(homeParts.storage_location, pattern),
        ilike(homeParts.notes, pattern),
      )!,
    );
  }
  const rows = await dbAll<PartWithSharing>(
    db
      .select(partColumns)
      .from(homeParts)
      .innerJoin(users, eq(users.id, homeParts.owner_user_id))
      .leftJoin(groups, eq(groups.id, homeParts.group_id))
      .where(and(...conditions))
      .orderBy(asc(homeParts.name), asc(homeParts.id)),
  );
  const ids = rows.map((r) => r.id);
  const [systems, covers] = await Promise.all([systemsOf(userId, groupIds, ids), partCovers(ids)]);
  return rows.map((row) =>
    toListItem(userId, row, ownedGroupIds, systems.get(row.id) ?? [], covers.get(row.id) ?? null),
  );
}

export async function getPartDetail(userId: number, partId: number): Promise<HomePartDetail> {
  await loadVisiblePart(userId, partId);
  const groupIds = await loadUserGroupIds(userId);
  const ownedGroupIds = await loadOwnedGroupIds(userId);
  const row = await dbFirst<PartWithSharing>(
    db
      .select(partColumns)
      .from(homeParts)
      .innerJoin(users, eq(users.id, homeParts.owner_user_id))
      .leftJoin(groups, eq(groups.id, homeParts.group_id))
      .where(eq(homeParts.id, partId)),
  );
  if (!row) throw APIError.notFound("part not found");
  const own = eq(homeSystems.owner_user_id, userId);
  const visibleSystem = groupIds.length ? or(own, inArray(homeSystems.group_id, groupIds))! : own;
  const [systems, media, items] = await Promise.all([
    systemsOf(userId, groupIds, [partId]),
    listPartMedia(partId),
    dbAll<{ system_id: number; system_name: string; id: number; label: string; location: string | null }>(
      db
        .select({
          system_id: homeSystems.id,
          system_name: homeSystems.name,
          id: homeSystemItems.id,
          label: homeSystemItems.label,
          location: homeSystemItems.location,
        })
        .from(homeSystemItems)
        .innerJoin(homeSystems, eq(homeSystems.id, homeSystemItems.system_id))
        .where(and(eq(homeSystemItems.part_id, partId), visibleSystem))
        .orderBy(asc(homeSystems.name), asc(homeSystemItems.sort), asc(homeSystemItems.id)),
    ),
  ]);
  return {
    ...toListItem(userId, row, ownedGroupIds, systems.get(partId) ?? [], media[0]?.id ?? null),
    ean: row.ean,
    supplierUrl: row.supplier_url,
    notes: row.notes,
    createdAt: row.created_at,
    items: items.map((i) => ({
      systemId: i.system_id,
      systemName: i.system_name,
      itemId: i.id,
      label: i.label,
      location: i.location,
    })),
    media,
  };
}

// ── Writing ─────────────────────────────────────────────────────────────────

export interface PartInput {
  name: string;
  manufacturer?: string | null;
  partNumber?: string | null;
  ean?: string | null;
  specification?: string | null;
  supplierUrl?: string | null;
  storageLocation?: string | null;
  stock?: number | null;
  notes?: string | null;
  /** Omitted: the caller's household; null: private. */
  groupId?: number | null;
}

export async function createPart(userId: number, input: PartInput): Promise<{ id: number }> {
  const groupId = await resolveShareGroup(userId, input.groupId);
  const [row] = await db
    .insert(homeParts)
    .values({
      name: requiredText(input.name, "name"),
      manufacturer: optionalText(input.manufacturer, "manufacturer", 200),
      part_number: optionalText(input.partNumber, "partNumber", 200),
      ean: normalizeEan(input.ean),
      specification: optionalText(input.specification, "specification", 2000),
      supplier_url: normalizeUrl(input.supplierUrl),
      storage_location: optionalText(input.storageLocation, "storageLocation", 500),
      stock: normalizeStock(input.stock),
      notes: optionalText(input.notes, "notes"),
      owner_user_id: userId,
      group_id: groupId,
    })
    .returning({ id: homeParts.id });
  return { id: row.id };
}

export async function updatePart(userId: number, partId: number, patch: Partial<PartInput>): Promise<void> {
  // Sharing is the owner's choice; the data is everybody's who sees the part.
  if (patch.groupId !== undefined) await loadManageablePart(userId, partId);
  else await loadVisiblePart(userId, partId);
  const set: Partial<typeof homeParts.$inferInsert> = { updated_at: new Date().toISOString() };
  if (patch.name !== undefined) set.name = requiredText(patch.name, "name");
  if (patch.manufacturer !== undefined) set.manufacturer = optionalText(patch.manufacturer, "manufacturer", 200);
  if (patch.partNumber !== undefined) set.part_number = optionalText(patch.partNumber, "partNumber", 200);
  if (patch.ean !== undefined) set.ean = normalizeEan(patch.ean);
  if (patch.specification !== undefined) set.specification = optionalText(patch.specification, "specification", 2000);
  if (patch.supplierUrl !== undefined) set.supplier_url = normalizeUrl(patch.supplierUrl);
  if (patch.storageLocation !== undefined) {
    set.storage_location = optionalText(patch.storageLocation, "storageLocation", 500);
  }
  if (patch.stock !== undefined) set.stock = normalizeStock(patch.stock);
  if (patch.notes !== undefined) set.notes = optionalText(patch.notes, "notes");
  if (patch.groupId !== undefined) set.group_id = await resolveShareGroup(userId, patch.groupId);
  await db.update(homeParts).set(set).where(eq(homeParts.id, partId));
}

/**
 * Take parts out or put them back ("one used", "five bought") in one step,
 * so two people at the shelf do not overwrite each other's count.
 */
export async function adjustStock(userId: number, partId: number, delta: number): Promise<number> {
  const part = await loadVisiblePart(userId, partId);
  if (!Number.isInteger(delta) || delta === 0 || Math.abs(delta) > MAX_STOCK) {
    throw APIError.invalidArgument("delta must be a whole number other than 0");
  }
  if (part.stock === null) {
    throw APIError.failedPrecondition("the stock of this part is not counted; set a number first");
  }
  const [row] = await dbAll<{ stock: number }>(
    db
      .update(homeParts)
      .set({ stock: sql`${homeParts.stock} + ${delta}`, updated_at: new Date().toISOString() })
      .where(
        and(
          eq(homeParts.id, partId),
          sql`${homeParts.stock} + ${delta} BETWEEN 0 AND ${MAX_STOCK}`,
        ),
      )
      .returning({ stock: homeParts.stock }),
  );
  if (!row) throw APIError.failedPrecondition("not that many left");
  return Number(row.stock);
}

export async function deletePart(userId: number, partId: number): Promise<void> {
  await loadManageablePart(userId, partId);
  // Links go with it (cascade), items keep their row without the part.
  await db.delete(homeParts).where(eq(homeParts.id, partId));
  await removeMediaOfTarget("part", partId);
}

// ── Systems and parts ───────────────────────────────────────────────────────

/** Fit a visible part to a system (no-op when it already is). */
export async function linkPart(systemId: number, partId: number): Promise<void> {
  await db
    .insert(homeSystemParts)
    .values({ system_id: systemId, part_id: partId })
    .onConflictDoNothing();
}

/**
 * Set which parts fit a system. Only parts the caller sees are touched:
 * links to parts they cannot see stay as they are. The caller must already
 * see the system (checked by the system service).
 */
export async function setSystemPartLinks(userId: number, systemId: number, partIds: number[]): Promise<void> {
  const wanted = [...new Set(partIds)];
  const groupIds = await loadUserGroupIds(userId);
  if (wanted.length > 0) {
    const visible = await dbAll<{ id: number }>(
      db
        .select({ id: homeParts.id })
        .from(homeParts)
        .where(and(inArray(homeParts.id, wanted), visiblePartsWhere(userId, groupIds))),
    );
    if (visible.length !== wanted.length) throw APIError.notFound("part not found");
  }
  const current = await dbAll<{ part_id: number }>(
    db
      .select({ part_id: homeSystemParts.part_id })
      .from(homeSystemParts)
      .innerJoin(homeParts, eq(homeParts.id, homeSystemParts.part_id))
      .where(and(eq(homeSystemParts.system_id, systemId), visiblePartsWhere(userId, groupIds))),
  );
  const remove = current.map((c) => c.part_id).filter((id) => !wanted.includes(id));
  await db.transaction(async (tx) => {
    if (remove.length > 0) {
      await tx
        .delete(homeSystemParts)
        .where(and(eq(homeSystemParts.system_id, systemId), inArray(homeSystemParts.part_id, remove)));
    }
    if (wanted.length > 0) {
      await tx
        .insert(homeSystemParts)
        .values(wanted.map((partId) => ({ system_id: systemId, part_id: partId })))
        .onConflictDoNothing();
    }
  });
}

export interface HomeSystemPart {
  id: number;
  name: string;
  manufacturer: string | null;
  partNumber: string | null;
  specification: string | null;
  storageLocation: string | null;
  stock: number | null;
}

/** The visible parts that fit a system, for its page. */
export async function partsOfSystem(userId: number, systemId: number): Promise<HomeSystemPart[]> {
  const groupIds = await loadUserGroupIds(userId);
  const rows = await dbAll<PartRow>(
    db
      .select({
        id: homeParts.id,
        name: homeParts.name,
        manufacturer: homeParts.manufacturer,
        part_number: homeParts.part_number,
        ean: homeParts.ean,
        specification: homeParts.specification,
        supplier_url: homeParts.supplier_url,
        storage_location: homeParts.storage_location,
        stock: homeParts.stock,
        notes: homeParts.notes,
        owner_user_id: homeParts.owner_user_id,
        group_id: homeParts.group_id,
        created_at: homeParts.created_at,
        updated_at: homeParts.updated_at,
      })
      .from(homeSystemParts)
      .innerJoin(homeParts, eq(homeParts.id, homeSystemParts.part_id))
      .where(and(eq(homeSystemParts.system_id, systemId), visiblePartsWhere(userId, groupIds)))
      .orderBy(asc(homeParts.name), asc(homeParts.id)),
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    manufacturer: r.manufacturer,
    partNumber: r.part_number,
    specification: r.specification,
    storageLocation: r.storage_location,
    stock: r.stock,
  }));
}

/** Names of the visible parts among `ids`, for the item table. */
export async function visiblePartNames(userId: number, ids: number[]): Promise<Map<number, string>> {
  if (ids.length === 0) return new Map();
  const groupIds = await loadUserGroupIds(userId);
  const rows = await dbAll<{ id: number; name: string }>(
    db
      .select({ id: homeParts.id, name: homeParts.name })
      .from(homeParts)
      .where(and(inArray(homeParts.id, [...new Set(ids)]), visiblePartsWhere(userId, groupIds))),
  );
  return new Map(rows.map((r) => [r.id, r.name]));
}
