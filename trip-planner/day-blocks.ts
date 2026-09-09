/**
 * Changing the shape of a day (§4.1).
 *
 * "Der Regelfall bleibt vorhersehbar und ohne Konfiguration" — four
 * blocks, nobody has to think about them. But §4.1 promises the other
 * half in the same breath: each one can be renamed, split, merged or
 * struck out. Until now none of that was possible after a trip was
 * created, so a family that never stops for a sit-down lunch carried a
 * ninety-minute meal block through a fortnight.
 *
 * Replace-all rather than a patch per block, because a day *is* the
 * ordered list: "move the break earlier" or "merge the two afternoons"
 * are statements about the list, and expressing them as a sequence of
 * per-block edits would leave a moment in between where the day makes
 * no sense.
 *
 * The trip is re-planned afterwards, for the reason a settings change
 * is: block budgets decide what fits, so a stored shape that left the
 * days alone would be a screen with nothing behind it. And it is
 * refused once a stop is ticked off — a begun day is a record, and
 * rewriting its frame would rewrite what happened.
 *
 * Reserved for the organiser (§6.2): the shape of the day is the frame.
 */

import { api, APIError } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import { requirePermission } from "../user/auth-handler";
import { DEFAULT_DAY } from "./blocks";
import { dayShapeOf, validateDayShape, type BlockShapeInput } from "./day-shape";
import { requireOrganiser } from "./plan-access";
import { loadPlan } from "./plan-store";
import { replanAfterFrameChange, type PlanResponse } from "./plans";

export interface DayShapeResponse {
  /** The day as it stands: the default four, or what somebody drew. */
  blocks: Array<{ id: string; label: string; kind: string; baseBudgetMinutes: number }>;
  /** True while the trip still uses the default shape. */
  isDefault: boolean;
}

export interface SetDayShapeRequest {
  planId: number;
  /** The whole day, in order. */
  blocks: BlockShapeInput[];
}

export const getTripDayShape = api(
  { expose: true, method: "GET", path: "/trip-planner/plans/:planId/blocks", auth: true },
  async (req: { planId: number }): Promise<DayShapeResponse> => {
    const userId = requireUser();
    const plan = await loadPlan(req.planId, userId);
    if (!plan) throw APIError.notFound("plan not found");

    const blocks = dayShapeOf(plan.constraints as Record<string, unknown>);
    return {
      blocks: blocks.map((block) => ({ ...block })),
      isDefault: blocks === DEFAULT_DAY,
    };
  },
);

export const setTripDayShape = api(
  { expose: true, method: "PATCH", path: "/trip-planner/plans/:planId/blocks", auth: true },
  async (req: SetDayShapeRequest): Promise<PlanResponse> => {
    const userId = requireUser();
    await requireOrganiser(req.planId, userId, "Der Tagesablauf");

    const plan = await loadPlan(req.planId, userId);
    if (!plan) throw APIError.notFound("plan not found");

    const blocks = validateDayShape(req.blocks);
    const constraints = {
      ...(plan.constraints as Record<string, unknown>),
      blocks: blocks.map((block) => ({ ...block })),
    };

    return await replanAfterFrameChange(plan, userId, constraints);
  },
);

function requireUser(): number {
  const auth = getAuthData();
  if (!auth) throw APIError.unauthenticated("Unauthorized");
  requirePermission(auth, "photos.view");
  return parseInt(auth.userID, 10);
}
