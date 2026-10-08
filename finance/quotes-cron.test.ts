import { describe, it, expect } from "vitest";
import { marketsOpen, nextQuoteTick } from "./quotes-cron";

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

describe("nextQuoteTick", () => {
  const open = new Date("2026-02-04T10:00:00+01:00");
  const night = new Date("2026-02-04T23:00:00+01:00");
  const plus = (d: Date, min: number) => new Date(d.getTime() + min * 60_000);

  it("fires every five minutes while markets trade, hourly otherwise", () => {
    expect(nextQuoteTick(open, null)).toEqual(plus(open, 5));
    expect(nextQuoteTick(night, null)).toEqual(plus(night, 60));
  });

  it("waits out a backoff, and ignores one that is over", () => {
    expect(nextQuoteTick(open, plus(open, 15))).toEqual(plus(open, 15));
    expect(nextQuoteTick(open, plus(open, -1))).toEqual(plus(open, 5));
  });
});
