/**
 * Trip Mode server support beyond the plain album endpoints it otherwise
 * reuses (see `docs/ios-trip-mode.md`). Currently just the home-location
 * lookup the client needs to suggest ending a trip once the device is back
 * home (Etappe 5).
 */

import { api, APIError } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import { requirePermission } from "../user/auth-handler";
import { getHomeCentroidForUser } from "./recaps.service";

interface HomeLocationResponse {
  /** The user's home centroid derived from their geotagged photo history, or
   *  `null` when there isn't enough data yet (matches `computeHomeCentroid`). */
  location: { lat: number; lon: number } | null;
}

/**
 * The user's home location, for the client-side "back home, end the trip?"
 * heuristic. Reuses the same home-centroid computation recaps use to tell
 * trip photos from everyday ones, so both agree on where "home" is.
 */
export const getHomeLocation = api(
  { expose: true, method: "GET", path: "/trips/home-location", auth: true },
  async (): Promise<HomeLocationResponse> => {
    const authData = getAuthData();
    if (!authData) throw APIError.unauthenticated("Unauthorized");
    requirePermission(authData, "photos.view");
    const userId = parseInt(authData.userID);
    const location = await getHomeCentroidForUser(userId);
    return { location };
  }
);
