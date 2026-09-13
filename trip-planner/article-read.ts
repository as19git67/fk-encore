/**
 * Reading an article without a trip behind it (§9.2 case 2, §9.3, §20).
 *
 * „Die zehn schönsten Cafés in Lissabon" is the commonest shape real
 * research takes, and the pipeline for it has been complete since the
 * share extension landed: fetch the page, strip it to its text, let the
 * model name the places, resolve each name against the region, and hand
 * back proposals with the sentence from the article that put each one
 * on the list (§9.3).
 *
 * It has only ever been reachable through `POST /plans/:planId/shares`
 * — through a trip. Two things follow from that, and both are wrong:
 * the reading needs Safari and the share sheet even when the app is
 * already open, and it cannot happen at all before a journey exists,
 * which is precisely when somebody reads such an article.
 *
 * The pipeline is unchanged and not copied. What the trip supplied was
 * *where to look up the names*, and that can come from a coordinate
 * instead: the area somebody is browsing (§9.2 case 4) and the region
 * under it. So this endpoint is the plumbing between a position and
 * `articleProposals`, and nothing else.
 *
 * A proposal goes into the collection with `POST /trip-planner/ideas`
 * like any other find — which is why nothing here writes: reading and
 * keeping are two decisions, and the second one belongs to whoever
 * reads the quotes.
 */

import { api, APIError } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import { requirePermission } from "../user/auth-handler";
import { pickRegion } from "../osm-admin/region-router";
import { articleProposals, type AnalyseShareResponse } from "./share";

/** How long a shared piece of text may be. The same cap `shares` uses. */
const MAX_TEXT = 200_000;
const MAX_URL_LENGTH = 4_000;

export interface ReadArticleRequest {
  /** Where to look the names up — the area being browsed. */
  position: { lat: number; lon: number };
  /** The page to read. */
  url?: string;
  /**
   * Text somebody pasted instead of a link. Wins over the URL, exactly
   * as it does for a share: text in hand beats a page to fetch, which
   * may be behind a cookie wall or a login (§9.3 stage 1).
   */
  text?: string;
}

export const readArticleHere = api(
  { expose: true, method: "POST", path: "/trip-planner/explore/article", auth: true },
  async (req: ReadArticleRequest): Promise<AnalyseShareResponse> => {
    requireUser();
    const position = validatePosition(req.position);

    const url = typeof req.url === "string" ? req.url.trim() : "";
    const text = typeof req.text === "string" ? req.text : "";
    if (!url && !text.trim()) {
      throw APIError.invalidArgument("url oder text wird gebraucht");
    }
    if (url.length > MAX_URL_LENGTH) {
      throw APIError.invalidArgument("die Adresse ist zu lang");
    }
    if (text.length > MAX_TEXT) {
      throw APIError.invalidArgument(`text ist länger als ${MAX_TEXT} Zeichen`);
    }

    const region = await pickRegion(position.lat, position.lon);
    if (!region) {
      // The same wall the browse hits, and the same answer: the names
      // in the article can be extracted but not placed, and a list of
      // places with no coordinates is not worth the model's time.
      // `POST /trip-planner/explore/region` is the way through it.
      throw APIError.failedPrecondition(
        "für diese Gegend sind noch keine Karten da — ohne sie lassen sich die "
          + "Orte aus dem Artikel nicht wiederfinden",
      );
    }

    // One area, because there is one place being looked at. `position`
    // is the leg index a proposal reports; with a single area it means
    // nothing, and zero is the honest nothing.
    return await articleProposals(url || null, text, [
      { position: 0, regionDb: region.postgresDb, anchor: position },
    ]);
  },
);

function requireUser(): number {
  const auth = getAuthData();
  if (!auth) throw APIError.unauthenticated("Unauthorized");
  requirePermission(auth, "photos.view");
  return parseInt(auth.userID, 10);
}

function validatePosition(
  position: ReadArticleRequest["position"],
): { lat: number; lon: number } {
  if (!position || typeof position !== "object") {
    throw APIError.invalidArgument("position is required");
  }
  const { lat, lon } = position;
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
    throw APIError.invalidArgument("lat must be between -90 and 90");
  }
  if (!Number.isFinite(lon) || lon < -180 || lon > 180) {
    throw APIError.invalidArgument("lon must be between -180 and 180");
  }
  return { lat, lon };
}
