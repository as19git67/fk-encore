/**
 * Asking for the maps a place needs (§13.0).
 *
 * A coordinate nobody has imported answers nothing — not a plan, not a
 * browse, not a search. The planner has always handled that by asking
 * for the region on the traveller's behalf when a trip is created, and
 * the asking is the part worth having in one place now that a second
 * screen needs it: the browse (§9.2) hits exactly the same wall, in the
 * same way, and should not grow its own policy about downloads.
 *
 * Goes through the same `createPending` the region admin uses, and so
 * inherits its policy rather than routing around it: a small region
 * starts importing at once, a large one waits for an admin. A traveller
 * does not get to commit the server to a fifty-gigabyte download by
 * typing a city name.
 *
 * Idempotent — a region already tracked comes back with whatever status
 * it has, which is what makes the second trip to the same place cheap.
 */

import { APIError } from "encore.dev/api";
import { createPending, slugToPostgresDb, suggestForCoord } from "../osm-admin/region.service";

export interface RequestedRegion {
  /** The Geofabrik region asked for, e.g. "europe/portugal/lisboa". */
  slug: string;
  /** pending_approval | importing | … — what the admin queue says. */
  status: string;
  postgresDb: string;
  /** True when nobody has to do anything: it is already downloading. */
  autoApproved: boolean;
}

export async function requestRegionFor(
  anchor: { lat: number; lon: number },
): Promise<RequestedRegion> {
  let suggestion;
  try {
    suggestion = await suggestForCoord(anchor.lat, anchor.lon);
  } catch (err) {
    // Working out *which* region is a lookup against Geofabrik's index,
    // so it can fail for reasons that have nothing to do with the trip.
    // Saying which beats a five-hundred.
    throw APIError.unavailable(
      "das Regionsverzeichnis von Geofabrik ist gerade nicht erreichbar — "
        + `ohne das lässt sich nicht sagen, welche Karten dieser Ort braucht (${(err as Error).message})`,
    );
  }
  if (!suggestion) {
    throw APIError.failedPrecondition(
      "für diesen Ort gibt es keine OpenStreetMap-Region bei Geofabrik — "
        + "liegt er vielleicht auf dem Meer?",
    );
  }
  // The suggestion already carries the probed size, so the second HEAD
  // request createPending would make is handed the answer instead.
  const created = await createPending(suggestion.slug, {
    probeSize: async () => suggestion.pbfSizeMb,
  });
  return {
    slug: suggestion.slug,
    status: created.status,
    postgresDb: slugToPostgresDb(suggestion.slug),
    autoApproved: created.status === "importing",
  };
}
