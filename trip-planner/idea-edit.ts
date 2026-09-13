/**
 * Changing something already collected (§20).
 *
 * The collection could be written to and emptied, and nothing in
 * between: an entry was whatever it was on the day somebody saved it.
 * That is wrong for the thing it is. A planned spot has had a title, a
 * note, a link and a stay length that can be corrected since notes
 * arrived (`spot-notes.ts`) — and an idea is the same place before it
 * belongs to a trip. The sentences that decide whether anybody goes —
 * „Eingang um die Ecke", „Karten vorher kaufen", „nur bis Ostern" —
 * are learned after the saving, never during it.
 *
 * The fields are the ones the entry already has room for, so this adds
 * no column and no migration:
 *
 *   - **title** — what the family calls it. Never a correction of
 *     OpenStreetMap: the map's name stays underneath, because that is
 *     the one the ticket desk answers to (§10.4).
 *   - **note** — why it is worth going.
 *   - **sourceUrl** — the one link kept with it.
 *   - **dwellMinutes** — how long you stay. For an entry the map does
 *     not know this was a guess somebody made once (§15.3), and the
 *     first visit is when they learn better.
 *   - **validFrom / validTo** — something that ends (§20.4).
 *   - **photoStop** — "we come here for the light" (§7.3).
 *
 * Omitting a field leaves it; sending an empty one clears it. That
 * rule lives in `field-edit.ts` because the spot note follows it too,
 * and two subtly different readings of "empty" is how one screen comes
 * to wipe what another wrote.
 *
 * Open to everybody the collection is shared with, like adding and
 * removing: §6.2 reserves three rights to the organiser of a *trip*,
 * and a shared collection is a list, not a journey.
 */

import { api, APIError } from "encore.dev/api";
import { and, eq } from "drizzle-orm";
import { getAuthData } from "~encore/auth";
import db from "../db/database";
import { ideaPool } from "../db/schema";
import { requirePermission } from "../user/auth-handler";
import {
  resolveDay,
  resolveDwellMinutes,
  resolveText,
  validateUrl,
} from "./field-edit";
import { loadIdeas, requireAccess, type IdeaEntry } from "./ideas";

const MAX_TITLE_LENGTH = 120;
const MAX_NOTE_LENGTH = 1_000;
const MAX_URL_LENGTH = 2_000;

export interface UpdateIdeaRequest {
  id: number;
  /** Whose collection. Your own unless a shared one is named. */
  ownerId?: number;
  /**
   * What the family calls it. An empty string clears it, which is not
   * the same as omitting the field: omitting leaves what is there.
   */
  title?: string | null;
  note?: string | null;
  sourceUrl?: string | null;
  /** How long you stay, in minutes. */
  dwellMinutes?: number | null;
  /** Both as YYYY-MM-DD, for something that ends (§20.4). */
  validFrom?: string | null;
  validTo?: string | null;
  photoStop?: boolean;
}

export interface UpdateIdeaResponse {
  /** The entry as it now stands, read back rather than echoed. */
  entry: IdeaEntry;
}

export const updateIdea = api(
  { expose: true, method: "PATCH", path: "/trip-planner/ideas/:id", auth: true },
  async (req: UpdateIdeaRequest): Promise<UpdateIdeaResponse> => {
    const userId = requireUser();
    const ownerId = await requireAccess(req.ownerId ?? userId, userId);

    const [existing] = await loadIdeas(ownerId, req.id);
    if (!existing) throw APIError.notFound("diese Idee gibt es nicht");

    const validFrom = resolveDay(req.validFrom, existing.validFrom, "validFrom");
    const validTo = resolveDay(req.validTo, existing.validTo, "validTo");
    if (validFrom && validTo && validTo < validFrom) {
      throw APIError.invalidArgument("validTo liegt vor validFrom");
    }

    await db
      .update(ideaPool)
      .set({
        title: resolveText(req.title, existing.title, MAX_TITLE_LENGTH, "title"),
        note: resolveText(req.note, existing.note, MAX_NOTE_LENGTH, "note"),
        source_url: validateUrl(
          resolveText(req.sourceUrl, existing.sourceUrl, MAX_URL_LENGTH, "sourceUrl"),
        ),
        // Never null: a spot with no stay length cannot be planned at
        // all, so clearing one would be a way to break the entry
        // rather than to edit it.
        dwell_minutes: resolveDwellMinutes(req.dwellMinutes, existing.dwellMinutes)
          ?? existing.dwellMinutes,
        valid_from: validFrom,
        valid_to: validTo,
        // Written only when it was sent. Spelling the omission out
        // rather than trusting the query builder to drop an
        // `undefined`: this is the field a screen that does not know
        // about photo stops would silently switch off.
        ...(req.photoStop === undefined ? {} : { photo_stop: req.photoStop }),
      })
      .where(and(eq(ideaPool.id, req.id), eq(ideaPool.owner_id, ownerId)));

    const [written] = await loadIdeas(ownerId, req.id);
    if (!written) throw APIError.internal("die Idee ist beim Speichern verschwunden");
    return { entry: written };
  },
);

function requireUser(): number {
  const auth = getAuthData();
  if (!auth) throw APIError.unauthenticated("Unauthorized");
  requirePermission(auth, "photos.view");
  return parseInt(auth.userID, 10);
}
