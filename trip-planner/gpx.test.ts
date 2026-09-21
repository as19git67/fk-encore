import { describe, expect, it } from "vitest";
import { buildGpx, EmptyTrackError, gpxFilename } from "./gpx";

const TIME = new Date("2026-05-01T08:00:00.000Z");

/** A short way with a bend in it; every place is invented. */
const PARTS = [[
  { lat: 45.881234, lon: 10.841111 },
  { lat: 45.885000, lon: 10.845000 },
  { lat: 45.890000, lon: 10.843000 },
]];

function gpx(overrides: Record<string, unknown> = {}): string {
  return buildGpx({
    name: "Serpentinenweg Beispiel",
    kind: "hiking",
    parts: PARTS,
    lengthM: 8_200,
    ascentM: 600,
    osmRef: "relation:1",
    ref: "B7",
    network: "lwn",
    time: TIME,
    ...overrides,
  });
}

describe("what the file says it is", () => {
  it("writes a track, never a route", () => {
    // The distinction is the whole point: a <rte> invites the reading
    // app to compute its own way between the points, which for a
    // signposted way means offering a different one.
    const out = gpx();
    expect(out).toContain("<trk>");
    expect(out).toContain("<trkseg>");
    expect(out).not.toContain("<rte>");
    expect(out).not.toContain("<rtept");
  });

  it("carries the name, the type and the numbers that are known", () => {
    const out = gpx();
    expect(out).toContain("<name>Serpentinenweg Beispiel</name>");
    expect(out).toContain("<type>hiking</type>");
    expect(out).toContain("B7");
    expect(out).toContain("LWN");
    expect(out).toContain("8,2 km");
    expect(out).toContain("600 Hm Anstieg");
    expect(out).toContain("OSM relation:1");
  });

  it("says nothing about what it does not know", () => {
    const out = gpx({ lengthM: null, ascentM: null, ref: null, network: null });
    expect(out).not.toContain("Hm Anstieg");
    expect(out).not.toContain("km<");
    // And no empty separators left behind where the numbers were.
    expect(out).not.toContain("· ·");
  });

  it("credits OpenStreetMap, because the data is theirs", () => {
    expect(gpx()).toContain("OpenStreetMap");
    expect(gpx()).toContain("ODbL");
  });

  it("writes no elevation, having none per point", () => {
    // The relation's `ascent` is one number for the whole way. An
    // <ele> per point would be a profile we invented (§15.3).
    expect(gpx()).not.toContain("<ele>");
  });
});

describe("the course itself", () => {
  it("writes every point, in order", () => {
    const out = gpx();
    const points = [...out.matchAll(/<trkpt lat="([\d.-]+)" lon="([\d.-]+)"/g)];
    expect(points).toHaveLength(3);
    expect(points[0][1]).toBe("45.881234");
    expect(points[0][2]).toBe("10.841111");
    expect(points[2][1]).toBe("45.890000");
  });

  it("keeps a gap as a gap", () => {
    // Two segments rather than one line drawn straight across the
    // hole: the second would be a way nobody can walk, presented as a
    // signposted one.
    const out = gpx({
      parts: [
        [{ lat: 45.88, lon: 10.84 }, { lat: 45.89, lon: 10.84 }],
        [{ lat: 45.91, lon: 10.84 }, { lat: 45.92, lon: 10.84 }],
      ],
    });
    expect([...out.matchAll(/<trkseg>/g)]).toHaveLength(2);
    expect([...out.matchAll(/<trk>/g)]).toHaveLength(1);
    expect(out).toContain("Lücken");
  });

  it("drops a part that is a single point", () => {
    const out = gpx({
      parts: [[{ lat: 45.88, lon: 10.84 }], PARTS[0]],
    });
    expect([...out.matchAll(/<trkseg>/g)]).toHaveLength(1);
  });

  it("refuses to write a file with nothing in it", () => {
    // A zero-point track imports as an empty tour, which looks like
    // the export worked. Being told there is nothing is better.
    expect(() => gpx({ parts: [] })).toThrow(EmptyTrackError);
    expect(() => gpx({ parts: [[{ lat: 45.88, lon: 10.84 }]] })).toThrow(EmptyTrackError);
  });
});

describe("names from the map", () => {
  it("escapes what a mapper typed", () => {
    // One unescaped ampersand makes the whole file unreadable to the
    // app it was exported for.
    const out = gpx({ name: "Weg <A> & \"B\"", website: "https://beispiel.test/?a=1&b=2" });
    expect(out).toContain("Weg &lt;A&gt; &amp; &quot;B&quot;");
    expect(out).toContain("a=1&amp;b=2");
    expect(out).not.toMatch(/&(?!amp;|lt;|gt;|quot;|apos;)/);
  });

  it("makes a file name somebody can find again", () => {
    expect(gpxFilename("Serpentinenweg Beispiel")).toBe("serpentinenweg-beispiel.gpx");
    expect(gpxFilename("Kösseine — Große Runde")).toBe("kosseine-grosse-runde.gpx");
    expect(gpxFilename("  ")).toBe("strecke.gpx");
    expect(gpxFilename("///")).toBe("strecke.gpx");
  });

  it("keeps the file name short enough to be one", () => {
    const long = gpxFilename("Weg ".repeat(60));
    expect(long.length).toBeLessThanOrEqual(84);
    expect(long.endsWith(".gpx")).toBe(true);
  });
});
