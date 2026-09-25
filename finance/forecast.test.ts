import { describe, it, expect, beforeEach, vi } from "vitest";
import { getAuthData } from "~encore/auth";
import { sql } from "drizzle-orm";

import db from "../db/database";
import {
  financeAccount,
  financeAccountAccess,
  financeAccountBalance,
  financeAccountType,
  financeCurrency,
  financeForecastItem,
  financeForecastMilestone,
  financeForecastPerson,
  financeForecastScenario,
  users,
} from "../db/schema";
import {
  createItem,
  createMilestone,
  createPerson,
  createScenario,
  deleteItem,
  deletePerson,
  getForecast,
  runSimulation,
  toEngineScenario,
  updateItem,
  updateMilestone,
  updatePerson,
  updateScenario,
} from "./forecast";

// Every name, date and amount below is made up.

function setAuth(userID: string, perms: string[]) {
  vi.mocked(getAuthData).mockReturnValue({ userID, permissions: perms });
}

async function ensureUser(id: number): Promise<void> {
  await db.execute(
    sql`INSERT INTO users (id, email, name, password_hash) VALUES (${id}, ${`u${id}@test.local`}, ${`User${id}`}, 'x') ON CONFLICT (id) DO NOTHING`,
  );
}

beforeEach(async () => {
  await db.delete(financeForecastScenario);
  await db.delete(financeForecastItem);
  await db.delete(financeForecastMilestone);
  await db.delete(financeForecastPerson);
  await db.delete(financeAccountBalance);
  await db.delete(financeAccountAccess);
  await db.delete(financeAccount);
  await db.delete(users);
  await ensureUser(1);
  await ensureUser(2);
  setAuth("1", ["finance.view"]);
});

async function personWithMilestones(label = "A", birthDate = "1970-01-01") {
  const person = await createPerson({ label, birthDate });
  const bundle = await getForecast();
  const ms = bundle.milestones.filter((m) => m.personId === person.id);
  return {
    person,
    leave: ms.find((m) => m.kind === "leave_work")!,
    pension: ms.find((m) => m.kind === "statutory_pension")!,
  };
}

describe("finance/forecast — persons and milestones", () => {
  it("creates a person with the two default milestones", async () => {
    const { person, leave, pension } = await personWithMilestones();
    expect(person.label).toBe("A");
    expect(leave.age).toBe(63);
    expect(pension.age).toBe(67);
  });

  it("rejects a bad birth date and an empty label", async () => {
    await expect(createPerson({ label: "A", birthDate: "1970-1-1" })).rejects.toThrow(/YYYY-MM-DD/);
    await expect(createPerson({ label: " ", birthDate: "1970-01-01" })).rejects.toThrow(/non-empty/);
  });

  it("requires finance.view", async () => {
    setAuth("1", []);
    await expect(getForecast()).rejects.toThrow(/permission/);
  });

  it("keeps users apart", async () => {
    const { person } = await personWithMilestones();
    setAuth("2", ["finance.view"]);
    expect((await getForecast()).persons).toHaveLength(0);
    await expect(updatePerson({ id: person.id, label: "X" })).rejects.toThrow(/not found/);
    await expect(deletePerson({ id: person.id })).rejects.toThrow(/not found/);
    await expect(createMilestone({ personId: person.id, kind: "custom", age: 60 })).rejects.toThrow(/not found/);
  });

  it("validates that a milestone has exactly one of date and age", async () => {
    const { person, leave } = await personWithMilestones();
    await expect(createMilestone({ personId: person.id, kind: "custom" })).rejects.toThrow(/exactly one/);
    await expect(createMilestone({ personId: person.id, kind: "custom", date: "2030-01-01", age: 60 })).rejects.toThrow(
      /exactly one/,
    );
    const custom = await createMilestone({ personId: person.id, kind: "custom", date: "2030-06-01" });
    expect(custom.label).toBe("Zeitpunkt");
    expect(custom.date).toBe("2030-06-01");
    // Switching from age to date clears the age.
    const moved = await updateMilestone({ id: leave.id, date: "2031-01-01" });
    expect(moved.age).toBeNull();
    expect(moved.date).toBe("2031-01-01");
    const back = await updateMilestone({ id: leave.id, age: 61 });
    expect(back.date).toBeNull();
    expect(back.age).toBe(61);
  });

  it("deleting a person removes their milestones and items", async () => {
    const { person, pension } = await personWithMilestones();
    await createItem({
      personId: person.id,
      type: "pension",
      label: "Rente",
      data: { kind: "statutory", monthlyAmount: 1500, start: { kind: "milestone", milestoneId: pension.id } },
    });
    await deletePerson({ id: person.id });
    const bundle = await getForecast();
    expect(bundle.persons).toHaveLength(0);
    expect(bundle.milestones).toHaveLength(0);
    expect(bundle.items).toHaveLength(0);
  });
});

describe("finance/forecast — items", () => {
  it("refuses personal items without a person and pensions without a start", async () => {
    const { person } = await personWithMilestones();
    await expect(createItem({ type: "salary", label: "Gehalt", data: { amount: 3000 } })).rejects.toThrow(/needs a person/);
    await expect(
      createItem({ personId: person.id, type: "pension", label: "Rente", data: { monthlyAmount: 1000 } }),
    ).rejects.toThrow(/start/);
    await expect(
      createItem({ personId: person.id, type: "life_insurance", label: "LV", data: { surrenderValue: 1 } }),
    ).rejects.toThrow(/maturity/);
    await expect(createItem({ type: "bogus" as never, label: "x", data: {} })).rejects.toThrow(/unknown item type/);
  });

  it("creates, updates and deletes a household item", async () => {
    const item = await createItem({ type: "living_expense", label: "Leben", data: { amount: 2500 } });
    expect(item.personId).toBeNull();
    const updated = await updateItem({ id: item.id, data: { amount: 2600 }, label: "Lebenshaltung" });
    expect(updated.data.amount).toBe(2600);
    expect(updated.label).toBe("Lebenshaltung");
    await deleteItem({ id: item.id });
    expect((await getForecast()).items).toHaveLength(0);
    await expect(deleteItem({ id: item.id })).rejects.toThrow(/not found/);
  });

  it("links an asset to an account the user may see and reports its balance", async () => {
    await db.insert(financeCurrency).values({ code: "EUR", symbol: "€" }).onConflictDoNothing();
    const [type] = await db.select({ id: financeAccountType.id }).from(financeAccountType).limit(1);
    const [acc] = await db
      .insert(financeAccount)
      .values({ type_id: type.id, currency_code: "EUR", account_number: "1", label: "Tagesgeld" })
      .returning();
    await db.insert(financeAccountBalance).values([
      { account_id: acc.id, as_of: "2026-01-01T00:00:00Z", balance: "1000.00", source: "manual" },
      { account_id: acc.id, as_of: "2026-02-01T00:00:00Z", balance: "1234.56", source: "manual" },
    ]);

    // No ACL row yet → not linkable.
    await expect(
      createItem({ type: "asset", label: "TG", data: { pot: "cash" }, linkedAccountId: acc.id }),
    ).rejects.toThrow(/not found/);

    await db.insert(financeAccountAccess).values({ account_id: acc.id, user_id: 1, level: "read" });
    const bundle = await getForecast();
    expect(bundle.accounts).toEqual([{ id: acc.id, label: "Tagesgeld", balance: 1234.56 }]);
    const item = await createItem({ type: "asset", label: "TG", data: { pot: "cash", currentValue: 5 }, linkedAccountId: acc.id });
    expect(item.linkedAccountBalance).toBe(1234.56);

    // The simulation uses the linked balance, not the stored value.
    await personWithMilestones();
    const sim = await runSimulation({ scenario: { endAge: 60, inflationRate: 0, defaultReturnRate: 0 } });
    expect(sim.result.years[0].pots.cash).toBeCloseTo(1234.56, 6);
  });
});

describe("finance/forecast — scenarios and simulation", () => {
  it("needs a person to simulate", async () => {
    await expect(runSimulation({})).rejects.toThrow(/add a person/);
  });

  it("runs with the default scenario, a saved scenario and an inline one", async () => {
    const { person, leave, pension } = await personWithMilestones("A", "1970-01-01");
    await createItem({ personId: person.id, type: "salary", label: "Gehalt", data: { amount: 3000 } });
    await createItem({ type: "living_expense", label: "Leben", data: { amount: 2000 } });
    await createItem({ type: "asset", label: "Depot", data: { pot: "depot", currentValue: 100000, returnRate: 0.03 } });
    await createItem({
      personId: person.id,
      type: "pension",
      label: "Rente",
      data: { kind: "statutory", monthlyAmount: 1800, start: { kind: "milestone", milestoneId: pension.id }, regularAge: 67 },
    });

    const def = await runSimulation({});
    expect(def.result.startYear).toBeGreaterThanOrEqual(2026);
    expect(def.result.milestones.find((m) => m.id === leave.id)?.age).toBe(63);

    const saved = await createScenario({
      name: "Früh raus",
      config: { milestoneOverrides: { [leave.id]: { age: 58 } }, endAge: 90 },
    });
    const early = await runSimulation({ scenarioId: saved.id, earliestFor: person.id, compareScenarioIds: [saved.id] });
    expect(early.result.milestones.find((m) => m.id === leave.id)?.age).toBe(58);
    expect(early.earliest?.personId).toBe(person.id);
    expect(early.comparisons).toHaveLength(1);
    expect(early.comparisons[0].name).toBe("Früh raus");

    const inline = await runSimulation({ scenario: { milestoneOverrides: { [leave.id]: { age: 60 } } } });
    expect(inline.result.milestones.find((m) => m.id === leave.id)?.age).toBe(60);

    const renamed = await updateScenario({ id: saved.id, name: "Mit 58" });
    expect(renamed.name).toBe("Mit 58");
    await expect(runSimulation({ scenarioId: 99999 })).rejects.toThrow(/not found/);
  });

  it("computes the two-person matrix", async () => {
    const a = await personWithMilestones("A", "1970-01-01");
    const b = await personWithMilestones("B", "1973-01-01");
    await createItem({ personId: a.person.id, type: "salary", label: "Gehalt A", data: { amount: 3000 } });
    await createItem({ personId: b.person.id, type: "salary", label: "Gehalt B", data: { amount: 3000 } });
    await createItem({ type: "living_expense", label: "Leben", data: { amount: 3000 } });
    const res = await runSimulation({
      scenario: { endAge: 80 },
      matrix: { personA: a.person.id, personB: b.person.id, fromAge: 60, toAge: 62 },
    });
    expect(res.matrix).toHaveLength(9);
    await expect(
      runSimulation({ matrix: { personA: a.person.id, personB: a.person.id, fromAge: 60, toAge: 62 } }),
    ).rejects.toThrow(/two different/);
  });
});

describe("toEngineScenario", () => {
  it("defaults everything and drops garbage", () => {
    const s = toEngineScenario({
      inflationRate: "x",
      endAge: 300,
      milestoneOverrides: { "1": { age: 60 }, "2": "nope", "3": { date: "2030-01-01" }, "4": {} },
      withdrawalOrder: ["depot", "bogus", "cash"],
      spendingCurve: { phases: [{ fromAge: 70, factor: 0.8 }, null] },
      offsetDeductions: [1, "2"],
      allowSurrender: "yes",
    });
    expect(s.inflationRate).toBe(0.02);
    expect(s.endAge).toBe(120);
    expect(s.milestoneOverrides).toEqual({ "1": { age: 60 }, "3": { date: "2030-01-01" } });
    expect(s.withdrawalOrder).toEqual(["depot", "cash"]);
    expect(s.spendingCurve.phases).toEqual([{ fromAge: 70, factor: 0.8 }]);
    expect(s.offsetDeductions).toEqual([1]);
    expect(s.allowSurrender).toBe(false);
  });
});
