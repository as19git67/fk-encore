/**
 * Reading a shared map link without a trip behind it (§9.2, §20).
 *
 * The reading itself has existed since the share sheet did — Apple,
 * Google, OpenStreetMap, `geo:`, bare coordinates and short links, all
 * in `map-link.ts` and all tested. It could only be reached through
 * `POST /plans/:planId/shares`, which is to say: through a trip.
 *
 * That is the wrong door for the idea pool, whose whole point is that
 * it needs no trip (§20). The share sheet worked around it by parsing
 * the link itself, in the extension, with a copy that knew one format —
 * Apple's `ll=`. So a link out of Google Maps carried nothing as far as
 * the extension was concerned, and the collection was not offered at
 * all: the picker listed trips and nothing else, which is exactly the
 * situation the pool exists to fix.
 *
 * One reader, one set of rules, one place they are tested. The clients
 * keep their local fast path for the plain Apple form — a coordinate
 * that is right there in the string needs no round trip — and ask here
 * for everything else, short links included, since following a
 * redirect is I/O either way and belongs on the side that validates
 * where it is pointing.
 */

import { api, APIError } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import log from "encore.dev/log";
import { requirePermission } from "../user/auth-handler";
import { parseMapLink } from "./map-link";
import { PageFetchError, resolveRedirect } from "./page-fetch";

/** Longer than any real map link; a defence against a pasted document. */
const MAX_URL_LENGTH = 4_000;

type RedirectResolver = (url: string) => Promise<string | null>;

/**
 * Following the short link, behind a seam.
 *
 * Only so the tests can exercise both outcomes — followed, and not
 * followed — without a unit test reaching the open internet for an id
 * that does not exist.
 */
let followRedirect: RedirectResolver = (url) => resolveRedirect(url);

export function setRedirectResolver(resolver: RedirectResolver | null): void {
  followRedirect = resolver ?? ((url) => resolveRedirect(url));
}

export interface ReadMapLinkRequest {
  url: string;
}

export interface ReadMapLinkResponse {
  /** True when this is a map link at all — a page is not. */
  isMapLink: boolean;
  /** Read from the link, never derived. Null when it carries none. */
  lat: number | null;
  lon: number | null;
  /** What the link called the place, or the search term it held. */
  name: string | null;
  /** Which app's format was recognised — for a message, not for logic. */
  source: string | null;
  /**
   * True when the link was a short one whose redirect could not be
   * followed. Distinct from a link that plainly holds no place: the
   * caller may offer "try again", which is useless for the other case.
   */
  unresolved: boolean;
}

export const readMapLink = api(
  { expose: true, method: "POST", path: "/trip-planner/map-link", auth: true },
  async (req: ReadMapLinkRequest): Promise<ReadMapLinkResponse> => {
    requireUser();
    const url = (req.url ?? "").trim();
    if (!url) throw APIError.invalidArgument("url wird gebraucht");
    if (url.length > MAX_URL_LENGTH) {
      throw APIError.invalidArgument(`url ist länger als ${MAX_URL_LENGTH} Zeichen`);
    }

    let link = parseMapLink(url);
    if (!link) {
      return { isMapLink: false, lat: null, lon: null, name: null, source: null, unresolved: false };
    }

    let unresolved = false;
    if (link.needsRedirect) {
      // A shortened link holds nothing until it is followed, and
      // failing to follow it is not an error: the caller is told the
      // link is a map link whose place is not known yet, which is the
      // truth and reads differently from "no place here".
      try {
        const target = await followRedirect(url);
        if (target) {
          link = parseMapLink(target) ?? link;
        }
      } catch (err) {
        if (!(err instanceof PageFetchError)) throw err;
        log.info("short map link could not be followed", { message: err.message });
      }
      unresolved = link.needsRedirect || link.position === null;
    }

    return {
      isMapLink: true,
      lat: link.position?.lat ?? null,
      lon: link.position?.lon ?? null,
      name: link.name,
      source: link.source,
      unresolved,
    };
  },
);

function requireUser(): number {
  const auth = getAuthData();
  requirePermission(auth, "photos.view");
  return Number(auth!.userID);
}
