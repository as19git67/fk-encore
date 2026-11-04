/**
 * Where the demo photos come from, without the network: the Openverse
 * search keeps only CC0/PDM results whose tags show no people, a downloaded
 * photo loses its metadata, the face check follows the photo book's rule,
 * and a drawn picture is the same for the same seed.
 */
import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { downloadPhoto, drawPhoto, faceDetectorProblem, hasRecognisableFace, MAX_EDGE, openverseProblem, searchOpenverse, usableResult, type PhotoDeps } from "./photo-sources";

function deps(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): PhotoDeps {
  return {
    fetch: (async (input: string | URL | Request, init?: RequestInit) => handler(String(input), init)) as typeof fetch,
    openverseUrl: "https://openverse.test",
    insightfaceUrl: "http://faces.test",
    searchPauseMs: 0,
  };
}

const result = (over: Record<string, unknown>) => ({
  id: "a",
  title: "Blumenbeet",
  creator: "Beispiel",
  license: "cc0",
  license_version: "1.0",
  url: "https://img.test/a.jpg",
  foreign_landing_url: "https://img.test/a",
  width: 2000,
  height: 1500,
  mature: false,
  tags: [{ name: "garden" }],
  ...over,
});

describe("openverseProblem and faceDetectorProblem", () => {
  it("say nothing when the service answers, and name the status or the network error when not", async () => {
    expect(await openverseProblem(deps(() => new Response("{}", { status: 200 })))).toBeNull();
    expect(await openverseProblem(deps(() => new Response("", { status: 403 })))).toBe("HTTP 403");
    const offline = Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } });
    expect(await openverseProblem(deps(() => { throw offline; }))).toBe("ENOTFOUND");
    expect(await faceDetectorProblem(deps(() => new Response("", { status: 503 })))).toBe("HTTP 503");
    expect(await faceDetectorProblem(deps(() => new Response("ok")))).toBeNull();
  });
});

describe("searchOpenverse", () => {
  it("asks for CC0 and PDM only and drops people, small pictures and other licences", async () => {
    let asked = "";
    const d = deps((url) => {
      asked = url;
      return Response.json({
        results: [
          result({ id: "keep" }),
          result({ id: "pdm", license: "pdm" }),
          result({ id: "by", license: "by" }),
          result({ id: "people", tags: [{ name: "garden" }, { name: "Woman" }] }),
          result({ id: "title", title: "Portrait im Garten" }),
          result({ id: "tiny", width: 640, height: 480 }),
          result({ id: "mature", mature: true }),
        ],
      });
    });
    const found = await searchOpenverse(d, "garden", 2);
    expect(found.map((c) => c.id)).toEqual(["keep", "pdm"]);
    expect(found[0]).toMatchObject({ license: "cc0", license_version: "1.0", landing_url: "https://img.test/a" });
    const params = new URL(asked).searchParams;
    expect(params.get("license")).toBe("cc0,pdm");
    expect(params.get("page")).toBe("2");
    expect(params.get("mature")).toBe("false");
  });

  it("reads the end of the results as an empty page and a server error as a failure", async () => {
    expect(await searchOpenverse(deps(() => new Response("", { status: 400 })), "beach", 11)).toEqual([]);
    await expect(searchOpenverse(deps(() => new Response("", { status: 500 })), "beach", 1)).rejects.toThrow(/500/);
  });

  it("keeps only licences that need no attribution", () => {
    expect(usableResult(result({}) as never)).toBe(true);
    expect(usableResult(result({ license: "by-sa" }) as never)).toBe(false);
  });
});

describe("downloadPhoto", () => {
  it("returns an upright JPEG no larger than the long edge, without the original's metadata", async () => {
    const original = await sharp({ create: { width: 3000, height: 2000, channels: 3, background: "#4a7" } })
      .withMetadata({ exif: { IFD0: { Make: "Original", Model: "Camera" } } })
      .jpeg()
      .toBuffer();
    const out = await downloadPhoto(deps(() => new Response(new Uint8Array(original))), "https://img.test/a.jpg");
    const meta = await sharp(out!).metadata();
    expect(Math.max(meta.width!, meta.height!)).toBe(MAX_EDGE);
    expect(meta.exif).toBeUndefined();
  });

  it("gives null for a failed or broken download", async () => {
    expect(await downloadPhoto(deps(() => new Response("", { status: 404 })), "https://img.test/x")).toBeNull();
    expect(await downloadPhoto(deps(() => new Response("not an image")), "https://img.test/x")).toBeNull();
  });
});

describe("hasRecognisableFace", () => {
  const jpeg = Buffer.from("x");
  const faces = (bboxes: number[][]) => deps(() => Response.json({ faces: bboxes.map((bbox) => ({ bbox })), width: 1000, height: 1000 }));

  it("drops a photo with a face of at least 5 % × 5 % of the frame and keeps one with tiny faces only", async () => {
    expect(await hasRecognisableFace(faces([]), jpeg)).toBe(false);
    expect(await hasRecognisableFace(faces([[0, 0, 30, 30], [500, 500, 520, 530]]), jpeg)).toBe(false);
    expect(await hasRecognisableFace(faces([[0, 0, 30, 30], [100, 100, 160, 160]]), jpeg)).toBe(true);
  });

  it("fails when the detector fails, so the photo is never taken unchecked", async () => {
    await expect(hasRecognisableFace(deps(() => new Response("", { status: 503 })), jpeg)).rejects.toThrow(/503/);
  });
});

describe("drawPhoto", () => {
  it("draws every topic as a 1600×1200 JPEG, the same for the same seed", async () => {
    const a = await drawPhoto("garden", 42);
    const meta = await sharp(a).metadata();
    expect(meta).toMatchObject({ format: "jpeg", width: 1600, height: 1200 });
    expect((await drawPhoto("garden", 42)).equals(a)).toBe(true);
    expect((await drawPhoto("garden", 43)).equals(a)).toBe(false);
    for (const topic of ["beach", "mountains", "snow", "city", "landscape", "food", "animals", "sports", "celebration", "christmas", "fireworks"] as const) {
      expect((await sharp(await drawPhoto(topic, 1)).metadata()).width).toBe(1600);
    }
  });
});
