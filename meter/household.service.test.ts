import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { getAuthData } from "~encore/auth";
import { eq } from "drizzle-orm";

import db from "../db/database";
import { groupMembers, groups, meterHomeLocations, users } from "../db/schema";
import {
  createMeter,
  deleteMeter,
  getMeterDetail,
  listMeters,
  replaceDevice,
  updateMeter,
} from "./meter.service";
import { addReading } from "./readings.service";
import { createApiKey } from "./api-keys.service";
import { createElectricityTariff, listElectricityTariffs } from "./tariffs.service";
import { getHomeLocation, setHomeLocation, userIdsWithHomeLocation } from "./degree-days.service";
import { userIdsWithChargingMeter } from "./fuel-prices.service";
import {
  getHouseholdState,
  resolveSettingsScope,
  setHousehold,
  shareMetersWithHousehold,
} from "./household.service";

const cleanupUserIds: number[] = [];
const cleanupGroupIds: number[] = [];

async function createUser(label: string): Promise<number> {
  const [row] = await db
    .insert(users)
    .values({
      email: `household-test-${label}-${Date.now()}-${Math.random()}@example.test`,
      name: `Tester ${label}`,
      password_hash: "x",
    })
    .returning({ id: users.id });
  cleanupUserIds.push(row.id);
  return row.id;
}

async function createGroup(ownerId: number, memberIds: number[]): Promise<number> {
  const [row] = await db
    .insert(groups)
    .values({ slug: `household-${Date.now()}-${Math.random()}`, name: "Familie" })
    .returning({ id: groups.id });
  cleanupGroupIds.push(row.id);
  await db.insert(groupMembers).values({ group_id: row.id, user_id: ownerId, role: "owner" });
  for (const userId of memberIds) {
    await db.insert(groupMembers).values({ group_id: row.id, user_id: userId, role: "member" });
  }
  return row.id;
}

function waterMeter(name: string, groupId?: number | null) {
  return {
    name,
    type: "water" as const,
    unit: "m³",
    ...(groupId !== undefined ? { groupId } : {}),
    device: { installedAt: "2025-01-01T00:00:00Z", startValue: 0 },
  };
}

let owner: number;
let member: number;
let outsider: number;
let groupId: number;

beforeEach(async () => {
  vi.mocked(getAuthData).mockReturnValue({ userID: "0", permissions: [] });
  owner = await createUser("owner");
  member = await createUser("member");
  outsider = await createUser("outsider");
  groupId = await createGroup(owner, [member]);
});

afterEach(async () => {
  for (const id of cleanupUserIds.splice(0)) {
    await db.delete(users).where(eq(users.id, id));
  }
  for (const id of cleanupGroupIds.splice(0)) {
    await db.delete(groups).where(eq(groups.id, id));
  }
  vi.restoreAllMocks();
});

describe("setHousehold", () => {
  it("lets an owner of the group mark it, and every member then shares it", async () => {
    const state = await setHousehold(owner, groupId);
    expect(state.household).toMatchObject({ id: groupId, myRole: "owner" });
    expect(await resolveSettingsScope(member)).toMatchObject({ kind: "household", groupId });
    expect(await resolveSettingsScope(outsider)).toEqual({ kind: "personal", userId: outsider });
  });

  it("refuses a plain member", async () => {
    await expect(setHousehold(member, groupId)).rejects.toMatchObject({ code: "permission_denied" });
  });

  it("refuses a group the caller is not in", async () => {
    await expect(setHousehold(outsider, groupId)).rejects.toMatchObject({ code: "not_found" });
  });

  it("brings the owner's personal tariffs and home location into an empty household", async () => {
    await createElectricityTariff(owner, {
      kind: "sewage_price",
      validFrom: "2024-01-01",
      amount: 2.79,
      unit: "eur_per_m3",
    });
    await setHomeLocation(owner, { label: "Musterstadt", lat: 50, lon: 10, source: "manual" });

    await setHousehold(owner, groupId);

    const tariffs = await listElectricityTariffs(member);
    expect(tariffs.map((t) => t.kind)).toEqual(["sewage_price"]);
    expect((await getHomeLocation(member))?.label).toBe("Musterstadt");
  });

  it("unmarks the household with null", async () => {
    await setHousehold(owner, groupId);
    await expect(setHousehold(member, null)).rejects.toMatchObject({ code: "permission_denied" });
    const state = await setHousehold(owner, null);
    expect(state.household).toBeNull();
    expect(await resolveSettingsScope(member)).toEqual({ kind: "personal", userId: member });
  });
});

describe("meters in a household", () => {
  beforeEach(async () => {
    await setHousehold(owner, groupId);
  });

  it("shares a new meter with the household unless it is made private", async () => {
    const shared = await createMeter(owner, waterMeter("Wasser Haupt"));
    const own = await createMeter(owner, waterMeter("Wasser Garten", null));

    const seen = await listMeters(member);
    expect(seen.map((m) => m.id)).toEqual([shared.id]);
    expect(seen[0]).toMatchObject({
      household: true,
      groupName: "Familie",
      ownerUserId: owner,
      ownerName: "Tester owner",
      canManage: false,
    });
    expect((await listMeters(outsider)).map((m) => m.id)).not.toContain(own.id);
    expect((await listMeters(owner)).find((m) => m.id === own.id)?.canManage).toBe(true);
  });

  it("lets members enter readings but keeps structural changes with the owners", async () => {
    const { id } = await createMeter(member, waterMeter("Wasser Haupt"));
    const other = await createMeter(owner, waterMeter("Strom"));

    await expect(addReading(owner, id, { value: 5, takenAt: "2025-02-01T00:00:00Z" })).resolves.toBeDefined();
    await expect(addReading(member, other.id, { value: 3, takenAt: "2025-02-01T00:00:00Z" })).resolves.toBeDefined();

    // The group owner may change a member's shared meter …
    await updateMeter(owner, id, { ...waterMeter("Wasser Haus"), groupId });
    expect((await getMeterDetail(member, id)).name).toBe("Wasser Haus");

    // … a member may not change the owner's.
    await expect(updateMeter(member, other.id, { ...waterMeter("x"), groupId })).rejects.toMatchObject({
      code: "permission_denied",
    });
    await expect(deleteMeter(member, other.id)).rejects.toMatchObject({ code: "permission_denied" });
    await expect(
      replaceDevice(member, other.id, { swapAt: "2025-03-01T00:00:00Z", finalValue: 4 }),
    ).rejects.toMatchObject({ code: "permission_denied" });
    await expect(createApiKey(member, other.id, "Shelly")).rejects.toMatchObject({
      code: "permission_denied",
    });
  });

  it("shares every private meter of the caller at once", async () => {
    await createMeter(member, waterMeter("Eins", null));
    await createMeter(member, waterMeter("Zwei", null));
    expect((await getHouseholdState(member)).privateMeterCount).toBe(2);

    expect(await shareMetersWithHousehold(member)).toEqual({ shared: 2 });
    expect((await listMeters(owner)).map((m) => m.name).sort()).toEqual(["Eins", "Zwei"]);
    expect((await getHouseholdState(member)).privateMeterCount).toBe(0);
  });

  it("gives every member the same tariffs and home location", async () => {
    await createElectricityTariff(member, {
      kind: "sewage_price",
      validFrom: "2024-01-01",
      amount: 2.5,
      unit: "eur_per_m3",
    });
    await setHomeLocation(owner, { label: "Musterstadt", lat: 50, lon: 10, source: "manual" });

    expect(await listElectricityTariffs(owner)).toEqual(await listElectricityTariffs(member));
    expect(await getHomeLocation(member)).toEqual(await getHomeLocation(owner));
    expect(await listElectricityTariffs(outsider)).toEqual([]);
    expect(await getHomeLocation(outsider)).toBeNull();
  });

  it("runs the daily jobs once per household", async () => {
    await setHomeLocation(member, { label: "Musterstadt", lat: 50, lon: 10, source: "manual" });
    const home = await db
      .select()
      .from(meterHomeLocations)
      .where(eq(meterHomeLocations.group_id, groupId));
    expect(home).toHaveLength(1);

    const audience = await userIdsWithHomeLocation();
    expect(audience.filter((id) => id === owner || id === member)).toEqual([owner]);

    await createMeter(owner, { ...waterMeter("Wallbox"), type: "electricity", role: "ev_charger_total" });
    await createMeter(member, { ...waterMeter("Wallbox 2"), type: "electricity", role: "ev_charger_total" });
    const charging = await userIdsWithChargingMeter();
    expect(charging.filter((id) => id === owner || id === member)).toHaveLength(1);
  });
});
