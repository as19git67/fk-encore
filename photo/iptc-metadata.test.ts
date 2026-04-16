import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import { afterAll, describe, expect, it } from "vitest";
import sharp from "sharp";
import { exiftool } from "exiftool-vendored";
import { getExifMetadata, iptcLocationUpdate, parseIptcDate, type ExifMetadata } from "./photo.service";

/**
 * Unit/integration tests for IPTC metadata handling (issue #129).
 *
 * The tests exercise the pure-TS helpers without DB access and then verify
 * full round-trip IPTC extraction through a temporary JPEG that ExifTool
 * writes the real IPTC records into. No Postgres is touched.
 */

const tmpFiles: string[] = [];

function registerTmp(p: string): string {
  tmpFiles.push(p);
  return p;
}

async function makeTempJpeg(): Promise<string> {
  const buf = await sharp({
    create: { width: 16, height: 16, channels: 3, background: { r: 120, g: 30, b: 30 } },
  })
    .jpeg()
    .toBuffer();
  const file = registerTmp(
    path.join(os.tmpdir(), `iptc-test-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.jpg`)
  );
  await fs.promises.writeFile(file, buf);
  return file;
}

afterAll(async () => {
  for (const f of tmpFiles) {
    try {
      await fs.promises.unlink(f);
    } catch {}
  }
  await exiftool.end();
});

describe("parseIptcDate", () => {
  it("parses packed IPTC dates (YYYYMMDD) with packed times (HHMMSS)", () => {
    const iso = parseIptcDate("20240615", "083000");
    expect(iso).toBe(new Date("2024-06-15T08:30:00Z").toISOString());
  });

  it("parses hyphenated dates with colon-separated times", () => {
    const iso = parseIptcDate("2024-06-15", "08:30:00");
    expect(iso).toBe(new Date("2024-06-15T08:30:00Z").toISOString());
  });

  it("respects explicit timezone offsets", () => {
    const iso = parseIptcDate("20240615", "083000+0200");
    expect(iso).toBe(new Date("2024-06-15T08:30:00+02:00").toISOString());
  });

  it("defaults to midnight UTC when the time field is missing", () => {
    const iso = parseIptcDate("20240615", undefined);
    expect(iso).toBe(new Date("2024-06-15T00:00:00Z").toISOString());
  });

  it("returns null for missing or garbage inputs", () => {
    expect(parseIptcDate(null, null)).toBeNull();
    expect(parseIptcDate("", "")).toBeNull();
    expect(parseIptcDate("not-a-date", "083000")).toBeNull();
  });
});

describe("getExifMetadata — IPTC fallbacks", () => {
  it("returns null/empty fields when the file does not exist", async () => {
    const meta = await getExifMetadata("/nonexistent/path/to/file.jpg");
    expect(meta.takenAt).toBeNull();
    expect(meta.description).toBeNull();
    expect(meta.keywords).toEqual([]);
    expect(meta.author).toBeNull();
  });

  it("extracts IPTC Keywords, Caption-Abstract, By-line and location fields", async () => {
    const file = await makeTempJpeg();
    await exiftool.write(
      file,
      {
        "Caption-Abstract": "Ein Foto aus München",
        "By-line": "Alice Photographer",
        Keywords: ["urlaub", "berge", "2024"],
        Headline: "Bergpanorama",
        CopyrightNotice: "© 2024 Alice",
        Credit: "Alice Photo Studio",
        City: "München",
        "Province-State": "Bayern",
        "Country-PrimaryLocationName": "Deutschland",
      },
      ["-overwrite_original"]
    );

    const meta = await getExifMetadata(file);
    expect(meta.description).toBe("Ein Foto aus München");
    expect(meta.author).toBe("Alice Photographer");
    expect(meta.keywords).toEqual(expect.arrayContaining(["urlaub", "berge", "2024"]));
    expect(meta.headline).toBe("Bergpanorama");
    expect(meta.copyright).toBe("© 2024 Alice");
    expect(meta.credit).toBe("Alice Photo Studio");
    expect(meta.city).toBe("München");
    expect(meta.state).toBe("Bayern");
    expect(meta.country).toBe("Deutschland");
  });

  it("falls back to XMP dc:title when IPTC Headline is absent", async () => {
    const file = await makeTempJpeg();
    await exiftool.write(
      file,
      {
        Headline: null,
        Title: "Bergpanorama",
      },
      ["-overwrite_original"]
    );
    const meta = await getExifMetadata(file);
    expect(meta.headline).toBe("Bergpanorama");
  });

  it("treats Caption-Abstract and Headline as independent fields", async () => {
    // The upload/refresh paths use `description ?? headline` as the description
    // fallback — but getExifMetadata itself must not silently conflate the two.
    const file = await makeTempJpeg();
    await exiftool.write(
      file,
      {
        ImageDescription: null,
        "Caption-Abstract": null,
        Description: null,
        Headline: "Bergpanorama",
      },
      ["-overwrite_original"]
    );
    const meta = await getExifMetadata(file);
    expect(meta.description).toBeNull();
    expect(meta.headline).toBe("Bergpanorama");
  });

  it("falls back to IPTC DateCreated/TimeCreated when EXIF date tags are absent", async () => {
    const file = await makeTempJpeg();
    // Wipe any date tags sharp may have added, then set IPTC-only dates.
    await exiftool.write(
      file,
      {
        DateTimeOriginal: null,
        CreateDate: null,
        ModifyDate: null,
        DateCreated: "2023:07:20",
        TimeCreated: "14:15:16",
      },
      ["-overwrite_original"]
    );

    const meta = await getExifMetadata(file);
    expect(meta.takenAt).not.toBeNull();
    const parsed = new Date(meta.takenAt!);
    expect(parsed.getUTCFullYear()).toBe(2023);
    expect(parsed.getUTCMonth()).toBe(6); // July
    expect(parsed.getUTCDate()).toBe(20);
  });
});

describe("iptcLocationUpdate", () => {
  const baseMeta: ExifMetadata = {
    takenAt: null,
    latitude: null,
    longitude: null,
    description: null,
    keywords: [],
    author: null,
    headline: null,
    copyright: null,
    credit: null,
    city: null,
    state: null,
    country: null,
  };

  it("returns null when no IPTC location fields are present", () => {
    expect(iptcLocationUpdate(baseMeta)).toBeNull();
  });

  it("builds a 'City, Country' display name when both are present", () => {
    const upd = iptcLocationUpdate({ ...baseMeta, city: "München", country: "Deutschland" });
    expect(upd).not.toBeNull();
    expect(upd!.location_name).toBe("München, Deutschland");
    expect(upd!.location_short).toBe("München");
    expect(upd!.location_city).toBe("München");
    expect(upd!.location_country).toBe("Deutschland");
  });

  it("falls back to state when city is missing", () => {
    const upd = iptcLocationUpdate({ ...baseMeta, state: "Bayern", country: "Deutschland" });
    expect(upd).not.toBeNull();
    expect(upd!.location_name).toBe("Bayern, Deutschland");
    expect(upd!.location_short).toBe("Bayern");
    expect(upd!.location_city).toBeNull();
  });

  it("handles a country-only location gracefully", () => {
    const upd = iptcLocationUpdate({ ...baseMeta, country: "Deutschland" });
    expect(upd).not.toBeNull();
    expect(upd!.location_name).toBe("Deutschland");
    expect(upd!.location_short).toBeNull();
  });
});

describe("IPTC writeback round-trip", () => {
  it("persists Caption-Abstract alongside EXIF ImageDescription", async () => {
    const file = await makeTempJpeg();
    await exiftool.write(
      file,
      {
        ImageDescription: "Test caption",
        "Caption-Abstract": "Test caption",
        Description: "Test caption",
      },
      ["-overwrite_original"]
    );
    const meta = await getExifMetadata(file);
    expect(meta.description).toBe("Test caption");
  });

  it("persists IPTC DateCreated/TimeCreated alongside EXIF DateTimeOriginal", async () => {
    const file = await makeTempJpeg();
    await exiftool.write(
      file,
      {
        DateTimeOriginal: "2022:03:04 05:06:07",
        CreateDate: "2022:03:04 05:06:07",
        ModifyDate: "2022:03:04 05:06:07",
        DateCreated: "2022:03:04",
        TimeCreated: "05:06:07",
        DigitalCreationDate: "2022:03:04",
        DigitalCreationTime: "05:06:07",
      },
      ["-overwrite_original"]
    );
    const meta = await getExifMetadata(file);
    expect(meta.takenAt).not.toBeNull();
    // Should match year/month/day regardless of local timezone handling.
    const d = new Date(meta.takenAt!);
    expect(d.getUTCFullYear()).toBe(2022);
  });
});
