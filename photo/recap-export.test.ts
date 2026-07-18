import { afterAll, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import sharp from "sharp";
import {
  RECAPS_EXPORT_DIR,
  buildExportFilterGraph,
  coverCrop,
  exportDurationSeconds,
  exportFileName,
  isFfmpegAvailable,
  resolveExportFilePath,
  startExport,
  getExportJob,
  renderTitleCard,
  SLIDE_SECONDS,
  FADE_SECONDS,
  EXPORT_WIDTH,
  EXPORT_HEIGHT,
} from "./recap-export.service";

describe("coverCrop", () => {
  it("crops a landscape image to 16:9 centred by default", () => {
    const crop = coverCrop(4000, 3000, 16 / 9);
    expect(crop.width).toBe(4000);
    expect(crop.height).toBe(2250);
    expect(crop.left).toBe(0);
    expect(crop.top).toBe(375);
  });

  it("keeps the focal point at the edge when focal is 0/1", () => {
    const top = coverCrop(4000, 3000, 16 / 9, { x: 0.5, y: 0 });
    expect(top.top).toBe(0);
    const bottom = coverCrop(4000, 3000, 16 / 9, { x: 0.5, y: 1 });
    expect(bottom.top).toBe(750);
  });

  it("keeps full width and crops vertically for portrait sources", () => {
    const crop = coverCrop(3000, 4000, 16 / 9, { x: 0.5, y: 0 });
    expect(crop.width).toBe(3000);
    expect(crop.height).toBe(Math.round(3000 / (16 / 9)));
    expect(crop.top).toBe(0);
  });

  it("clamps invalid focal values to the centre", () => {
    const crop = coverCrop(4000, 3000, 16 / 9, { x: Number.NaN, y: 5 });
    expect(crop.top).toBe(750); // y clamped to 1 → bottom
  });
});

describe("exportDurationSeconds", () => {
  it("accounts for overlapping crossfades", () => {
    expect(exportDurationSeconds(1)).toBeCloseTo(SLIDE_SECONDS);
    expect(exportDurationSeconds(3)).toBeCloseTo(
      3 * SLIDE_SECONDS - 2 * FADE_SECONDS
    );
    expect(exportDurationSeconds(0)).toBe(0);
  });
});

describe("buildExportFilterGraph", () => {
  it("chains zoompan and xfade for multiple slides", () => {
    const g = buildExportFilterGraph({
      count: 3,
      zoomIn: [true, false, true],
      withAudio: true,
    });
    expect(g.videoLabel).toBe("[vout]");
    expect(g.audioLabel).toBe("[aout]");
    expect(g.filter).toContain("[0:v]zoompan");
    expect(g.filter).toContain("[2:v]zoompan");
    expect(g.filter).toContain("xfade=transition=fade");
    // Audio is input index 3 (after the 3 frames).
    expect(g.filter).toContain("[3:a]atrim");
    expect(g.duration).toBeCloseTo(exportDurationSeconds(3));
  });

  it("handles a single slide without xfade and without audio", () => {
    const g = buildExportFilterGraph({ count: 1, zoomIn: [true], withAudio: false });
    expect(g.videoLabel).toBe("[v0]");
    expect(g.audioLabel).toBeNull();
    expect(g.filter).not.toContain("xfade");
  });

  it("applies z=1 for static indices (title card)", () => {
    const g = buildExportFilterGraph({
      count: 3,
      zoomIn: [false, true, false],
      withAudio: false,
      staticIndices: new Set([0]),
    });
    expect(g.filter).toMatch(/\[0:v\]zoompan=z='1'/);
    expect(g.filter).not.toMatch(/\[1:v\]zoompan=z='1'/);
  });

  it("respects per-slide durations in total duration", () => {
    const g = buildExportFilterGraph({
      count: 3,
      zoomIn: [false, true, false],
      withAudio: false,
      slideDurations: [4, 3.5, 3.5],
      fadeSeconds: 0.6,
    });
    // 4 + 3.5 + 3.5 - 2*0.6 = 9.8
    expect(g.duration).toBeCloseTo(9.8);
  });
});

describe("exportFileName / resolveExportFilePath", () => {
  it("changes the name when the photo set changes", () => {
    const a = exportFileName(5, [1, 2, 3], "Rom");
    const b = exportFileName(5, [1, 2, 4], "Rom");
    expect(a).not.toBe(b);
    expect(a).toMatch(/^recap-5-[0-9a-f]{20}\.mp4$/);
  });

  it("rejects traversal and foreign names", async () => {
    expect(await resolveExportFilePath("../etc/passwd")).toBeNull();
    expect(await resolveExportFilePath("recap-1-zzzz.mp4")).toBeNull();
    expect(await resolveExportFilePath("recap-1-0123456789abcdef0123.mp4")).toBeNull();
  });
});

describe("renderTitleCard", () => {
  it("produces a JPEG at the expected dimensions", async () => {
    const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "title-card-"));
    const out = path.join(tmp, "title.jpg");
    await renderTitleCard("Sommerurlaub 2024", "Mallorca — 42 Fotos", out);
    const meta = await sharp(out).metadata();
    expect(meta.format).toBe("jpeg");
    expect(meta.width).toBe(2560);
    expect(meta.height).toBe(1440);
    await fs.promises.rm(tmp, { recursive: true, force: true });
  });

  it("handles title without subtitle", async () => {
    const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "title-card-"));
    const out = path.join(tmp, "title.jpg");
    await renderTitleCard("Kurztrip", null, out);
    const stat = await fs.promises.stat(out);
    expect(stat.size).toBeGreaterThan(1000);
    await fs.promises.rm(tmp, { recursive: true, force: true });
  });

  it("renders non-Latin scripts without throwing (glyph coverage is a Docker-image font concern, not this pipeline's)", async () => {
    const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "title-card-"));
    const out = path.join(tmp, "title.jpg");
    await renderTitleCard("東京旅行 2024", "日本 — 家族旅行", out);
    const meta = await sharp(out).metadata();
    expect(meta.format).toBe("jpeg");
    expect(meta.width).toBe(2560);
    await fs.promises.rm(tmp, { recursive: true, force: true });
  });
});

// Real end-to-end render. Skipped when ffmpeg is not installed (e.g. CI).
const ffmpeg = await isFfmpegAvailable();

describe("startExport (ffmpeg)", () => {
  afterAll(async () => {
    await fs.promises.rm(RECAPS_EXPORT_DIR, { recursive: true, force: true }).catch(() => {});
  });

  it.skipIf(!ffmpeg)(
    "renders a small MP4 from two photos",
    async () => {
      const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "recap-export-src-"));
      const mkPhoto = async (name: string, color: { r: number; g: number; b: number }) => {
        const p = path.join(tmp, name);
        await sharp({
          create: { width: 640, height: 480, channels: 3, background: color },
        })
          .jpeg()
          .toFile(p);
        return p;
      };
      const p1 = await mkPhoto("a.jpg", { r: 200, g: 40, b: 40 });
      const p2 = await mkPhoto("b.jpg", { r: 40, g: 40, b: 200 });

      const job = await startExport({
        userId: 1,
        recapId: 999_999,
        title: "Test",
        subtitle: "Subtitle",
        photos: [
          { id: 2, filePath: p1, focal: { x: 0.5, y: 0.5 } },
          { id: 3, filePath: p2 },
        ],
        musicFilePath: null,
      });
      expect(["running", "done"]).toContain(job.status);

      // Poll until the background job settles (encode of 2 slides is quick).
      const deadline = Date.now() + 120_000;
      let st = getExportJob(1, 999_999);
      while (st && st.status === "running" && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 500));
        st = getExportJob(1, 999_999);
      }
      expect(st?.status).toBe("done");
      expect(st?.file).toBeDefined();
      const rendered = await resolveExportFilePath(st!.file!);
      expect(rendered).not.toBeNull();
      const stat = await fs.promises.stat(rendered!);
      expect(stat.size).toBeGreaterThan(10_000);

      await fs.promises.rm(tmp, { recursive: true, force: true });
    },
    150_000
  );
});
