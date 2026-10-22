import { describe, it, expect, beforeEach, vi } from "vitest";
import sharp from "sharp";
import { getAuthData } from "~encore/auth";
import { eq } from "drizzle-orm";
import db from "../db/database";
import { photos } from "../db/schema";
import { createUserLogic } from "../user/user.service";
import * as service from "./photo.service";
import {
  COLLAGE_TEXT_POSITIONS,
  captionSvg,
  collageLayouts,
  collageTakenAt,
  pickCollageLayout,
  renderCollage,
  textPlacement,
  wrapCaption,
} from "./collage";
import { createPhotoCollage } from "./collage-api";

async function solid(width: number, height: number, rgb: [number, number, number]): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: { r: rgb[0], g: rgb[1], b: rgb[2] } } }).jpeg().toBuffer();
}

async function pixel(jpeg: Buffer, x: number, y: number): Promise<number[]> {
  const { data, info } = await sharp(jpeg).raw().toBuffer({ resolveWithObject: true });
  const i = (y * info.width + x) * info.channels;
  return [data[i], data[i + 1], data[i + 2]];
}

describe("collage layouts", () => {
  it("pick the first variant unless one is named, and nothing for an unknown id", () => {
    expect(pickCollageLayout(4)?.id).toBe("grid");
    expect(pickCollageLayout(4, "hero-left")?.cells).toHaveLength(4);
    expect(pickCollageLayout(4, "grid-3x3")).toBeUndefined();
    expect(pickCollageLayout(12)).toBeUndefined();
  });
});

describe("caption", () => {
  it("places edges, corners and the middle", () => {
    expect(textPlacement("center")).toEqual({ align: "center", vertical: "middle" });
    expect(textPlacement("left")).toEqual({ align: "left", vertical: "middle" });
    expect(textPlacement("top")).toEqual({ align: "center", vertical: "top" });
    expect(textPlacement("bottom-right")).toEqual({ align: "right", vertical: "bottom" });
    expect(COLLAGE_TEXT_POSITIONS).toHaveLength(9);
  });

  it("wraps at word boundaries and keeps explicit line breaks", () => {
    expect(wrapCaption("Sommer am See mit allen", 10)).toEqual(["Sommer am", "See mit", "allen"]);
    expect(wrapCaption("Eins\nZwei", 40)).toEqual(["Eins", "Zwei"]);
  });

  it("escapes the text for the SVG", () => {
    const svg = captionSvg(1000, 500, { text: "A & B <C>", position: "top-left", size: "small", color: "#ffffff" });
    expect(svg).toContain("A &amp; B &lt;C&gt;");
    expect(svg).toContain('text-anchor="start"');
  });
});

describe("renderCollage", () => {
  it("fills each cell with its photo, keeps a white gap and draws the caption where asked", async () => {
    const layout = pickCollageLayout(2, "side")!;
    const red = await solid(300, 200, [220, 20, 20]);
    const blue = await solid(200, 300, [20, 20, 220]);
    const plain = await renderCollage(layout, [{ input: red }, { input: blue }], null, 600);
    const meta = await sharp(plain).metadata();
    expect([meta.width, meta.height]).toEqual([600, 400]);
    const left = await pixel(plain, 150, 200);
    const right = await pixel(plain, 450, 200);
    expect(left[0]).toBeGreaterThan(180);
    expect(right[2]).toBeGreaterThan(180);
    const gap = await pixel(plain, 300, 200);
    expect(Math.min(...gap)).toBeGreaterThan(200);

    // A large caption at the bottom changes pixels there and nowhere near the top.
    const captioned = await renderCollage(layout, [{ input: red }, { input: blue }], {
      text: "IIIIIIIIII", position: "bottom", size: "large", color: "#00ff00",
    }, 600);
    const { data: a } = await sharp(plain).raw().toBuffer({ resolveWithObject: true });
    const { data: b } = await sharp(captioned).raw().toBuffer({ resolveWithObject: true });
    const changedRows = new Set<number>();
    for (let i = 0; i < a.length; i += 3) {
      if (Math.abs(a[i + 1] - b[i + 1]) > 60) changedRows.add(Math.floor(i / 3 / 600));
    }
    expect(changedRows.size).toBeGreaterThan(0);
    expect(Math.min(...changedRows)).toBeGreaterThan(200);
  });

  it("refuses a layout whose cells do not match the photos", async () => {
    await expect(renderCollage(pickCollageLayout(3)!, [{ input: await solid(10, 10, [0, 0, 0]) }], null, 100)).rejects.toThrow(/3 cells/);
  });
});

describe("collageTakenAt", () => {
  it("is one second after the newest source", () => {
    expect(collageTakenAt(["2025-07-01T10:00:00.000Z", null, "2025-07-02T23:59:59.000Z"])).toBe("2025-07-03T00:00:00.000Z");
    expect(collageTakenAt([null, undefined])).toBeNull();
  });
});

describe("POST /photos/collage", () => {
  let owner: { id: number };
  let stranger: { id: number };
  let ids: number[];

  beforeEach(async () => {
    const run = Math.random().toString(36).slice(2, 8);
    owner = await createUserLogic({ email: `collage-owner-${run}@test.local`, name: "O", password: "pw" });
    stranger = await createUserLogic({ email: `collage-stranger-${run}@test.local`, name: "S", password: "pw" });
    ids = [];
    const colors: [number, number, number][] = [[200, 0, 0], [0, 200, 0], [0, 0, 200]];
    for (const [i, c] of colors.entries()) {
      const p = await service.uploadPhotoLogic(
        owner.id,
        { data: await solid(120, 80, c), name: `p${i}.jpg`, mimeType: "image/jpeg" },
        `2025-06-0${i + 1}T12:00:00`,
      );
      ids.push(p.id);
    }
    vi.mocked(getAuthData).mockReturnValue({ userID: String(owner.id), permissions: ["module.photos", "photos.view", "photos.upload"] });
  });

  it("files the collage as a new photo of the caller, dated after its sources", async () => {
    const res = await (createPhotoCollage as any)({ photoIds: ids, layout: "hero-top", text: "Sommer", textPosition: "top-left" });
    expect(res.created).toBe(true);
    expect(res.layout).toBe("hero-top");
    const [row] = await db.select().from(photos).where(eq(photos.id, res.photoId));
    expect(row.user_id).toBe(owner.id);
    expect(row.mime_type).toBe("image/jpeg");
    expect(row.taken_at).toMatch(/^2025-06-03[T ]12:00:01/);

    const again = await (createPhotoCollage as any)({ photoIds: ids, layout: "hero-top", text: "Sommer", textPosition: "top-left" });
    expect(again).toMatchObject({ photoId: res.photoId, created: false });
  });

  it("refuses photos the caller may not see, wrong counts and unknown layouts", async () => {
    await expect((createPhotoCollage as any)({ photoIds: [ids[0]] })).rejects.toThrow(/2 to 9/);
    await expect((createPhotoCollage as any)({ photoIds: ids, layout: "grid-3x3" })).rejects.toThrow(/unknown layout/);
    await expect((createPhotoCollage as any)({ photoIds: ids, text: "x", textPosition: "somewhere" })).rejects.toThrow(/text position/);
    vi.mocked(getAuthData).mockReturnValue({ userID: String(stranger.id), permissions: ["module.photos", "photos.view", "photos.upload"] });
    await expect((createPhotoCollage as any)({ photoIds: ids })).rejects.toThrow(/not found/);
  });

  it("needs the upload right", async () => {
    vi.mocked(getAuthData).mockReturnValue({ userID: String(owner.id), permissions: ["module.photos", "photos.view"] });
    await expect((createPhotoCollage as any)({ photoIds: ids })).rejects.toThrow();
  });
});
