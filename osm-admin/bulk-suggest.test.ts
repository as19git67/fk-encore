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
    expect(r).toEqual({ geotaggedPhotoCount: 0, unmappedPhotoCount: 0, suggestions: [] });
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
});
