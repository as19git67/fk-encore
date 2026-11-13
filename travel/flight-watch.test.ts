import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAuthData } from "~encore/auth";
import { eq } from "drizzle-orm";

import db from "../db/database";
import { travelFlightChecks, travelFlightPricePoints, travelFlightWatches, users } from "../db/schema";
import { FLIGHTS } from "./flight-offers.test";
import {
  combinationsOf,
  flightWatchStatus,
  normalizeFlightWatchInput,
  runDueFlightChecks,
  type FlightWatchInput,
} from "./flight-watch.service";
import { setFlightSearchClient, type FlightSearchClient, type FlightSearchParams } from "./flight-search-client";
import { setFlightAlertSender, type FlightPriceAlert } from "./flight-alerts";
import { searchesThisMonth } from "./search-budget";
import * as endpoints from "./flight-watch";

const NOW = new Date("2026-11-12T10:00:00Z");
const TODAY = "2026-11-12";

function input(over: Partial<FlightWatchInput> = {}): FlightWatchInput {
  return {
    origin: "AAA",
    destination: "BBB",
    outbound_date: "2027-05-01",
    return_date: "2027-05-08",
    adults: 2,
    limit_total: 400,
    end_date: "2027-04-30",
    ...over,
  };
}

const FLEX: Partial<FlightWatchInput> = {
  flexible: true,
  outbound_date: null,
  return_date: null,
  date_from: "2027-05-01",
  date_until: "2027-05-06",
  min_nights: 3,
  max_nights: 4,
};

/** Answers like Google Flights; the price of the cheapest flight per outbound date comes from `prices`. */
function fakeClient(calls: FlightSearchParams[], prices: Record<string, number> = {}): FlightSearchClient {
  return {
    async search(params) {
      calls.push(params);
      if (params.booking_token) {
        return { booking_options: [{ together: { book_with: "Beispiel Air", price: 380 } }] };
      }
      if (params.departure_token) {
        return { best_flights: [{ flights: [{ airline: "Beispiel Air" }], price: 389, booking_token: "book-1" }] };
      }
      const price = prices[params.outbound_date];
      if (price === undefined) return FLIGHTS;
      return { ...FLIGHTS, other_flights: [{ ...FLIGHTS.other_flights[0], price }] };
    },
  };
}

let userId: number;
const cleanup: number[] = [];

async function createUser(): Promise<number> {
  const [row] = await db
    .insert(users)
    .values({ email: `flight-${Date.now()}-${Math.random()}@example.com`, name: "Flug Test", password_hash: "x" })
    .returning({ id: users.id });
  cleanup.push(row.id);
  return row.id;
}

function setAuth(id: number, perms = ["module.travel", "travel.view", "travel.manage"]) {
  vi.mocked(getAuthData).mockReturnValue({ userID: String(id), permissions: perms } as any);
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  userId = await createUser();
  setAuth(userId);
});

afterEach(async () => {
  vi.useRealTimers();
  setFlightSearchClient(undefined);
  setFlightAlertSender(null);
  for (const id of cleanup.splice(0)) await db.delete(users).where(eq(users.id, id));
  vi.restoreAllMocks();
});

describe("criteria", () => {
  it("accepts a round trip and normalizes codes and hours", () => {
    const n = normalizeFlightWatchInput(input({ origin: "aaa, ddd", airlines: "xx ,yy", outbound_times: "0,23", return_times: "8,20" }), TODAY);
    expect(n).toMatchObject({
      origin: "AAA,DDD",
      trip_type: "round",
      airlines: "XX,YY",
      airlines_mode: "include",
      outbound_times: null,
      return_times: "8,20",
      travel_class: 1,
      max_stops: null,
      currency: "EUR",
    });
  });

  it("refuses bad airports, passengers and dates", () => {
    expect(() => normalizeFlightWatchInput(input({ origin: "Musterstadt" }), TODAY)).toThrow(/Abflug/);
    expect(() => normalizeFlightWatchInput(input({ destination: "AAA" }), TODAY)).toThrow(/gemeinsam/);
    expect(() => normalizeFlightWatchInput(input({ adults: 5, children: 5 }), TODAY)).toThrow(/Höchstens 9/);
    expect(() => normalizeFlightWatchInput(input({ adults: 1, infants_on_lap: 2 }), TODAY)).toThrow(/Kleinkinder/);
    expect(() => normalizeFlightWatchInput(input({ return_date: "2027-04-30" }), TODAY)).toThrow(/Rückflug/);
    expect(() => normalizeFlightWatchInput(input({ outbound_date: TODAY }), TODAY)).toThrow(/Zukunft/);
    expect(() => normalizeFlightWatchInput(input({ end_date: "2027-05-01" }), TODAY)).toThrow(/letzten möglichen Hinflug/);
    expect(() => normalizeFlightWatchInput(input({ outbound_times: "12,6" }), TODAY)).toThrow(/Abflugzeit/);
  });

  it("takes a flexible window with a range of nights, within limits", () => {
    const n = normalizeFlightWatchInput(input({ ...FLEX, end_date: "2027-05-01" }), TODAY);
    expect(n).toMatchObject({ flexible: true, outbound_date: null, date_from: "2027-05-01", min_nights: 3, max_nights: 4 });
    expect(combinationsOf(n as any, TODAY)).toHaveLength(5);
    // The last outbound is the 3rd (3 nights to the 6th), so the watch may end before it.
    expect(() => normalizeFlightWatchInput(input({ ...FLEX, end_date: "2027-05-03" }), TODAY)).toThrow(/letzten möglichen/);
    expect(() =>
      normalizeFlightWatchInput(input({ ...FLEX, date_until: "2027-08-01", min_nights: 1, max_nights: 30 }), TODAY),
    ).toThrow(/Zu viele Kombinationen/);
    expect(() => normalizeFlightWatchInput(input({ ...FLEX, min_nights: 5, max_nights: 4 }), TODAY)).toThrow(/Dauer/);
  });

  it("flexible one way: any day of the window", () => {
    const n = normalizeFlightWatchInput(
      input({ trip_type: "oneway", flexible: true, outbound_date: null, return_date: null, date_from: "2027-05-01", date_until: "2027-05-03", end_date: "2027-05-01" }),
      TODAY,
    );
    expect(combinationsOf(n as any, TODAY)).toEqual([
      { start: "2027-05-01", end: null },
      { start: "2027-05-02", end: null },
      { start: "2027-05-03", end: null },
    ]);
  });

  it("ends once the end date or the last departure has passed", () => {
    const w = { ...normalizeFlightWatchInput(input(), TODAY), paused: false } as any;
    expect(flightWatchStatus(w, TODAY)).toBe("active");
    expect(flightWatchStatus({ ...w, paused: true }, TODAY)).toBe("paused");
    expect(flightWatchStatus(w, "2027-05-01")).toBe("ended");
  });
});

describe("endpoints", () => {
  it("need the module permission", async () => {
    setAuth(userId, ["travel.view"]);
    await expect(endpoints.listFlightWatchesApi()).rejects.toThrow();
  });

  it("create, check now and read flights, insight and history", async () => {
    const calls: FlightSearchParams[] = [];
    setFlightSearchClient(fakeClient(calls));
    const { watch } = await endpoints.createFlightWatchApi(input({ max_stops: 0, airlines: "XX", airlines_mode: "exclude" }));
    expect(watch).toMatchObject({ status: "active", combinations: 1, latest: null });
    expect(watch.link).toContain("google.com/travel/flights");

    const { check } = await endpoints.checkFlightWatchApi({ id: watch.id });
    expect(check).toMatchObject({ searches: 1, flight_count: 2, lowest_price: 389, price_level: "low", typical_low: 420, below_limit: true });
    expect(calls[0]).toMatchObject({ return_date: "2027-05-08", stops: 1, exclude_airlines: "XX", include_airlines: null });

    const detail = await endpoints.getFlightWatch({ id: watch.id });
    expect(detail.offers.map((o) => o.price)).toEqual([389, 412]);
    expect(detail.history?.points).toHaveLength(2);
    expect(detail.watch.best).toMatchObject({ price: 389, outbound_date: "2027-05-01", return_date: "2027-05-08" });
    expect(detail.bookings).toBeNull();
    expect(await searchesThisMonth(NOW)).toBeGreaterThanOrEqual(1);
  });

  it("keep other users' watches apart", async () => {
    const { watch } = await endpoints.createFlightWatchApi(input());
    setAuth(await createUser());
    await expect(endpoints.getFlightWatch({ id: watch.id })).rejects.toThrow(/nicht gefunden/);
  });

  it("say so when no key is configured", async () => {
    setFlightSearchClient(null);
    const { watch } = await endpoints.createFlightWatchApi(input());
    await expect(endpoints.checkFlightWatchApi({ id: watch.id })).rejects.toThrow(/SerpApi-Schlüssel/);
  });
});

describe("flexible watches", () => {
  it("check one combination per run, in turn, and keep the best one known", async () => {
    const calls: FlightSearchParams[] = [];
    setFlightSearchClient(fakeClient(calls, { "2027-05-01": 450, "2027-05-02": 360 }));
    const { watch } = await endpoints.createFlightWatchApi(input({ ...FLEX, limit_total: null, end_date: "2027-05-01" }));
    expect(watch.combinations).toBe(5);

    for (let i = 0; i < 4; i++) await endpoints.checkFlightWatchApi({ id: watch.id });
    expect(calls.map((c) => `${c.outbound_date}|${c.return_date}`)).toEqual([
      "2027-05-01|2027-05-04",
      "2027-05-01|2027-05-05",
      "2027-05-02|2027-05-05",
      "2027-05-02|2027-05-06",
    ]);

    const detail = await endpoints.getFlightWatch({ id: watch.id });
    expect(detail.watch.best).toMatchObject({ price: 360, outbound_date: "2027-05-02" });
    expect(detail.combinations).toHaveLength(5);
    expect(detail.combinations.filter((c) => c.price === null)).toHaveLength(1);
    const points = await db.select().from(travelFlightPricePoints).where(eq(travelFlightPricePoints.watch_id, watch.id));
    expect(new Set(points.map((p) => p.combo)).size).toBe(4);
  });
});

describe("job and reports", () => {
  it("reports the best price below the limit with who sells it, once, and again for a new low", async () => {
    const calls: FlightSearchParams[] = [];
    const prices: Record<string, number> = { "2027-05-01": 389 };
    setFlightSearchClient(fakeClient(calls, prices));
    const sent: FlightPriceAlert[] = [];
    setFlightAlertSender({ push: async (a) => void sent.push(a), email: async () => {} });
    const { watch } = await endpoints.createFlightWatchApi(input({ notify_email: false }));

    const client = fakeClient(calls, prices);
    expect(await runDueFlightChecks(client, NOW)).toMatchObject({ due: 1, checked: 1 });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ price: 389, limit: 400, passengers: 2, stops: 0, level: "low", newLow: false });
    expect(sent[0]!.bookings.map((b) => b.bookWith)).toEqual(["Beispiel Air"]);
    expect(sent[0]!.link).toContain("google.com/travel/flights");
    // Outbound list, return flights of the cheapest, then its booking options: three searches.
    const [first] = await db.select().from(travelFlightChecks).where(eq(travelFlightChecks.watch_id, watch.id));
    expect(first!.searches).toBe(3);

    // Same price the next day: nothing new.
    const later = new Date(NOW.getTime() + 24 * 3600_000);
    await runDueFlightChecks(client, later);
    expect(sent).toHaveLength(1);

    prices["2027-05-01"] = 350;
    await runDueFlightChecks(client, new Date(later.getTime() + 24 * 3600_000));
    expect(sent).toHaveLength(2);
    expect(sent[1]).toMatchObject({ price: 350, newLow: true });

    const [row] = await db.select().from(travelFlightWatches).where(eq(travelFlightWatches.id, watch.id));
    expect(row!.notified_price).toBe(350);
  });

  it("counts a checked bag: no report when the fee lifts the price over the limit", async () => {
    const calls: FlightSearchParams[] = [];
    const prices: Record<string, number> = { "2027-05-01": 389 };
    const base = fakeClient(calls, prices);
    // Two seated travellers, 389 + 2 × 30 = 449 > 400.
    const client: FlightSearchClient = {
      async search(params) {
        if (params.booking_token) {
          calls.push(params);
          return {
            booking_options: [
              {
                together: {
                  book_with: "Beispiel Air",
                  price: prices["2027-05-01"],
                  baggage_prices: ["1 free carry-on", "1st checked bag: 30"],
                },
              },
            ],
          };
        }
        return base.search(params);
      },
    };
    const sent: FlightPriceAlert[] = [];
    setFlightAlertSender({ push: async (a) => void sent.push(a), email: async () => {} });
    const { watch } = await endpoints.createFlightWatchApi(input({ notify_email: false }));
    expect(watch.checked_bag).toBe(true);

    await runDueFlightChecks(client, NOW);
    expect(sent).toHaveLength(0);
    const [first] = await db.select().from(travelFlightChecks).where(eq(travelFlightChecks.watch_id, watch.id));
    expect(first).toMatchObject({ lowest_price: 389, bag_price: 449, below_limit: false, searches: 3 });
    let detail = await endpoints.getFlightWatch({ id: watch.id });
    expect(detail.watch.best).toMatchObject({ price: 449, with_bag: true });
    expect(detail.bookings!.options[0]).toMatchObject({ book_with: "Beispiel Air", baggage: "1 free carry-on, 1st checked bag: 30" });

    // Same price the next day: the known fee is reused, no further searches.
    const later = new Date(NOW.getTime() + 24 * 3600_000);
    calls.length = 0;
    await runDueFlightChecks(client, later);
    expect(calls).toHaveLength(1);
    expect(sent).toHaveLength(0);

    // Cheaper: the options are read again; 340 + 2 × 30 = 400 is not below 400 either …
    prices["2027-05-01"] = 340;
    calls.length = 0;
    await runDueFlightChecks(client, new Date(later.getTime() + 24 * 3600_000));
    expect(calls).toHaveLength(3);
    expect(sent).toHaveLength(0);

    // … 330 + 60 = 390 is.
    prices["2027-05-01"] = 330;
    await runDueFlightChecks(client, new Date(later.getTime() + 2 * 24 * 3600_000));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ price: 390, bag: "included", seated: 2 });
    detail = await endpoints.getFlightWatch({ id: watch.id });
    expect(detail.watch.notified_price).toBe(390);
  });

  it("reports the plain price when the watch does not ask for a checked bag", async () => {
    const calls: FlightSearchParams[] = [];
    setFlightSearchClient(fakeClient(calls));
    const sent: FlightPriceAlert[] = [];
    setFlightAlertSender({ push: async (a) => void sent.push(a), email: async () => {} });
    const { watch } = await endpoints.createFlightWatchApi(
      input({ notify_email: false, checked_bag: false, limit_total: 1000 }),
    );
    expect(watch.checked_bag).toBe(false);
    await runDueFlightChecks(fakeClient(calls), NOW);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ bag: null });
    const [row] = await db.select().from(travelFlightChecks).where(eq(travelFlightChecks.watch_id, watch.id));
    expect(row!.bag_price).toBeNull();
  });

  it("skip paused and ended watches", async () => {
    const calls: FlightSearchParams[] = [];
    await endpoints.createFlightWatchApi(input({ paused: true }));
    expect(await runDueFlightChecks(fakeClient(calls), NOW)).toMatchObject({ due: 0 });
    expect(calls).toHaveLength(0);
  });
});
