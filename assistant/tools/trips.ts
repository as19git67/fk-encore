/**
 * Trip-planner read tool.
 *
 * The one tool that does not go through `~encore/clients`: the service is
 * called `trip-planner`, and the client name Encore generates for a hyphenated
 * service cannot be checked without the Encore CLI. So it reads through the
 * plan store's own query with the same check the endpoint makes
 * (`photos.view`, plans the user organises or was invited to) — the same
 * rows `GET /trip-planner/plans` returns, never more.
 */

import { requirePermission } from "../../user/auth-handler";
import { listPlans } from "../../trip-planner/plan-store";
import { digestOf, int, table } from "../format";
import type { ToolSpec } from "../types";

interface PlanSummary { id: number; title: string | null; legTitles: (string | null)[]; dayCount: number; startDate: string | null; updatedAt: string }

export const listTripPlans: ToolSpec = {
  name: "list_trip_plans",
  kind: "read",
  summary: "Trip plans from the trip planner with legs, start date and length in days.",
  permissions: ["photos.view"],
  source: "hand",
  parameters: {
    type: "object",
    properties: { year: { type: "integer", description: "only plans starting in this year; leave out for every plan, e.g. for trips being planned now, which may start next year" } },
  },
  async run(args, ctx) {
    const year = int(args.year);
    requirePermission({ userID: ctx.user.userID, permissions: ctx.user.permissions }, "photos.view");
    const plans: PlanSummary[] = await listPlans(Number(ctx.user.userID));
    const rows = plans.filter((p) => year === undefined || (p.startDate !== null && Number(p.startDate.slice(0, 4)) === year));
    return {
      text: table(
        ["id", "title", "legs", "start", "days"],
        rows.map((p) => [p.id, p.title, p.legTitles.filter(Boolean).join(" → "), p.startDate?.slice(0, 10), p.dayCount]),
        { cap: 30 },
      ),
      digest: digestOf("list_trip_plans", rows.length, rows.map((p) => p.id)),
      rowCount: rows.length,
      block: {
        kind: "trip_plans",
        tool: "list_trip_plans",
        rows: rows.map((p) => ({ id: p.id, title: p.title, legs: p.legTitles, start_date: p.startDate, day_count: p.dayCount })),
      },
    };
  },
};

export const TRIP_TOOLS = [listTripPlans];
