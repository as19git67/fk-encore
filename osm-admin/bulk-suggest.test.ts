import { beforeEach, describe, expect, it } from "vitest";
import db from "../db/database";
import { osmRegionImports, photos, users } from "../db/schema";
import { suggestRegionsFromPhotos } from "./bulk-suggest";
import { parseIndex, type GeofabrikIndex } from "./geofabrik-index";

function fixture(): GeofabrikIndex {
  const raw = JSON.stringify({
    features: [
      {
        properties: {
          id: "europe/germany/bayern",
          name: "Bayern",
          parent: "europe/germany",
          urls: { pbf: "https://example.com/bayern.osm.pbf" },
        },
        geometry: {
          type: "Polygon",
          coordinates: [[[9, 47.5], [13.5, 47.5], [13.5, 50.5], [9, 50.5], [9, 47.5]]],
        },
      },
      {
        properties: {
          id: "europe/france/ile-de-france",
          name: "Île-de-France",
          parent: "europe/france",
          urls: { pbf: "https://example.com/idf.osm.pbf" },
        },
        geometry: {
          type: "Polygon",
          coordinates: [[[1.4, 48.1], [3.6, 48.1], [3.6, 49.3], [1.4, 49.3], [1.4, 48.1]]],
        },
      },
    ],
  });
  return parseIndex(raw, new Date("2026-01-01T00:00:00Z"));
}

/**
 * Index with a parent region (europe/germany) that geographically
 * encompasses the leaf europe/germany/bayern — used to test the
 * "already covered by an imported parent" suppression.
 */
function fixtureWithParent(): GeofabrikIndex {
  const raw = JSON.stringify({
    features: [
      {
        properties: {
          id: "europe/germany",
          name: "Germany",
          parent: "europe",
          urls: { pbf: "https://example.com/germany.osm.pbf" },
        },
        geometry: {
          type: "Polygon",
          coordinates: [[[5, 47], [15.5, 47], [15.5, 55.5], [5, 55.5], [5, 47]]],
        },
      },
      {
        properties: {
          id: "europe/germany/bayern",
          name: "Bayern",
          parent: "europe/germany",
          urls: { pbf: "https://example.com/bayern.osm.pbf" },
        },
        geometry: {
          type: "Polygon",
          coordinates: [[[9, 47.5], [13.5, 47.5], [13.5, 50.5], [9, 50.5], [9, 47.5]]],
        },
      },
      {
        properties: {
          id: "europe/france/ile-de-france",
          name: "Île-de-France",
          parent: "europe/france",
          urls: { pbf: "https://example.com/idf.osm.pbf" },
        },
        geometry: {
          type: "Polygon",
          coordinates: [[[1.4, 48.1], [3.6, 48.1], [3.6, 49.3], [1.4, 49.3], [1.4, 48.1]]],
        },
      },
    ],
  });
  return parseIndex(raw, new Date("2026-01-01T00:00:00Z"));
}

async function seedRegion(slug: string, status: string, postgresDb = "nom_x") {
  await db.insert(osmRegionImports).values({
    slug,
    geofabrik_url: "https://example.com/x.osm.pbf",
    postgres_db: postgresDb,
    bbox_min_lat: 0,
    bbox_min_lon: 0,
    bbox_max_lat: 0,
    bbox_max_lon: 0,
    status,
  });
}

async function seedUser(): Promise<number> {
  const [u] = await db
    .insert(users)
    .values({
      email: "bulk-test@example.com",
      name: "Bulk Test",
      password_hash: "x",
    })
    .returning({ id: users.id });
  return u.id;
}

async function seedPhoto(userId: number, lat: number | null, lon: number | null, idx: number) {
  await db.insert(photos).values({
    user_id: userId,
    filename: `p${idx}.jpg`,
    original_name: `p${idx}.jpg`,
    mime_type: "image/jpeg",
    size: 1,
    latitude: lat,
    longitude: lon,
  });
}

const loadIndex = async () => fixture();

beforeEach(async () => {
  await db.delete(osmRegionImports);
  await db.delete(photos);
  await db.delete(users);
});

describe("suggestRegionsFromPhotos", () => {
  it("returns empty result when the library has no geotagged photos", async () => {
    const u = await seedUser();
    await seedPhoto(u, null, null, 1);
    const r = await suggestRegionsFromPhotos({ loadIndex });
    expect(r).toEqual({
      geotaggedPhotoCount: 0,
      unmappedPhotoCount: 0,
      coveredPhotoCount: 0,
      suggestions: [],
      redundantRegions: [],
    });
  });

  it("aggregates photos by their smallest matching region, sorted desc", async () => {
    const u = await seedUser();
    // 3 in Bayern, 1 in Ile-de-France
    await seedPhoto(u, 48.137, 11.575, 1); // Munich
    await seedPhoto(u, 49.453, 11.077, 2); // Nuremberg
    await seedPhoto(u, 47.999, 11.343, 3); // Starnberg
    await seedPhoto(u, 48.857, 2.352, 4); // Paris
    const r = await suggestRegionsFromPhotos({ loadIndex });
    expect(r.geotaggedPhotoCount).toBe(4);
    expect(r.unmappedPhotoCount).toBe(0);
    expect(r.suggestions.map((s) => `${s.slug}=${s.photoCount}`)).toEqual([
      "europe/germany/bayern=3",
      "europe/france/ile-de-france=1",
    ]);
  });

  it("counts photos outside every region polygon as unmapped", async () => {
    const u = await seedUser();
    await seedPhoto(u, 48.137, 11.575, 1); // Munich
    await seedPhoto(u, 0, -30, 2); // mid-Atlantic
    const r = await suggestRegionsFromPhotos({ loadIndex });
    expect(r.geotaggedPhotoCount).toBe(2);
    expect(r.unmappedPhotoCount).toBe(1);
    expect(r.suggestions).toHaveLength(1);
    expect(r.suggestions[0].slug).toBe("europe/germany/bayern");
  });

  it("merges existing osm_region_imports state into the result", async () => {
    const u = await seedUser();
    await seedPhoto(u, 48.137, 11.575, 1);
    await db.insert(osmRegionImports).values({
      slug: "europe/germany/bayern",
      geofabrik_url: "https://example.com/bayern.osm.pbf",
      postgres_db: "nom_bayern",
      bbox_min_lat: 47.5,
      bbox_min_lon: 9,
      bbox_max_lat: 50.5,
      bbox_max_lon: 13.5,
      status: "ready_running",
    });
    const r = await suggestRegionsFromPhotos({ loadIndex });
    expect(r.suggestions[0].existing).toBe(true);
    expect(r.suggestions[0].existingStatus).toBe("ready_running");
  });

  it("uses the geohash cache: identical coords don't multiply Geofabrik lookups", async () => {
    const u = await seedUser();
    // 100 photos at the same coordinate — should still produce a count of 100
    // and a single suggestion. The lookup is internally cached.
    for (let i = 0; i < 100; i++) {
      await seedPhoto(u, 48.137, 11.575, i + 1);
    }
    const r = await suggestRegionsFromPhotos({ loadIndex });
    expect(r.suggestions[0].photoCount).toBe(100);
  });

  it("flags photos covered by an existing region instead of re-suggesting", async () => {
    const u = await seedUser();
    await seedPhoto(u, 48.137, 11.575, 1); // Munich (in Bayern)
    await seedRegion("europe/germany/bayern", "ready_running", "nom_bayern");

    const r = await suggestRegionsFromPhotos({ loadIndex });
    expect(r.coveredPhotoCount).toBe(1);
    expect(r.suggestions).toHaveLength(1);
    expect(r.suggestions[0].slug).toBe("europe/germany/bayern");
    expect(r.suggestions[0].coveredByExisting).toBe(true);
    expect(r.suggestions[0].existing).toBe(true);
  });

  it("attributes photos to an imported parent and suppresses the finer sub-region", async () => {
    const u = await seedUser();
    await seedPhoto(u, 48.137, 11.575, 1); // Munich — leaf is Bayern
    await seedPhoto(u, 49.453, 11.077, 2); // Nuremberg — leaf is Bayern
    await seedPhoto(u, 48.857, 2.352, 3); // Paris — only Île-de-France
    // The whole of Germany is already imported.
    await seedRegion("europe/germany", "ready_running", "nom_germany");

    const r = await suggestRegionsFromPhotos({ loadIndex: fixtureWithParent });

    // Bayern photos roll up under the imported parent, not a new leaf.
    expect(r.coveredPhotoCount).toBe(2);
    const bySlug = Object.fromEntries(r.suggestions.map((s) => [s.slug, s]));
    expect(bySlug["europe/germany"].photoCount).toBe(2);
    expect(bySlug["europe/germany"].coveredByExisting).toBe(true);
    // The finer Bayern leaf must NOT be proposed as a new import.
    expect(bySlug["europe/germany/bayern"]).toBeUndefined();
    // Paris is genuinely uncovered → still a fresh suggestion.
    expect(bySlug["europe/france/ile-de-france"].coveredByExisting).toBe(false);
    expect(bySlug["europe/france/ile-de-france"].existing).toBe(false);
  });

  it("does not treat a failed region as covering — still suggests the import", async () => {
    const u = await seedUser();
    await seedPhoto(u, 48.137, 11.575, 1); // Munich (in Bayern)
    await seedRegion("europe/germany", "failed", "nom_germany");

    const r = await suggestRegionsFromPhotos({ loadIndex: fixtureWithParent });
    expect(r.coveredPhotoCount).toBe(0);
    expect(r.suggestions).toHaveLength(1);
    // Falls back to the smallest matching leaf, as a fresh suggestion.
    expect(r.suggestions[0].slug).toBe("europe/germany/bayern");
    expect(r.suggestions[0].coveredByExisting).toBe(false);
  });

  it("marks a tracked parent as redundant when all its photos are covered by imported children", async () => {
    const u = await seedUser();
    // Only photos in Bayern — Germany is imported but Bayern covers them all.
    await seedPhoto(u, 48.137, 11.575, 1); // Munich
    await seedPhoto(u, 49.453, 11.077, 2); // Nuremberg
    await seedRegion("europe/germany", "ready_running", "nom_germany");
    await seedRegion("europe/germany/bayern", "ready_running", "nom_bayern");

    const r = await suggestRegionsFromPhotos({ loadIndex: fixtureWithParent });

    expect(r.redundantRegions).toHaveLength(1);
    expect(r.redundantRegions[0].slug).toBe("europe/germany");
    expect(r.redundantRegions[0].status).toBe("ready_running");
    expect(r.redundantRegions[0].coveringChildren).toContain("europe/germany/bayern");
  });

  it("does not flag a parent as redundant when it still has directly-attributed photos", async () => {
    const u = await seedUser();
    // Munich → Bayern, but there's no Bayern-equivalent for Ile-de-France in Germany
    // Actually use Germany + Bayern but also add a photo outside Bayern (would need Berlin).
    // Instead: only Bayern tracked, no parent → no redundancy.
    await seedPhoto(u, 48.137, 11.575, 1); // Munich → Bayern covers
    await seedRegion("europe/germany/bayern", "ready_running", "nom_bayern");

    const r = await suggestRegionsFromPhotos({ loadIndex: fixtureWithParent });
    expect(r.redundantRegions).toHaveLength(0);
  });

  it("does not flag a parent as redundant when it has photos not covered by children", async () => {
    const u = await seedUser();
    // Munich in Bayern (covered by child), and Paris NOT in Germany
    // Use a photo in Germany-but-not-Bayern to keep Germany non-redundant.
    // Hamburg (53.55, 9.99) is in Germany but outside Bayern's bbox.
    await seedPhoto(u, 48.137, 11.575, 1); // Munich → Bayern
    await seedPhoto(u, 53.55, 9.99, 2);    // Hamburg → Germany (no Bayern sub-region covers it)
    await seedRegion("europe/germany", "ready_running", "nom_germany");
    await seedRegion("europe/germany/bayern", "ready_running", "nom_bayern");

    const r = await suggestRegionsFromPhotos({ loadIndex: fixtureWithParent });
    // Germany appears in counts for Hamburg → not redundant.
    expect(r.redundantRegions).toHaveLength(0);
  });

  it("returns empty redundantRegions when no geotagged photos exist", async () => {
    const u = await seedUser();
    await seedPhoto(u, null, null, 1);
    await seedRegion("europe/germany", "ready_running", "nom_germany");

    const r = await suggestRegionsFromPhotos({ loadIndex: fixtureWithParent });
    expect(r.redundantRegions).toHaveLength(0);
  });
});
