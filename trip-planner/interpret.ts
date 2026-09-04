/**
 * Natural language in, planning constraints out.
 *
 * Step 5 of docs/ios-urlaubsplanung.md §13. "Wir sind vier Tage in
 * Augsburg, mit einem Kind, eher gemütlich" becomes the same fields a
 * caller could have filled in by hand — nothing more.
 *
 * Deliberately a separate call rather than a text field on
 * `POST /trip-planner/plans`: the traveller gets to see what the model
 * understood before a plan is built on it, and a misread sentence costs
 * a correction instead of a wrong trip. `rejected` carries whatever the
 * model proposed that could not be used, so a silent misreading is
 * impossible.
 *
 * No coordinates come out of this. The service has no forward geocoder;
 * `placeHint` echoes the named place and the caller supplies the anchor
 * (the app knows where the map is pointing). Inventing coordinates from
 * a place name is exactly the kind of confident guess §15.3 rules out.
 */

import { api, APIError } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import { requirePermission } from "../user/auth-handler";
import { getGeoClient } from "../osm-admin/geo-client";
import {
  normalizeConstraints,
  type NlConstraints,
} from "./constraints";
import { interpretTripRequest, LlmServiceUnavailableError } from "./llm-client";

/** Long enough for a paragraph, short enough not to be a document. */
const MAX_TEXT_LENGTH = 2_000;

export interface InterpretRequest {
  /** What the traveller typed or dictated. */
  text: string;
}

export interface InterpretResponse {
  constraints: NlConstraints;
  /** What the model proposed that could not be used, in plain words. */
  rejected: string[];
}

export const interpretRequest = api(
  { expose: true, method: "POST", path: "/trip-planner/interpret", auth: true },
  async (req: InterpretRequest): Promise<InterpretResponse> => {
    requireUser();

    const text = typeof req.text === "string" ? req.text.trim() : "";
    if (!text) throw APIError.invalidArgument("text is required");
    if (text.length > MAX_TEXT_LENGTH) {
      throw APIError.invalidArgument(
        `text is longer than ${MAX_TEXT_LENGTH} characters`,
      );
    }

    // The vocabulary comes from geo rather than a copy here, so a
    // category added there is immediately reachable by sentence.
    const categories = await getGeoClient().poiCategories();

    let raw: unknown;
    try {
      raw = await interpretTripRequest(text, categories);
    } catch (err) {
      if (err instanceof LlmServiceUnavailableError) {
        // A missing model is a state, not a fault of the request: say so
        // rather than returning empty constraints that look like "the
        // sentence said nothing".
        throw APIError.unavailable(err.message);
      }
      throw err;
    }

    const { constraints, rejected } = normalizeConstraints(
      raw,
      categories.map((c) => c.id),
    );
    return { constraints, rejected };
  },
);

function requireUser(): number {
  const auth = getAuthData();
  if (!auth) throw APIError.unauthenticated("Unauthorized");
  requirePermission(auth, "photos.view");
  return parseInt(auth.userID, 10);
}
