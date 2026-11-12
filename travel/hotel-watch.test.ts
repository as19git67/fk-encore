import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAuthData } from "~encore/auth";
import { eq } from "drizzle-orm";

import db from "../db/database";
import { travelHotelChecks, travelHotelOffers, travelHotelWatches, users } from "../db/schema";
import { DETAIL } from "./hotel-offers.test";
import { maxEndDate, normalizeWatchInput, runDueChecks, watchStatus, type WatchInput } from "./hotel-watch.service";
import { setHotelSearchClient, type HotelSearchClient, type HotelSearchParams } from "./serpapi-client";
import { setAlertSender, type PriceAlert } from "./hotel-alerts";
import * as endpoints from "./hotel-watch";

const NOW = new Date("2026-11-07T10:00:00Z");
const TODAY = "2026-11-07";

function input(over: Partial<WatchInput> = {}): WatchInput {
  return {
    query: "Hotel Beispiel Musterstadt",
    check_in: "2027-05-12",
    check_out: "2027-05-14",
    adults: 3,
    limit_per_night: 250,
    end_date: "2027-05-11",
    ...over,
  };
}

/** Answers like Google Hotels: a result list for a name, the detail for a token. */
function fakeClient(calls: HotelSearchParams[]): HotelSearchClient {
  return {
    async search(params) {
      calls.push(params);
      if (params.property_token) return DETAIL;
      return { properties: [{ name: "Hotel Beispiel Musterstadt", property_token: "tok-beispiel" }] };
    },
  };
}

let userId: number;
const cleanup: number[] = [];

async function createUser(): Promise<number> {
  const [row] = await db
    .insert(users)
    .values({ email: `travel-${Date.now()}-${Math.random()}@example.com`, name: "Reise Test", password_hash: "x" })
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
  setHotelSearchClient(undefined);
  setAlertSender(null);
  for (const id of cleanup.splice(0)) await db.delete(users).where(eq(users.id, id));
  vi.restoreAllMocks();
});

describe("criteria", () => {
  it("accepts a watch that ends before the check-in", () => {
    const n = normalizeWatchInput(input(), TODAY);
    expect(n).toMatchObject({ free_cancellation_only: true, breakfast_required: false, currency: "EUR", children_ages: [] });
  });

  it("always needs an end at most two years ahead", () => {
    expect(maxEndDate(TODAY)).toBe("2028-11-07");
    expect(() => normalizeWatchInput(input({ end_date: "" }), TODAY)).toThrow(/Ende der Beobachtung/);
    expect(() =>
      normalizeWatchInput(input({ check_in: "2029-01-10", check_out: "2029-01-12", end_date: "2028-11-08" }), TODAY),
    ).toThrow(/höchstens 2 Jahre/);
    expect(() => normalizeWatchInput(input({ end_date: "2026-11-06" }), TODAY)).toThrow(/Vergangenheit/);
  });

  it("refuses an end on or after the check-in, and impossible stays", () => {
    expect(() => normalizeWatchInput(input({ end_date: "2027-05-12" }), TODAY)).toThrow(/vor der Anreise/);
    expect(() => normalizeWatchInput(input({ check_out: "2027-05-12" }), TODAY)).toThrow(/nach der Anreise/);
    expect(() => normalizeWatchInput(input({ adults: 0 }), TODAY)).toThrow(/Erwachsene/);
    expect(() => normalizeWatchInput(input({ children_ages: [18] }), TODAY)).toThrow(/Kindes/);
  });

  it("allows double rooms only for an even number of adults from four, without children", () => {
    expect(normalizeWatchInput(input({ adults: 4, split_rooms: true }), TODAY).split_rooms).toBe(true);
    expect(normalizeWatchInput(input(), TODAY).split_rooms).toBe(false);
    expect(() => normalizeWatchInput(input({ adults: 3, split_rooms: true }), TODAY)).toThrow(/Doppelzimmer/);
    expect(() => normalizeWatchInput(input({ adults: 4, children_ages: [6], split_rooms: true }), TODAY)).toThrow(/Doppelzimmer/);
  });

  it("ends once the end date or the check-in has passed", () => {
    const w = { paused: false, end_date: "2027-05-11", check_in: "2027-05-12" };
    expect(watchStatus(w, TODAY)).toBe("active");
    expect(watchStatus({ ...w, paused: true }, TODAY)).toBe("paused");
    expect(watchStatus(w, "2027-05-11")).toBe("active");
    expect(watchStatus(w, "2027-05-12")).toBe("ended");
  });
});

describe("endpoints", () => {
  it("need the module permission", async () => {
    setAuth(userId, ["travel.view"]);
    await expect(endpoints.listHotelWatches()).rejects.toThrow();
  });

  it("create, check now and read the history", async () => {
    const calls: HotelSearchParams[] = [];
    setHotelSearchClient(fakeClient(calls));
    const { watch } = await endpoints.createHotelWatch(input());
    expect(watch.status).toBe("active");

    const { check } = await endpoints.checkHotelWatch({ id: watch.id });
    expect(calls).toHaveLength(2);
    expect(check).toMatchObject({
      searches: 2,
      offer_count: 4,
      lowest_per_night: 200,
      lowest_free_per_night: 240,
      matching_per_night: 240,
      below_limit: true,
      error: null,
    });

    const detail = await endpoints.getHotelWatch({ id: watch.id });
    expect(detail.watch.hotel_name).toBe("Hotel Beispiel Musterstadt");
    expect(detail.watch.latest?.matching_per_night).toBe(240);
    expect(detail.offers.map((o) => o.per_night)).toEqual([200, 210, 240, 260]);
    expect(detail.checks).toHaveLength(1);

    // The second check goes straight to the stored hotel: one search.
    await endpoints.checkHotelWatch({ id: watch.id });
    expect(calls).toHaveLength(3);
    expect(calls[2].property_token).toBe("tok-beispiel");
  });

  it("store links that still open later instead of Google's click redirects", async () => {
    const detail = {
      ...structuredClone(DETAIL),
      link: "https://hotel-beispiel.example/",
      featured_prices: [
        {
          source: "Hotel Beispiel Musterstadt",
          official: true,
          link: "https://www.google.com/aclk?sa=l&ai=beispiel&adurl=",
          rooms: [{ name: "Doppelzimmer", rates: [{ rate_per_night: { extracted_lowest: 180 }, free_cancellation: true }] }],
        },
      ],
      prices: [
        { source: "Booking.com", link: "https://www.google.com/travel/clk?pc=beispiel", rate_per_night: { extracted_lowest: 190 } },
        {
          source: "Portal E",
          link: "https://www.googleadservices.com/pagead/aclk?adurl=https%3A%2F%2Fportal-e.example%2Fangebot",
          rate_per_night: { extracted_lowest: 195 },
        },
        { source: "Portal F", link: "https://www.google.com/aclk?sa=l&ai=f", rate_per_night: { extracted_lowest: 199 } },
      ],
    };
    setHotelSearchClient({ search: async (p) => (p.property_token ? detail : { properties: [{ name: "Hotel Beispiel Musterstadt", property_token: "tok-beispiel" }] }) });
    const { watch } = await endpoints.createHotelWatch(input());
    await endpoints.checkHotelWatch({ id: watch.id });

    const links = Object.fromEntries((await endpoints.getHotelWatch({ id: watch.id })).offers.map((o) => [o.source, o.link]));
    expect(links["Hotel Beispiel Musterstadt"]).toBe("https://hotel-beispiel.example/");
    expect(links["Booking.com"]).toMatch(/^https:\/\/www\.booking\.com\/searchresults\.de\.html\?ss=Hotel\+Beispiel/);
    expect(links["Booking.com"]).toContain("checkin=2027-05-12");
    expect(links["Portal E"]).toBe("https://portal-e.example/angebot");
    expect(links["Portal F"]).toBe("https://www.google.com/travel/hotels/entity/tok-beispiel/prices?hl=de&gl=de");
  });

  it("replace Google redirects stored by older checks when reading", async () => {
    const { watch } = await endpoints.createHotelWatch(input());
    const [check] = await db
      .insert(travelHotelChecks)
      .values({ watch_id: watch.id, checked_at: NOW.toISOString(), searches: 1, offer_count: 1, below_limit: false })
      .returning();
    await db.insert(travelHotelOffers).values({
      check_id: check.id,
      source: "Portal F",
      room: "(ohne Zimmerangabe)",
      per_night: 199,
      breakfast: false,
      link: "https://www.google.com/aclk?sa=l&ai=f",
      rooms: 1,
    });
    const { offers } = await endpoints.getHotelWatch({ id: watch.id });
    expect(offers[0].link).toBe("https://www.google.com/travel/search?q=Hotel+Beispiel+Musterstadt&hl=de&gl=de");
  });

  it("keep other users' watches apart", async () => {
    const { watch } = await endpoints.createHotelWatch(input());
    setAuth(await createUser());
    await expect(endpoints.getHotelWatch({ id: watch.id })).rejects.toThrow(/nicht gefunden/);
    expect((await endpoints.listHotelWatches()).watches).toEqual([]);
  });

  it("say so when no key is configured", async () => {
    setHotelSearchClient(null);
    const { watch } = await endpoints.createHotelWatch(input());
    await expect(endpoints.checkHotelWatch({ id: watch.id })).rejects.toThrow(/SerpApi-Schlüssel/);
    expect((await endpoints.runHotelWatchJob()).configured).toBe(false);
  });

  it("forget the matched hotel when the search changes", async () => {
    setHotelSearchClient(fakeClient([]));
    const { watch } = await endpoints.createHotelWatch(input());
    await endpoints.checkHotelWatch({ id: watch.id });
    const { watch: moved } = await endpoints.updateHotelWatch({ id: watch.id, ...input({ check_out: "2027-05-15" }) });
    expect(moved.hotel_name).toBe("Hotel Beispiel Musterstadt");
    const { watch: other } = await endpoints.updateHotelWatch({ id: watch.id, ...input({ query: "Anderes Haus" }) });
    expect(other.hotel_name).toBeNull();
  });
});

describe("job", () => {
  it("checks active watches once per gap, skips paused and ended ones, records failures", async () => {
    const calls: HotelSearchParams[] = [];
    const { watch: active } = await endpoints.createHotelWatch(input());
    await endpoints.createHotelWatch(input({ paused: true }));
    const { watch: ended } = await endpoints.createHotelWatch(input());
    await db.update(travelHotelWatches).set({ end_date: "2026-11-01" }).where(eq(travelHotelWatches.id, ended.id));
    const { watch: broken } = await endpoints.createHotelWatch(input({ query: "Nirgendwo" }));

    const client: HotelSearchClient = {
      async search(params) {
        if (params.q === "Nirgendwo") return { properties: [] };
        return fakeClient(calls).search(params);
      },
    };
    const first = await runDueChecks(client, NOW);
    expect(first).toMatchObject({ due: 2, checked: 2, failed: 1, skippedBudget: 0 });
    const failed = await db.select().from(travelHotelChecks).where(eq(travelHotelChecks.watch_id, broken.id));
    expect(failed[0].error).toMatch(/Kein Hotel/);

    // Within the gap nothing is due; after it, both again.
    expect((await runDueChecks(client, new Date(NOW.getTime() + 60 * 60_000))).due).toBe(0);
    expect((await runDueChecks(client, new Date(NOW.getTime() + 6 * 60 * 60_000))).due).toBe(2);
    const history = await db.select().from(travelHotelChecks).where(eq(travelHotelChecks.watch_id, active.id));
    expect(history).toHaveLength(2);
  });

  it("stops when the month's searches are spent", async () => {
    vi.stubEnv("TRAVEL_SERPAPI_MONTHLY_SEARCHES", "3");
    try {
      await endpoints.createHotelWatch(input());
      await endpoints.createHotelWatch(input());
      await endpoints.createHotelWatch(input());
      // Checks other tests left count too, so move to a month nobody used.
      const later = new Date("2031-03-01T10:00:00Z");
      vi.setSystemTime(later);
      await db
        .update(travelHotelWatches)
        .set({ check_in: "2031-05-12", check_out: "2031-05-14", end_date: "2031-05-11" })
        .where(eq(travelHotelWatches.user_id, userId));
      // First watch: two searches. Second: one, then the cap stops it (a failed
      // check). Third: left for next month.
      const result = await runDueChecks(fakeClient([]), later);
      expect(result).toMatchObject({ due: 3, checked: 2, failed: 1, skippedBudget: 1 });
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("double rooms", () => {
  it("search a second time for two adults and keep both kinds of offer", async () => {
    const calls: HotelSearchParams[] = [];
    const { watch } = await endpoints.createHotelWatch(input({ adults: 4, split_rooms: true, limit_per_night: 500 }));
    await runDueChecks(fakeClient(calls), NOW);
    expect(calls.map((c) => [c.adults, c.property_token ?? null])).toEqual([
      [4, null],
      [4, "tok-beispiel"],
      [2, "tok-beispiel"],
    ]);
    const detail = await endpoints.getHotelWatch({ id: watch.id });
    expect(detail.checks[0].searches).toBe(3);
    const doubles = detail.offers.filter((o) => o.rooms === 2);
    expect(doubles[0]).toMatchObject({ room: "2 × Doppelzimmer, zwei Betten", per_night: 400 });
    // The cheapest free rate is in double rooms: 2 × 240.
    expect(detail.checks[0]).toMatchObject({ matching_per_night: 480, below_limit: true });
  });

  it("keep the check when the double-room search fails", async () => {
    const calls: HotelSearchParams[] = [];
    const inner = fakeClient(calls);
    const client: HotelSearchClient = {
      async search(params) {
        if (params.adults === 2) throw new Error("boom");
        return inner.search(params);
      },
    };
    const { watch } = await endpoints.createHotelWatch(input({ adults: 4, split_rooms: true }));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await runDueChecks(client, NOW);
    const detail = await endpoints.getHotelWatch({ id: watch.id });
    expect(detail.checks[0]).toMatchObject({ error: null, searches: 3 });
    expect(detail.offers.every((o) => o.rooms === 1)).toBe(true);
  });
});

describe("reports", () => {
  /** DETAIL with the free-cancellation rate of Portal A at `price`. */
  function priced(price: () => number): HotelSearchClient {
    return {
      async search(params) {
        if (!params.property_token) {
          return { properties: [{ name: "Hotel Beispiel Musterstadt", property_token: "tok-beispiel" }] };
        }
        const detail = structuredClone(DETAIL);
        detail.featured_prices[0].rooms[0].rates[1].rate_per_night.extracted_lowest = price();
        return detail;
      },
    };
  }

  function spy() {
    const pushed: PriceAlert[] = [];
    const mailed: Array<{ alert: PriceAlert; to: string }> = [];
    setAlertSender({
      async push(alert) {
        pushed.push(alert);
      },
      async email(alert, to) {
        mailed.push({ alert, to });
      },
    });
    return { pushed, mailed };
  }

  const at = (hours: number) => new Date(NOW.getTime() + hours * 60 * 60_000);

  it("report a price below the limit once, again for a new low, and again after it rose above", async () => {
    const { pushed, mailed } = spy();
    let price = 240;
    const client = priced(() => price);
    const { watch } = await endpoints.createHotelWatch(input({ limit_per_night: 250 }));

    await runDueChecks(client, at(0));
    expect(pushed).toHaveLength(1);
    expect(pushed[0]).toMatchObject({ watchId: watch.id, perNight: 240, limit: 250, newLow: false, source: "Portal A" });
    expect(pushed[0].link).toBe("https://portal-a.example/hotel");
    expect(mailed).toHaveLength(1);
    expect(mailed[0].to).toMatch(/@example\.com$/);

    await runDueChecks(client, at(24)); // same price: nothing new
    expect(pushed).toHaveLength(1);

    price = 230;
    await runDueChecks(client, at(48)); // new low
    expect(pushed).toHaveLength(2);
    expect(pushed[1]).toMatchObject({ perNight: 230, newLow: true });

    price = 255; // the cheapest free rate is now above the limit
    await runDueChecks(client, at(72));
    const [row] = await db.select().from(travelHotelWatches).where(eq(travelHotelWatches.id, watch.id));
    expect(row.notified_per_night).toBeNull();
    expect(pushed).toHaveLength(2);

    price = 245;
    await runDueChecks(client, at(96));
    expect(pushed).toHaveLength(3);
    expect(pushed[2]).toMatchObject({ perNight: 245, newLow: false });
  });

  it("send only on the chosen ways, and nothing for check now", async () => {
    const { pushed, mailed } = spy();
    const client = priced(() => 240);
    setHotelSearchClient(client);
    const { watch } = await endpoints.createHotelWatch(input({ notify_push: false }));
    expect(watch).toMatchObject({ notify_push: false, notify_email: true });

    await endpoints.checkHotelWatch({ id: watch.id });
    expect(pushed).toHaveLength(0);
    expect(mailed).toHaveLength(0);

    await runDueChecks(client, at(6));
    expect(pushed).toHaveLength(0);
    expect(mailed).toHaveLength(1);
  });

  it("report again once the criteria change", async () => {
    const { pushed } = spy();
    const client = priced(() => 240);
    const { watch } = await endpoints.createHotelWatch(input());
    await runDueChecks(client, at(0));
    expect(pushed).toHaveLength(1);

    await endpoints.updateHotelWatch({ id: watch.id, ...input({ limit_per_night: 245 }) });
    await runDueChecks(client, at(24));
    expect(pushed).toHaveLength(2);
  });
});

