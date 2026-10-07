import { describe, it, expect } from "vitest";
import { dueNow, marketsOpen } from "./quotes-cron";

describe("marketsOpen", () => {
  it("is true on a weekday between 8 and 22 Berlin time", () => {
    expect(marketsOpen(new Date("2026-02-04T09:00:00+01:00"))).toBe(true);
    expect(marketsOpen(new Date("2026-02-04T21:59:00+01:00"))).toBe(true);
  });

  it("is false at night and on the weekend", () => {
    expect(marketsOpen(new Date("2026-02-04T22:30:00+01:00"))).toBe(false);
    expect(marketsOpen(new Date("2026-02-04T07:30:00+01:00"))).toBe(false);
    expect(marketsOpen(new Date("2026-02-07T12:00:00+01:00"))).toBe(false);
  });

  it("reads the Berlin hour, not the UTC one", () => {
    // 21:30 UTC in summer is 23:30 in Berlin.
    expect(marketsOpen(new Date("2026-07-01T21:30:00Z"))).toBe(false);
  });
});

describe("dueNow", () => {
  const open = new Date("2026-02-04T10:00:00+01:00");
  const night = new Date("2026-02-04T23:00:00+01:00");
  const min = (d: Date, n: number) => new Date(d.getTime() - n * 60_000);

  it("fetches at once when it never has", () => {
    expect(dueNow(open, null, null)).toBe(true);
  });

  it("fetches every five minutes while markets trade, hourly otherwise", () => {
    expect(dueNow(open, min(open, 5), null)).toBe(true);
    expect(dueNow(open, min(open, 3), null)).toBe(false);
    expect(dueNow(night, min(night, 30), null)).toBe(false);
    expect(dueNow(night, min(night, 60), null)).toBe(true);
  });

  it("waits out a backoff", () => {
    expect(dueNow(open, min(open, 60), new Date(open.getTime() + 60_000))).toBe(false);
    expect(dueNow(open, min(open, 60), min(open, 1))).toBe(true);
  });
});
