import { describe, expect, it } from "vitest";
import { alertDecision, alertText, watchPath, type PriceAlert } from "./hotel-alerts";

describe("alertDecision", () => {
  it("reports the first price below the limit", () => {
    expect(alertDecision(200, 190, null)).toEqual({ kind: "report", newLow: false });
  });

  it("reports a new low below the last report, nothing for the same or a higher price", () => {
    expect(alertDecision(200, 180, 190)).toEqual({ kind: "report", newLow: true });
    expect(alertDecision(200, 190, 190)).toEqual({ kind: "none" });
    expect(alertDecision(200, 195, 190)).toEqual({ kind: "none" });
  });

  it("forgets the report once the price is back at the limit or nothing matches", () => {
    expect(alertDecision(200, 200, 190)).toEqual({ kind: "reset" });
    expect(alertDecision(200, null, 190)).toEqual({ kind: "reset" });
    expect(alertDecision(200, 210, null)).toEqual({ kind: "none" });
  });

  it("never reports without a limit", () => {
    expect(alertDecision(null, 100, null)).toEqual({ kind: "none" });
  });
});

describe("alertText", () => {
  const alert: PriceAlert = {
    userId: 1,
    watchId: 7,
    hotel: "Hotel Beispiel Musterstadt",
    checkIn: "2027-05-12",
    checkOut: "2027-05-14",
    nights: 2,
    currency: "EUR",
    perNight: 185,
    limit: 200,
    source: "Portal A",
    room: "Familienzimmer",
    freeCancellation: true,
    cancelUntil: "10. Mai",
    breakfast: false,
    link: null,
    newLow: false,
  };

  it("names hotel, price, provider, limit, dates and terms", () => {
    const t = alertText(alert);
    expect(t.title).toBe("Preis unter deiner Grenze: Hotel Beispiel Musterstadt");
    expect(t.body).toMatch(/185\s€ pro Nacht bei Portal A \(Grenze 200\s€\), 12\.05\.2027–14\.05\.2027, kostenlos stornierbar bis 10\. Mai/);
  });

  it("says a new low and unknown terms", () => {
    const t = alertText({ ...alert, newLow: true, freeCancellation: null, breakfast: true });
    expect(t.title).toMatch(/^Neuer Tiefstpreis/);
    expect(t.terms).toBe("Storno unbekannt, mit Frühstück");
  });

  it("links the watch in the web app", () => {
    expect(watchPath(7)).toBe("/app/reise/hotelpreise?watch=7");
  });
});
