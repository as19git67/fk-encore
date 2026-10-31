/** The skeleton of the demo household: deterministic, the promised size, valid IBANs, nothing in the future. */
import { describe, expect, it } from "vitest";
import { planHousehold } from "./household";
import { demoIban } from "./names";

function ibanValid(iban: string): boolean {
  const moved = iban.slice(4) + iban.slice(0, 4);
  const digits = moved.replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
  let rest = 0;
  for (const d of digits) rest = (rest * 10 + Number(d)) % 97;
  return rest === 1;
}

describe("planHousehold", () => {
  const today = "2026-10-26";

  it("gives the same household for the same seed and day", () => {
    expect(planHousehold(7, "full", today)).toEqual(planHousehold(7, "full", today));
  });

  it("gives another household for another seed", () => {
    const a = planHousehold(7, "full", today).bookings.map((b) => b.cents);
    const b = planHousehold(8, "full", today).bookings.map((b) => b.cents);
    expect(a).not.toEqual(b);
  });

  it("plans 500 bookings for the full size and 40 for the small one", () => {
    expect(planHousehold(7, "full", today).bookings).toHaveLength(500);
    expect(planHousehold(7, "small", today).bookings).toHaveLength(40);
  });

  it("books nothing after today and nothing before its first day", () => {
    const plan = planHousehold(7, "full", today);
    for (const b of plan.bookings) {
      expect(b.date <= today).toBe(true);
      expect(b.date >= plan.from).toBe(true);
    }
    const dates = plan.bookings.map((b) => b.date);
    expect([...dates].sort()).toEqual(dates);
  });

  it("has four accounts with valid IBANs, one of them shared", () => {
    const plan = planHousehold(7, "full", today);
    expect(plan.accounts.map((a) => a.key).sort()).toEqual(["giro_self", "giro_spouse", "joint", "savings"]);
    expect(plan.accounts.filter((a) => a.owner === "both")).toHaveLength(1);
    for (const a of plan.accounts) expect(ibanValid(a.iban)).toBe(true);
    expect(ibanValid(demoIban("0000100001"))).toBe(true);
  });

  it("pays salaries in and moves household money to the joint account every month", () => {
    const plan = planHousehold(7, "full", today);
    const salaries = plan.bookings.filter((b) => b.kind === "salary");
    expect(salaries.length).toBeGreaterThanOrEqual(2 * 35);
    expect(salaries.every((b) => b.cents > 0)).toBe(true);
    const intoJoint = plan.bookings.filter((b) => b.kind === "transfer" && b.account === "joint" && b.cents > 0);
    expect(intoJoint.length).toBeGreaterThan(0);
  });
});
