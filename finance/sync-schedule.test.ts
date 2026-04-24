import { describe, it, expect, beforeEach, vi } from "vitest";
import { getAuthData } from "~encore/auth";
import { eq } from "drizzle-orm";

import db from "../db/database";
import { financeBankcontact } from "../db/schema";
import { getSchedule, putSchedule } from "./sync-schedule";

function setAuth(userID: string, perms: string[]) {
  vi.mocked(getAuthData).mockReturnValue({ userID, permissions: perms });
}

beforeEach(async () => {
  await db.delete(financeBankcontact);
  setAuth("1", []);
});

async function insertBankcontact(): Promise<number> {
  const [row] = await db
    .insert(financeBankcontact)
    .values({
      name: "Test",
      blz: "1",
      login: "u",
      server_url: "https://x",
    })
    .returning({ id: financeBankcontact.id });
  return row.id;
}

describe("finance/sync-schedule — GET", () => {
  it("returns an empty list for a fresh bankcontact", async () => {
    setAuth("1", ["finance.accounts.manage"]);
    const id = await insertBankcontact();
    const result = await getSchedule({ id });
    expect(result).toEqual({ bankcontact_id: id, slots: [] });
  });

  it("404s for unknown bankcontact", async () => {
    setAuth("1", ["finance.accounts.manage"]);
    await expect(getSchedule({ id: 999_999 })).rejects.toThrow(/not found/);
  });

  it("requires finance.accounts.manage", async () => {
    setAuth("1", []);
    const id = await insertBankcontact();
    await expect(getSchedule({ id })).rejects.toThrow(/permission/);
  });
});

describe("finance/sync-schedule — PUT (replace)", () => {
  it("accepts a valid slot and persists it", async () => {
    setAuth("1", ["finance.accounts.manage"]);
    const id = await insertBankcontact();
    const result = await putSchedule({
      id,
      slots: [
        { weekdays: [1, 2, 3, 4, 5], time: "06:25", tz: "Europe/Berlin" },
      ],
    });
    expect(result.slots).toHaveLength(1);
    expect(result.slots[0].time).toBe("06:25");

    const [row] = await db
      .select({ sync_times: financeBankcontact.sync_times })
      .from(financeBankcontact)
      .where(eq(financeBankcontact.id, id));
    expect((row.sync_times as any[])[0].weekdays).toEqual([1, 2, 3, 4, 5]);
  });

  it("normalises weekdays (dedup + sort)", async () => {
    setAuth("1", ["finance.accounts.manage"]);
    const id = await insertBankcontact();
    const result = await putSchedule({
      id,
      slots: [
        { weekdays: [5, 1, 1, 3], time: "09:00", tz: "Europe/Berlin" },
      ],
    });
    expect(result.slots[0].weekdays).toEqual([1, 3, 5]);
  });

  it("replaces the full list (empty array wipes everything)", async () => {
    setAuth("1", ["finance.accounts.manage"]);
    const id = await insertBankcontact();
    await putSchedule({
      id,
      slots: [{ weekdays: [1], time: "10:00", tz: "Europe/Berlin" }],
    });
    const result = await putSchedule({ id, slots: [] });
    expect(result.slots).toEqual([]);
  });

  it("rejects weekdays out of range", async () => {
    setAuth("1", ["finance.accounts.manage"]);
    const id = await insertBankcontact();
    await expect(
      putSchedule({
        id,
        slots: [{ weekdays: [7], time: "06:25", tz: "Europe/Berlin" }],
      }),
    ).rejects.toThrow(/weekdays/);
  });

  it("rejects malformed time", async () => {
    setAuth("1", ["finance.accounts.manage"]);
    const id = await insertBankcontact();
    await expect(
      putSchedule({
        id,
        slots: [{ weekdays: [1], time: "25:99", tz: "Europe/Berlin" }],
      }),
    ).rejects.toThrow(/HH:MM/);
  });

  it("rejects unknown timezone", async () => {
    setAuth("1", ["finance.accounts.manage"]);
    const id = await insertBankcontact();
    await expect(
      putSchedule({
        id,
        slots: [{ weekdays: [1], time: "06:25", tz: "Europe/Bogus" }],
      }),
    ).rejects.toThrow(/IANA/);
  });

  it("404s for unknown bankcontact", async () => {
    setAuth("1", ["finance.accounts.manage"]);
    await expect(
      putSchedule({
        id: 999_999,
        slots: [{ weekdays: [1], time: "06:25", tz: "Europe/Berlin" }],
      }),
    ).rejects.toThrow(/not found/);
  });

  it("requires finance.accounts.manage", async () => {
    setAuth("1", []);
    const id = await insertBankcontact();
    await expect(
      putSchedule({
        id,
        slots: [{ weekdays: [1], time: "06:25", tz: "Europe/Berlin" }],
      }),
    ).rejects.toThrow(/permission/);
  });
});
