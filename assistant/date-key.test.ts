import { describe, expect, it } from "vitest";
import { dateKey } from "./tools/ranking";

describe("dateKey", () => {
  it("keys a date by year, quarter, month, ISO week and day", () => {
    expect(dateKey("2025-05-02T21:00:00", "year")).toBe("2025");
    expect(dateKey("2025-05-02T21:00:00", "quarter")).toBe("2025-Q2");
    expect(dateKey("2025-05-02T21:00:00", "month")).toBe("2025-05");
    expect(dateKey("2025-05-02T21:00:00", "day")).toBe("2025-05-02");
    expect(dateKey("2025-05-02", "week")).toBe("2025-W18");
  });

  it("gives a week at the turn of the year to the year that owns it", () => {
    expect(dateKey("2024-12-30", "week")).toBe("2025-W01");
    expect(dateKey("2021-01-03", "week")).toBe("2020-W53");
  });

  it("has no day or week for a date without a day", () => {
    expect(dateKey("2025-05", "day")).toBeUndefined();
    expect(dateKey("2025-05", "week")).toBeUndefined();
  });
});
