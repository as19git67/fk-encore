import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import { afterAll, describe, expect, it } from "vitest";
import sharp from "sharp";
import { exiftool } from "exiftool-vendored";
import {
  combineDescription,
  extractDateFromFilename,
  getExifMetadata,
  iptcLocationUpdate,
  mergeRatingKeyword,
  parseIptcDate,
  parseXmpRating,
  ratingKeyword,
  type ExifMetadata,
} from "./photo.service";

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

  it("extracts XMP dc:title into its own `title` field", async () => {
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
    expect(meta.title).toBe("Bergpanorama");
    expect(meta.headline).toBeNull();
  });

  it("treats Caption-Abstract and Headline as independent fields", async () => {
    // combineDescription() uses `description ?? headline` as the description
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

  it("recovers UTF-8 IPTC strings that exifr decoded as Latin-1", async () => {
    // Write IPTC with `CodedCharacterSet=UTF8` so exiftool stores `ü` as the
    // two-byte UTF-8 sequence 0xC3 0xBC. exifr's IPTC parser uses
    // `getLatin1String()` unconditionally and returns "MÃ¼nchen" / "BrÃ¼ssel"
    // for these bytes; the producer-boundary repair in `asString()` must
    // recover the original strings. If this test regresses, every IPTC
    // consumer downstream (recap grouping, search, UI) starts seeing
    // mojibake again.
    const file = await makeTempJpeg();
    await exiftool.write(
      file,
      {
        CodedCharacterSet: "UTF8",
        "Caption-Abstract": "Ein Foto aus München",
        "By-line": "Jörg Müller",
        Keywords: ["reise", "brüssel", "café"],
        Headline: "Über den Dächern",
        City: "Brüssel",
        "Province-State": "Brüssel-Hauptstadt",
        "Country-PrimaryLocationName": "Belgien",
      },
      ["-overwrite_original"]
    );
    const meta = await getExifMetadata(file);
    expect(meta.description).toBe("Ein Foto aus München");
    expect(meta.author).toBe("Jörg Müller");
    expect(meta.headline).toBe("Über den Dächern");
    expect(meta.city).toBe("Brüssel");
    expect(meta.state).toBe("Brüssel-Hauptstadt");
    expect(meta.country).toBe("Belgien");
    expect(meta.keywords).toEqual(
      expect.arrayContaining(["reise", "brüssel", "café"]),
    );
    // None of the mojibake "Ã" / "Â" artefacts should survive.
    for (const v of [meta.description, meta.author, meta.headline, meta.city, meta.state, meta.country]) {
      expect(v).not.toMatch(/[ÂÃ][-¿]/);
    }
    for (const kw of meta.keywords) {
      expect(kw).not.toMatch(/[ÂÃ][-¿]/);
    }
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
    title: null,
    copyright: null,
    credit: null,
    city: null,
    state: null,
    country: null,
    rating: null,
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

describe("combineDescription", () => {
  const baseMeta: ExifMetadata = {
    takenAt: null,
    latitude: null,
    longitude: null,
    description: null,
    keywords: [],
    author: null,
    headline: null,
    title: null,
    copyright: null,
    credit: null,
    city: null,
    state: null,
    country: null,
    rating: null,
  };

  it("returns null when nothing is set", () => {
    expect(combineDescription(baseMeta)).toBeNull();
  });

  it("returns the description alone when no title is present", () => {
    expect(combineDescription({ ...baseMeta, description: "Foto aus München" }))
      .toBe("Foto aus München");
  });

  it("falls back to headline when description is absent", () => {
    expect(combineDescription({ ...baseMeta, headline: "Bergpanorama" }))
      .toBe("Bergpanorama");
  });

  it("returns the title alone when only title is present", () => {
    expect(combineDescription({ ...baseMeta, title: "Bergpanorama" }))
      .toBe("Bergpanorama");
  });

  it("appends title to description with a blank line in between", () => {
    expect(combineDescription({ ...baseMeta, description: "Foto aus München", title: "Bergpanorama" }))
      .toBe("Foto aus München\n\nBergpanorama");
  });

  it("skips the title when it is already contained in the description", () => {
    expect(combineDescription({ ...baseMeta, description: "Bergpanorama — Foto aus München", title: "Bergpanorama" }))
      .toBe("Bergpanorama — Foto aus München");
  });
});

describe("parseXmpRating", () => {
  it("accepts integer star ratings 1..5", () => {
    expect(parseXmpRating(1)).toBe(1);
    expect(parseXmpRating(5)).toBe(5);
  });

  it("accepts stringified numbers written by some encoders", () => {
    expect(parseXmpRating("3")).toBe(3);
    expect(parseXmpRating(" 4 ")).toBe(4);
  });

  it("rounds fractional ratings to the nearest whole star", () => {
    expect(parseXmpRating(3.4)).toBe(3);
    expect(parseXmpRating(3.6)).toBe(4);
  });

  it("treats 0 (unrated) and -1 (rejected) as 'no rating'", () => {
    expect(parseXmpRating(0)).toBeNull();
    expect(parseXmpRating(-1)).toBeNull();
  });

  it("rejects out-of-range and garbage values", () => {
    expect(parseXmpRating(6)).toBeNull();
    expect(parseXmpRating("hi")).toBeNull();
    expect(parseXmpRating(null)).toBeNull();
    expect(parseXmpRating(undefined)).toBeNull();
  });
});

describe("ratingKeyword / mergeRatingKeyword", () => {
  it("builds the 'Rating-N' label for valid star counts only", () => {
    expect(ratingKeyword(3)).toBe("Rating-3");
    expect(ratingKeyword(null)).toBeNull();
    expect(ratingKeyword(0)).toBeNull();
    expect(ratingKeyword(6)).toBeNull();
  });

  it("appends the derived tag to the existing keyword list", () => {
    expect(mergeRatingKeyword(["urlaub"], 4)).toEqual(["urlaub", "Rating-4"]);
  });

  it("leaves the list untouched when no rating is present", () => {
    const kw = ["urlaub"];
    expect(mergeRatingKeyword(kw, null)).toBe(kw);
  });

  it("de-duplicates case-insensitively so re-imports stay stable", () => {
    expect(mergeRatingKeyword(["urlaub", "rating-4"], 4)).toEqual(["urlaub", "rating-4"]);
  });
});

describe("getExifMetadata — XMP rating", () => {
  it("reads xmp:Rating and exposes it as an integer", async () => {
    const file = await makeTempJpeg();
    await exiftool.write(file, { Rating: 4 }, ["-overwrite_original"]);
    const meta = await getExifMetadata(file);
    expect(meta.rating).toBe(4);
  });

  it("returns null when no rating tag is present", async () => {
    const file = await makeTempJpeg();
    const meta = await getExifMetadata(file);
    expect(meta.rating).toBeNull();
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

describe("extractDateFromFilename", () => {
  it("parses ISO-like YYYY-MM-DD", () => {
    const r = extractDateFromFilename("2023-12-25_photo.jpg");
    expect(r).not.toBeNull();
    const d = new Date(r!);
    expect(d.getUTCFullYear()).toBe(2023);
    expect(d.getUTCMonth() + 1).toBe(12);
    expect(d.getUTCDate()).toBe(25);
  });

  it("parses underscore-separated YYYY_MM_DD", () => {
    const r = extractDateFromFilename("photo_2021_06_15.jpg");
    expect(r).not.toBeNull();
    const d = new Date(r!);
    expect(d.getUTCFullYear()).toBe(2021);
    expect(d.getUTCMonth() + 1).toBe(6);
    expect(d.getUTCDate()).toBe(15);
  });

  it("parses compact YYYYMMDD in IMG_20231225_143022", () => {
    const r = extractDateFromFilename("IMG_20231225_143022.jpg");
    expect(r).not.toBeNull();
    const d = new Date(r!);
    expect(d.getUTCFullYear()).toBe(2023);
    expect(d.getUTCMonth() + 1).toBe(12);
    expect(d.getUTCDate()).toBe(25);
  });

  it("parses WhatsApp-style IMG-20231225-WA0001", () => {
    const r = extractDateFromFilename("IMG-20231225-WA0001.jpg");
    expect(r).not.toBeNull();
    const d = new Date(r!);
    expect(d.getUTCFullYear()).toBe(2023);
    expect(d.getUTCMonth() + 1).toBe(12);
    expect(d.getUTCDate()).toBe(25);
  });

  it("returns null for generic names without dates", () => {
    expect(extractDateFromFilename("IMG_1234.jpg")).toBeNull();
    expect(extractDateFromFilename("photo.jpg")).toBeNull();
    expect(extractDateFromFilename("DSC00123.jpg")).toBeNull();
  });

  it("returns null for implausible month/day", () => {
    expect(extractDateFromFilename("20231399.jpg")).toBeNull();
  });
});
