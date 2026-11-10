/**
 * Deciding that a spot was actually visited (§6.4).
 *
 * Three signals arrive from the device — how long the group stayed, a
 * photo the POI matcher tied to the place, a payment in the window —
 * and this module turns them into one of two outcomes:
 *
 *   - **A long enough stay sets the status by itself**
 *     (reise-planen-und-unterwegs.md, stage 5): the group stood there
 *     for the threshold below, and every check can be undone ("Doch
 *     nicht", "Nicht besucht").
 *   - **A photo or a payment alone is a suggestion** ("wart ihr hier?
 *     ✓ / ✗"): either is taken from the pavement as easily as inside.
 *   - **Two signals set the status silently**, as before.
 *
 * The asymmetry is deliberate: a wrong tick costs one tap to undo,
 * while a false alarm interrupts a holiday.
 *
 * Everything is pure — minutes and signal names in, a verdict out. No
 * clock, no coordinates, no database. The position itself never reaches
 * this module, let alone the server: the concept keeps location on the
 * device and sends only the event "X was at Y" (§7.1).
 */

/** Ten minutes, the floor under every dwell threshold (§6.4). */
export const MIN_DWELL_MINUTES = 10;

/**
 * A quarter of the planned stay. For a ninety-minute museum that is
 * twenty-three minutes, which is what makes "walking past a museum is
 * not a visit" true; for a twenty-minute viewpoint it is five, which is
 * why the ten-minute floor exists.
 */
export const DWELL_FRACTION = 0.25;

/**
 * A spot between two others on the route is passed anyway, so standing
 * near it proves less. Half again as long before it counts.
 */
export const ON_THE_WAY_FACTOR = 1.5;

export type VisitSignal = "dwell" | "photo" | "payment" | "manual";

export type VisitVerdict =
  /** Nothing happened worth recording. */
  | "none"
  /** Ask: "wart ihr hier?" */
  | "suggested"
  /** A long enough stay, or two signals agreeing; set it and say so quietly. */
  | "confirmed";

export interface DwellThresholdOptions {
  /** What the plan allowed for this spot. */
  plannedDwellMinutes: number;
  /**
   * True when the spot sits between two others on the day's route. The
   * group walks past it either way, so presence says less.
   */
  onTheWay?: boolean;
}

/**
 * How long the group has to stay before a stop counts as visited.
 *
 * The larger of ten minutes and a quarter of the planned stay — not the
 * smaller. A quarter alone would let two minutes count at a viewpoint;
 * ten minutes alone would let a stroll through a museum's forecourt
 * count as having seen it.
 */
export function dwellThresholdMinutes(opts: DwellThresholdOptions): number {
  const planned = Number.isFinite(opts.plannedDwellMinutes)
    ? Math.max(0, opts.plannedDwellMinutes)
    : 0;
  const base = Math.max(MIN_DWELL_MINUTES, planned * DWELL_FRACTION);
  return Math.round(opts.onTheWay ? base * ON_THE_WAY_FACTOR : base);
}

export interface VisitEvidence {
  /** Minutes spent at the spot, as the device measured them. */
  dwellMinutes?: number;
  /** A photo the POI matcher tied to this spot (§6.4, signal 2). */
  hasMatchingPhoto?: boolean;
  /** A receipt or card payment in the window (§6.4, signal 3). */
  hasPayment?: boolean;
  /** The traveller said so. Always enough on its own. */
  manual?: boolean;
}

export interface VisitAssessment {
  verdict: VisitVerdict;
  /** Which signals fired, in a stable order — the "why" of the verdict. */
  signals: VisitSignal[];
  /** The threshold the dwell was measured against, for the explanation. */
  thresholdMinutes: number;
}

/**
 * Weigh the evidence for one spot.
 *
 * A short stay is not a signal at all rather than a weak one: half the
 * threshold is what walking past looks like, and counting it as "half a
 * signal" would let a photo taken from the pavement confirm a visit.
 */
export function assessVisit(
  evidence: VisitEvidence,
  opts: DwellThresholdOptions,
): VisitAssessment {
  const thresholdMinutes = dwellThresholdMinutes(opts);
  const signals: VisitSignal[] = [];

  if ((evidence.dwellMinutes ?? 0) >= thresholdMinutes) signals.push("dwell");
  if (evidence.hasMatchingPhoto) signals.push("photo");
  if (evidence.hasPayment) signals.push("payment");
  if (evidence.manual) signals.push("manual");

  // The traveller saying so outranks any amount of inference.
  if (evidence.manual) return { verdict: "confirmed", signals, thresholdMinutes };

  // Standing there long enough is a visit on its own; a photo or a
  // payment alone only asks.
  const verdict: VisitVerdict =
    signals.length >= 2 || signals.includes("dwell")
      ? "confirmed"
      : signals.length === 1 ? "suggested" : "none";
  return { verdict, signals, thresholdMinutes };
}

/**
 * Whether a spot lies between two others on the route, for the raised
 * threshold above.
 *
 * "Between" means in the middle of the sequence, not geometrically on
 * the line: the day is walked in order, so the spots either side of it
 * are what the group passes it between. A geometric test would also
 * catch a spot the route happens to point at from a distance.
 */
export function isOnTheWay(orderedRefs: readonly string[], osmRef: string): boolean {
  const index = orderedRefs.indexOf(osmRef);
  return index > 0 && index < orderedRefs.length - 1;
}
