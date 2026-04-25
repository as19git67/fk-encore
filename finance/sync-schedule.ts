/**
 * CRUD for `finance_bankcontact.sync_times`.
 *
 * Feeds `SyncScheduleView` (see finance-frontend.md §4.3). The sync
 * cron (`statements-cron.ts`) reads the same JSONB field on every
 * tick to decide which bankcontacts are due.
 *
 * Permission: `finance.accounts.manage`.
 */

import { api, APIError } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import { eq } from "drizzle-orm";

import { requirePermission } from "../user/auth-handler";
import db from "../db/database";
import {
  financeBankcontact,
  type FinanceSyncSlot,
} from "../db/schema";

console.log("[boot] finance/sync-schedule.ts: all imports resolved");

// -----------------------------------------------------------------------
// Validation
// -----------------------------------------------------------------------

const WEEKDAY_MIN = 0;
const WEEKDAY_MAX = 6;
const TIME_REGEX = /^([01]\d|2[0-3]):[0-5]\d$/;

function validateSlot(slot: unknown, index: number): FinanceSyncSlot {
  if (!slot || typeof slot !== "object") {
    throw APIError.invalidArgument(`slots[${index}] must be an object`);
  }
  const s = slot as Record<string, unknown>;
  if (!Array.isArray(s.weekdays) || s.weekdays.length === 0) {
    throw APIError.invalidArgument(
      `slots[${index}].weekdays must be a non-empty array`,
    );
  }
  const weekdays: number[] = [];
  const seen = new Set<number>();
  for (const day of s.weekdays) {
    if (
      typeof day !== "number" ||
      !Number.isInteger(day) ||
      day < WEEKDAY_MIN ||
      day > WEEKDAY_MAX
    ) {
      throw APIError.invalidArgument(
        `slots[${index}].weekdays entries must be integers in [${WEEKDAY_MIN}, ${WEEKDAY_MAX}]`,
      );
    }
    if (!seen.has(day)) {
      seen.add(day);
      weekdays.push(day);
    }
  }
  weekdays.sort((a, b) => a - b);

  if (typeof s.time !== "string" || !TIME_REGEX.test(s.time)) {
    throw APIError.invalidArgument(
      `slots[${index}].time must match HH:MM (24h)`,
    );
  }

  if (typeof s.tz !== "string" || s.tz.trim().length === 0) {
    throw APIError.invalidArgument(
      `slots[${index}].tz must be a non-empty IANA time zone`,
    );
  }
  // Sanity-check the zone via Intl.DateTimeFormat — unknown zones throw.
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: s.tz }).format(new Date());
  } catch {
    throw APIError.invalidArgument(
      `slots[${index}].tz '${s.tz}' is not a recognised IANA time zone`,
    );
  }

  return {
    weekdays,
    time: s.time,
    tz: s.tz.trim(),
  };
}

// -----------------------------------------------------------------------
// GET
// -----------------------------------------------------------------------

interface IdParams {
  id: number;
}

interface ScheduleResponse {
  bankcontact_id: number;
  slots: FinanceSyncSlot[];
}

export const getSchedule = api(
  {
    expose: true,
    method: "GET",
    path: "/finance/bankcontacts/:id/schedule",
    auth: true,
  },
  async ({ id }: IdParams): Promise<ScheduleResponse> => {
    const auth = getAuthData()!;
    requirePermission(auth, "finance.accounts.manage");

    const [row] = await db
      .select({ id: financeBankcontact.id, sync_times: financeBankcontact.sync_times })
      .from(financeBankcontact)
      .where(eq(financeBankcontact.id, id))
      .limit(1);
    if (!row) throw APIError.notFound(`bankcontact ${id} not found`);

    return {
      bankcontact_id: row.id,
      slots: (row.sync_times as FinanceSyncSlot[]) ?? [],
    };
  },
);

// -----------------------------------------------------------------------
// PUT (replace the whole slot list)
// -----------------------------------------------------------------------

interface PutParams {
  id: number;
  slots: Array<{
    weekdays: number[];
    time: string;
    tz: string;
  }>;
}

export const putSchedule = api(
  {
    expose: true,
    method: "PUT",
    path: "/finance/bankcontacts/:id/schedule",
    auth: true,
  },
  async (p: PutParams): Promise<ScheduleResponse> => {
    const auth = getAuthData()!;
    requirePermission(auth, "finance.accounts.manage");

    if (!Array.isArray(p.slots)) {
      throw APIError.invalidArgument("slots must be an array");
    }

    const normalised = p.slots.map((slot, i) => validateSlot(slot, i));

    const [row] = await db
      .update(financeBankcontact)
      .set({ sync_times: normalised })
      .where(eq(financeBankcontact.id, p.id))
      .returning({
        id: financeBankcontact.id,
        sync_times: financeBankcontact.sync_times,
      });
    if (!row) throw APIError.notFound(`bankcontact ${p.id} not found`);

    return {
      bankcontact_id: row.id,
      slots: (row.sync_times as FinanceSyncSlot[]) ?? [],
    };
  },
);
