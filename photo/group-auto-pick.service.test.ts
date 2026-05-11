import { beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import db from "../db/database";
import { dbAll, dbExec, dbInsertReturning } from "../db/adapter";
import {
  faces,
  photoCuration,
  photoGroupMembers,
  photoGroups,
  photos,
  users,
} from "../db/schema";
import {
  acceptAiPickLogic,
  bulkAcceptHighConfidencePicksLogic,
  exportCalibrationDatasetLogic,
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
