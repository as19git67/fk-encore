/**
 * The vocabulary of a change (§6.3).
 *
 * Several devices, some offline, change the same trip. §6.3 answers
 * that with one decision — **the plan is never written as a whole** —
 * and the endpoints have worked that way from the start: every one of
 * them changes one thing. What this module adds is the *name* of each
 * such change, so a device can buffer them while it has no connection,
 * hand them over in order when it does, and everybody can see
 * afterwards who did what.
 *
 * Pure on purpose: what an operation is, whether its payload makes
 * sense, how to say it in a sentence, and what its inverse looks like.
 * Applying one is the service's business, and keeping the two apart is
 * what lets every rule below be a unit test.
 *
 * **Not every operation has an inverse, and that is said rather than
 * faked.** Putting a stop back into the pool re-solves the day around
 * the gap; the row is gone and the day is different. An "undo" that
 * planned something similar in roughly the same slot would be a new
 * decision wearing the word "undo", which is worse than a button that
 * politely refuses.
 */

/** The changes a device may buffer and replay. */
export type OpKind = "hide-spot" | "unhide-spot" | "vote" | "spot-note" | "stop-to-pool";

export const OP_KINDS: readonly OpKind[] = [
  "hide-spot",
  "unhide-spot",
  "vote",
  "spot-note",
  "stop-to-pool",
];

export interface Op {
  /**
   * Minted on the device before the operation is sent, so a batch that
   * arrives twice — the dropped connection this whole mechanism exists
   * for — is recognised instead of applied again.
   */
  clientOpId: string;
  kind: OpKind;
  payload: Record<string, unknown>;
}

export function isOpKind(value: unknown): value is OpKind {
  return typeof value === "string" && (OP_KINDS as readonly string[]).includes(value);
}

/**
 * What a payload must carry, per operation.
 *
 * Checked here rather than at the endpoint each op dispatches to: a
 * batch is applied in order, and one malformed entry in the middle
 * should be refused before anything is written, not halfway through.
 */
export function validatePayload(kind: OpKind, payload: Record<string, unknown>): string | null {
  switch (kind) {
    case "hide-spot":
    case "unhide-spot":
      return typeof payload.osmRef === "string" && payload.osmRef.trim() !== ""
        ? null
        : "osmRef is required";
    case "vote":
      if (typeof payload.osmRef !== "string" || payload.osmRef.trim() === "") {
        return "osmRef is required";
      }
      return typeof payload.value === "string" ? null : "value is required";
    case "spot-note":
      if (typeof payload.osmRef !== "string" || payload.osmRef.trim() === "") {
        return "osmRef is required";
      }
      return Number.isInteger(payload.legIndex) ? null : "legIndex is required";
    case "stop-to-pool":
      return Number.isInteger(payload.stopId) ? null : "stopId is required";
  }
}

/**
 * Does undoing this mean anything exact?
 *
 * The three that do are the ones that replace a value: hiding, voting
 * and noting all have a "before" the journal can keep. Taking a stop
 * off a day re-solves the day around the gap, and no record of the
 * previous arrangement would make putting it back the same trip again.
 */
export function isUndoable(kind: OpKind): boolean {
  return kind !== "stop-to-pool";
}

/**
 * The operation that undoes this one, given what it replaced.
 *
 * `previous` is what the journal captured before the operation ran —
 * null when there was nothing there before, which is itself an answer:
 * undoing a first vote means removing it, not writing "egal".
 */
export function inverseOf(
  kind: OpKind,
  payload: Record<string, unknown>,
  previous: Record<string, unknown> | null,
): { kind: OpKind; payload: Record<string, unknown> } | null {
  switch (kind) {
    case "hide-spot":
      return { kind: "unhide-spot", payload: { osmRef: payload.osmRef } };
    case "unhide-spot":
      return { kind: "hide-spot", payload: { osmRef: payload.osmRef } };
    case "vote":
      // No previous answer means the undo is "as if nobody had said
      // anything", and the nearest honest state for that is a shrug —
      // votes are not deletable, and inventing a "want" would be worse.
      return {
        kind: "vote",
        payload: {
          osmRef: payload.osmRef,
          forTravellerId: payload.forTravellerId,
          value: previous?.value ?? "meh",
          heart: previous?.heart ?? false,
        },
      };
    case "spot-note":
      return {
        kind: "spot-note",
        payload: {
          legIndex: payload.legIndex,
          osmRef: payload.osmRef,
          title: previous?.title ?? null,
          note: previous?.note ?? null,
          url: previous?.url ?? null,
          dwellMinutes: previous?.dwellMinutes ?? null,
          photoStop: previous?.photoStop ?? false,
        },
      };
    case "stop-to-pool":
      return null;
  }
}

/**
 * The journal line, in words (§6.3: "sichtbar bleibt, wer was geändert
 * hat").
 *
 * Names the spot rather than its OSM reference where the caller knows
 * it: a list of `node:4711` is a log, and a log is not what somebody
 * scrolls through to find out what their partner changed this morning.
 */
export function describe(
  kind: OpKind,
  payload: Record<string, unknown>,
  name?: string | null,
): string {
  // The name the payload carries is the one the trip knew when the
  // operation ran, and it is often the only one left: hiding a spot
  // takes it out of the pool, so looking it up afterwards finds
  // nothing. A journal that then says "way:34" is a log.
  const remembered = typeof payload.name === "string" ? payload.name : null;
  const what = name
    ?? remembered
    ?? (typeof payload.osmRef === "string" ? payload.osmRef : "einen Spot");
  switch (kind) {
    case "hide-spot":
      return `${what} für diese Reise ausgeblendet`;
    case "unhide-spot":
      return `${what} wieder aufgenommen`;
    case "vote":
      if (payload.heart === true) return `${what} zum Herzenswunsch gemacht`;
      if (payload.value === "want") return `${what}: will ich`;
      if (payload.value === "rather-not") return `${what}: lieber nicht`;
      return `${what}: egal`;
    case "spot-note":
      return `Notiz zu ${what} geändert`;
    case "stop-to-pool":
      return `${what} zurück in den Vorrat gelegt`;
  }
}
