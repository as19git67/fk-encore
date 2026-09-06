/**
 * What people have to say about individual spots (§9.2, §10.4).
 *
 * A note and a link have travelled with a spot since finds arrived,
 * but only as provenance: whoever saved the place got to say why, in
 * the one moment they saved it, and nobody could add a word
 * afterwards. The sentences that actually decide how a morning goes —
 * "Eingang um die Ecke", "Tickets vorher kaufen", "Karten mitnehmen" —
 * are learned after the planning, from a blog, from the family, from
 * standing there once before.
 *
 * Three fields, and the split between them is the point:
 *
 *   - The **title** is what the group calls the place. It does not
 *     correct OpenStreetMap: the map's name stays on the stop, and the
 *     detail screen still shows it underneath. "Das Museum mit dem
 *     Dachgarten" is a better handle for the family than the official
 *     name and a worse one for anybody else.
 *   - The **note** is why it matters, in their words.
 *   - The **URL** is the one link the group keeps with the spot.
 *
 * Open to everybody on the trip, like the pool: §6.2 reserves three
 * rights to the organiser and none of them is this one.
 *
 * Written against (leg, osmRef) rather than the stop row, because the
 * stop row is not durable — every re-plan deletes the day's stops and
 * writes them again. A note hanging off the row would survive until
 * the next settings change, which is the kind of loss nobody reports
 * and everybody stops trusting.
 */

import { api, APIError } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import { requirePermission } from "../user/auth-handler";
import { findSpotNote, loadPlan, saveSpotNote, type SpotNote } from "./plan-store";

const MAX_TITLE_LENGTH = 120;
const MAX_NOTE_LENGTH = 1_000;
const MAX_URL_LENGTH = 2_000;

export interface SaveSpotNoteRequest {
  planId: number;
  /** Which leg the spot belongs to, counted from zero. */
  legIndex: number;
  /** The spot, by its OSM reference — its handle everywhere else too. */
  osmRef: string;
  /**
   * What the group calls it. An empty string clears it, which is not
   * the same as omitting the field: omitting leaves what is there.
   */
  title?: string | null;
  note?: string | null;
  url?: string | null;
}

export interface SaveSpotNoteResponse {
  /** What is written now, or null once the last field was cleared. */
  spotNote: SpotNote | null;
}

export const saveTripSpotNote = api(
  {
    expose: true,
    method: "PATCH",
    // The reference goes in the body rather than the path: an OSM ref
    // is "node:123", and a colon in a path segment is a fight with
    // every URL library between here and the database for no gain.
    path: "/trip-planner/plans/:planId/legs/:legIndex/spot",
    auth: true,
  },
  async (req: SaveSpotNoteRequest): Promise<SaveSpotNoteResponse> => {
    const userId = requireUser();
    const plan = await loadPlan(req.planId, userId);
    if (!plan) throw APIError.notFound("plan not found");

    const leg = plan.legs.find((l) => l.position === req.legIndex);
    if (!leg) throw APIError.notFound(`leg ${req.legIndex} not found in this plan`);

    const osmRef = req.osmRef.trim();
    if (!osmRef) throw APIError.invalidArgument("osmRef is required");

    // The spot has to be one of this leg's, in the pool or on a day.
    // Not a permission check — everybody here may write — but a
    // typo check: a note against a reference this leg has never heard
    // of is a note nobody will ever see again.
    if (!knowsSpot(leg, osmRef)) {
      throw APIError.notFound("dieser Spot gehört nicht zu dieser Etappe");
    }

    const existing = await findSpotNote(leg.id, osmRef);
    const fields = {
      title: resolve(req.title, existing?.title ?? null, MAX_TITLE_LENGTH, "title"),
      note: resolve(req.note, existing?.note ?? null, MAX_NOTE_LENGTH, "note"),
      url: validateUrl(resolve(req.url, existing?.url ?? null, MAX_URL_LENGTH, "url")),
    };

    await saveSpotNote(leg.id, osmRef, fields, userId);

    const written = await findSpotNote(leg.id, osmRef);
    return { spotNote: written ?? null };
  },
);

type LegLike = {
  pool: ReadonlyArray<{ osmRef: string }>;
  days: ReadonlyArray<{ blocks: ReadonlyArray<{ stops: ReadonlyArray<{ osmRef: string }> }> }>;
};

function knowsSpot(leg: LegLike, osmRef: string): boolean {
  if (leg.pool.some((c) => c.osmRef === osmRef)) return true;
  return leg.days.some((day) =>
    day.blocks.some((block) => block.stops.some((stop) => stop.osmRef === osmRef)),
  );
}

/**
 * The new value of one field.
 *
 * Omitted leaves what is there; an empty string clears it. The two
 * have to differ, or a screen that edits only the note would wipe the
 * link every time it saved.
 */
function resolve(
  incoming: string | null | undefined,
  current: string | null,
  max: number,
  field: string,
): string | null {
  if (incoming === undefined) return current;
  if (incoming === null) return null;
  const trimmed = incoming.trim();
  if (!trimmed) return null;
  if (trimmed.length > max) {
    throw APIError.invalidArgument(`${field} may be at most ${max} characters`);
  }
  return trimmed;
}

/**
 * A link the app can actually open.
 *
 * Only http and https: a `javascript:` or `data:` string in a field
 * that renders as a tappable link is not a link, and refusing it here
 * is cheaper than remembering to refuse it in every client.
 */
function validateUrl(url: string | null): string | null {
  if (url === null) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw APIError.invalidArgument("url must be a full web address, e.g. https://beispiel.test");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw APIError.invalidArgument("url must be an http or https address");
  }
  return parsed.toString();
}

function requireUser(): number {
  const auth = getAuthData();
  if (!auth) throw APIError.unauthenticated("Unauthorized");
  requirePermission(auth, "photos.view");
  return parseInt(auth.userID, 10);
}
