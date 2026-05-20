import { describe, it, expect, beforeEach } from "vitest";
import db from "../db/database";
import { photos, photoScanQueue, users } from "../db/schema";
import { getFailedJobsGrouped, isScanService } from "./scan-queue";

async function seedUser(email: string): Promise<number> {
  const [u] = await db
    .insert(users)
    .values({ email, name: "T", password_hash: "x" })
    .returning({ id: users.id });
  return u.id;
}

async function seedPhoto(userId: number, idx: number): Promise<number> {
  const [p] = await db
    .insert(photos)
    .values({
      user_id: userId,
      filename: `p${idx}.jpg`,
      original_name: `p${idx}.jpg`,
      mime_type: "image/jpeg",
      size: 1,
    })
    .returning({ id: photos.id });
  return p.id;
}

async function seedQueueRow(opts: {
  photoId: number;
  userId: number | null;
  service: "embedding" | "face_assignment";
  status: "failed" | "done";
  errorMsg?: string | null;
  finishedAt?: string;
}): Promise<void> {
  await db.insert(photoScanQueue).values({
    photo_id: opts.photoId,
    user_id: opts.userId,
    service: opts.service,
    status: opts.status,
    priority: 2,
    error_msg: opts.errorMsg ?? null,
    finished_at: opts.finishedAt ?? null,
  });
}

beforeEach(async () => {
  await db.delete(photoScanQueue);
  await db.delete(photos);
  await db.delete(users);
});

describe("isScanService", () => {
  it("accepts known services", () => {
    expect(isScanService("embedding")).toBe(true);
    expect(isScanService("poi_detection")).toBe(true);
    expect(isScanService("face_assignment")).toBe(true);
  });

  it("rejects unknown values", () => {
    expect(isScanService("nonsense")).toBe(false);
    expect(isScanService("")).toBe(false);
    expect(isScanService("EMBEDDING")).toBe(false);
  });
});

describe("getFailedJobsGrouped", () => {
  it("returns an empty array when nothing failed", async () => {
    const userId = await seedUser("a@test");
    const photoId = await seedPhoto(userId, 1);
    await seedQueueRow({ photoId, userId: null, service: "embedding", status: "done" });

    const groups = await getFailedJobsGrouped(userId, "embedding");
    expect(groups).toEqual([]);
  });

  it("groups failed jobs by error message, most frequent first", async () => {
    const userId = await seedUser("a@test");
    const p1 = await seedPhoto(userId, 1);
    const p2 = await seedPhoto(userId, 2);
    const p3 = await seedPhoto(userId, 3);

    // 2× the same message, 1× a different one.
    await seedQueueRow({ photoId: p1, userId: null, service: "embedding", status: "failed", errorMsg: "convertHeicToJpeg is not defined" });
    await seedQueueRow({ photoId: p2, userId: null, service: "embedding", status: "failed", errorMsg: "convertHeicToJpeg is not defined" });
    await seedQueueRow({ photoId: p3, userId: null, service: "embedding", status: "failed", errorMsg: "Embedding service returned 500" });

    const groups = await getFailedJobsGrouped(userId, "embedding");
    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({
      errorMsg: "convertHeicToJpeg is not defined",
      count: 2,
    });
    expect(groups[0].samplePhotoIds.sort()).toEqual([p1, p2].sort());
    expect(groups[1]).toMatchObject({
      errorMsg: "Embedding service returned 500",
      count: 1,
    });
  });

  it("collapses a null error_msg into the '(no message)' group", async () => {
    const userId = await seedUser("a@test");
    const p1 = await seedPhoto(userId, 1);
    await seedQueueRow({ photoId: p1, userId: null, service: "embedding", status: "failed", errorMsg: null });

    const groups = await getFailedJobsGrouped(userId, "embedding");
    expect(groups).toHaveLength(1);
    expect(groups[0].errorMsg).toBe("(no message)");
    expect(groups[0].count).toBe(1);
  });

  it("only counts user_id IS NULL rows for a global service", async () => {
    const userA = await seedUser("a@test");
    const userB = await seedUser("b@test");
    const p1 = await seedPhoto(userA, 1);
    const p2 = await seedPhoto(userB, 2);

    // A global service should ignore any stray rows that carry a user_id
    // (legacy data) and only report the canonical user_id IS NULL rows.
    await seedQueueRow({ photoId: p1, userId: null, service: "embedding", status: "failed", errorMsg: "boom" });
    await seedQueueRow({ photoId: p2, userId: userB, service: "embedding", status: "failed", errorMsg: "boom" });

    const groups = await getFailedJobsGrouped(userA, "embedding");
    expect(groups).toHaveLength(1);
    expect(groups[0].count).toBe(1); // the user_id-bearing row is excluded
  });

  it("scopes a per-user service to the requesting user", async () => {
    const userA = await seedUser("a@test");
    const userB = await seedUser("b@test");
    const p1 = await seedPhoto(userA, 1);
    const p2 = await seedPhoto(userB, 2);

    await seedQueueRow({ photoId: p1, userId: userA, service: "face_assignment", status: "failed", errorMsg: "boom" });
    await seedQueueRow({ photoId: p2, userId: userB, service: "face_assignment", status: "failed", errorMsg: "boom" });

    // userA must see only their own face_assignment failure, never userB's.
    const groupsA = await getFailedJobsGrouped(userA, "face_assignment");
    expect(groupsA).toHaveLength(1);
    expect(groupsA[0].count).toBe(1);
    expect(groupsA[0].samplePhotoIds).toEqual([p1]);
  });
});
