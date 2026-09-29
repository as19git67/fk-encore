// Retirement forecast — endpoints for plan vs. actual (#1342). The logic is
// in forecast-snapshots.service.ts.

import { api, APIError } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import { eq } from "drizzle-orm";

import { requirePermission } from "../user/auth-handler";
import db from "../db/database";
import { financeForecastScenario } from "../db/schema";
import { defaultScenario, simulate } from "./forecast-engine";
import { resolveHousehold } from "./forecast-household.service";
import { loadHousehold, toEngineScenario } from "./forecast";
import {
  adoptLiving,
  deleteSnapshot,
  liquidNow,
  listSnapshots,
  loadActuals,
  takeSnapshot,
  wealthNow,
  type ActualsDto,
  type SnapshotDto,
} from "./forecast-snapshots.service";

console.log("[boot] finance/forecast-snapshots.ts: all imports resolved");

async function authed(mode: "view" | "edit") {
  const auth = getAuthData()!;
  requirePermission(auth, "finance.view");
  const access = await resolveHousehold(Number(auth.userID), auth.permissions.includes("finance.admin"));
  if (mode === "edit" && access.role === "view") throw APIError.permissionDenied("this forecast is shared with you read-only");
  return { userId: access.ownerId, access };
}

export interface PlanActualResponse {
  snapshots: SnapshotDto[];
  /** The household's wealth today, as the forecast starts from it. */
  now: { date: string; liquid: number; wealth: number };
  /** What the bookings of the last twelve months say; null without bookings. */
  actuals: ActualsDto | null;
}

/** GET /finance/forecast/plan-actual — snapshots against today, and the assumptions against the bookings. */
export const getPlanActual = api(
  { expose: true, method: "GET", path: "/finance/forecast/plan-actual", auth: true },
  async (): Promise<PlanActualResponse> => {
    const { userId, access } = await authed("view");
    const hh = await loadHousehold(userId, access);
    const nowIso = new Date().toISOString();
    const snapshots = await listSnapshots(userId, nowIso);
    let actuals: ActualsDto | null = null;
    if (hh.persons.length > 0) {
      const res = simulate({ persons: hh.persons, milestones: hh.milestones, items: hh.items, scenario: defaultScenario() });
      actuals = await loadActuals(userId, hh, res);
    }
    return { snapshots, now: { date: nowIso.slice(0, 10), liquid: liquidNow(hh.items), wealth: wealthNow(hh.items) }, actuals };
  },
);

interface TakeSnapshotRequest {
  /** A saved scenario; omitted = the default assumptions. */
  scenarioId?: number;
}

/** POST /finance/forecast/snapshots — keep what the scenario expects today. */
export const createSnapshot = api(
  { expose: true, method: "POST", path: "/finance/forecast/snapshots", auth: true },
  async (req: TakeSnapshotRequest): Promise<SnapshotDto> => {
    const { userId, access } = await authed("edit");
    const hh = await loadHousehold(userId, access);
    if (hh.persons.length === 0) throw APIError.failedPrecondition("add a person first");
    let scenario: { id: number; name: string; config: Record<string, unknown> } | null = null;
    if (req.scenarioId != null) {
      const [row] = await db
        .select({ id: financeForecastScenario.id, name: financeForecastScenario.name, config: financeForecastScenario.config, userId: financeForecastScenario.user_id })
        .from(financeForecastScenario)
        .where(eq(financeForecastScenario.id, req.scenarioId));
      if (!row || row.userId !== userId) throw APIError.notFound(`scenario ${req.scenarioId} not found`);
      scenario = row;
      // Guards the normalisation once: a broken config fails here, not in the cron.
      toEngineScenario(row.config, row.name, row.id);
    }
    return takeSnapshot(userId, hh, scenario, "manual");
  },
);

interface IdRequest {
  id: number;
}

/** DELETE /finance/forecast/snapshots/:id */
export const removeSnapshot = api(
  { expose: true, method: "DELETE", path: "/finance/forecast/snapshots/:id", auth: true },
  async ({ id }: IdRequest): Promise<void> => {
    const { userId } = await authed("edit");
    if (!(await deleteSnapshot(userId, id))) throw APIError.notFound(`snapshot ${id} not found`);
  },
);

interface AdoptRequest {
  /** The living-expense item to write to. */
  itemId: number;
  /** Spending per month from the bookings. */
  monthly: number;
}

/** POST /finance/forecast/actuals/adopt — take the actual spending into the plan. */
export const adoptActuals = api(
  { expose: true, method: "POST", path: "/finance/forecast/actuals/adopt", auth: true },
  async (req: AdoptRequest): Promise<void> => {
    const { userId } = await authed("edit");
    if (!(req.monthly >= 0) || req.monthly > 1_000_000) throw APIError.invalidArgument("monthly must be between 0 and 1 000 000");
    try {
      await adoptLiving(userId, req.itemId, req.monthly);
    } catch {
      throw APIError.notFound(`living expense item ${req.itemId} not found`);
    }
  },
);
