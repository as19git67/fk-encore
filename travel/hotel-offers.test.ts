import { describe, expect, it } from "vitest";
import { isHotelDetail, offersOf, pickProperty, summarize } from "./hotel-offers";

/** A synthetic Google Hotels detail answer in SerpApi's shape. */
export const DETAIL = {
  name: "Hotel Beispiel Musterstadt",
  property_token: "tok-beispiel",
  featured_prices: [
    {
      source: "Portal A",
      rooms: [
        {
          name: "Doppelzimmer, zwei Betten",
          num_guests: 3,
          rates: [
            { rate_per_night: { extracted_lowest: 200 }, total_rate: { extracted_lowest: 400 }, free_cancellation: false },
            {
              rate_per_night: { extracted_lowest: 240 },
              total_rate: { extracted_lowest: 480 },
              free_cancellation: true,
              free_cancellation_until_date: "10. Mai",
            },
            {
              rate_per_night: { extracted_lowest: 260 },
              total_rate: { extracted_lowest: 520 },
              free_cancellation: true,
              breakfast_included: true,
            },
          ],
        },
        {
          name: "Einzelzimmer",
          num_guests: 1,
          rates: [{ rate_per_night: { extracted_lowest: 90 }, free_cancellation: true }],
        },
      ],
    },
  ],
  prices: [
    { source: "Portal A", rate_per_night: { extracted_lowest: 200 } },
    { source: "Portal B", rate_per_night: { extracted_lowest: 210 }, total_rate: { extracted_lowest: 420 } },
    { source: "Portal C" },
  ],
};

describe("offersOf", () => {
  it("makes one offer per rate, cheapest first, and drops rooms too small for the party", () => {
    const offers = offersOf(DETAIL, 3);
    expect(offers.map((o) => [o.source, o.perNight])).toEqual([
      ["Portal A", 200],
      ["Portal B", 210],
      ["Portal A", 240],
      ["Portal A", 260],
    ]);
    expect(offers[2]).toMatchObject({ freeCancellation: true, cancelUntil: "10. Mai", total: 480 });
    expect(offers[3]).toMatchObject({ freeCancellation: true, breakfast: true });
  });

  it("counts a provider without rooms as not cancellable and without breakfast", () => {
    const b = offersOf(DETAIL, 2).find((o) => o.source === "Portal B")!;
    expect(b).toMatchObject({ freeCancellation: false, breakfast: false, room: "(ohne Zimmerangabe)" });
  });

  it("returns nothing for an answer without prices", () => {
    expect(offersOf({}, 2)).toEqual([]);
  });
});

describe("summarize", () => {
  const offers = offersOf(DETAIL, 3);

  it("names the cheapest rate, the cheapest cancellable and cancellable with breakfast", () => {
    const s = summarize(offers, { freeCancellationOnly: true, breakfastRequired: false });
    expect(s.lowest?.perNight).toBe(200);
    expect(s.lowestFree?.perNight).toBe(240);
    expect(s.lowestFreeBreakfast?.perNight).toBe(260);
    expect(s.matching?.perNight).toBe(240);
  });

  it("matches by the watch's conditions", () => {
    expect(summarize(offers, { freeCancellationOnly: false, breakfastRequired: false }).matching?.perNight).toBe(200);
    expect(summarize(offers, { freeCancellationOnly: true, breakfastRequired: true }).matching?.perNight).toBe(260);
  });
});

describe("result lists", () => {
  const list = {
    properties: [
      { name: "Anderes Haus", property_token: "tok-1" },
      { name: "Hotel Beispiel Musterstadt", property_token: "tok-2" },
    ],
  };

  it("tells a detail answer from a list", () => {
    expect(isHotelDetail(DETAIL)).toBe(true);
    expect(isHotelDetail(list)).toBe(false);
  });

  it("picks the hit the query names, otherwise the first", () => {
    expect(pickProperty(list, "hotel beispiel")?.token).toBe("tok-2");
    expect(pickProperty(list, "Ganz woanders")?.token).toBe("tok-1");
    expect(pickProperty({ properties: [] }, "x")).toBeNull();
  });
});
