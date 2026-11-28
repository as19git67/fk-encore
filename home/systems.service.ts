/**
 * Haus › Anlagen — the handbook of the house's technical systems
 * (documentation/plans/haus-anlagen.md, stage 1).
 *
 * A system (`home_systems`) carries its guides (Markdown, with an undo
 * history in `home_system_guide_revisions`), the identical units it has at
 * different places (`home_system_items`) and dated notes
 * (`home_system_notes`). Photos of all four (`home_media`, stage 2) live in
 * media-store.ts; deleting a guide, item, note or system removes its photos.
 *
 * Visibility follows the meters (lib/household.ts): the owner sees a system,
 * and so does every member of its group; a new system without a choice goes
 * to the creator's household. Outside that scope a system is `not_found`.
 *
 * Who may change what:
 * - the system itself (name, data, sharing, archive, delete): its owner and
 *   the owners of its group;
 * - guides, items and notes: everybody who sees the system — a handbook is
 *   shared knowledge. The endpoints additionally require `home.manage`.
 */

import { and, asc, desc, eq, ilike, inArray, isNotNull, isNull, or, sql, type SQL } from "drizzle-orm";
import { APIError } from "encore.dev/api";
import db from "../db/database";
import { dbAll, dbFirst } from "../db/adapter";
import {
  groups,
  homeMedia,
  homeSystemGuideRevisions,
  homeSystemGuides,
  homeSystemItems,
  homeSystemNotes,
  homeSystems,
  users,
  type HomeItemAttribute,
  type HomeSystemCategory,
} from "../db/schema";
import {
  listSystemMedia,
  removeMediaOfSystem,
  removeMediaOfTarget,
  type HomeMedia,
} from "./media-store";
import {
  loadOwnedGroupIds,
  loadUserGroupIds,
  mayManageShared,
  resolveShareGroup,
} from "../lib/household";

export const HOME_SYSTEM_CATEGORIES: readonly HomeSystemCategory[] = [
  "heating",
  "water",
  "ventilation",
  "sanitary",
  "electrical",
  "garden",
  "building",
  "other",
];

/** A guide body is a handbook page, not a book. */
export const MAX_GUIDE_LENGTH = 100_000;
const MAX_TEXT = 10_000;
const MAX_ATTRIBUTES = 20;

type SystemRow = typeof homeSystems.$inferSelect;

// ── Access ──────────────────────────────────────────────────────────────────

/** WHERE fragment selecting every system visible to `userId`. */
export function visibleSystemsWhere(userId: number, groupIds: number[]): SQL {
  const own = eq(homeSystems.owner_user_id, userId);
  if (groupIds.length === 0) return own;
  return or(own, inArray(homeSystems.group_id, groupIds))!;
}

/** A system the caller sees, else `not_found` (existence stays hidden). */
export async function loadVisibleSystem(userId: number, systemId: number): Promise<SystemRow> {
  const groupIds = await loadUserGroupIds(userId);
  const row = await dbFirst<SystemRow>(
    db
      .select()
      .from(homeSystems)
      .where(and(eq(homeSystems.id, systemId), visibleSystemsWhere(userId, groupIds))),
  );
  if (!row) throw APIError.notFound("system not found");
  return row;
}

/** A system the caller may change itself (owner or owner of its group). */
async function loadManageableSystem(userId: number, systemId: number): Promise<SystemRow> {
  const row = await loadVisibleSystem(userId, systemId);
  if (!mayManageShared(userId, row, await loadOwnedGroupIds(userId))) {
    throw APIError.permissionDenied(
      "only the system's owner or an owner of its group can change it",
    );
  }
  return row;
}

async function touchSystem(systemId: number): Promise<void> {
  await db
    .update(homeSystems)
    .set({ updated_at: new Date().toISOString() })
    .where(eq(homeSystems.id, systemId));
}

// ── Normalising input ───────────────────────────────────────────────────────

function requiredText(value: string | undefined | null, field: string, max = 200): string {
  const trimmed = (value ?? "").trim();
  if (!trimmed) throw APIError.invalidArgument(`${field} must not be empty`);
  if (trimmed.length > max) throw APIError.invalidArgument(`${field} is too long (max ${max})`);
  return trimmed;
}

function optionalText(value: string | undefined | null, field: string, max = MAX_TEXT): string | null {
  const trimmed = (value ?? "").trim();
  if (!trimmed) return null;
  if (trimmed.length > max) throw APIError.invalidArgument(`${field} is too long (max ${max})`);
  return trimmed;
}

function normalizeCategory(category: string): HomeSystemCategory {
  if (!HOME_SYSTEM_CATEGORIES.includes(category as HomeSystemCategory)) {
    throw APIError.invalidArgument(`category must be one of: ${HOME_SYSTEM_CATEGORIES.join(", ")}`);
  }
  return category as HomeSystemCategory;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A real calendar date `YYYY-MM-DD` (2026-02-30 is refused). */
export function normalizeDate(value: string, field: string): string {
  if (!ISO_DATE.test(value)) throw APIError.invalidArgument(`${field} must be YYYY-MM-DD`);
  const [y, m, d] = value.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) {
    throw APIError.invalidArgument(`${field} is not a calendar date`);
  }
  return value;
}

function optionalDate(value: string | null | undefined, field: string): string | null {
  if (value === undefined || value === null || value.trim() === "") return null;
  return normalizeDate(value.trim(), field);
}

/** Today in the house's time zone, as `YYYY-MM-DD`. */
export function todayInHouse(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Berlin",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/** Key/value pairs of an item: trimmed, empty pairs dropped. */
export function normalizeAttributes(list: HomeItemAttribute[] | undefined): HomeItemAttribute[] {
  const result: HomeItemAttribute[] = [];
  for (const pair of list ?? []) {
    const key = (pair?.key ?? "").trim();
    const value = (pair?.value ?? "").trim();
    if (!key && !value) continue;
    if (!key) throw APIError.invalidArgument("every attribute needs a name");
    if (key.length > 100 || value.length > 500) {
      throw APIError.invalidArgument("attribute is too long");
    }
    result.push({ key, value });
  }
  if (result.length > MAX_ATTRIBUTES) {
    throw APIError.invalidArgument(`at most ${MAX_ATTRIBUTES} attributes per item`);
  }
  return result;
}

function guideBody(body: string | undefined): string {
  const text = body ?? "";
  if (text.length > MAX_GUIDE_LENGTH) {
    throw APIError.invalidArgument(`guide is too long (max ${MAX_GUIDE_LENGTH} characters)`);
  }
  return text;
}

// ── Systems ─────────────────────────────────────────────────────────────────

interface Sharing {
  groupId: number | null;
  groupName: string | null;
  household: boolean;
  ownerUserId: number;
  ownerName: string;
  /** The caller may change the system itself (data, sharing, delete). */
  canManage: boolean;
}

export interface HomeSystemListItem extends Sharing {
  id: number;
  name: string;
  category: HomeSystemCategory;
  location: string | null;
  manufacturer: string | null;
  model: string | null;
  archived: boolean;
  guideCount: number;
  itemCount: number;
  noteCount: number;
  /** Date of the newest note. */
  lastNoteOn: string | null;
  /** Where the search term was found besides the system's own fields. */
  matches: string[];
  /** The first photo of the system itself, shown on its card. */
  coverMediaId: number | null;
  updatedAt: string;
}

export interface ListSystemsOptions {
  q?: string;
  category?: string;
  /** false (default): only active systems; true: only archived ones. */
  archived?: boolean;
}

const sharingColumns = {
  owner_name: users.name,
  group_name: groups.name,
  group_household: groups.household,
};

type SystemWithSharing = SystemRow & {
  owner_name: string;
  group_name: string | null;
  group_household: boolean | null;
};

function sharingOf(userId: number, row: SystemWithSharing, ownedGroupIds: number[]): Sharing {
  return {
    groupId: row.group_id,
    groupName: row.group_name,
    household: row.group_household === true,
    ownerUserId: row.owner_user_id,
    ownerName: row.owner_name,
    canManage: mayManageShared(userId, row, ownedGroupIds),
  };
}

/** `%term%` for ILIKE, with the wildcards of the term itself escaped. */
function likePattern(term: string): string {
  return `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

export async function listSystems(
  userId: number,
  opts: ListSystemsOptions = {},
): Promise<HomeSystemListItem[]> {
  const groupIds = await loadUserGroupIds(userId);
  const ownedGroupIds = await loadOwnedGroupIds(userId);
  const conditions: SQL[] = [
    visibleSystemsWhere(userId, groupIds),
    opts.archived ? isNotNull(homeSystems.archived_at) : isNull(homeSystems.archived_at),
  ];
  if (opts.category) conditions.push(eq(homeSystems.category, normalizeCategory(opts.category)));

  const term = (opts.q ?? "").trim();
  const pattern = term ? likePattern(term) : null;
  if (pattern) {
    conditions.push(
      or(
        ilike(homeSystems.name, pattern),
        ilike(homeSystems.location, pattern),
        ilike(homeSystems.manufacturer, pattern),
        ilike(homeSystems.model, pattern),
        ilike(homeSystems.description, pattern),
        sql`EXISTS (SELECT 1 FROM home_system_guides g WHERE g.system_id = ${homeSystems.id}
              AND (g.title ILIKE ${pattern} OR g.body ILIKE ${pattern}))`,
        sql`EXISTS (SELECT 1 FROM home_system_items i WHERE i.system_id = ${homeSystems.id}
              AND (i.label ILIKE ${pattern} OR i.location ILIKE ${pattern}
                   OR i.attributes::text ILIKE ${pattern}))`,
        sql`EXISTS (SELECT 1 FROM home_system_notes n WHERE n.system_id = ${homeSystems.id}
              AND n.body ILIKE ${pattern})`,
      )!,
    );
  }

  const rows = await dbAll<SystemWithSharing>(
    db
      .select({ ...homeSystemColumns, ...sharingColumns })
      .from(homeSystems)
      .innerJoin(users, eq(users.id, homeSystems.owner_user_id))
      .leftJoin(groups, eq(groups.id, homeSystems.group_id))
      .where(and(...conditions))
      .orderBy(asc(homeSystems.name), asc(homeSystems.id)),
  );
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);

  const [guideCounts, itemCounts, noteStats] = await Promise.all([
    countBy(homeSystemGuides, homeSystemGuides.system_id, ids),
    countBy(homeSystemItems, homeSystemItems.system_id, ids),
    dbAll<{ system_id: number; count: number; last: string | null }>(
      db
        .select({
          system_id: homeSystemNotes.system_id,
          count: sql<number>`count(*)::int`,
          last: sql<string | null>`max(${homeSystemNotes.noted_on})::text`,
        })
        .from(homeSystemNotes)
        .where(inArray(homeSystemNotes.system_id, ids))
        .groupBy(homeSystemNotes.system_id),
    ),
  ]);
  const notesBySystem = new Map(noteStats.map((n) => [n.system_id, n]));
  const covers = await coversOf(ids);
  const matches = pattern ? await matchesOf(ids, pattern) : new Map<number, string[]>();

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    category: row.category,
    location: row.location,
    manufacturer: row.manufacturer,
    model: row.model,
    archived: row.archived_at !== null,
    guideCount: guideCounts.get(row.id) ?? 0,
    itemCount: itemCounts.get(row.id) ?? 0,
    noteCount: Number(notesBySystem.get(row.id)?.count ?? 0),
    lastNoteOn: notesBySystem.get(row.id)?.last ?? null,
    matches: matches.get(row.id) ?? [],
    coverMediaId: covers.get(row.id) ?? null,
    updatedAt: row.updated_at,
    ...sharingOf(userId, row, ownedGroupIds),
  }));
}

const homeSystemColumns = {
  id: homeSystems.id,
  name: homeSystems.name,
  category: homeSystems.category,
  location: homeSystems.location,
  manufacturer: homeSystems.manufacturer,
  model: homeSystems.model,
  installed_on: homeSystems.installed_on,
  description: homeSystems.description,
  owner_user_id: homeSystems.owner_user_id,
  group_id: homeSystems.group_id,
  archived_at: homeSystems.archived_at,
  created_at: homeSystems.created_at,
  updated_at: homeSystems.updated_at,
};

/** The first photo of each system itself (not of a guide, item or note). */
async function coversOf(ids: number[]): Promise<Map<number, number>> {
  const rows = await dbAll<{ system_id: number; id: number }>(
    db
      .select({ system_id: homeMedia.system_id, id: sql<number>`min(${homeMedia.id})::int` })
      .from(homeMedia)
      .where(and(inArray(homeMedia.system_id, ids), eq(homeMedia.target_kind, "system")))
      .groupBy(homeMedia.system_id),
  );
  return new Map(rows.map((r) => [r.system_id, Number(r.id)]));
}

async function countBy(
  table: typeof homeSystemGuides | typeof homeSystemItems,
  column: typeof homeSystemGuides.system_id | typeof homeSystemItems.system_id,
  ids: number[],
): Promise<Map<number, number>> {
  const rows = await dbAll<{ system_id: number; count: number }>(
    db
      .select({ system_id: column, count: sql<number>`count(*)::int` })
      .from(table)
      .where(inArray(column, ids))
      .groupBy(column),
  );
  return new Map(rows.map((r) => [r.system_id, Number(r.count)]));
}

/** Which guides and items of each system hold the term — shown under the row. */
async function matchesOf(ids: number[], pattern: string): Promise<Map<number, string[]>> {
  const result = new Map<number, string[]>();
  const add = (systemId: number, label: string) => {
    const list = result.get(systemId) ?? [];
    if (!list.includes(label)) list.push(label);
    result.set(systemId, list);
  };
  const guides = await dbAll<{ system_id: number; title: string }>(
    db
      .select({ system_id: homeSystemGuides.system_id, title: homeSystemGuides.title })
      .from(homeSystemGuides)
      .where(
        and(
          inArray(homeSystemGuides.system_id, ids),
          or(ilike(homeSystemGuides.title, pattern), ilike(homeSystemGuides.body, pattern)),
        ),
      )
      .orderBy(asc(homeSystemGuides.sort), asc(homeSystemGuides.id)),
  );
  for (const g of guides) add(g.system_id, `Anleitung „${g.title}“`);
  const items = await dbAll<{ system_id: number; label: string }>(
    db
      .select({ system_id: homeSystemItems.system_id, label: homeSystemItems.label })
      .from(homeSystemItems)
      .where(
        and(
          inArray(homeSystemItems.system_id, ids),
          or(
            ilike(homeSystemItems.label, pattern),
            ilike(homeSystemItems.location, pattern),
            sql`${homeSystemItems.attributes}::text ILIKE ${pattern}`,
          ),
        ),
      )
      .orderBy(asc(homeSystemItems.sort), asc(homeSystemItems.id)),
  );
  for (const i of items) add(i.system_id, `Einzelteil „${i.label}“`);
  const notes = await dbAll<{ system_id: number }>(
    db
      .selectDistinct({ system_id: homeSystemNotes.system_id })
      .from(homeSystemNotes)
      .where(and(inArray(homeSystemNotes.system_id, ids), ilike(homeSystemNotes.body, pattern))),
  );
  for (const n of notes) add(n.system_id, "Notizen");
  return result;
}

export interface HomeGuide {
  id: number;
  title: string;
  body: string;
  sort: number;
  updatedAt: string;
  updatedByName: string | null;
  revisionCount: number;
}

export interface HomeItem {
  id: number;
  label: string;
  location: string | null;
  attributes: HomeItemAttribute[];
  sort: number;
}

export interface HomeNote {
  id: number;
  notedOn: string;
  body: string;
  authorId: number | null;
  authorName: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface HomeSystemDetail extends Sharing {
  id: number;
  name: string;
  category: HomeSystemCategory;
  location: string | null;
  manufacturer: string | null;
  model: string | null;
  installedOn: string | null;
  description: string | null;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
  guides: HomeGuide[];
  items: HomeItem[];
  /** Newest first. */
  notes: HomeNote[];
  /** Photos of the system and of its guides, items and notes, oldest first. */
  media: HomeMedia[];
}

export async function getSystemDetail(userId: number, systemId: number): Promise<HomeSystemDetail> {
  await loadVisibleSystem(userId, systemId);
  const row = await dbFirst<SystemWithSharing>(
    db
      .select({ ...homeSystemColumns, ...sharingColumns })
      .from(homeSystems)
      .innerJoin(users, eq(users.id, homeSystems.owner_user_id))
      .leftJoin(groups, eq(groups.id, homeSystems.group_id))
      .where(eq(homeSystems.id, systemId)),
  );
  if (!row) throw APIError.notFound("system not found");
  const ownedGroupIds = await loadOwnedGroupIds(userId);

  const [guides, items, notes, media] = await Promise.all([
    dbAll<{
      id: number;
      title: string;
      body: string;
      sort: number;
      updated_at: string;
      updated_by_name: string | null;
      revision_count: number;
    }>(
      db
        .select({
          id: homeSystemGuides.id,
          title: homeSystemGuides.title,
          body: homeSystemGuides.body,
          sort: homeSystemGuides.sort,
          updated_at: homeSystemGuides.updated_at,
          updated_by_name: users.name,
          revision_count: sql<number>`(SELECT count(*)::int FROM home_system_guide_revisions r
                                       WHERE r.guide_id = ${homeSystemGuides.id})`,
        })
        .from(homeSystemGuides)
        .leftJoin(users, eq(users.id, homeSystemGuides.updated_by))
        .where(eq(homeSystemGuides.system_id, systemId))
        .orderBy(asc(homeSystemGuides.sort), asc(homeSystemGuides.id)),
    ),
    dbAll<typeof homeSystemItems.$inferSelect>(
      db
        .select()
        .from(homeSystemItems)
        .where(eq(homeSystemItems.system_id, systemId))
        .orderBy(asc(homeSystemItems.sort), asc(homeSystemItems.id)),
    ),
    dbAll<typeof homeSystemNotes.$inferSelect & { author_name: string | null }>(
      db
        .select({
          id: homeSystemNotes.id,
          system_id: homeSystemNotes.system_id,
          noted_on: homeSystemNotes.noted_on,
          body: homeSystemNotes.body,
          author_id: homeSystemNotes.author_id,
          created_at: homeSystemNotes.created_at,
          updated_at: homeSystemNotes.updated_at,
          author_name: users.name,
        })
        .from(homeSystemNotes)
        .leftJoin(users, eq(users.id, homeSystemNotes.author_id))
        .where(eq(homeSystemNotes.system_id, systemId))
        .orderBy(desc(homeSystemNotes.noted_on), desc(homeSystemNotes.id)),
    ),
    listSystemMedia(systemId),
  ]);

  return {
    id: row.id,
    name: row.name,
    category: row.category,
    location: row.location,
    manufacturer: row.manufacturer,
    model: row.model,
    installedOn: row.installed_on,
    description: row.description,
    archived: row.archived_at !== null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...sharingOf(userId, row, ownedGroupIds),
    guides: guides.map((g) => ({
      id: g.id,
      title: g.title,
      body: g.body,
      sort: g.sort,
      updatedAt: g.updated_at,
      updatedByName: g.updated_by_name,
      revisionCount: Number(g.revision_count),
    })),
    items: items.map((i) => ({
      id: i.id,
      label: i.label,
      location: i.location,
      attributes: i.attributes ?? [],
      sort: i.sort,
    })),
    notes: notes.map((n) => ({
      id: n.id,
      notedOn: n.noted_on,
      body: n.body,
      authorId: n.author_id,
      authorName: n.author_name,
      createdAt: n.created_at,
      updatedAt: n.updated_at,
    })),
    media,
  };
}

export interface SystemInput {
  name: string;
  category: string;
  location?: string | null;
  manufacturer?: string | null;
  model?: string | null;
  /** `YYYY-MM-DD`. */
  installedOn?: string | null;
  description?: string | null;
  /** Omitted: the caller's household; null: private. */
  groupId?: number | null;
}

export async function createSystem(userId: number, input: SystemInput): Promise<{ id: number }> {
  const groupId = await resolveShareGroup(userId, input.groupId);
  const [row] = await db
    .insert(homeSystems)
    .values({
      name: requiredText(input.name, "name"),
      category: normalizeCategory(input.category),
      location: optionalText(input.location, "location", 500),
      manufacturer: optionalText(input.manufacturer, "manufacturer", 200),
      model: optionalText(input.model, "model", 200),
      installed_on: optionalDate(input.installedOn, "installedOn"),
      description: optionalText(input.description, "description"),
      owner_user_id: userId,
      group_id: groupId,
    })
    .returning({ id: homeSystems.id });
  return { id: row.id };
}

export type SystemPatch = Partial<SystemInput> & { archived?: boolean };

export async function updateSystem(
  userId: number,
  systemId: number,
  patch: SystemPatch,
): Promise<void> {
  await loadManageableSystem(userId, systemId);
  const set: Partial<typeof homeSystems.$inferInsert> = { updated_at: new Date().toISOString() };
  if (patch.name !== undefined) set.name = requiredText(patch.name, "name");
  if (patch.category !== undefined) set.category = normalizeCategory(patch.category);
  if (patch.location !== undefined) set.location = optionalText(patch.location, "location", 500);
  if (patch.manufacturer !== undefined) set.manufacturer = optionalText(patch.manufacturer, "manufacturer", 200);
  if (patch.model !== undefined) set.model = optionalText(patch.model, "model", 200);
  if (patch.installedOn !== undefined) set.installed_on = optionalDate(patch.installedOn, "installedOn");
  if (patch.description !== undefined) set.description = optionalText(patch.description, "description");
  // Changing the sharing is an explicit choice: undefined leaves it alone.
  if (patch.groupId !== undefined) set.group_id = await resolveShareGroup(userId, patch.groupId);
  if (patch.archived !== undefined) set.archived_at = patch.archived ? new Date().toISOString() : null;
  await db.update(homeSystems).set(set).where(eq(homeSystems.id, systemId));
}

export async function deleteSystem(userId: number, systemId: number): Promise<void> {
  await loadManageableSystem(userId, systemId);
  // The photo files first: their rows would go with the system, the files not.
  await removeMediaOfSystem(systemId);
  // Guides (with revisions), items and notes go with it (ON DELETE CASCADE).
  await db.delete(homeSystems).where(eq(homeSystems.id, systemId));
}

// ── Guides ──────────────────────────────────────────────────────────────────

type GuideRow = typeof homeSystemGuides.$inferSelect;

async function loadGuide(userId: number, systemId: number, guideId: number): Promise<GuideRow> {
  await loadVisibleSystem(userId, systemId);
  const guide = await dbFirst<GuideRow>(
    db
      .select()
      .from(homeSystemGuides)
      .where(and(eq(homeSystemGuides.id, guideId), eq(homeSystemGuides.system_id, systemId))),
  );
  if (!guide) throw APIError.notFound("guide not found");
  return guide;
}

export interface GuideInput {
  title: string;
  body?: string;
}

export async function createGuide(
  userId: number,
  systemId: number,
  input: GuideInput,
): Promise<{ id: number }> {
  await loadVisibleSystem(userId, systemId);
  const [{ next }] = await dbAll<{ next: number }>(
    db
      .select({ next: sql<number>`coalesce(max(${homeSystemGuides.sort}) + 1, 0)::int` })
      .from(homeSystemGuides)
      .where(eq(homeSystemGuides.system_id, systemId)),
  );
  const [row] = await db
    .insert(homeSystemGuides)
    .values({
      system_id: systemId,
      title: requiredText(input.title, "title"),
      body: guideBody(input.body),
      sort: Number(next),
      updated_by: userId,
    })
    .returning({ id: homeSystemGuides.id });
  await touchSystem(systemId);
  return { id: row.id };
}

export interface GuidePatch {
  title?: string;
  body?: string;
  sort?: number;
}

/**
 * Change a guide. When the title or the text changes, the state before is
 * kept as a revision, so the edit can be undone.
 */
export async function updateGuide(
  userId: number,
  systemId: number,
  guideId: number,
  patch: GuidePatch,
): Promise<void> {
  const guide = await loadGuide(userId, systemId, guideId);
  const title = patch.title !== undefined ? requiredText(patch.title, "title") : guide.title;
  const body = patch.body !== undefined ? guideBody(patch.body) : guide.body;
  const textChanged = title !== guide.title || body !== guide.body;
  const now = new Date().toISOString();

  await db.transaction(async (tx) => {
    if (textChanged) {
      await tx.insert(homeSystemGuideRevisions).values({
        guide_id: guide.id,
        title: guide.title,
        body: guide.body,
        edited_by: guide.updated_by,
        edited_at: guide.updated_at,
      });
    }
    await tx
      .update(homeSystemGuides)
      .set({
        title,
        body,
        ...(patch.sort !== undefined ? { sort: Math.trunc(patch.sort) } : {}),
        ...(textChanged ? { updated_by: userId, updated_at: now } : {}),
      })
      .where(eq(homeSystemGuides.id, guide.id));
  });
  if (textChanged) await touchSystem(systemId);
}

export async function deleteGuide(userId: number, systemId: number, guideId: number): Promise<void> {
  const guide = await loadGuide(userId, systemId, guideId);
  await db.delete(homeSystemGuides).where(eq(homeSystemGuides.id, guide.id));
  await removeMediaOfTarget("guide", guide.id);
  await touchSystem(systemId);
}

export interface GuideRevision {
  id: number;
  title: string;
  body: string;
  editedAt: string;
  editedByName: string | null;
}

/** Earlier versions of a guide, newest first. */
export async function listGuideRevisions(
  userId: number,
  systemId: number,
  guideId: number,
): Promise<GuideRevision[]> {
  const guide = await loadGuide(userId, systemId, guideId);
  const rows = await dbAll<{
    id: number;
    title: string;
    body: string;
    edited_at: string;
    edited_by_name: string | null;
  }>(
    db
      .select({
        id: homeSystemGuideRevisions.id,
        title: homeSystemGuideRevisions.title,
        body: homeSystemGuideRevisions.body,
        edited_at: homeSystemGuideRevisions.edited_at,
        edited_by_name: users.name,
      })
      .from(homeSystemGuideRevisions)
      .leftJoin(users, eq(users.id, homeSystemGuideRevisions.edited_by))
      .where(eq(homeSystemGuideRevisions.guide_id, guide.id))
      .orderBy(desc(homeSystemGuideRevisions.id)),
  );
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    body: r.body,
    editedAt: r.edited_at,
    editedByName: r.edited_by_name,
  }));
}

/**
 * Put an earlier version back. The current text becomes a revision itself,
 * so restoring is undoable too.
 */
export async function restoreGuideRevision(
  userId: number,
  systemId: number,
  guideId: number,
  revisionId: number,
): Promise<void> {
  const guide = await loadGuide(userId, systemId, guideId);
  const revision = await dbFirst<typeof homeSystemGuideRevisions.$inferSelect>(
    db
      .select()
      .from(homeSystemGuideRevisions)
      .where(
        and(
          eq(homeSystemGuideRevisions.id, revisionId),
          eq(homeSystemGuideRevisions.guide_id, guide.id),
        ),
      ),
  );
  if (!revision) throw APIError.notFound("revision not found");
  await updateGuide(userId, systemId, guideId, { title: revision.title, body: revision.body });
}

// ── Items in place ──────────────────────────────────────────────────────────

export interface ItemInput {
  label: string;
  location?: string | null;
  attributes?: HomeItemAttribute[];
}

async function loadItem(userId: number, systemId: number, itemId: number) {
  await loadVisibleSystem(userId, systemId);
  const item = await dbFirst<typeof homeSystemItems.$inferSelect>(
    db
      .select()
      .from(homeSystemItems)
      .where(and(eq(homeSystemItems.id, itemId), eq(homeSystemItems.system_id, systemId))),
  );
  if (!item) throw APIError.notFound("item not found");
  return item;
}

export async function createItem(
  userId: number,
  systemId: number,
  input: ItemInput,
): Promise<{ id: number }> {
  await loadVisibleSystem(userId, systemId);
  const [{ next }] = await dbAll<{ next: number }>(
    db
      .select({ next: sql<number>`coalesce(max(${homeSystemItems.sort}) + 1, 0)::int` })
      .from(homeSystemItems)
      .where(eq(homeSystemItems.system_id, systemId)),
  );
  const [row] = await db
    .insert(homeSystemItems)
    .values({
      system_id: systemId,
      label: requiredText(input.label, "label"),
      location: optionalText(input.location, "location", 500),
      attributes: normalizeAttributes(input.attributes),
      sort: Number(next),
    })
    .returning({ id: homeSystemItems.id });
  await touchSystem(systemId);
  return { id: row.id };
}

export async function updateItem(
  userId: number,
  systemId: number,
  itemId: number,
  patch: Partial<ItemInput> & { sort?: number },
): Promise<void> {
  const item = await loadItem(userId, systemId, itemId);
  const set: Partial<typeof homeSystemItems.$inferInsert> = {};
  if (patch.label !== undefined) set.label = requiredText(patch.label, "label");
  if (patch.location !== undefined) set.location = optionalText(patch.location, "location", 500);
  if (patch.attributes !== undefined) set.attributes = normalizeAttributes(patch.attributes);
  if (patch.sort !== undefined) set.sort = Math.trunc(patch.sort);
  if (Object.keys(set).length === 0) return;
  await db.update(homeSystemItems).set(set).where(eq(homeSystemItems.id, item.id));
  await touchSystem(systemId);
}

export async function deleteItem(userId: number, systemId: number, itemId: number): Promise<void> {
  const item = await loadItem(userId, systemId, itemId);
  await db.delete(homeSystemItems).where(eq(homeSystemItems.id, item.id));
  await removeMediaOfTarget("item", item.id);
  await touchSystem(systemId);
}

// ── Notes ───────────────────────────────────────────────────────────────────

export interface NoteInput {
  body: string;
  /** `YYYY-MM-DD`; defaults to today. */
  notedOn?: string | null;
}

function noteDate(value: string | null | undefined): string {
  const date = optionalDate(value, "notedOn") ?? todayInHouse();
  if (date > todayInHouse()) throw APIError.invalidArgument("notedOn must not lie in the future");
  return date;
}

async function loadNote(userId: number, systemId: number, noteId: number) {
  await loadVisibleSystem(userId, systemId);
  const note = await dbFirst<typeof homeSystemNotes.$inferSelect>(
    db
      .select()
      .from(homeSystemNotes)
      .where(and(eq(homeSystemNotes.id, noteId), eq(homeSystemNotes.system_id, systemId))),
  );
  if (!note) throw APIError.notFound("note not found");
  return note;
}

export async function createNote(
  userId: number,
  systemId: number,
  input: NoteInput,
): Promise<{ id: number }> {
  await loadVisibleSystem(userId, systemId);
  const [row] = await db
    .insert(homeSystemNotes)
    .values({
      system_id: systemId,
      noted_on: noteDate(input.notedOn),
      body: requiredText(input.body, "body", MAX_TEXT),
      author_id: userId,
    })
    .returning({ id: homeSystemNotes.id });
  await touchSystem(systemId);
  return { id: row.id };
}

export async function updateNote(
  userId: number,
  systemId: number,
  noteId: number,
  patch: Partial<NoteInput>,
): Promise<void> {
  const note = await loadNote(userId, systemId, noteId);
  const set: Partial<typeof homeSystemNotes.$inferInsert> = { updated_at: new Date().toISOString() };
  if (patch.body !== undefined) set.body = requiredText(patch.body, "body", MAX_TEXT);
  if (patch.notedOn !== undefined) set.noted_on = noteDate(patch.notedOn);
  await db.update(homeSystemNotes).set(set).where(eq(homeSystemNotes.id, note.id));
}

export async function deleteNote(userId: number, systemId: number, noteId: number): Promise<void> {
  const note = await loadNote(userId, systemId, noteId);
  await db.delete(homeSystemNotes).where(eq(homeSystemNotes.id, note.id));
  await removeMediaOfTarget("note", note.id);
}
