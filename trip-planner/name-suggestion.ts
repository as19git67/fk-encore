/**
 * A name for a trip nobody named (documentation/plans/reise-planen-und-unterwegs.md,
 * stage 1).
 *
 * "Neue Reise" does not ask for a name. When a trip has none, the local
 * model proposes one from its stays and its date — "Musterstadt im
 * November" — and it is written only while the trip still has none: a
 * name somebody typed is never replaced. Tapping the title changes it
 * like any other name, through the settings.
 */

import { api, APIError } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import { requirePermission } from "../user/auth-handler";
import { askForJson, LlmServiceUnavailableError } from "./llm-client";
import { requireOrganiser } from "./plan-access";
import { loadPlan, renamePlan, type StoredPlan } from "./plan-store";

/** Longer than this is a sentence, not a name. */
export const MAX_NAME_LENGTH = 40;
const NAME_TIMEOUT_MS = 20_000;

const MONTHS = [
  "Januar", "Februar", "März", "April", "Mai", "Juni",
  "Juli", "August", "September", "Oktober", "November", "Dezember",
];

export interface NameSuggestionRequest {
  planId: number;
}

export interface NameSuggestionResponse {
  /** The trip's name now: the one it had, or the one just proposed. */
  title: string | null;
  /** Whether this call wrote it. False when the trip already had a name. */
  written: boolean;
}

export const suggestTripName = api(
  { expose: true, method: "POST", path: "/trip-planner/plans/:planId/name-suggestion", auth: true },
  async (req: NameSuggestionRequest): Promise<NameSuggestionResponse> => {
    const userId = requireUser();
    const plan = await loadPlan(req.planId, userId);
    if (!plan) throw APIError.notFound("plan not found");
    await requireOrganiser(req.planId, userId, "Den Namen der Reise");
    if (plan.title?.trim()) return { title: plan.title, written: false };

    let answer: unknown;
    try {
      answer = await askForJson(buildNamePrompt(plan), NAME_TIMEOUT_MS, { maxTokens: 128 });
    } catch (err) {
      if (err instanceof LlmServiceUnavailableError) {
        throw APIError.unavailable("das lokale Modell ist gerade nicht erreichbar");
      }
      throw err;
    }
    const name = parseName(answer);
    if (!name) return { title: null, written: false };

    // Somebody may have typed a name while the model was thinking.
    const again = await loadPlan(req.planId, userId);
    if (again?.title?.trim()) return { title: again.title, written: false };
    await renamePlan(req.planId, plan.ownerId, name);
    return { title: name, written: true };
  },
);

/** What the model is told: the stays in order and when the trip starts. */
export function buildNamePrompt(plan: Pick<StoredPlan, "legs">): string {
  const stays = [...plan.legs]
    .filter((leg) => leg.kind !== "transit")
    .sort((a, b) => a.position - b.position);
  const places = stays.map((leg) => `- ${leg.title?.trim() || leg.anchorLabel?.trim() || "ohne Namen"} (${Math.max(1, leg.days.length)} Tage)`);
  const start = stays[0]?.startDate ?? null;
  const when = start ? `Die Reise beginnt im ${MONTHS[Number(start.slice(5, 7)) - 1]} ${start.slice(0, 4)}.` : "Die Reise hat noch kein Datum.";
  return [
    "Schlage einen kurzen deutschen Namen für eine Reise vor.",
    "Höchstens vier Wörter, ohne Anführungszeichen, ohne Jahreszahl, ohne Emoji.",
    "Nenne nur Orte, die unten stehen. Bei mehreren Orten den wichtigsten oder zwei.",
    "Mit Datum darf der Monat vorkommen, etwa „Musterstadt im November“.",
    "",
    "Aufenthalte:",
    ...places,
    "",
    when,
    "",
    'Antworte nur mit JSON: {"name": "..."}',
  ].join("\n");
}

/** The name out of the model's answer, or null when there is none worth keeping. */
export function parseName(answer: unknown): string | null {
  if (!answer || typeof answer !== "object") return null;
  const raw = (answer as { name?: unknown }).name;
  if (typeof raw !== "string") return null;
  const name = raw.replace(/["„“”'«»]/g, "").replace(/\s+/g, " ").trim();
  if (name.length === 0 || name.length > MAX_NAME_LENGTH) return null;
  return name;
}

function requireUser(): number {
  const auth = getAuthData();
  if (!auth) throw APIError.unauthenticated("Unauthorized");
  requirePermission(auth, "photos.view");
  return parseInt(auth.userID, 10);
}
