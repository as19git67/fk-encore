import { describe, expect, it } from "vitest";
import {
  bookingOptionsOf,
  cheapestWithBag,
  checkedBagOf,
  flightsOf,
  googleFlightsLink,
  insightOf,
  priceWithBag,
  stopsParam,
} from "./flight-offers";
import { flightQuery } from "./flight-search-client";

/** A synthetic Google Flights answer: two outbound flights of a round trip. Airports and airlines are made up. */
export const FLIGHTS = {
  best_flights: [
    {
      flights: [
        {
          departure_airport: { id: "AAA", time: "2027-05-01 07:05" },
          arrival_airport: { id: "CCC", time: "2027-05-01 08:10" },
          airline: "Beispiel Air",
          flight_number: "BX 101",
        },
        {
          departure_airport: { id: "CCC", time: "2027-05-01 09:30" },
          arrival_airport: { id: "BBB", time: "2027-05-01 12:00" },
          airline: "Beispiel Air",
          flight_number: "BX 202",
        },
      ],
      layovers: [{ id: "CCC", name: "Umsteigestadt", duration: 80 }],
      total_duration: 295,
      price: 412,
      departure_token: "dep-1",
    },
  ],
  other_flights: [
    {
      flights: [
        {
          departure_airport: { id: "AAA", time: "2027-05-01 18:00" },
          arrival_airport: { id: "BBB", time: "2027-05-01 21:00" },
          airline: "Muster Wings",
          flight_number: "MW 7",
        },
      ],
      total_duration: 180,
      price: 389,
      departure_token: "dep-2",
    },
    { flights: [], price: 100 },
    { flights: [{ airline: "Ohne Preis" }] },
  ],
  price_insights: {
    lowest_price: 389,
    price_level: "Low",
    typical_price_range: [420, 610],
    price_history: [
      [1793404800, 455],
      [1793491200, 430],
    ],
  },
};

describe("reading Google Flights", () => {
  it("lists every flight with a price, cheapest first", () => {
    const offers = flightsOf(FLIGHTS);
    expect(offers.map((o) => o.price)).toEqual([389, 412]);
    expect(offers[1]).toMatchObject({
      airlines: "Beispiel Air",
      flightNumbers: "BX 101, BX 202",
      departsAt: "2027-05-01 07:05",
      arrivesAt: "2027-05-01 12:00",
      durationMin: 295,
      stops: 1,
      layovers: "CCC",
      best: true,
      departureToken: "dep-1",
      bookingToken: null,
    });
    expect(offers[0]).toMatchObject({ stops: 0, layovers: "", best: false });
  });

  it("reads Google's assessment and its history per day", () => {
    expect(insightOf(FLIGHTS)).toEqual({
      lowest: 389,
      level: "low",
      typicalLow: 420,
      typicalHigh: 610,
      history: [
        { day: "2026-10-31", price: 455 },
        { day: "2026-11-01", price: 430 },
      ],
    });
    expect(insightOf({})).toMatchObject({ lowest: null, level: null, history: [] });
  });

  it("reads booking options, together and as separate tickets", () => {
    const options = bookingOptionsOf({
      booking_options: [
        { together: { book_with: "Beispiel Air", price: 412, option_title: "Basic", extensions: ["Keine Erstattung"] } },
        { departing: { book_with: "Portal A", price: 180 }, returning: { book_with: "Portal B", price: 190 } },
        { together: { price: 1 } },
      ],
    });
    expect(options).toEqual([
      {
        bookWith: "Portal A + Portal B",
        price: 370,
        optionTitle: "Getrennte Tickets",
        extensions: "",
        baggage: "",
        checkedBag: null,
      },
      {
        bookWith: "Beispiel Air",
        price: 412,
        optionTitle: "Basic",
        extensions: "Keine Erstattung",
        baggage: "",
        checkedBag: null,
      },
    ]);
  });

  it("reads the first checked bag from Google's baggage lines", () => {
    expect(checkedBagOf(["1 free carry-on", "1st checked bag: 99"])).toBe(99);
    expect(checkedBagOf(["1 free carry-on", "1st checked bag up to 23 kg free"])).toBe("included");
    expect(checkedBagOf(["1st checked bag: 99-187"])).toBe(99);
    expect(checkedBagOf(["1. aufgegebenes Gepäckstück: 45 €"])).toBe(45);
    expect(checkedBagOf(["1. aufgegebenes Gepäckstück: 1.040 €"])).toBe(1040);
    expect(checkedBagOf(["1. aufgegebenes Gepäckstück: 39,50 €"])).toBe(39.5);
    expect(checkedBagOf(["1. aufgegebenes Gepäckstück kostenlos"])).toBe("included");
    expect(checkedBagOf(["1st checked bag: 0"])).toBe("included");
    expect(checkedBagOf(["1 free carry-on"])).toBeNull();
    expect(checkedBagOf(["Checked bag not included"])).toBeNull();
    expect(checkedBagOf([])).toBeNull();
  });

  it("prices an option with a checked bag per seated traveller", () => {
    const options = bookingOptionsOf({
      booking_options: [
        { together: { book_with: "Beispiel Air", price: 300, baggage_prices: ["1 free carry-on", "1st checked bag: 50"] } },
        { together: { book_with: "Portal A", price: 380, baggage_prices: ["1st checked bag up to 23 kg free"] } },
        { together: { book_with: "Portal B", price: 250 } },
        {
          departing: { book_with: "Portal C", price: 150, baggage_prices: ["1st checked bag: 20"] },
          returning: { book_with: "Portal C", price: 160, baggage_prices: ["1st checked bag: 25"] },
        },
      ],
    });
    const byName = Object.fromEntries(options.map((o) => [o.bookWith, o]));
    expect(byName["Beispiel Air"]).toMatchObject({ checkedBag: 50, baggage: "1 free carry-on, 1st checked bag: 50" });
    expect(byName["Portal C"]).toMatchObject({ price: 310, checkedBag: 45 });
    expect(priceWithBag(byName["Beispiel Air"]!, 2)).toBe(400);
    expect(priceWithBag(byName["Portal A"]!, 2)).toBe(380);
    expect(priceWithBag(byName["Portal B"]!, 2)).toBeNull();
    // Cheapest with a bag: Portal A (380) before Portal C (310 + 2 × 45) and Beispiel Air (400).
    expect(cheapestWithBag(options, 2)).toBe(380);
    expect(cheapestWithBag([byName["Portal B"]!], 2)).toBeNull();
  });

  it("maps the stops and links a Google Flights search, never a redirect", () => {
    expect([null, 0, 1, 2].map(stopsParam)).toEqual([0, 1, 2, 3]);
    const link = googleFlightsLink({
      origin: "AAA,DDD",
      destination: "BBB",
      outbound: "2027-05-01",
      return: "2027-05-08",
      travelClass: 3,
      currency: "EUR",
    });
    const url = new URL(link);
    expect(url.origin + url.pathname).toBe("https://www.google.com/travel/flights");
    expect(url.searchParams.get("q")).toBe("Flights to BBB from AAA or DDD on 2027-05-01 through 2027-05-08 business class");
    expect(link).not.toContain("/clk/");
  });

  it("builds SerpApi's query from the watch's criteria", () => {
    const q = flightQuery({
      departure_id: "AAA",
      arrival_id: "BBB",
      outbound_date: "2027-05-01",
      return_date: null,
      adults: 2,
      children: 1,
      infants_on_lap: 0,
      travel_class: 1,
      stops: 1,
      exclude_airlines: "XX",
      outbound_times: "6,12",
      return_times: "10,20",
      currency: "EUR",
      booking_token: "b",
      departure_token: "d",
    });
    expect(q).toMatchObject({ engine: "google_flights", type: "2", children: "1", stops: "1", exclude_airlines: "XX", outbound_times: "6,12", booking_token: "b" });
    expect(q).not.toHaveProperty("return_times");
    expect(q).not.toHaveProperty("departure_token");
    expect(q).not.toHaveProperty("infants_on_lap");
  });
});
