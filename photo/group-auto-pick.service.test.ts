import { beforeEach, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import db from "../db/database";
import { dbAll, dbExec, dbInsertReturning } from "../db/adapter";
import {
  albumPhotos,
  albumShares,
  albums,
  faces,
  photoCuration,
  photoGroupMembers,
  photoGroups,
  photos,
  users,
} from "../db/schema";
import {
  acceptAiPickLogic,
  acceptPeerConsensusLogic,
  bulkAcceptHighConfidencePicksLogic,
  exportCalibrationDatasetLogic,
  listReviewQueueLogic,
  recomputeAiPicksForAllUsers,
  recomputeAiPicksForGroups,
} from "./group-auto-pick.service";

async function makeUser(email: string): Promise<number> {
  const row = await dbInsertReturning<{ id: number }>(
    db.insert(users).values({
      email,
      name: "Test",
      password_hash: "x",
    }).returning({ id: users.id }),
  );
  return row!.id;
}

interface PhotoSeed {
  details?: Record<string, number>;
  faces?: number;
  bboxWH?: [number, number][];
  width?: number;
  height?: number;
}

async function makePhoto(userId: number, seed: PhotoSeed = {}): Promise<number> {
  const row = await dbInsertReturning<{ id: number }>(
    db.insert(photos).values({
      user_id: userId,
      filename: `p-${Math.random().toString(36).slice(2)}.jpg`,
      original_name: "p.jpg",
      mime_type: "image/jpeg",
      size: 1000,
      ai_quality_details: seed.details ?? null,
      width: seed.width ?? null,
      height: seed.height ?? null,
    }).returning({ id: photos.id }),
  );
  const photoId = row!.id;
  const count = seed.faces ?? 0;
  const sizes = seed.bboxWH ?? [];
  for (let i = 0; i < count; i++) {
    const [w, h] = sizes[i] ?? [0.1, 0.1];
    await dbExec(
      db.insert(faces).values({
        photo_id: photoId,
        bbox: JSON.stringify({ x: 0, y: 0, width: w, height: h }),
        embedding: "[]",
      }),
    );
  }
  return photoId;
}

async function makeGroup(userId: number, coverPhotoId: number, memberIds: number[]): Promise<number> {
  const row = await dbInsertReturning<{ id: number }>(
    db.insert(photoGroups).values({
      user_id: userId,
      cover_photo_id: coverPhotoId,
    }).returning({ id: photoGroups.id }),
  );
  const groupId = row!.id;
  for (let i = 0; i < memberIds.length; i++) {
    await dbExec(
      db.insert(photoGroupMembers).values({
        group_id: groupId,
        photo_id: memberIds[i],
        similarity_rank: i,
      }),
    );
  }
  return groupId;
}

beforeEach(async () => {
  await db.delete(photoCuration);
  await db.delete(photoGroupMembers);
  await db.delete(photoGroups);
  await db.delete(faces);
  await db.delete(photos);
  await db.delete(users);
});

describe("recomputeAiPicksForGroups — face_composition", () => {
  it("reads face_composition from ai_quality_details and uses it for the pick", async () => {
    // Two photos with identical face_sharpness / eyes_open /
    // face_coverage but very different face_composition. With weight
    // 0.10 on face_composition (face branch) the spread is ≥ 0.08 →
    // medium-or-better confidence, well-defined winner.
    const u = await makeUser("face-composition@test.com");
    const a = await makePhoto(u, {
      details: {
        face_sharpness: 0.8, eyes_open: 0.5, sharpness: 1,
        face_composition: 0.10,
      },
      faces: 1,
      bboxWH: [[0.2, 0.2]],
    });
    const b = await makePhoto(u, {
      details: {
        face_sharpness: 0.8, eyes_open: 0.5, sharpness: 1,
        face_composition: 0.95,
      },
      faces: 1,
      bboxWH: [[0.2, 0.2]],
    });
    await makeGroup(u, a, [a, b]);

    await recomputeAiPicksForGroups(u);
    const [row] = await db.select().from(photoGroups);
    // Top pick must be `b`. Multi-pick may include both depending on
    // the 0.92 threshold; the important property is that b's score
    // beats a's.
    expect(row.ai_picked_photo_ids).toContain(b);
    const bScore = row.ai_pick_details?.scores.find((s) => s.photo_id === b);
    const aScore = row.ai_pick_details?.scores.find((s) => s.photo_id === a);
    expect(bScore && aScore && bScore.score > aScore.score).toBe(true);
    expect(bScore?.signals.face_composition).toBeCloseTo(0.95, 5);
  });
});

describe("recomputeAiPicksForGroups — DB key mapping", () => {
  it("reads sharpness/contrast/exposure/eyes_open from the actual DB keys", async () => {
    // The embedding service writes these signals without `_score`
    // suffix (verified on the live database via jsonb_each on
    // ai_quality_details). Before the toPhotoSignals fix the four
    // canonical names below would have been ignored and replaced by
    // the neutral 0.5 fallback, collapsing the score gap and forcing
    // every group into "low" confidence.
    const u = await makeUser("db-key-mapping@test.com");
    const a = await makePhoto(u, { details: { sharpness: 0.10 } });
    const b = await makePhoto(u, { details: { sharpness: 0.90 } });
    await makeGroup(u, a, [a, b]);

    await recomputeAiPicksForGroups(u);
    const [row] = await db.select().from(photoGroups);
    expect(row.ai_picked_photo_ids).toEqual([b]);
    expect(row.ai_picked_confidence).toBe("high");
    const bScore = row.ai_pick_details?.scores.find((s) => s.photo_id === b);
    // The mapped value lands in the output as `blur` (historical name
    // kept on the AiPickPhotoScore so existing exports don't break).
    expect(bScore?.signals.blur).toBeCloseTo(0.90, 2);
  });

  it("accepts both DB-canonical and *_score keys (forward-compat)", async () => {
    const u = await makeUser("db-key-fallback@test.com");
    const a = await makePhoto(u, { details: { blur_score: 0.10 } });
    const b = await makePhoto(u, { details: { blur_score: 0.90 } });
    await makeGroup(u, a, [a, b]);

    await recomputeAiPicksForGroups(u);
    const [row] = await db.select().from(photoGroups);
    expect(row.ai_picked_photo_ids).toEqual([b]);
  });
});

describe("recomputeAiPicksForGroups", () => {
  it("scores an unreviewed group and persists ai_picked_*", async () => {
    const u = await makeUser("recompute@test.com");
    // Non-face branch: blur dominates. Photo b is the obvious winner.
    const a = await makePhoto(u, { details: { sharpness: 0.10 } });
    const b = await makePhoto(u, { details: { sharpness: 0.90 } });
    const c = await makePhoto(u, { details: { sharpness: 0.20 } });
    const g = await makeGroup(u, a, [a, b, c]);

    const result = await recomputeAiPicksForGroups(u);
    expect(result.groups_scored).toBe(1);

    const [row] = await db.select().from(photoGroups).where(eq(photoGroups.id, g));
    expect(row.ai_picked_photo_ids).toEqual([b]);
    expect(row.ai_picked_confidence).toBe("high");
    expect(row.ai_picked_at).not.toBeNull();
    expect(row.ai_pick_details?.scores).toHaveLength(3);
  });

  it("skips reviewed groups", async () => {
    const u = await makeUser("skip-reviewed@test.com");
    const a = await makePhoto(u, { details: { blur_score: 0.10 } });
    const b = await makePhoto(u, { details: { blur_score: 0.90 } });
    const g = await makeGroup(u, a, [a, b]);
    await dbExec(
      db.update(photoGroups)
        .set({ reviewed_at: new Date().toISOString() })
        .where(eq(photoGroups.id, g)),
    );

    const result = await recomputeAiPicksForGroups(u);
    expect(result.groups_scored).toBe(0);

    const [row] = await db.select().from(photoGroups).where(eq(photoGroups.id, g));
    expect(row.ai_picked_photo_ids).toBeNull();
  });

  it("aggregates face_coverage from the faces table", async () => {
    const u = await makeUser("face-coverage@test.com");
    // Same face_sharpness + eyes_open everywhere, only face area differs.
    // Photo b has a much larger face → wins via face_coverage weight.
    const a = await makePhoto(u, {
      details: { face_sharpness: 0.5, eyes_open_score: 0.5, blur_score: 0.5 },
      faces: 1,
      bboxWH: [[0.05, 0.05]],
    });
    const b = await makePhoto(u, {
      details: { face_sharpness: 0.5, eyes_open_score: 0.5, blur_score: 0.5 },
      faces: 1,
      bboxWH: [[0.5, 0.5]],
    });
    await makeGroup(u, a, [a, b]);

    await recomputeAiPicksForGroups(u);
    const [row] = await db.select().from(photoGroups);
    expect(row.ai_picked_photo_ids).toContain(b);
  });

  it("only scores the group ids passed in when filtered", async () => {
    const u = await makeUser("filter-ids@test.com");
    const a = await makePhoto(u, { details: { blur_score: 0.1 } });
    const b = await makePhoto(u, { details: { blur_score: 0.9 } });
    const c = await makePhoto(u, { details: { blur_score: 0.1 } });
    const d = await makePhoto(u, { details: { blur_score: 0.9 } });
    const g1 = await makeGroup(u, a, [a, b]);
    const g2 = await makeGroup(u, c, [c, d]);

    const result = await recomputeAiPicksForGroups(u, [g1]);
    expect(result.groups_scored).toBe(1);
    const rows = await dbAll<{ id: number; ai_picked_photo_ids: number[] | null }>(
      db.select({
        id: photoGroups.id,
        ai_picked_photo_ids: photoGroups.ai_picked_photo_ids,
      }).from(photoGroups),
    );
    const g1Row = rows.find((r) => r.id === g1);
    const g2Row = rows.find((r) => r.id === g2);
    expect(g1Row?.ai_picked_photo_ids).not.toBeNull();
    expect(g2Row?.ai_picked_photo_ids).toBeNull();
  });
});

describe("recomputeAiPicksForAllUsers", () => {
  it("scores unreviewed groups across every user", async () => {
    const u1 = await makeUser("global-a@test.com");
    const u2 = await makeUser("global-b@test.com");
    const a1 = await makePhoto(u1, { details: { blur_score: 0.10 } });
    const a2 = await makePhoto(u1, { details: { blur_score: 0.90 } });
    const b1 = await makePhoto(u2, { details: { blur_score: 0.10 } });
    const b2 = await makePhoto(u2, { details: { blur_score: 0.90 } });
    await makeGroup(u1, a1, [a1, a2]);
    await makeGroup(u2, b1, [b1, b2]);

    const result = await recomputeAiPicksForAllUsers();
    expect(result.groups_scored).toBe(2);

    const rows = await dbAll<{ user_id: number; ai_picked_photo_ids: number[] | null }>(
      db.select({
        user_id: photoGroups.user_id,
        ai_picked_photo_ids: photoGroups.ai_picked_photo_ids,
      }).from(photoGroups),
    );
    const u1Row = rows.find((r) => r.user_id === u1);
    const u2Row = rows.find((r) => r.user_id === u2);
    expect(u1Row?.ai_picked_photo_ids).toEqual([a2]);
    expect(u2Row?.ai_picked_photo_ids).toEqual([b2]);
  });
});

describe("orientation diversity (Track I follow-up)", () => {
  it("picks the best of each orientation when the group is mixed", async () => {
    const u = await makeUser("orient-mixed@test.com");
    // Two portraits + one landscape, scores close enough that the
    // landscape clears the 0.75 floor.
    const p1 = await makePhoto(u, {
      details: { blur_score: 0.90 },
      width: 2000, height: 3000,
    });
    const p2 = await makePhoto(u, {
      details: { blur_score: 0.85 },
      width: 2000, height: 3000,
    });
    const l1 = await makePhoto(u, {
      details: { blur_score: 0.80 },
      width: 3000, height: 2000,
    });
    await makeGroup(u, p1, [p1, p2, l1]);

    await recomputeAiPicksForGroups(u);
    const [row] = await db.select().from(photoGroups);
    expect(row.ai_picked_photo_ids?.sort()).toEqual([p1, p2, l1].sort());
    const scoresById = new Map(
      (row.ai_pick_details?.scores ?? []).map((s) => [s.photo_id, s] as const),
    );
    expect(scoresById.get(p1)?.orientation).toBe("portrait");
    expect(scoresById.get(l1)?.orientation).toBe("landscape");
  });

  it("does not promote a landscape that is far below the floor", async () => {
    const u = await makeUser("orient-bad-landscape@test.com");
    const p1 = await makePhoto(u, {
      details: { blur_score: 0.90 },
      width: 2000, height: 3000,
    });
    const l1 = await makePhoto(u, {
      details: { blur_score: 0.10 },
      width: 3000, height: 2000,
    });
    await makeGroup(u, p1, [p1, l1]);

    await recomputeAiPicksForGroups(u);
    const [row] = await db.select().from(photoGroups);
    expect(row.ai_picked_photo_ids).toEqual([p1]);
  });

  it("ignores the rule when dimensions are still NULL (pre-backfill)", async () => {
    const u = await makeUser("orient-null@test.com");
    // No width/height — orientation undefined → rule must no-op.
    const p1 = await makePhoto(u, { details: { blur_score: 0.90 } });
    const p2 = await makePhoto(u, { details: { blur_score: 0.10 } });
    await makeGroup(u, p1, [p1, p2]);

    await recomputeAiPicksForGroups(u);
    const [row] = await db.select().from(photoGroups);
    expect(row.ai_picked_photo_ids).toEqual([p1]);
  });
});

describe("acceptAiPickLogic", () => {
  it("hides non-picked members and marks the group reviewed", async () => {
    const u = await makeUser("accept@test.com");
    const a = await makePhoto(u, { details: { blur_score: 0.10 } });
    const b = await makePhoto(u, { details: { blur_score: 0.90 } });
    const c = await makePhoto(u, { details: { blur_score: 0.20 } });
    const g = await makeGroup(u, a, [a, b, c]);
    await recomputeAiPicksForGroups(u);

    const result = await acceptAiPickLogic(u, g);
    expect(result.success).toBe(true);
    expect(result.hidden_count).toBe(2);

    const curationRows = await dbAll<{ photo_id: number; status: string }>(
      db.select({ photo_id: photoCuration.photo_id, status: photoCuration.status })
        .from(photoCuration)
        .where(eq(photoCuration.user_id, u)),
    );
    const hidden = curationRows.filter((r) => r.status === "hidden").map((r) => r.photo_id);
    expect(hidden.sort()).toEqual([a, c].sort());

    const [groupRow] = await db.select().from(photoGroups).where(eq(photoGroups.id, g));
    expect(groupRow.reviewed_at).not.toBeNull();
  });

  it("does not clobber favorites when hiding non-picks", async () => {
    const u = await makeUser("favorite-safe@test.com");
    const a = await makePhoto(u, { details: { blur_score: 0.10 } });
    const b = await makePhoto(u, { details: { blur_score: 0.90 } });
    const g = await makeGroup(u, a, [a, b]);
    // User favorited the photo the AI would hide.
    await dbExec(
      db.insert(photoCuration).values({
        user_id: u,
        photo_id: a,
        status: "favorite",
      }),
    );
    await recomputeAiPicksForGroups(u);

    await acceptAiPickLogic(u, g);

    const [row] = await db.select().from(photoCuration)
      .where(eq(photoCuration.photo_id, a));
    expect(row.status).toBe("favorite");
  });

  it("is a no-op on already-reviewed groups", async () => {
    const u = await makeUser("already-reviewed@test.com");
    const a = await makePhoto(u, { details: { blur_score: 0.10 } });
    const b = await makePhoto(u, { details: { blur_score: 0.90 } });
    const g = await makeGroup(u, a, [a, b]);
    await recomputeAiPicksForGroups(u);
    await dbExec(
      db.update(photoGroups)
        .set({ reviewed_at: new Date().toISOString() })
        .where(eq(photoGroups.id, g)),
    );

    const result = await acceptAiPickLogic(u, g);
    expect(result.hidden_count).toBe(0);
  });
});

describe("acceptAiPickLogic — explicit pick override (Stufe C)", () => {
  it("hides every member except the explicit pick set", async () => {
    const u = await makeUser("explicit-pick@test.com");
    const a = await makePhoto(u, { details: { blur_score: 0.10 } });
    const b = await makePhoto(u, { details: { blur_score: 0.90 } });
    const c = await makePhoto(u, { details: { blur_score: 0.50 } });
    const g = await makeGroup(u, a, [a, b, c]);
    await recomputeAiPicksForGroups(u);
    // AI prefers b (sharper). User wants to keep `a` instead.
    const result = await acceptAiPickLogic(u, g, [a]);
    expect(result.success).toBe(true);
    expect(result.hidden_count).toBe(2);

    const curations = await dbAll<{ photo_id: number; status: string }>(
      db.select({ photo_id: photoCuration.photo_id, status: photoCuration.status })
        .from(photoCuration)
        .where(eq(photoCuration.user_id, u)),
    );
    const hidden = curations.filter((r) => r.status === "hidden").map((r) => r.photo_id);
    expect(hidden.sort()).toEqual([b, c].sort());

    const [row] = await db.select().from(photoGroups).where(eq(photoGroups.id, g));
    expect(row.reviewed_at).not.toBeNull();
  });

  it("falls back to the AI pick when override is undefined", async () => {
    const u = await makeUser("explicit-fallback@test.com");
    const a = await makePhoto(u, { details: { blur_score: 0.10 } });
    const b = await makePhoto(u, { details: { blur_score: 0.90 } });
    const g = await makeGroup(u, a, [a, b]);
    await recomputeAiPicksForGroups(u);
    const result = await acceptAiPickLogic(u, g);
    expect(result.success).toBe(true);
    // AI picked b, so a should now be the hidden one.
    const [row] = await db.select().from(photoCuration).where(eq(photoCuration.photo_id, a));
    expect(row.status).toBe("hidden");
  });

  it("refuses when the override references a photo outside the group", async () => {
    const u = await makeUser("explicit-outsider@test.com");
    const a = await makePhoto(u, { details: { blur_score: 0.10 } });
    const b = await makePhoto(u, { details: { blur_score: 0.90 } });
    const outsider = await makePhoto(u, { details: { blur_score: 0.50 } });
    const g = await makeGroup(u, a, [a, b]);
    await recomputeAiPicksForGroups(u);
    const result = await acceptAiPickLogic(u, g, [outsider]);
    expect(result.success).toBe(false);
    expect(result.hidden_count).toBe(0);
    // No curation rows should have been written.
    const rows = await dbAll<{ photo_id: number }>(
      db.select({ photo_id: photoCuration.photo_id })
        .from(photoCuration)
        .where(eq(photoCuration.user_id, u)),
    );
    expect(rows).toHaveLength(0);
  });
});

describe("bulkAcceptHighConfidencePicksLogic", () => {
  it("only touches high-confidence unreviewed groups", async () => {
    const u = await makeUser("bulk@test.com");
    // High confidence (Δ ≈ 0.32):
    const ha = await makePhoto(u, { details: { blur_score: 0.10 } });
    const hb = await makePhoto(u, { details: { blur_score: 0.90 } });
    const high = await makeGroup(u, ha, [ha, hb]);
    // Medium confidence (Δ ≈ 0.08 — between 0.04 and 0.10):
    const ma = await makePhoto(u, { details: { blur_score: 0.40 } });
    const mb = await makePhoto(u, { details: { blur_score: 0.60 } });
    const medium = await makeGroup(u, ma, [ma, mb]);

    await recomputeAiPicksForGroups(u);
    const result = await bulkAcceptHighConfidencePicksLogic(u);
    expect(result.groups_accepted).toBe(1);
    expect(result.hidden_count).toBe(1);

    const [highRow] = await db.select().from(photoGroups).where(eq(photoGroups.id, high));
    const [medRow] = await db.select().from(photoGroups).where(eq(photoGroups.id, medium));
    expect(highRow.reviewed_at).not.toBeNull();
    expect(medRow.reviewed_at).toBeNull();
  });

  it("preserves favorites across the bulk run (no clobber)", async () => {
    // Same property as acceptAiPickLogic guards in the per-group path,
    // re-verified for the CTE pipeline: a non-picked photo that the user
    // had previously marked 'favorite' must stay favorite after bulk-
    // accept, never silently degrade to 'hidden'.
    const u = await makeUser("bulk-favorite@test.com");
    const a = await makePhoto(u, { details: { blur_score: 0.10 } });
    const b = await makePhoto(u, { details: { blur_score: 0.90 } });
    const g = await makeGroup(u, a, [a, b]);
    await dbExec(
      db.insert(photoCuration).values({
        user_id: u,
        photo_id: a,
        status: "favorite",
      }),
    );
    await recomputeAiPicksForGroups(u);

    await bulkAcceptHighConfidencePicksLogic(u);

    const [row] = await db.select().from(photoCuration)
      .where(eq(photoCuration.photo_id, a));
    expect(row.status).toBe("favorite");
    const [grp] = await db.select().from(photoGroups).where(eq(photoGroups.id, g));
    expect(grp.reviewed_at).not.toBeNull();
  });

  it("marks a multi-pick group reviewed even when no member needs hiding", async () => {
    // When every member of a high-confidence group is in the pick set
    // (multi-pick over the 0.92 threshold), there is nothing to hide.
    // The group must still leave the unreviewed queue, otherwise the
    // bulk run would loop forever on it.
    const u = await makeUser("bulk-all-picked@test.com");
    const a = await makePhoto(u, { details: { blur_score: 0.95 } });
    const b = await makePhoto(u, { details: { blur_score: 0.95 } });
    const g = await makeGroup(u, a, [a, b]);
    await recomputeAiPicksForGroups(u);
    // Sanity: the recompute really did mark both as picked.
    const [scored] = await db.select().from(photoGroups).where(eq(photoGroups.id, g));
    expect(scored.ai_picked_photo_ids?.sort()).toEqual([a, b].sort());
    // Force the confidence to 'high' so this group matches the bulk
    // filter — a tied multi-pick lands on 'low' naturally, but we want
    // to exercise the "nothing to hide, still mark reviewed" path.
    await dbExec(
      db.update(photoGroups)
        .set({ ai_picked_confidence: "high" })
        .where(eq(photoGroups.id, g)),
    );

    const result = await bulkAcceptHighConfidencePicksLogic(u);
    expect(result.groups_accepted).toBe(1);
    expect(result.hidden_count).toBe(0);

    const [row] = await db.select().from(photoGroups).where(eq(photoGroups.id, g));
    expect(row.reviewed_at).not.toBeNull();
    const curation = await dbAll<{ status: string }>(
      db.select({ status: photoCuration.status }).from(photoCuration)
        .where(eq(photoCuration.user_id, u)),
    );
    expect(curation).toHaveLength(0);
  });

  it("processes more groups than the per-chunk limit in a single call", { timeout: 60_000 }, async () => {
    // Regression guard for the 502 reported by the user: the previous
    // sequential implementation timed out on 2k+ groups. The new CTE
    // pipeline batches in chunks of 500 and loops until the queue is
    // empty. Crossing the chunk boundary with > 500 groups proves the
    // loop terminates and aggregates totals correctly.
    //
    // 600 is plenty to cross the 500-group chunk boundary while keeping
    // the test fast enough for a single Vitest run (~3 s on the
    // sandbox).
    const u = await makeUser("bulk-large@test.com");
    const N = 600;
    const groupIds: number[] = [];
    for (let i = 0; i < N; i++) {
      const a = await makePhoto(u, { details: { blur_score: 0.10 } });
      const b = await makePhoto(u, { details: { blur_score: 0.90 } });
      groupIds.push(await makeGroup(u, a, [a, b]));
    }
    await recomputeAiPicksForGroups(u);

    const result = await bulkAcceptHighConfidencePicksLogic(u);
    expect(result.groups_accepted).toBe(N);
    expect(result.hidden_count).toBe(N);

    const unreviewed = await dbAll<{ id: number }>(
      db.select({ id: photoGroups.id }).from(photoGroups)
        .where(eq(photoGroups.user_id, u)),
    );
    expect(unreviewed.length).toBe(N);
    const stillUnreviewed = await dbAll<{ id: number; reviewed_at: string | null }>(
      db.select({
        id: photoGroups.id,
        reviewed_at: photoGroups.reviewed_at,
      }).from(photoGroups).where(eq(photoGroups.user_id, u)),
    );
    expect(stillUnreviewed.every((g) => g.reviewed_at !== null)).toBe(true);
  });

  it("is idempotent: a second bulk-accept run accepts zero groups", async () => {
    // After the first run all high-confidence groups are reviewed, so
    // the WHERE clause in the targets CTE returns nothing on the second
    // run and the loop exits on the first iteration.
    const u = await makeUser("bulk-idempotent@test.com");
    const a = await makePhoto(u, { details: { blur_score: 0.10 } });
    const b = await makePhoto(u, { details: { blur_score: 0.90 } });
    await makeGroup(u, a, [a, b]);
    await recomputeAiPicksForGroups(u);

    const first = await bulkAcceptHighConfidencePicksLogic(u);
    expect(first.groups_accepted).toBe(1);

    const second = await bulkAcceptHighConfidencePicksLogic(u);
    expect(second.groups_accepted).toBe(0);
    expect(second.hidden_count).toBe(0);
  });
});

describe("exportCalibrationDatasetLogic", () => {
  it("emits one entry per reviewed group with kept/hidden flags", async () => {
    const u = await makeUser("calibration@test.com");
    const a = await makePhoto(u, { details: { blur_score: 0.10 } });
    const b = await makePhoto(u, { details: { blur_score: 0.90 } });
    const g = await makeGroup(u, a, [a, b]);
    await recomputeAiPicksForGroups(u);
    await acceptAiPickLogic(u, g);

    const result = await exportCalibrationDatasetLogic(u);
    expect(result.entries).toHaveLength(1);
    const entry = result.entries[0];
    expect(entry.group_id).toBe(g);
    expect(entry.group_confidence).toBe("high");
    expect(entry.group_ai_picked_photo_ids).toEqual([b]);
    const aRow = entry.photos.find((p) => p.photo_id === a);
    const bRow = entry.photos.find((p) => p.photo_id === b);
    expect(aRow?.user_kept).toBe(false);
    expect(aRow?.ai_picked).toBe(false);
    expect(bRow?.user_kept).toBe(true);
    expect(bRow?.ai_picked).toBe(true);
  });

  it("excludes unreviewed groups", async () => {
    const u = await makeUser("calibration-unreviewed@test.com");
    const a = await makePhoto(u, { details: { blur_score: 0.10 } });
    const b = await makePhoto(u, { details: { blur_score: 0.90 } });
    await makeGroup(u, a, [a, b]);
    await recomputeAiPicksForGroups(u);

    const result = await exportCalibrationDatasetLogic(u);
    expect(result.entries).toHaveLength(0);
  });

  it("scores reviewed groups inline so the dump is never empty when signals exist", async () => {
    // Reproduces the very first export the user got after PR #404: the
    // groups had been reviewed (hidden via photo_curation) but
    // recomputeAiPicks had never touched them, so ai_pick_details was
    // NULL and the dump was structurally empty (no signals, no picks).
    // The export must score them on the fly.
    const u = await makeUser("calibration-empty-then-scored@test.com");
    const a = await makePhoto(u, { details: { blur_score: 0.10 } });
    const b = await makePhoto(u, { details: { blur_score: 0.90 } });
    const g = await makeGroup(u, a, [a, b]);
    // Reviewed by hand WITHOUT ever calling recomputeAiPicks — exact
    // scenario from the user's first export.
    await dbExec(sql`
      INSERT INTO photo_curation (user_id, photo_id, status, updated_at)
      VALUES (${u}, ${a}, 'hidden', NOW())
    `);
    await dbExec(
      db.update(photoGroups)
        .set({ reviewed_at: new Date().toISOString() })
        .where(eq(photoGroups.id, g)),
    );

    const result = await exportCalibrationDatasetLogic(u);
    expect(result.entries).toHaveLength(1);
    const entry = result.entries[0];
    expect(entry.group_ai_picked_photo_ids).toEqual([b]);
    expect(entry.group_confidence).toBe("high");
    const bRow = entry.photos.find((p) => p.photo_id === b);
    expect(bRow?.ai_picked).toBe(true);
    expect(Object.keys(bRow?.signals ?? {})).not.toHaveLength(0);
  });

  it("re-running the export does not re-score already-scored reviewed groups", async () => {
    const u = await makeUser("calibration-idempotent@test.com");
    const a = await makePhoto(u, { details: { blur_score: 0.10 } });
    const b = await makePhoto(u, { details: { blur_score: 0.90 } });
    const g = await makeGroup(u, a, [a, b]);
    await dbExec(
      db.update(photoGroups)
        .set({ reviewed_at: new Date().toISOString() })
        .where(eq(photoGroups.id, g)),
    );

    await exportCalibrationDatasetLogic(u);
    const [first] = await db.select().from(photoGroups).where(eq(photoGroups.id, g));
    const firstAt = first.ai_picked_at;

    // Force a tiny sleep so any second UPDATE would advance NOW()
    await new Promise((r) => setTimeout(r, 50));
    await exportCalibrationDatasetLogic(u);
    const [second] = await db.select().from(photoGroups).where(eq(photoGroups.id, g));
    expect(second.ai_picked_at).toEqual(firstAt);
  });
});

describe("listReviewQueueLogic — high_confidence_total", () => {
  it("returns the filter-independent count of unreviewed high-confidence groups", async () => {
    // Three high-confidence groups, one medium, one reviewed-high. The
    // "Alle Sicheren bestätigen"-Button needs to know that there are
    // 3 high-confidence groups left regardless of which filter the user
    // is currently looking at — so the count must come from a server-
    // wide aggregate, not from the filtered page window.
    const u = await makeUser("review-queue-high-total@test.com");
    const groupIds: number[] = [];
    for (let i = 0; i < 3; i++) {
      const a = await makePhoto(u, { details: { blur_score: 0.10 } });
      const b = await makePhoto(u, { details: { blur_score: 0.90 } });
      groupIds.push(await makeGroup(u, a, [a, b]));
    }
    // Δ ≈ 0.08 — between MEDIUM_CONFIDENCE_DELTA (0.04) and
    // HIGH_CONFIDENCE_DELTA (0.10), lands at confidence='medium'.
    const ma = await makePhoto(u, { details: { blur_score: 0.40 } });
    const mb = await makePhoto(u, { details: { blur_score: 0.60 } });
    await makeGroup(u, ma, [ma, mb]);
    const ra = await makePhoto(u, { details: { blur_score: 0.10 } });
    const rb = await makePhoto(u, { details: { blur_score: 0.90 } });
    const reviewedHigh = await makeGroup(u, ra, [ra, rb]);
    await recomputeAiPicksForGroups(u);
    // Mark one high-confidence group reviewed — it must not count.
    await dbExec(
      db.update(photoGroups)
        .set({ reviewed_at: new Date().toISOString() })
        .where(eq(photoGroups.id, reviewedHigh)),
    );

    const all = await listReviewQueueLogic(u);
    expect(all.high_confidence_total).toBe(3);

    const onlyMedium = await listReviewQueueLogic(u, { confidence: "medium" });
    expect(onlyMedium.total).toBe(1);
    // High count stays 3 regardless of the active filter.
    expect(onlyMedium.high_confidence_total).toBe(3);

    const onlyLow = await listReviewQueueLogic(u, { confidence: "low" });
    expect(onlyLow.total).toBe(0);
    expect(onlyLow.high_confidence_total).toBe(3);
  });

  it("drops to 0 once every high-confidence group is reviewed", async () => {
    const u = await makeUser("review-queue-high-zero@test.com");
    const a = await makePhoto(u, { details: { blur_score: 0.10 } });
    const b = await makePhoto(u, { details: { blur_score: 0.90 } });
    const g = await makeGroup(u, a, [a, b]);
    await recomputeAiPicksForGroups(u);

    const before = await listReviewQueueLogic(u);
    expect(before.high_confidence_total).toBe(1);

    await acceptAiPickLogic(u, g);

    const after = await listReviewQueueLogic(u);
    expect(after.high_confidence_total).toBe(0);
  });
});

// ── Peer-Consensus (Phase 1 aggregate + Phase 2 accept) ──

async function makeAlbum(ownerId: number, name = "Shared"): Promise<number> {
  const row = await dbInsertReturning<{ id: number }>(
    db.insert(albums).values({
      user_id: ownerId,
      name,
    }).returning({ id: albums.id }),
  );
  return row!.id;
}

async function shareAlbum(albumId: number, withUserId: number): Promise<void> {
  await dbExec(
    db.insert(albumShares).values({
      album_id: albumId,
      user_id: withUserId,
      access_level: "read",
    }),
  );
}

async function addPhotoToAlbum(albumId: number, photoId: number): Promise<void> {
  await dbExec(
    db.insert(albumPhotos).values({
      album_id: albumId,
      photo_id: photoId,
    }),
  );
}

async function setCuration(userId: number, photoId: number, status: "hidden" | "favorite"): Promise<void> {
  await dbExec(
    db.insert(photoCuration).values({
      user_id: userId,
      photo_id: photoId,
      status,
    }),
  );
}

describe("listReviewQueueLogic — peer_curation aggregate (Phase 1)", () => {
  it("counts hidden + favorite votes from peers who share at least one album", async () => {
    // Owner (the reviewer) shares an album with two peers. Peer A hid
    // photo X; Peer B favorited it. The aggregate must return
    // { hidden: 1, favorite: 1 } regardless of which peer reviewed first.
    const owner = await makeUser("owner-peer@test.com");
    const peerA = await makeUser("peer-a@test.com");
    const peerB = await makeUser("peer-b@test.com");
    const album = await makeAlbum(owner);
    await shareAlbum(album, peerA);
    await shareAlbum(album, peerB);

    const px = await makePhoto(owner, { details: { sharpness: 0.50 } });
    const py = await makePhoto(owner, { details: { sharpness: 0.90 } });
    await addPhotoToAlbum(album, px);
    await addPhotoToAlbum(album, py);
    await makeGroup(owner, px, [px, py]);

    await setCuration(peerA, px, "hidden");
    await setCuration(peerB, px, "favorite");

    const res = await listReviewQueueLogic(owner);
    expect(res.groups).toHaveLength(1);
    const group = res.groups[0];
    const photoX = group.photos.find((p) => p.id === px)!;
    const photoY = group.photos.find((p) => p.id === py)!;
    expect(photoX.peer_curation).toEqual({ hidden: 1, favorite: 1 });
    // No peer touched py → both counts 0.
    expect(photoY.peer_curation).toEqual({ hidden: 0, favorite: 0 });
  });

  it("does not leak peer signals from un-shared albums (privacy boundary)", async () => {
    // Peer hid the photo, but in an album they own privately — the
    // owner of this queue has no access to that album. The peer's
    // decision must not appear in the owner's aggregate.
    const owner = await makeUser("owner-private@test.com");
    const peer = await makeUser("peer-private@test.com");

    const px = await makePhoto(owner, { details: { sharpness: 0.50 } });
    await makeGroup(owner, px, [px]);

    // Peer's private album that the photo is also in, but not shared
    // with owner.
    const peerAlbum = await makeAlbum(peer, "Peer-Privat");
    await addPhotoToAlbum(peerAlbum, px);
    await setCuration(peer, px, "hidden");

    const res = await listReviewQueueLogic(owner);
    const photoX = res.groups[0].photos.find((p) => p.id === px)!;
    // Owner can't see peer's private album → no signal leaks through.
    expect(photoX.peer_curation).toEqual({ hidden: 0, favorite: 0 });
  });

  it("excludes the requester's own curation from the peer count", async () => {
    // Self-curation must never show up as "peer signal" — that would
    // be a confusing echo of the user's own past decisions.
    const owner = await makeUser("owner-self@test.com");
    const peer = await makeUser("peer-self@test.com");
    const album = await makeAlbum(owner);
    await shareAlbum(album, peer);

    const px = await makePhoto(owner, { details: { sharpness: 0.50 } });
    await addPhotoToAlbum(album, px);
    await makeGroup(owner, px, [px]);

    await setCuration(owner, px, "favorite"); // own → must be excluded
    await setCuration(peer, px, "hidden");    // peer → counts

    const res = await listReviewQueueLogic(owner);
    const photoX = res.groups[0].photos.find((p) => p.id === px)!;
    expect(photoX.peer_curation).toEqual({ hidden: 1, favorite: 0 });
  });
});

describe("acceptPeerConsensusLogic (Phase 2)", () => {
  it("hides photos when ≥1 peer hid and 0 peers favorited", async () => {
    const owner = await makeUser("consensus-hide@test.com");
    const peer = await makeUser("consensus-hide-peer@test.com");
    const album = await makeAlbum(owner);
    await shareAlbum(album, peer);

    const px = await makePhoto(owner);
    const py = await makePhoto(owner);
    await addPhotoToAlbum(album, px);
    await addPhotoToAlbum(album, py);
    const g = await makeGroup(owner, px, [px, py]);

    await setCuration(peer, px, "hidden"); // peer hid px

    const res = await acceptPeerConsensusLogic(owner, g);
    expect(res.success).toBe(true);
    expect(res.hidden_count).toBe(1);
    expect(res.kept_count).toBe(0);
    expect(res.no_signal_count).toBe(1); // py has no signal

    // Owner now has a 'hidden' row on px.
    const [pxRow] = await db.select().from(photoCuration)
      .where(and(eq(photoCuration.photo_id, px), eq(photoCuration.user_id, owner)));
    expect(pxRow.status).toBe("hidden");

    // Group is reviewed.
    const [grp] = await db.select().from(photoGroups).where(eq(photoGroups.id, g));
    expect(grp.reviewed_at).not.toBeNull();
  });

  it("does not hide when at least one peer favorited (favorite vetoes)", async () => {
    // 2 peers hid the photo, 1 peer favorited it. Conservative rule:
    // ANY favorite vetoes the hide consensus.
    const owner = await makeUser("consensus-veto@test.com");
    const peerA = await makeUser("consensus-veto-a@test.com");
    const peerB = await makeUser("consensus-veto-b@test.com");
    const peerC = await makeUser("consensus-veto-c@test.com");
    const album = await makeAlbum(owner);
    await shareAlbum(album, peerA);
    await shareAlbum(album, peerB);
    await shareAlbum(album, peerC);

    const px = await makePhoto(owner);
    await addPhotoToAlbum(album, px);
    const g = await makeGroup(owner, px, [px]);

    await setCuration(peerA, px, "hidden");
    await setCuration(peerB, px, "hidden");
    await setCuration(peerC, px, "favorite");

    const res = await acceptPeerConsensusLogic(owner, g);
    expect(res.success).toBe(true);
    expect(res.hidden_count).toBe(0);
    expect(res.kept_count).toBe(1);
    expect(res.no_signal_count).toBe(0);

    // Owner's curation row must remain absent (or visible) — favorite
    // veto preserved the photo.
    const ownerRows = await dbAll(
      db.select().from(photoCuration)
        .where(and(eq(photoCuration.user_id, owner), eq(photoCuration.photo_id, px))),
    );
    expect(ownerRows).toHaveLength(0);

    // Group still marked reviewed (explicit user action).
    const [grp] = await db.select().from(photoGroups).where(eq(photoGroups.id, g));
    expect(grp.reviewed_at).not.toBeNull();
  });

  it("preserves the requester's own favorite (never clobbered to hidden)", async () => {
    // Same property as acceptAiPickLogic — even if every peer hid the
    // photo, the requester's existing 'favorite' must survive.
    const owner = await makeUser("consensus-own-fav@test.com");
    const peer = await makeUser("consensus-own-fav-peer@test.com");
    const album = await makeAlbum(owner);
    await shareAlbum(album, peer);

    const px = await makePhoto(owner);
    await addPhotoToAlbum(album, px);
    const g = await makeGroup(owner, px, [px]);

    await setCuration(owner, px, "favorite"); // owner's own favorite
    await setCuration(peer, px, "hidden");    // peer hid

    const res = await acceptPeerConsensusLogic(owner, g);
    expect(res.success).toBe(true);
    expect(res.hidden_count).toBe(1); // consensus *said* hide
    // ...but the actual curation row stays 'favorite' (ON CONFLICT guard).
    const [pxRow] = await db.select().from(photoCuration)
      .where(and(eq(photoCuration.user_id, owner), eq(photoCuration.photo_id, px)));
    expect(pxRow.status).toBe("favorite");
  });

  it("marks the group reviewed even when no photo has any peer signal", async () => {
    // Explicit user click is a review act. Empty consensus must still
    // remove the group from the queue, otherwise the user can't tell
    // "I tried but there was nothing" apart from "the button didn't work".
    const owner = await makeUser("consensus-empty@test.com");
    const px = await makePhoto(owner);
    const g = await makeGroup(owner, px, [px]);

    const res = await acceptPeerConsensusLogic(owner, g);
    expect(res.success).toBe(true);
    expect(res.hidden_count).toBe(0);
    expect(res.no_signal_count).toBe(1);

    const [grp] = await db.select().from(photoGroups).where(eq(photoGroups.id, g));
    expect(grp.reviewed_at).not.toBeNull();
  });
});
