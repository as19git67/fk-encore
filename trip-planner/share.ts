/**
 * What arrived from the share sheet, turned into proposals (§9.2, §9.3).
 *
 * Three of the four ways into the pool land here — a map link, an
 * article, and a screenshot's text — and all three end in the same
 * place: a list of candidates the traveller confirms. The fourth,
 * searching in the app, needs none of this and has its own way in.
 *
 * **This endpoint proposes; it does not add.** Nothing here writes to a
 * pool. Once the traveller has picked, the app calls the existing
 * `POST /trip-planner/plans/:planId/finds`, where the five rules of
 * §9.2 already live — the right leg, a suggestion rather than an
 * appointment, duplicates merged, provenance kept, missing data named.
 * Duplicating any of that here would be duplicating the part that has
 * to be right.
 *
 * What the traveller confirms depends on what came in, and the three
 * answers are deliberately different:
 *
 *   - **A map link with a coordinate** is one gesture away from the
 *     pool, which is what §9.2 asks for. It still comes back for
 *     confirmation, because reading a coordinate out of a link is
 *     fragile by the concept's own admission — but the confirmation is
 *     a map with a pin on it, not an error dialog.
 *   - **A name that resolved to exactly one place** arrives with all of
 *     its OSM data.
 *   - **A name that matched several, or none** arrives saying so. None
 *     is not a failure: it stays a note with its link and its quote
 *     until somebody resolves it by hand. Nothing is invented (§10.4).
 */

import { api, APIError } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import { requirePermission } from "../user/auth-handler";
import { loadPlan } from "./plan-store";
import { chooseLeg } from "./finds";
import { parseMapLink } from "./map-link";
import { articleTextFromHtml, prepareArticleText } from "./article";
import { buildExtractPrompt, parseExtractedPlaces, type ExtractedPlace } from "./extract-places";
import { askForJson, LlmServiceUnavailableError } from "./llm-client";
import { lookupPlace, type LocatedCandidate } from "./place-lookup";
import { fetchSharedPage, resolveRedirect, PageFetchError } from "./page-fetch";

/** A page the device already read is text; anything longer is a book. */
const MAX_SHARED_TEXT = 200_000;

export interface AnalyseShareRequest {
  planId: number;
  /**
   * What was shared. A map link, an article link, or — when the share
   * extension read the open page itself — nothing, with the text in
   * `text` instead.
   */
  url?: string;
  /**
   * The visible text of the page, read on the device (§9.3 stage 1).
   * Far better than fetching the URL here: the browser has already
   * dealt with JavaScript, cookie banners, logins and bot blocks.
   */
  text?: string;
}

export interface ShareProposalOption {
  osmRef: string;
  name: string | null;
  lat: number;
  lon: number;
  categories: string[];
  legIndex: number;
  distanceM: number | null;
}

export interface ShareProposal {
  /** What to call it: the article's name, or the link's. */
  name: string | null;
  /**
   * `coordinate` — the link carried a position and no name to resolve.
   * `unique` / `ambiguous` / `none` — the outcome of resolving a name
   * against the trip's regions (§9.3 stage 4).
   */
  verdict: "coordinate" | "unique" | "ambiguous" | "none";
  /** Set for `coordinate` and `unique`. */
  position: { lat: number; lon: number } | null;
  osmRef: string | null;
  categories: string[];
  /** Which leg it belongs to, when that is already clear. */
  legIndex: number | null;
  /** For `ambiguous`: the places to choose between, nearest first. */
  options: ShareProposalOption[];
  /** The words in the page that put it on the list (§9.3 stage 3). */
  quote: string | null;
  /** "in der Altstadt" — carried as provenance, never acted on. */
  placeHint: string | null;
  /** What the article called it. A word, not a category id. */
  kindHint: string | null;
}

export interface AnalyseShareResponse {
  kind: "map-link" | "article";
  /** Where it came from, for the pool entry's provenance (§9.2). */
  sourceUrl: string | null;
  proposals: ShareProposal[];
  /**
   * What was refused, in plain words: a quote that was not in the page,
   * an entry without a name. Shown rather than swallowed — an
   * extraction that quietly halves is worse than one that says so.
   */
  rejected: string[];
}

export const analyseShare = api(
  { expose: true, method: "POST", path: "/trip-planner/plans/:planId/shares", auth: true },
  async (req: AnalyseShareRequest): Promise<AnalyseShareResponse> => {
    const userId = requireUser();
    const plan = await loadPlan(req.planId, userId);
    if (!plan) throw APIError.notFound("plan not found");

    const url = typeof req.url === "string" ? req.url.trim() : "";
    const text = typeof req.text === "string" ? req.text : "";
    if (!url && !text.trim()) {
      throw APIError.invalidArgument("url oder text wird gebraucht");
    }
    if (text.length > MAX_SHARED_TEXT) {
      throw APIError.invalidArgument(`text ist länger als ${MAX_SHARED_TEXT} Zeichen`);
    }

    // A map link is checked first and only when no page text came with
    // it: a share carrying the text of an article is an article, even
    // if the article happens to live on a map service.
    if (url && !text.trim()) {
      const proposal = await mapLinkProposal(url, plan);
      if (proposal) {
        return { kind: "map-link", sourceUrl: url, proposals: [proposal], rejected: [] };
      }
    }

    return await articleProposals(url || null, text, plan);
  },
);

type LoadedPlan = NonNullable<Awaited<ReturnType<typeof loadPlan>>>;

/**
 * A shared map pin (§9.2, case 1).
 *
 * Answers null when the link is not a map link at all, which sends the
 * caller on to the article path — a URL that is not a pin is a page.
 */
async function mapLinkProposal(url: string, plan: LoadedPlan): Promise<ShareProposal | null> {
  let link = parseMapLink(url);
  if (!link) return null;

  if (link.needsRedirect) {
    // A shortened link holds nothing until it is followed. Failing to
    // follow it is not fatal: the traveller still gets a proposal with
    // no position and confirms the spot on a map.
    try {
      const target = await resolveRedirect(url);
      if (target) link = parseMapLink(target) ?? link;
    } catch (err) {
      if (!(err instanceof PageFetchError)) throw err;
    }
  }

  if (!link.position && !link.name) return null;

  const legIndex = link.position ? legFor(link.position, plan) : null;
  return {
    name: link.name,
    // With a position the traveller only has to confirm the pin; with
    // only a name there is a name to resolve, and that is the article
    // path's job rather than a second copy of it here.
    verdict: link.position ? "coordinate" : "none",
    position: link.position,
    osmRef: null,
    categories: [],
    legIndex,
    options: [],
    quote: null,
    placeHint: null,
    kindHint: null,
  };
}

/**
 * An article, a blog post or the text off a screenshot (§9.2 cases 2
 * and 3, §9.3).
 *
 * Cases 2 and 3 converge here on purpose: once OCR has turned a
 * screenshot into text, it is the same problem, and the concept says as
 * much.
 */
async function articleProposals(
  url: string | null,
  sharedText: string,
  plan: LoadedPlan,
): Promise<AnalyseShareResponse> {
  const rejected: string[] = [];
  let articleText = sharedText.trim();

  if (!articleText && url) {
    // The fallback: only a URL arrived, so the server reads the page
    // itself — with every guard `page-fetch.ts` sets out.
    try {
      const fetched = await fetchSharedPage(url);
      articleText = articleTextFromHtml(fetched.body);
      if (fetched.truncated) rejected.push("die Seite war zu lang und wurde gekürzt");
    } catch (err) {
      if (err instanceof PageFetchError) throw APIError.invalidArgument(err.message);
      throw err;
    }
  } else if (articleText.includes("<") && articleText.includes(">")) {
    // Some share sources hand over markup rather than text.
    articleText = articleTextFromHtml(articleText);
  }

  const prepared = prepareArticleText(articleText);
  if (!prepared) {
    throw APIError.invalidArgument("auf dieser Seite war kein Text zu finden");
  }

  let raw: unknown;
  try {
    raw = await askForJson(buildExtractPrompt(prepared));
  } catch (err) {
    if (err instanceof LlmServiceUnavailableError) {
      // A missing model is a state, not a fault of the request.
      throw APIError.unavailable(err.message);
    }
    throw err;
  }

  const extraction = parseExtractedPlaces(raw, prepared);
  rejected.push(...extraction.rejected);

  const proposals: ShareProposal[] = [];
  for (const place of extraction.places) {
    proposals.push(await resolveExtracted(place, plan));
  }

  return { kind: "article", sourceUrl: url, proposals, rejected };
}

async function resolveExtracted(
  place: ExtractedPlace,
  plan: LoadedPlan,
): Promise<ShareProposal> {
  const lookup = await lookupPlace(place.name, plan.legs.map((leg) => ({
    position: leg.position,
    regionDb: leg.regionDb,
    anchor: leg.anchor,
  })));

  const base = {
    name: place.name,
    quote: place.quote,
    placeHint: place.placeHint,
    kindHint: place.kindHint,
  };

  if (lookup.verdict === "unique" && lookup.match) {
    return {
      ...base,
      verdict: "unique",
      position: { lat: lookup.match.lat, lon: lookup.match.lon },
      osmRef: lookup.match.osmRef,
      categories: lookup.match.categories,
      legIndex: lookup.legIndex,
      options: [],
    };
  }
  if (lookup.verdict === "ambiguous") {
    return {
      ...base,
      verdict: "ambiguous",
      position: null,
      osmRef: null,
      categories: [],
      legIndex: null,
      options: lookup.options.map(toOption),
    };
  }
  // No match. Not a failure — a note with its link and its quote, which
  // stays in view until somebody resolves it by hand.
  return {
    ...base,
    verdict: "none",
    position: null,
    osmRef: null,
    categories: [],
    legIndex: null,
    options: [],
  };
}

function toOption(candidate: LocatedCandidate): ShareProposalOption {
  return {
    osmRef: candidate.osmRef,
    name: candidate.name,
    lat: candidate.lat,
    lon: candidate.lon,
    categories: candidate.categories,
    legIndex: candidate.legIndex,
    distanceM: candidate.distanceM,
  };
}

/**
 * Which leg a coordinate belongs to, or null when it belongs to none.
 *
 * Null rather than an error: the proposal is still useful, and the
 * traveller picks the leg when confirming it. The refusal proper
 * belongs to the endpoint that writes to the pool.
 */
function legFor(position: { lat: number; lon: number }, plan: LoadedPlan): number | null {
  const choice = chooseLeg(
    position,
    plan.legs.map((leg) => ({ position: leg.position, title: leg.title, anchor: leg.anchor })),
  );
  return choice.position;
}

function requireUser(): number {
  const auth = getAuthData();
  if (!auth) throw APIError.unauthenticated("Unauthorized");
  requirePermission(auth, "photos.view");
  return parseInt(auth.userID, 10);
}
