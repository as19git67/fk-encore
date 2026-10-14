import { describe, it, expect } from "vitest";
import { normalizeSortOrder, sortItems, type SortSubject } from "./collection-sort";

describe("normalizeSortOrder", () => {
  it("keeps known fields once, at most three, defaulting to ascending", () => {
    expect(
      normalizeSortOrder([
        { field: "correspondent" },
        { field: "doc_date", dir: "desc" },
        { field: "correspondent", dir: "desc" },
        { field: "colour" },
        { field: "title", dir: "sideways" },
      ]),
    ).toEqual([
      { field: "correspondent", dir: "asc" },
      { field: "doc_date", dir: "desc" },
      { field: "title", dir: "asc" },
    ]);
  });

  it("means 'by hand' when nothing usable is left", () => {
    expect(normalizeSortOrder([])).toBeNull();
    expect(normalizeSortOrder(null)).toBeNull();
    expect(normalizeSortOrder([{ field: "colour" }])).toBeNull();
  });
});

describe("sortItems", () => {
  const item = (position: number, correspondent: string | null, title: string | null, doc_date: string | null): SortSubject & { n: number } =>
    ({ n: position, position, correspondent, title, doc_date });

  const items = [
    item(0, "Zweite Bank", "Kontoauszug 10", "2024-03-01"),
    item(1, "Erste Kasse", "Rechnung", "2024-05-01"),
    item(2, null, "anschreiben", null),
    item(3, "erste kasse", "Bescheid", "2023-12-24"),
    item(4, "Zweite Bank", "Kontoauszug 9", null),
  ];

  it("sorts by correspondent, then title, names collated (case, numbers)", () => {
    const keys = [{ field: "correspondent", dir: "asc" }, { field: "title", dir: "asc" }] as const;
    expect(sortItems(items, keys).map((i) => i.n)).toEqual([3, 1, 4, 0, 2]);
  });

  it("puts a missing value last in either direction", () => {
    expect(sortItems(items, [{ field: "doc_date", dir: "asc" }]).map((i) => i.n)).toEqual([3, 0, 1, 2, 4]);
    expect(sortItems(items, [{ field: "doc_date", dir: "desc" }]).map((i) => i.n)).toEqual([1, 0, 3, 2, 4]);
  });

  it("keeps the current order on a full tie", () => {
    const same = [item(0, "A", "x", null), item(1, "A", "x", null)];
    expect(sortItems(same, [{ field: "correspondent", dir: "desc" }]).map((i) => i.n)).toEqual([0, 1]);
  });
});
