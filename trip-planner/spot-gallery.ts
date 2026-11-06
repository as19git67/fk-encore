/**
 * More pictures of one place than its article has (ranking plan,
 * stage 2).
 *
 * A Wikipedia article usually uses one or two photographs; the Commons
 * category of the same place (Wikidata's P373) often holds dozens,
 * taken by visitors from every side and in every season. The detail
 * screen shows them as a strip under the place's own picture.
 *
 * **What leaves the house** is the name of a public Commons category.
 */

import { api, APIError, type Query } from "encore.dev/api";
import { eq } from "drizzle-orm";
import { getAuthData } from "~encore/auth";
import db from "../db/database";
import { tripSpotFame } from "../db/schema";
import { requirePermission } from "../user/auth-handler";
import { getCommonsClient, type CommonsPhoto } from "./commons-client";
import type { SpotImage } from "./spot-fame";

/** Enough to scroll through, few enough to load on a phone. */
const GALLERY_SIZE = 30;

export interface SpotGalleryResponse {
  photos: CommonsPhoto[];
}

export const spotGallery = api(
  { expose: true, method: "GET", path: "/trip-planner/spots/gallery", auth: true },
  async (req: { osmRef: Query<string> }): Promise<SpotGalleryResponse> => {
    const auth = getAuthData();
    if (!auth) throw APIError.unauthenticated("Unauthorized");
    requirePermission(auth, "photos.view");
    const [row] = await db.select().from(tripSpotFame).where(eq(tripSpotFame.osm_ref, req.osmRef)).limit(1);
    const own = (row?.image ?? null) as SpotImage | null;
    let photos: CommonsPhoto[] = [];
    if (row?.commons_category) {
      try {
        photos = await getCommonsClient().category(row.commons_category, GALLERY_SIZE);
      } catch {
        // Commons down is a screen with the one picture it has, not an error.
        photos = [];
      }
    }
    return { photos: galleryOf(own, photos) };
  },
);

/** The place's own picture first, then the category's, each once. */
export function galleryOf(own: SpotImage | null, category: readonly CommonsPhoto[]): CommonsPhoto[] {
  const norm = (t: string) => t.replace(/_/g, " ");
  const out: CommonsPhoto[] = own ? [own] : [];
  const seen = new Set(out.map((p) => norm(p.title)));
  for (const photo of category) {
    if (seen.has(norm(photo.title))) continue;
    seen.add(norm(photo.title));
    out.push(photo);
  }
  return out.slice(0, GALLERY_SIZE);
}
