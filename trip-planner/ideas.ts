/**
 * The pool without a trip (§20).
 *
 * Everything up to here needs a trip: create one, name a place, get
 * days. That is the half people *plan*, and the rarer one. The commoner
 * half is what they *collect* — the beer garden somebody mentioned, the
 * exhibition in the next town, the walk that came up twice. Things
 * without a date, a city or a frame.
 *
 * The building block existed all along: the pool (§5) is a scored list
 * of possibilities that happens to hang off a leg. This is the same
 * list without one, and it deliberately takes the same way in as a find
 * does (§9.2): a coordinate, optionally a name, a note and where it came
 * from; the OSM entry is matched if there is one, and when there is
 * not, the one permitted question is asked (how long?) rather than a
 * duration invented.
 *
 * Two properties separate it from a shopping list, and both are here:
 *
 *   - **It is shared**, as one list rather than a copy per person
 *     (§20.1). Sharing has the shape §6.2 uses for a trip — a list of
 *     people, not a permission grid — and every entry keeps who put it
 *     there, because "Papa wollte da hin" is half the information.
 *   - **It is about places, not lines in a list.** That half — the
 *     collection speaking up when you are near something in it — is
 *     §20.2 and comes next; the columns it needs (`last_suggested_at`,
 *     `dismissed_count`) are written here so the rule can be honest
 *     when it arrives: remembered rather than deleted.
 */

import { api, APIError } from "encore.dev/api";
import { and, asc, eq, inArray, or } from "drizzle-orm";
import { getAuthData } from "~encore/auth";
import db from "../db/database";
import { ideaPool, ideaPoolShares, users } from "../db/schema";
import { requirePermission } from "../user/auth-handler";
import { getGeoClient, type GeoPoiSearchSpot } from "../osm-admin/geo-client";
import { pickRegion } from "../osm-admin/region-router";
import { DEFAULT_DWELL_MINUTES } from "./candidates";
import { findDuplicate, manualRef } from "./finds";
import { displayName } from "./readable-name";
import { haversineMeters } from "./travel";

/** How far around a coordinate to look for the OSM entry it might be. */
const MATCH_RADIUS_M = 80;
const MAX_NOTE_LENGTH = 1_000;

export interface IdeaEntry {
  id: number;
  /**
   * Whose collection this entry lives in. The list is one list across
   * every collection a person may write into, so a row has to say
   * where it is before it can be edited or removed.
   */
  ownerId: number;
  osmRef: string;
  name: string | null;
  /** What the family calls it, when that is not the map's name. */
  title: string | null;
  lat: number;
  lon: number;
  category: string;
  dwellMinutes: number;
  note: string | null;
  sourceUrl: string | null;
  /** True when no OSM entry matched — category and duration are guesses. */
  unmatched: boolean;
  /** Something that ends: an exhibition until Sunday (§20.4). */
  validFrom: string | null;
  validTo: string | null;
  /** Who put it there. The name, because that is what makes it useful. */
  addedBy: string | null;
  addedAt: string;
}

export interface AddIdeaRequest {
  lat: number;
  lon: number;
  /** Whose collection. Defaults to your own; a shared one may be named. */
  ownerId?: number;
  name?: string;
  note?: string;
  sourceUrl?: string;
  /** Required when no OSM entry matches — the one question §9.2 asks. */
  dwellMinutes?: number;
  /** For something that ends (§20.4), both as YYYY-MM-DD. */
  validFrom?: string;
  validTo?: string;
}

export interface AddIdeaResponse {
  entry: IdeaEntry;
  /** True when this folded into an idea that was already collected. */
  merged: boolean;
  matchedOsmRef: string | null;
  /** What is not known about it, in plain words (§15.3). */
  unknown: string[];
}

export const addIdea = api(
  { expose: true, method: "POST", path: "/trip-planner/ideas", auth: true },
  async (req: AddIdeaRequest): Promise<AddIdeaResponse> => {
    const userId = requireUser();
    const ownerId = await requireAccess(req.ownerId ?? userId, userId);
    const position = validatePosition(req);
    const note = validateNote(req.note);
    const validFrom = validateDay(req.validFrom, "validFrom");
    const validTo = validateDay(req.validTo, "validTo");
    if (validFrom && validTo && validTo < validFrom) {
      throw APIError.invalidArgument("validTo liegt vor validFrom");
    }

    const match = await matchOsmEntry(position, req.name);

    // The same idea twice is one idea. Merging beats a second row that
    // would compete with the first for the same afternoon.
    const collected = await db
      .select({
        id: ideaPool.id,
        osmRef: ideaPool.osm_ref,
        name: ideaPool.name,
        lat: ideaPool.lat,
        lon: ideaPool.lon,
      })
      .from(ideaPool)
      .where(eq(ideaPool.owner_id, ownerId));
    const duplicate = findDuplicate(
      { osmRef: match?.osmRef, name: req.name ?? match?.name, ...position },
      collected,
    );

    if (duplicate) {
      // A second mention adds what it brought — a note, a link — and
      // never overwrites what somebody wrote before.
      await db
        .update(ideaPool)
        .set({
          note: note ?? undefined,
          source_url: req.sourceUrl ?? undefined,
          valid_from: validFrom ?? undefined,
          valid_to: validTo ?? undefined,
        })
        .where(eq(ideaPool.id, duplicate.id));
      const [entry] = await loadIdeas(ownerId, duplicate.id);
      return { entry, merged: true, matchedOsmRef: match?.osmRef ?? null, unknown: [] };
    }

    const category = match ? match.categories[0] ?? null : null;
    const dwellMinutes = resolveDwell(req.dwellMinutes, category);
    if (dwellMinutes === null) {
      throw APIError.invalidArgument(
        "kein OpenStreetMap-Eintrag an dieser Stelle — bitte eine geschätzte Dauer "
          + "(dwellMinutes) mitgeben",
      );
    }

    const [row] = await db
      .insert(ideaPool)
      .values({
        owner_id: ownerId,
        created_by: userId,
        osm_ref: match?.osmRef ?? manualRef(`${Date.now()}-${Math.round(position.lat * 1e5)}`),
        name: req.name ?? (match ? displayName(match) : null),
        local_name: match?.name ?? null,
        lat: position.lat,
        lon: position.lon,
        // "unknown" rather than a plausible-looking guess: it is what is
        // known, and a later planner can see it is not a real category.
        category: category ?? "unknown",
        kind: match?.kind ?? null,
        dwell_minutes: dwellMinutes,
        note,
        source_url: req.sourceUrl ?? null,
        wikipedia_url: match?.wikipedia ?? null,
        facade_azimuth: match?.facadeAzimuth ?? null,
        unmatched: match === null,
        valid_from: validFrom,
        valid_to: validTo,
      })
      .returning({ id: ideaPool.id });

    const [entry] = await loadIdeas(ownerId, row.id);
    return {
      entry,
      merged: false,
      matchedOsmRef: match?.osmRef ?? null,
      unknown: match ? [] : ["Öffnungszeiten", "Kategorie"],
    };
  },
);

export interface ListIdeasRequest {
  /**
   * One collection only. Without it the answer is everything the
   * caller may write into — their own and every collection they were
   * let into — as one list, folded where two collections hold the same
   * place.
   */
  ownerId?: number;
}

export interface ListIdeasResponse {
  entries: IdeaEntry[];
  /** The collections this person may write into, their own first. */
  collections: IdeaCollection[];
}

export interface IdeaCollection {
  ownerId: number;
  /** Whose it is, for the picker. */
  ownerName: string | null;
  /** True for the caller's own collection. */
  own: boolean;
}

export const listIdeas = api(
  { expose: true, method: "GET", path: "/trip-planner/ideas", auth: true },
  async (req: ListIdeasRequest): Promise<ListIdeasResponse> => {
    const userId = requireUser();
    const owners = req.ownerId === undefined
      ? await accessibleOwnerIds(userId)
      : [await requireAccess(req.ownerId, userId)];
    return {
      entries: foldAcrossCollections(await loadIdeas(owners), userId),
      collections: await collectionsFor(userId),
    };
  },
);

export interface IdeaMember {
  userId: number;
  name: string | null;
  email: string;
}

/**
 * Who writes into my collection (§20.1) — the list behind "Wer
 * schreibt mit", so somebody let in can be seen and taken out again.
 */
export const listIdeaMembers = api(
  { expose: true, method: "GET", path: "/trip-planner/ideas/members", auth: true },
  async (): Promise<{ members: IdeaMember[] }> => {
    const ownerId = requireUser();
    const rows = await db
      .select({ userId: ideaPoolShares.user_id, name: users.name, email: users.email })
      .from(ideaPoolShares)
      .innerJoin(users, eq(users.id, ideaPoolShares.user_id))
      .where(eq(ideaPoolShares.owner_id, ownerId))
      .orderBy(asc(users.name));
    return { members: rows };
  },
);

export interface RemoveIdeaRequest {
  id: number;
  ownerId?: number;
}

export const removeIdea = api(
  { expose: true, method: "POST", path: "/trip-planner/ideas/remove", auth: true },
  async (req: RemoveIdeaRequest): Promise<{ removed: boolean }> => {
    const userId = requireUser();
    const ownerId = await requireAccess(req.ownerId ?? userId, userId);
    // Anybody in the collection may take something out again: §6.2 gives
    // the organiser three rights, and this is not one of them.
    const removed = await db
      .delete(ideaPool)
      .where(and(eq(ideaPool.id, req.id), eq(ideaPool.owner_id, ownerId)))
      .returning({ id: ideaPool.id });
    return { removed: removed.length > 0 };
  },
);

export interface ShareIdeasRequest {
  /** Who joins the collection, picked from the household by id … */
  userId?: number;
  /** … or by the address they signed up with. One of the two. */
  email?: string;
}

export const shareIdeas = api(
  { expose: true, method: "POST", path: "/trip-planner/ideas/share", auth: true },
  async (req: ShareIdeasRequest): Promise<{ collections: IdeaCollection[] }> => {
    const userId = requireUser();
    const invitee = await findInvitee(req);
    if (invitee.id === userId) {
      throw APIError.invalidArgument("dein eigener Vorrat gehört dir bereits");
    }

    await db
      .insert(ideaPoolShares)
      .values({ owner_id: userId, user_id: invitee.id, invited_by: userId })
      .onConflictDoNothing();
    return { collections: await collectionsFor(invitee.id) };
  },
);

export const unshareIdeas = api(
  { expose: true, method: "POST", path: "/trip-planner/ideas/unshare", auth: true },
  async (req: { userId: number }): Promise<{ removed: boolean }> => {
    const ownerId = requireUser();
    const removed = await db
      .delete(ideaPoolShares)
      .where(and(eq(ideaPoolShares.owner_id, ownerId), eq(ideaPoolShares.user_id, req.userId)))
      .returning({ id: ideaPoolShares.id });
    return { removed: removed.length > 0 };
  },
);

/** The person a share request names — by id, else by address. */
async function findInvitee(req: ShareIdeasRequest): Promise<{ id: number }> {
  if (req.userId !== undefined) {
    const [byId] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, req.userId))
      .limit(1);
    if (!byId) throw APIError.notFound("diese Person gibt es nicht");
    return byId;
  }
  const email = (req.email ?? "").trim().toLowerCase();
  if (!email) throw APIError.invalidArgument("userId or email is required");
  const [byEmail] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  if (!byEmail) throw APIError.notFound(`niemand mit der Adresse ${email}`);
  return byEmail;
}

/**
 * Every collection this person may write into: their own first, then
 * the ones they were let into. The list, the neighbourhood, the outing
 * and a trip's "aus den Ideen" all read across these — one household,
 * one view, while every entry keeps whose collection it sits in.
 */
export async function accessibleOwnerIds(userId: number): Promise<number[]> {
  const shared = await db
    .select({ ownerId: ideaPoolShares.owner_id })
    .from(ideaPoolShares)
    .where(eq(ideaPoolShares.user_id, userId))
    .orderBy(asc(ideaPoolShares.created_at));
  return [userId, ...shared.map((row) => row.ownerId).filter((id) => id !== userId)];
}

/**
 * Two people collecting separately and then letting each other in
 * often hold the same beer garden twice. Across collections the
 * unique index does not fold them, so the list does: the same OSM
 * reference, or two unmatched places within `MATCH_RADIUS_M`, are one
 * row — the caller's own copy wins, then the earlier one.
 */
export function foldAcrossCollections<T extends {
  ownerId: number; osmRef: string; lat: number; lon: number; addedAt: string;
}>(entries: T[], userId: number): T[] {
  const ordered = [...entries].sort((a, b) => {
    if ((a.ownerId === userId) !== (b.ownerId === userId)) return a.ownerId === userId ? -1 : 1;
    return a.addedAt < b.addedAt ? -1 : a.addedAt > b.addedAt ? 1 : 0;
  });
  const kept: T[] = [];
  for (const entry of ordered) {
    const twin = kept.some((seen) =>
      seen.osmRef === entry.osmRef
        || (seen.osmRef.startsWith("manual:") && entry.osmRef.startsWith("manual:")
            && haversineMeters(seen, entry) <= MATCH_RADIUS_M));
    if (!twin) kept.push(entry);
  }
  // Back in the order the list shows: oldest first, like `loadIdeas`.
  return kept.sort((a, b) => (a.addedAt < b.addedAt ? -1 : a.addedAt > b.addedAt ? 1 : 0));
}

/**
 * May this person write into that collection, and which one is it?
 *
 * Exported because browsing needs it too (`explore.ts`): a list that
 * marks what you have already collected has to be sure it is allowed
 * to look into that collection first.
 */
export async function requireAccess(ownerId: number, userId: number): Promise<number> {
  if (ownerId === userId) return ownerId;
  const [share] = await db
    .select({ id: ideaPoolShares.id })
    .from(ideaPoolShares)
    .where(and(eq(ideaPoolShares.owner_id, ownerId), eq(ideaPoolShares.user_id, userId)))
    .limit(1);
  // Not "permission denied": a collection somebody has not been let
  // into is not theirs to know about.
  if (!share) throw APIError.notFound("dieser Ideenvorrat existiert nicht");
  return ownerId;
}

async function collectionsFor(userId: number): Promise<IdeaCollection[]> {
  const shared = await db
    .select({ ownerId: ideaPoolShares.owner_id })
    .from(ideaPoolShares)
    .where(eq(ideaPoolShares.user_id, userId));
  const ownerIds = shared.map((row) => row.ownerId);
  const names = ownerIds.length === 0
    ? []
    : await db
      .select({ id: users.id, name: users.name })
      .from(users)
      .where(inArray(users.id, ownerIds));

  return [
    { ownerId: userId, ownerName: null, own: true },
    ...ownerIds.map((ownerId) => ({
      ownerId,
      ownerName: names.find((row) => row.id === ownerId)?.name ?? null,
      own: false,
    })),
  ];
}

/**
 * The collection's entries, newest first — or one of them by id.
 *
 * Exported for `idea-edit.ts`, which has to answer with the entry as it
 * now stands: a screen that saves and then shows what it sent rather
 * than what was stored is a screen that lies the first time the server
 * disagrees.
 */
export async function loadIdeas(
  owner: number | number[],
  onlyId?: number,
): Promise<IdeaEntry[]> {
  const owners = Array.isArray(owner) ? owner : [owner];
  if (owners.length === 0) return [];
  const rows = await db
    .select({
      id: ideaPool.id,
      ownerId: ideaPool.owner_id,
      osmRef: ideaPool.osm_ref,
      name: ideaPool.name,
      title: ideaPool.title,
      lat: ideaPool.lat,
      lon: ideaPool.lon,
      category: ideaPool.category,
      dwellMinutes: ideaPool.dwell_minutes,
      note: ideaPool.note,
      sourceUrl: ideaPool.source_url,
      unmatched: ideaPool.unmatched,
      validFrom: ideaPool.valid_from,
      validTo: ideaPool.valid_to,
      createdAt: ideaPool.created_at,
      addedBy: users.name,
    })
    .from(ideaPool)
    .leftJoin(users, eq(users.id, ideaPool.created_by))
    .where(
      onlyId === undefined
        ? inArray(ideaPool.owner_id, owners)
        : and(inArray(ideaPool.owner_id, owners), eq(ideaPool.id, onlyId)),
    )
    .orderBy(asc(ideaPool.created_at));

  return rows.map((row) => ({
    id: row.id,
    ownerId: row.ownerId,
    osmRef: row.osmRef,
    name: row.name,
    title: row.title,
    lat: row.lat,
    lon: row.lon,
    category: row.category,
    dwellMinutes: row.dwellMinutes,
    note: row.note,
    sourceUrl: row.sourceUrl,
    unmatched: row.unmatched,
    validFrom: row.validFrom,
    validTo: row.validTo,
    addedBy: row.addedBy,
    addedAt: row.createdAt,
  }));
}

/**
 * The nearest OSM entry, if one is close enough to be the same place.
 *
 * Copied in spirit from `add-find.ts`: failing to match is a normal
 * outcome, not an error — plenty of what people collect is not in
 * OpenStreetMap at all.
 */
async function matchOsmEntry(
  position: { lat: number; lon: number },
  name: string | undefined,
): Promise<GeoPoiSearchSpot | null> {
  const region = await pickRegion(position.lat, position.lon);
  if (!region) return null;

  let page;
  try {
    page = await getGeoClient().searchPois(region.postgresDb, {
      center: { ...position, radiusM: MATCH_RADIUS_M },
      limit: 20,
    });
  } catch {
    return null;
  }
  if (page.spots.length === 0) return null;

  const wanted = name?.trim().toLocaleLowerCase("de");
  if (wanted) {
    const named = page.spots.find((s) => s.name?.toLocaleLowerCase("de") === wanted);
    if (named) return named;
  }
  return page.spots[0];
}

function resolveDwell(stated: number | undefined, category: string | null): number | null {
  if (stated !== undefined) {
    if (!Number.isFinite(stated) || stated <= 0) {
      throw APIError.invalidArgument("dwellMinutes must be a positive number");
    }
    return Math.round(stated);
  }
  if (category && DEFAULT_DWELL_MINUTES[category] !== undefined) {
    return DEFAULT_DWELL_MINUTES[category];
  }
  return null;
}

function validatePosition(req: { lat: number; lon: number }): { lat: number; lon: number } {
  const { lat, lon } = req;
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
    throw APIError.invalidArgument("lat must be between -90 and 90");
  }
  if (!Number.isFinite(lon) || lon < -180 || lon > 180) {
    throw APIError.invalidArgument("lon must be between -180 and 180");
  }
  return { lat, lon };
}

function validateNote(note: string | undefined): string | null {
  if (note === undefined) return null;
  const trimmed = note.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > MAX_NOTE_LENGTH) {
    throw APIError.invalidArgument(`note must be at most ${MAX_NOTE_LENGTH} characters`);
  }
  return trimmed;
}

function validateDay(day: string | undefined, field: string): string | null {
  if (day === undefined) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    throw APIError.invalidArgument(`${field} must be YYYY-MM-DD, got '${day}'`);
  }
  return day;
}

function requireUser(): number {
  const auth = getAuthData();
  if (!auth) throw APIError.unauthenticated("Unauthorized");
  requirePermission(auth, "photos.view");
  return parseInt(auth.userID, 10);
}
