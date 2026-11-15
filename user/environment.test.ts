import { describe, expect, it } from "vitest";

import { parseTestCopy } from "./environment";

describe("parseTestCopy", () => {
  it("reads the snapshot, its day and the refresh time the refresh writes", () => {
    expect(parseTestCopy("tank/f4mil@daily-2026-11-14_01-30\t2026-11-14T09:12:00Z\n")).toEqual({
      snapshot: "daily-2026-11-14_01-30",
      date: "2026-11-14",
      refreshed_at: "2026-11-14T09:12:00Z",
    });
  });

  it("keeps a label without a date and refuses an empty file", () => {
    expect(parseTestCopy("tank/f4mil@manual\n")).toEqual({ snapshot: "manual", date: null, refreshed_at: null });
    expect(parseTestCopy("\n")).toBeNull();
  });
});
