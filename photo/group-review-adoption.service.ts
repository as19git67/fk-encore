/**
 * Adopting other people's similar-photo group reviews.
 *
 * In a household where only one person works through the stacks, everybody
 * else keeps seeing every burst frame. This pass turns the reviewer's result
 * into the others' default — reversibly, and never silently.
 *
 * The adoption materialises real `photo_curation` rows marked
 * `source = 'adopted'` instead of deriving visibility on read, so the ~20
 * existing "is this hidden for me" queries keep working untouched. The rule
 * itself lives in `group-review-adoption.ts`; this module loads, decides and
 * writes.
 *
 * Public surface:
 *   runAdoptionForUser()    — adopt every qualifying peer review for one
 *                             user. Idempotent, serialised per user.
 *   scheduleAdoption()      — fire-and-forget wrapper with coalescing.
 *   revertAdoptionForUser() — drop adopted rows and reopen the groups they
 *                             closed. Used when the setting is switched off.
 *
 * See docs/group-review-adoption.md.
 */

import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import db from "../db/database";
import { dbAll, dbExec, dbFirst } from "../db/adapter";
import {
  photoCuration,
  photoGroupMembers,
  photoGroups,
  users,
} from "../db/schema";
import {
  decideAdoption,
  resolveAdoptionEnabled,
  type AdoptionMember,
  type CurationSource,
  type CurationStatus,
} from "./group-review-adoption";

const AI_USER_EMAIL = "ai@system.local";

export interface AdoptionResult {
  /** Groups closed by adopting a peer review in this pass. */
  groups_adopted: number;
  /** Photos newly hidden on the user's behalf. */
  photos_hidden: number;
  /** Adopted hides dropped again because the peers changed their mind. */
  photos_reverted: number;
  /**
   * Groups that had a qualifying peer review but were left open because
   * applying it would have dropped them below two visible members.
   */
  groups_skipped: number;
}

const EMPTY: AdoptionResult = {
  groups_adopted: 0,
  photos_hidden: 0,
  photos_reverted: 0,
  groups_skipped: 0,
};

/**
 * The AI system user votes on every photo but never owns `photo_groups`
 * rows, so it can never be the source of an adoption. Excluded explicitly
 * anyway, so a future AI-side grouping experiment can't silently start
 * culling other people's libraries.
 */
async function getAiUserId(): Promise<number | null> {
  const row = await dbFirst<{ id: number }>(
    db.select({ id: users.id }).from(users).where(eq(users.email, AI_USER_EMAIL)),
  );
  return row?.id ?? null;
}

/**
 * Peer groups that qualify as "somebody already reviewed this".
 *
 * A peer group qualifies when it belongs to a different, non-AI user, was
 * reviewed by that user themselves (`review_source = 'user'` — adopted
 * reviews never cascade on to a third person), and its member set *covers*
 * the group being considered.
 *
 * Covering rather than equal: the peer may see photos from an album the
 * adopter is not part of, so their cluster can be larger. A smaller peer
 * cluster does not qualify — they never looked at the extra members, so
 * there is no decision to adopt.
 *
 * The privacy boundary is the one `acceptPeerConsensusLogic` and
 * `listReviewQueueLogic` already use: the peer's view of a photo only counts
 * while peer and adopter currently share an album containing it.
 */
async function findCoveringPeerUserIds(
  userId: number,
  memberIds: number[],
  aiUserId: number | null,
): Promise<number[]> {
  const idArray = sql`ARRAY[${sql.join(memberIds.map((id) => sql`${id}`), sql`, `)}]::int[]`;
  const rows = (await db.execute(sql`
      SELECT g2.user_id
      FROM photo_group_members m2
      INNER JOIN photo_groups g2 ON g2.id = m2.group_id
      WHERE m2.photo_id = ANY(${idArray})
        AND g2.user_id <> ${userId}
        ${aiUserId === null ? sql`` : sql`AND g2.user_id <> ${aiUserId}`}
        AND g2.reviewed_at IS NOT NULL
        AND g2.review_source = 'user'
        AND EXISTS (
          SELECT 1 FROM album_photos ap
          WHERE ap.photo_id = m2.photo_id
            AND (
              EXISTS (SELECT 1 FROM albums a WHERE a.id = ap.album_id AND a.user_id = ${userId})
              OR EXISTS (SELECT 1 FROM album_shares s WHERE s.album_id = ap.album_id AND s.user_id = ${userId})
            )
            AND (
              EXISTS (SELECT 1 FROM albums a WHERE a.id = ap.album_id AND a.user_id = g2.user_id)
              OR EXISTS (SELECT 1 FROM album_shares s WHERE s.album_id = ap.album_id AND s.user_id = g2.user_id)
            )
        )
      GROUP BY g2.id, g2.user_id
      HAVING COUNT(DISTINCT m2.photo_id) = ${memberIds.length}
    `)).rows as Array<{ user_id: number }>;
  return Array.from(new Set(rows.map((r) => r.user_id)));
}

/**
 * Whether adoption is active for a group, given the per-album overrides of
 * every album that holds one of its members. Only albums the user actually
 * participates in are consulted — a stale settings row for an album whose
 * share was revoked must not keep deciding.
 */
async function isAdoptionEnabledForGroup(
  userId: number,
  globalDefault: boolean,
  memberIds: number[],
): Promise<boolean> {
  const idArray = sql`ARRAY[${sql.join(memberIds.map((id) => sql`${id}`), sql`, `)}]::int[]`;
  const rows = (await db.execute(sql`
      SELECT DISTINCT aus.group_review_adoption
      FROM album_photos ap
      INNER JOIN album_user_settings aus
        ON aus.album_id = ap.album_id AND aus.user_id = ${userId}
      WHERE ap.photo_id = ANY(${idArray})
        AND aus.group_review_adoption IS NOT NULL
        AND (
          EXISTS (SELECT 1 FROM albums a WHERE a.id = ap.album_id AND a.user_id = ${userId})
          OR EXISTS (SELECT 1 FROM album_shares s WHERE s.album_id = ap.album_id AND s.user_id = ${userId})
        )
    `)).rows as Array<{ group_review_adoption: string | null }>;
  return resolveAdoptionEnabled(
    globalDefault,
    rows.map((r) => r.group_review_adoption as "on" | "off" | null),
  );
}

/**
 * Adopt every qualifying peer review for one user.
 *
 * Idempotent: a second run over an unchanged database writes nothing. Only
 * the user's *unreviewed* groups are considered — a group they closed
 * themselves is theirs and stays untouched.
 */
export async function runAdoptionForUser(userId: number): Promise<AdoptionResult> {
  const user = await dbFirst<{ adopt_group_reviews: boolean }>(
    db.select({ adopt_group_reviews: users.adopt_group_reviews })
      .from(users)
      .where(eq(users.id, userId)),
  );
  if (!user) return { ...EMPTY };

  const groups = await dbAll<{ id: number }>(
    db.select({ id: photoGroups.id })
      .from(photoGroups)
      .where(and(eq(photoGroups.user_id, userId), isNull(photoGroups.reviewed_at))),
  );
  if (groups.length === 0) return { ...EMPTY };

  const aiUserId = await getAiUserId();
  const result: AdoptionResult = { ...EMPTY };

  for (const g of groups) {
    const members = await dbAll<{ photo_id: number }>(
      db.select({ photo_id: photoGroupMembers.photo_id })
        .from(photoGroupMembers)
        .where(eq(photoGroupMembers.group_id, g.id)),
    );
    const memberIds = members.map((m) => m.photo_id);
    if (memberIds.length < 2) continue;

    if (!(await isAdoptionEnabledForGroup(userId, user.adopt_group_reviews, memberIds))) {
      continue;
    }

    const peerUserIds = await findCoveringPeerUserIds(userId, memberIds, aiUserId);
    if (peerUserIds.length === 0) continue;

    // Only the peers' own decisions count. Reading `source = 'adopted'` rows
    // here would let one review echo back and forth between two passive
    // users until it looked like a consensus.
    const peerRows = await dbAll<{ photo_id: number; hidden: number; favorite: number }>(
      db.select({
        photo_id: photoCuration.photo_id,
        hidden: sql<number>`SUM(CASE WHEN ${photoCuration.status} = 'hidden' THEN 1 ELSE 0 END)::int`,
        favorite: sql<number>`SUM(CASE WHEN ${photoCuration.status} = 'favorite' THEN 1 ELSE 0 END)::int`,
      })
        .from(photoCuration)
        .where(and(
          inArray(photoCuration.photo_id, memberIds),
          inArray(photoCuration.user_id, peerUserIds),
          eq(photoCuration.source, "user"),
        ))
        .groupBy(photoCuration.photo_id),
    );
    const peerByPhoto = new Map(peerRows.map((r) => [r.photo_id, { hidden: r.hidden, favorite: r.favorite }]));

    const ownRows = await dbAll<{ photo_id: number; status: string; source: string }>(
      db.select({
        photo_id: photoCuration.photo_id,
        status: photoCuration.status,
        source: photoCuration.source,
      })
        .from(photoCuration)
        .where(and(
          eq(photoCuration.user_id, userId),
          inArray(photoCuration.photo_id, memberIds),
        )),
    );
    const ownByPhoto = new Map(
      ownRows.map((r) => [r.photo_id, { status: r.status as CurationStatus, source: r.source as CurationSource }]),
    );

    const input: AdoptionMember[] = memberIds.map((photo_id) => ({
      photo_id,
      own: ownByPhoto.get(photo_id),
      peer: peerByPhoto.get(photo_id),
    }));
    const decision = decideAdoption(input);
    if (decision.skipped) {
      result.groups_skipped++;
      continue;
    }

    for (const photoId of decision.hide) {
      // The WHERE on the conflict branch is the second guard behind
      // decideAdoption: a user-made row is never overwritten, even if the
      // in-memory snapshot raced with a curation request.
      await db.execute(sql`
        INSERT INTO photo_curation (user_id, photo_id, status, source, updated_at)
        VALUES (${userId}, ${photoId}, 'hidden', 'adopted', NOW())
        ON CONFLICT (user_id, photo_id) DO UPDATE
          SET status = 'hidden', source = 'adopted', updated_at = NOW()
          WHERE photo_curation.source = 'adopted'
      `);
    }
    if (decision.revert.length > 0) {
      await dbExec(
        db.delete(photoCuration).where(and(
          eq(photoCuration.user_id, userId),
          inArray(photoCuration.photo_id, decision.revert),
          eq(photoCuration.source, "adopted"),
        )),
      );
    }

    await dbExec(
      db.update(photoGroups)
        .set({ reviewed_at: new Date().toISOString(), review_source: "adopted" })
        .where(and(eq(photoGroups.id, g.id), isNull(photoGroups.reviewed_at))),
    );

    result.groups_adopted++;
    result.photos_hidden += decision.hide.length;
    result.photos_reverted += decision.revert.length;
  }

  return result;
}

export interface RevertResult {
  groups_reopened: number;
  photos_restored: number;
}

/**
 * Undo adopted reviews for a user, optionally limited to a set of groups.
 *
 * Used when the user switches adoption off: the stacks reappear as open
 * work, and the photos that were hidden on their behalf come back. Rows the
 * user made themselves — including a deliberate un-hide of an adopted
 * photo — are never touched.
 */
export async function revertAdoptionForUser(
  userId: number,
  groupIds?: number[],
): Promise<RevertResult> {
  const conds = [eq(photoGroups.user_id, userId), eq(photoGroups.review_source, "adopted")];
  if (groupIds && groupIds.length > 0) conds.push(inArray(photoGroups.id, groupIds));

  const groups = await dbAll<{ id: number }>(
    db.select({ id: photoGroups.id }).from(photoGroups).where(and(...conds)),
  );
  if (groups.length === 0) return { groups_reopened: 0, photos_restored: 0 };

  const ids = groups.map((g) => g.id);
  const members = await dbAll<{ photo_id: number }>(
    db.select({ photo_id: photoGroupMembers.photo_id })
      .from(photoGroupMembers)
      .where(inArray(photoGroupMembers.group_id, ids)),
  );
  const memberIds = Array.from(new Set(members.map((m) => m.photo_id)));

  let restored = 0;
  if (memberIds.length > 0) {
    const del = await dbExec(
      db.delete(photoCuration).where(and(
        eq(photoCuration.user_id, userId),
        inArray(photoCuration.photo_id, memberIds),
        eq(photoCuration.source, "adopted"),
      )),
    );
    restored = del.changes ?? 0;
  }

  await dbExec(
    db.update(photoGroups)
      .set({ reviewed_at: null, review_source: null })
      .where(inArray(photoGroups.id, ids)),
  );

  return { groups_reopened: ids.length, photos_restored: restored };
}

// ── Per-user serialisation ───────────────────────────────────────────────────
// The pass reads the peers' state and writes the user's own, so two runs for
// the same user would race over the same rows. Mirrors scheduleRegroup():
// at most one run per user, further triggers coalesce into one follow-up.

const adoptionRunning = new Map<number, Promise<void>>();
const adoptionPending = new Set<number>();

/**
 * Fire-and-forget adoption for one user. Errors are logged, never thrown —
 * the triggering request (a review, a share, a regroup) must not fail
 * because a background default could not be applied.
 */
export function scheduleAdoption(userId: number): Promise<void> {
  const existing = adoptionRunning.get(userId);
  if (existing) {
    adoptionPending.add(userId);
    return existing;
  }
  const run = (async () => {
    try {
      do {
        adoptionPending.delete(userId);
        try {
          await runAdoptionForUser(userId);
        } catch (err) {
          console.error(`[group-adoption] error for user ${userId}:`, err);
        }
      } while (adoptionPending.has(userId));
    } finally {
      adoptionRunning.delete(userId);
    }
  })();
  adoptionRunning.set(userId, run);
  return run;
}

/**
 * Schedule adoption for everybody who might inherit a review the actor just
 * made: the peers who share an album with them for one of these photos.
 *
 * Resolved here rather than through `getUsersWithPhotoAccess` so this module
 * stays free of a photo.service import — the review paths that trigger it
 * live there and in group-auto-pick.service.
 */
export async function scheduleAdoptionForPeers(
  actorUserId: number,
  photoIds: number[],
): Promise<void> {
  if (photoIds.length === 0) return;
  const idArray = sql`ARRAY[${sql.join(photoIds.map((id) => sql`${id}`), sql`, `)}]::int[]`;
  const rows = (await db.execute(sql`
    SELECT DISTINCT u.user_id FROM (
      SELECT p.user_id FROM photos p WHERE p.id = ANY(${idArray})
      UNION
      SELECT a.user_id
      FROM albums a
      INNER JOIN album_photos ap ON ap.album_id = a.id
      WHERE ap.photo_id = ANY(${idArray})
      UNION
      SELECT s.user_id
      FROM album_shares s
      INNER JOIN album_photos ap ON ap.album_id = s.album_id
      WHERE ap.photo_id = ANY(${idArray})
    ) u
    WHERE u.user_id <> ${actorUserId}
  `)).rows as Array<{ user_id: number }>;

  // Every caller `void`s this function, so awaiting the scheduled runs here
  // costs the review request nothing and makes the fan-out deterministic for
  // tests. Failures are logged, never propagated: a peer's default must not
  // make the actor's own review fail.
  await Promise.all(rows.map((r) =>
    scheduleAdoption(r.user_id).catch((err) => {
      console.error(`[group-adoption] scheduling failed for user ${r.user_id}:`, err);
    }),
  ));
}

export interface GroupReviewAdoptionSettings {
  enabled: boolean;
}

/** The user's global default, as shown in the photo settings. */
export async function getAdoptionDefaultLogic(userId: number): Promise<GroupReviewAdoptionSettings> {
  const row = await dbFirst<{ adopt_group_reviews: boolean }>(
    db.select({ adopt_group_reviews: users.adopt_group_reviews })
      .from(users)
      .where(eq(users.id, userId)),
  );
  return { enabled: row?.adopt_group_reviews ?? true };
}

/**
 * Flip the global default and apply it straight away: switching it off
 * gives the adopted stacks and their photos back, switching it on closes
 * the groups the household has already answered. Albums with an explicit
 * override keep deciding for their own groups either way.
 */
export async function setAdoptionDefaultLogic(
  userId: number,
  enabled: boolean,
): Promise<GroupReviewAdoptionSettings> {
  await dbExec(
    db.update(users).set({ adopt_group_reviews: enabled }).where(eq(users.id, userId)),
  );
  // Revert first in both directions: an album override may still switch a
  // group off even while the global default is on, and only a fresh pass
  // can tell which groups those are.
  await revertAdoptionForUser(userId);
  await runAdoptionForUser(userId);
  return { enabled };
}
