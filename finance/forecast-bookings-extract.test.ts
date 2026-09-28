import { describe, it, expect } from "vitest";

import {
  bookingProposal,
  expectedPerYear,
  fitsPremium,
  isInsuranceItem,
  kindWords,
  nameTokens,
  summarizeBookings,
} from "./forecast-bookings-extract";

// Every insurer name and amount below is invented.

describe("forecast-bookings-extract", () => {
  it("tells insurance items from other items", () => {
    expect(isInsuranceItem("expense", "Privathaftpflicht", {})).toBe(true);
    expect(isInsuranceItem("expense", "Kfz-Versicherung Kombi", {})).toBe(true);
    expect(isInsuranceItem("expense", "Kredit Haus", {})).toBe(false);
    expect(isInsuranceItem("expense", "Kredit Haus", { insurer: "Beispiel AG" })).toBe(true);
    expect(isInsuranceItem("life_insurance", "LV", {})).toBe(true);
    expect(isInsuranceItem("living_expense", "Lebenshaltung", {})).toBe(false);
  });

  it("finds the kind of insurance and the insurer's name in a label", () => {
    expect(kindWords("Wohngebäude Beispiel")).toEqual(["wohngebäude"]);
    expect(kindWords("Rechtsschutz + Privathaftpflicht")).toEqual(["haftpflicht", "rechtsschutz"]);
    expect(nameTokens(null, "Rechtsschutz Musterschutz AG")).toEqual(["musterschutz"]);
    expect(nameTokens("Beispiel Versicherungsverein a.G.", "egal")).toEqual(["beispiel"]);
    expect(nameTokens(null, "Privathaftpflicht")).toEqual([]);
  });

  it("knows what an item expects to pay and which bookings fit it", () => {
    expect(expectedPerYear("expense", { amount: 25, frequency: "monthly" })).toBe(300);
    expect(expectedPerYear("expense", { amount: 300, frequency: "yearly" })).toBe(300);
    expect(expectedPerYear("expense", { amount: 300, frequency: "once" })).toBeNull();
    expect(expectedPerYear("life_insurance", { monthlyPremium: 100 })).toBe(1200);
    expect(fitsPremium(-26, 300)).toBe(true); // monthly
    expect(fitsPremium(-75, 300)).toBe(true); // quarterly
    expect(fitsPremium(-310, 300)).toBe(true); // yearly
    expect(fitsPremium(-500, 300)).toBe(false);
    expect(fitsPremium(-26, null)).toBe(false);
  });

  it("reads rhythm and current cost from bookings", () => {
    const yearly = summarizeBookings([
      { date: "2024-02-01", amount: -300 },
      { date: "2025-02-03", amount: -305.5 },
      { date: "2026-02-02", amount: -312.4 },
    ]);
    expect(yearly).toMatchObject({ rhythm: "yearly", perYearCount: 1, lastAmount: 312.4, lastDate: "2026-02-02", perYear: 312.4, count: 3 });
    const monthly = summarizeBookings(["2026-01-01", "2026-02-01", "2026-03-02", "2026-04-01"].map((date) => ({ date, amount: -26.03 })));
    expect(monthly).toMatchObject({ rhythm: "monthly", perYear: 312.36 });
    expect(summarizeBookings([{ date: "2026-01-01", amount: -10 }])?.rhythm).toBe("irregular");
    expect(summarizeBookings([])).toBeNull();
  });

  it("proposes the premium in the item's own terms", () => {
    const s = summarizeBookings(["2026-01-01", "2026-04-01", "2026-07-01"].map((date) => ({ date, amount: -78 })))!;
    expect(s.rhythm).toBe("quarterly");
    expect(bookingProposal("expense", { amount: 22, frequency: "monthly" }, s)).toMatchObject({ field: "amount", current: 22, proposed: 26 });
    expect(bookingProposal("expense", { amount: 300, frequency: "yearly" }, s)).toMatchObject({ proposed: 312 });
    expect(bookingProposal("expense", { amount: 26, frequency: "monthly" }, s)).toBeNull();
    expect(bookingProposal("life_insurance", { monthlyPremium: 20 }, s)).toMatchObject({ field: "monthlyPremium", proposed: 26 });
    const once = summarizeBookings([{ date: "2026-01-01", amount: -78 }]);
    expect(bookingProposal("expense", { amount: 25, frequency: "monthly" }, once)).toBeNull();
  });
});
