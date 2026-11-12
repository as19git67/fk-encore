import { describe, expect, it } from "vitest";
import { calendarPrices, estimateStays } from "./hotel-calendar";

describe("price calendar", () => {
  const prices = calendarPrices({
    prices: [
      { date: "2027-05-10", extracted_display_price: 100, extracted_after_taxes_fees: 110 },
      { date: "2027-05-11", extracted_display_price: 90 },
      { date: "2027-05-12", extracted_after_taxes_fees: 200 },
      { date: "2027-05-14", extracted_after_taxes_fees: 70 },
      { date: "2027-05-15" },
    ],
  });

  it("reads one price per arrival day, taxes included where named", () => {
    expect([...prices]).toEqual([
      ["2027-05-10", 110],
      ["2027-05-11", 90],
      ["2027-05-12", 200],
      ["2027-05-14", 70],
    ]);
  });

  it("estimates a stay as the mean of its nights and leaves out stays with a night without price", () => {
    const stays = [
      { start: "2027-05-10", end: "2027-05-12" },
      { start: "2027-05-11", end: "2027-05-13" },
      { start: "2027-05-13", end: "2027-05-15" },
      { start: "2027-05-14", end: "2027-05-15" },
    ];
    expect(estimateStays(prices, stays)).toEqual([
      { start: "2027-05-14", end: "2027-05-15", perNight: 70 },
      { start: "2027-05-10", end: "2027-05-12", perNight: 100 },
      { start: "2027-05-11", end: "2027-05-13", perNight: 145 },
    ]);
  });
});
