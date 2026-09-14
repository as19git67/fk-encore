/**
 * The decision rule for adopting somebody else's similar-photo group review.
 *
 * Pure and DB-free so the rule itself can be unit-tested without a database;
 * `group-review-adoption.service.ts` does the loading and the writing.
 *
 * See docs/group-review-adoption.md for the why.
 */

export type CurationStatus = "visible" | "hidden" | "favorite";
export type CurationSource = "user" | "adopted";

/** Aggregated decisions of the qualifying peers on one photo. */
export interface PeerSignal {
  hidden: number;
  favorite: number;
}

export interface AdoptionMember {
  photo_id: number;
  /** The adopting user's own curation row for this photo, if any. */
  own?: { status: CurationStatus; source: CurationSource };
  /** Peer votes; absent means nobody said anything about this photo. */
  peer?: PeerSignal;
}

export interface AdoptionDecision {
  /** Photos to hide on the adopter's behalf, marked as adopted. */
  hide: number[];
  /**
   * Adopted hides to drop again — the peers no longer hide the photo, so
   * the adopted row has to go with them. Never contains user-made rows.
   */
  revert: number[];
  /** How many members stay visible once hide/revert are applied. */
  visibleAfter: number;
  /**
   * True when the rule was not applied at all. Adoption may tidy a stack,
   * never empty it: if fewer than two members would survive, the group
   * stays open and nothing is written.
   */
  skipped: boolean;
}

/**
 * A photo is hidden on the adopter's behalf when at least one qualifying peer
 * hid it and none of them favorited it — a single favourite vetoes the hides.
 * No peer signal at all leaves the photo alone.
 *
 * Deliberately the same conservative rule as "Konsens übernehmen"
 * (`acceptPeerConsensusLogic`), so the automatic and the manual path can
 * never disagree about the same group.
 */
export function peerVerdict(peer: PeerSignal | undefined): "hide" | "keep" {
  if (!peer) return "keep";
  return peer.hidden > 0 && peer.favorite === 0 ? "hide" : "keep";
}

/**
 * Work out what adopting the peers' review of one group would change.
 *
 * The adopter's own decisions are untouchable: a row with `source: "user"`
 * always keeps its status, whatever the peers think. That is what makes the
 * mixed mode work — touching a single photo of an adopted group carves out a
 * permanent exception without any per-group flag.
 */
export function decideAdoption(members: AdoptionMember[]): AdoptionDecision {
  const hide: number[] = [];
  const revert: number[] = [];
  let visibleAfter = 0;

  for (const m of members) {
    const own = m.own;
    if (own && own.source === "user") {
      // The adopter has spoken. Their row stands; it only counts towards
      // the "at least two visible members" check.
      if (own.status !== "hidden") visibleAfter++;
      continue;
    }

    const verdict = peerVerdict(m.peer);
    const isAdoptedHide = own?.source === "adopted" && own.status === "hidden";

    if (verdict === "hide") {
      if (!isAdoptedHide) hide.push(m.photo_id);
    } else {
      if (isAdoptedHide) revert.push(m.photo_id);
      visibleAfter++;
    }
  }

  // Adoption may tidy a stack, never empty it. A group the rule would
  // reduce below two visible members is left open for a real review.
  if (visibleAfter < 2) {
    return { hide: [], revert: [], visibleAfter, skipped: true };
  }

  return { hide, revert, visibleAfter, skipped: false };
}

/**
 * Resolve whether adoption is active for one group.
 *
 * Groups are album-independent, so the per-album overrides of every album
 * that holds a member photo are considered together. An explicit override
 * beats the user's global default, and `"off"` beats `"on"` when several
 * albums disagree — not auto-hiding is the safe side of the choice.
 */
export function resolveAdoptionEnabled(
  globalDefault: boolean,
  albumOverrides: Array<"on" | "off" | null | undefined>,
): boolean {
  const explicit = albumOverrides.filter((o): o is "on" | "off" => o === "on" || o === "off");
  if (explicit.length === 0) return globalDefault;
  return !explicit.includes("off");
}
