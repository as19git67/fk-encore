/**
 * Asking the browse a question instead of setting a filter (§3.1, §7.2).
 *
 * The interest chips answer "what kind of thing", which is what a
 * category is for. They cannot answer the questions people actually
 * stand there asking — *it is raining, what now?* — and those are the
 * ones where this app has something Google Maps has not: it knows
 * whether a spot minds the wet and how long people stay, and it will
 * say so rather than rank a list by popularity.
 *
 * Three questions, and each is answerable from data already in hand:
 *
 *   - **Bei Regen** — `shelterOf` (§7.2), which derives indoor from the
 *     category and the OSM tag rather than from a field somebody has to
 *     maintain. „Teils überdacht" is kept and marked, not dropped: a
 *     market hall or a cloister genuinely is half an answer, and
 *     hiding it would send a family into the rain for want of a word.
 *   - **Bei schönem Wetter** — the same derivation, read the other way.
 *   - **Nur kurz** — the stay length the planner would allow. „Wir
 *     haben eine halbe Stunde" is a real question and the pool has
 *     always known the answer.
 *
 * ## What is deliberately not here
 *
 * **„Was ist am Montag offen?"** would need OpenStreetMap's
 * `opening_hours` syntax parsed, and half-understanding that grammar is
 * how a screen comes to promise a museum that is shut (§15.3). The raw
 * string is shown; it is not interpreted.
 *
 * **„Zur goldenen Stunde"** needs a date and the *place's* time zone,
 * neither of which a browse has — `lightWindows` says so itself. The
 * light belongs to a planned day, where both exist (§7.3).
 *
 * **„Was passt noch in Mittwochnachmittag?"** needs a block with a
 * budget, so it belongs to a trip's own search rather than to a browse
 * that deliberately has no trip.
 */

import { shelterOf } from "./shelter";

export type ExploreQuestion = "rain" | "fair" | "quick";

/** Short enough for a gap between two other things. */
export const QUICK_DWELL_MINUTES = 30;

export function isExploreQuestion(value: string): value is ExploreQuestion {
  return value === "rain" || value === "fair" || value === "quick";
}

export interface QuestionAnswer {
  /** Whether this spot is part of the answer at all. */
  keep: boolean;
  /**
   * Why, in the words the row shows. Null when the spot is kept for no
   * reason worth a line — which never happens today, and is here so a
   * later question can keep a spot silently rather than invent a note.
   */
  note: string | null;
  /**
   * Lower sorts earlier within the answer. A wholly indoor place beats
   * a half-covered one on a wet afternoon, and the ordering says so
   * instead of leaving the reader to work it out from the notes.
   */
  rank: number;
}

/** What this spot has to say about the question, if anything. */
export function answer(
  question: ExploreQuestion,
  spot: { category: string; kind?: string | null; dwellMinutes: number },
): QuestionAnswer {
  switch (question) {
    case "rain": return againstRain(spot);
    case "fair": return inFairWeather(spot);
    case "quick": return quickly(spot);
  }
}

function againstRain(spot: { category: string; kind?: string | null }): QuestionAnswer {
  switch (shelterOf(spot.category, spot.kind)) {
    case "indoor": return { keep: true, note: "innen", rank: 0 };
    // Kept and marked. A cloister is genuinely half an answer, and the
    // reader is better placed than the app to decide whether half is
    // enough for the rain that is actually falling.
    case "partly": return { keep: true, note: "teils überdacht", rank: 1 };
    default: return { keep: false, note: null, rank: 2 };
  }
}

function inFairWeather(spot: { category: string; kind?: string | null }): QuestionAnswer {
  switch (shelterOf(spot.category, spot.kind)) {
    case "outdoor": return { keep: true, note: "draußen", rank: 0 };
    case "partly": return { keep: true, note: "teils draußen", rank: 1 };
    default: return { keep: false, note: null, rank: 2 };
  }
}

function quickly(spot: { dwellMinutes: number }): QuestionAnswer {
  if (spot.dwellMinutes > QUICK_DWELL_MINUTES) return { keep: false, note: null, rank: 2 };
  return { keep: true, note: `etwa ${spot.dwellMinutes} Minuten`, rank: 0 };
}

/** What the chip says, for the sentence a screen shows when nothing matched. */
export function questionLabel(question: ExploreQuestion): string {
  switch (question) {
    case "rain": return "bei Regen";
    case "fair": return "bei schönem Wetter";
    case "quick": return "in einer halben Stunde";
  }
}
