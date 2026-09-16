// Text recognised inside photos (#1029): what gets kept out of the OCR
// service's answer, how it is stored, and that a photo can be found by words
// that only appear on a sign or a whiteboard in it.

import { describe, it, expect, beforeEach } from "vitest";
import { eq, sql } from "drizzle-orm";

import db from "../db/database";
import { dbAll, dbInsertReturning } from "../db/adapter";
import { photoOcr, photos, users, type PhotoOcrBlock } from "../db/schema";
import { createUserLogic } from "../user/user.service";
import {
  blocksToFullText,
  getPhotoOcrLogic,
  meanConfidence,
  storePhotoOcr,
  toStoredBlocks,
} from "./photo-ocr.service";
import type { PhotoOcrLine } from "./photo-ocr-client";
import { ocrTextMatches } from "./photo-ocr-search";

function line(overrides: Partial<PhotoOcrLine> = {}): PhotoOcrLine {
  return {
    text: "Hauptbahnhof",
    confidence: 0.92,
    polygon: [[0.1, 0.2], [0.6, 0.2], [0.6, 0.3], [0.1, 0.3]],
    left: 0.1,
    top: 0.2,
    right: 0.6,
    bottom: 0.3,
    ...overrides,
  };
}

describe("toStoredBlocks", () => {
  it("keeps a confident line with its geometry", () => {
    const [block] = toStoredBlocks([line()]);
    expect(block.text).toBe("Hauptbahnhof");
    expect(block.polygon).toEqual([[0.1, 0.2], [0.6, 0.2], [0.6, 0.3], [0.1, 0.3]]);
    expect(block.left).toBe(0.1);
  });

  it("drops what the detector only half-believes", () => {
    // Scene-text detection finds "text" in brickwork; that noise would cost
    // search far more than it could ever add.
    expect(toStoredBlocks([line({ text: "l1I|", confidence: 0.2 })])).toEqual([]);
  });

  it("keeps a barely-legible sign above the threshold", () => {
    expect(toStoredBlocks([line({ confidence: 0.55 })])).toHaveLength(1);
  });

  it("drops blank detections and trims the rest", () => {
    const blocks = toStoredBlocks([line({ text: "   " }), line({ text: "  Gleis 3 " })]);
    expect(blocks.map(b => b.text)).toEqual(["Gleis 3"]);
  });

  it("preserves reading order", () => {
    const blocks = toStoredBlocks([line({ text: "oben" }), line({ text: "unten" })]);
    expect(blocks.map(b => b.text)).toEqual(["oben", "unten"]);
  });
});

describe("blocksToFullText", () => {
  it("joins the lines as they were read", () => {
    const blocks = toStoredBlocks([line({ text: "Gleis 3" }), line({ text: "nach Musterstadt" })]);
    expect(blocksToFullText(blocks)).toBe("Gleis 3\nnach Musterstadt");
  });

  it("is empty for a photo with no text on it", () => {
    expect(blocksToFullText([])).toBe("");
  });
});

describe("meanConfidence", () => {
  it("weighs a long line more than a short one", () => {
    const blocks: PhotoOcrBlock[] = [
      { text: "a", confidence: 1, polygon: [], left: 0, top: 0, right: 0, bottom: 0 },
      { text: "b".repeat(9), confidence: 0.5, polygon: [], left: 0, top: 0, right: 0, bottom: 0 },
    ];
    expect(meanConfidence(blocks)).toBeCloseTo(0.55, 4);
  });

  it("is zero without any text", () => {
    expect(meanConfidence([])).toBe(0);
  });
});

describe("stored OCR", () => {
  let owner: any;
  let photoId: number;

  beforeEach(async () => {
    await db.delete(photoOcr);
    await db.delete(photos);
    await db.delete(users);
    owner = await createUserLogic({ email: "ocr@test.local", name: "O", password: "pw" });
    const row = await dbInsertReturning<{ id: number }>(
      db.insert(photos).values({
        user_id: owner.id,
        filename: "sign.jpg",
        original_name: "sign.jpg",
        mime_type: "image/jpeg",
        size: 1,
      }).returning({ id: photos.id }),
    );
    photoId = row!.id;
  });

  it("reports an unscanned photo as unknown rather than empty", async () => {
    expect(await getPhotoOcrLogic(photoId)).toBeNull();
  });

  it("stores the text, the geometry and the confidence", async () => {
    await storePhotoOcr(photoId, toStoredBlocks([line({ text: "Gleis 3" })]));

    const stored = await getPhotoOcrLogic(photoId);
    expect(stored?.full_text).toBe("Gleis 3");
    expect(stored?.blocks[0].polygon).toHaveLength(4);
    expect(stored?.mean_confidence).toBeCloseTo(0.92, 2);
  });

  it("records a photo without text, so it is not scanned again", async () => {
    await storePhotoOcr(photoId, []);

    const stored = await getPhotoOcrLogic(photoId);
    expect(stored).not.toBeNull();
    expect(stored?.blocks).toEqual([]);
    expect(stored?.full_text).toBe("");
  });

  it("replaces an earlier reading instead of adding a second row", async () => {
    await storePhotoOcr(photoId, toStoredBlocks([line({ text: "alt" })]));
    await storePhotoOcr(photoId, toStoredBlocks([line({ text: "neu" })]));

    const rows = await dbAll(db.select().from(photoOcr).where(eq(photoOcr.photo_id, photoId)));
    expect(rows).toHaveLength(1);
    expect((await getPhotoOcrLogic(photoId))?.full_text).toBe("neu");
  });

  it("indexes the text for full-text search", async () => {
    await storePhotoOcr(photoId, toStoredBlocks([line({ text: "Gleis 3 nach Musterstadt" })]));

    // The tsvector is maintained by the trigger from migration 0201.
    const hits = await db.execute<{ photo_id: number }>(sql`
      SELECT photo_id FROM photo_ocr
      WHERE text_tsv @@ plainto_tsquery('german', 'Musterstadt')
    `);
    expect(hits.rows.map(r => r.photo_id)).toEqual([photoId]);
  });

  it("keeps the row usable when the text is far too long to index", async () => {
    // Postgres refuses a tsvector above 1 MB of lexemes; the trigger falls
    // back to a truncated vector rather than losing the whole reading.
    const huge = "Musterstadt ".repeat(120_000);
    await storePhotoOcr(photoId, [
      { text: huge, confidence: 0.9, polygon: [], left: 0, top: 0, right: 1, bottom: 1 },
    ]);

    const stored = await getPhotoOcrLogic(photoId);
    expect(stored?.full_text.length).toBeGreaterThan(1_000_000);
  });

  it("is found by a fragment of a word on the sign", async () => {
    // A search for "bahnhof" should find the "Hauptbahnhof" on the sign —
    // which is why the search predicate is ILIKE, not the tsvector index.
    await storePhotoOcr(photoId, toStoredBlocks([line({ text: "Hauptbahnhof" })]));

    const hits = await dbAll<{ id: number }>(
      db.select({ id: photos.id }).from(photos).where(ocrTextMatches("%bahnhof%")),
    );
    expect(hits.map(h => h.id)).toEqual([photoId]);
  });

  it("is not found by a word that is not on it", async () => {
    await storePhotoOcr(photoId, toStoredBlocks([line({ text: "Hauptbahnhof" })]));

    const hits = await dbAll<{ id: number }>(
      db.select({ id: photos.id }).from(photos).where(ocrTextMatches("%flughafen%")),
    );
    expect(hits).toEqual([]);
  });

  it("disappears with the photo", async () => {
    await storePhotoOcr(photoId, toStoredBlocks([line()]));
    await db.delete(photos).where(eq(photos.id, photoId));

    const rows = await dbAll(db.select().from(photoOcr));
    expect(rows).toHaveLength(0);
  });
});
