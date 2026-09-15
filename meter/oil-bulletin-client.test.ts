import { describe, it, expect } from "vitest";
import ExcelJS from "exceljs";
import {
  EuOilBulletinClient,
  findHistoryWorkbookUrl,
  MAX_PLAUSIBLE_EUR_PER_L,
  OilBulletinUnavailableError,
  parseWeeklyPrices,
  priceColumnName,
  weekOf,
} from "./oil-bulletin-client";

const PAGE_URL = "https://energy.ec.europa.eu/data-and-analysis/weekly-oil-bulletin_en";

describe("priceColumnName", () => {
  it("names the column the bulletin uses", () => {
    expect(priceColumnName("DE", "euro95")).toBe("DE_price_with_tax_euro95");
    expect(priceColumnName("at", "diesel")).toBe("AT_price_with_tax_diesel");
  });
});

describe("findHistoryWorkbookUrl", () => {
  it("picks the history workbook out of the several the page links", () => {
    const html = `
      <a href="/document/download/aaa_en?filename=Weekly%20Oil%20Bulletin%20Weekly%20prices%20with%20Taxes%20-%202026-09-07.xlsx">week</a>
      <a href="/document/download/bbb_en?filename=Oil_Bulletin_Duties_and_taxes.xlsx">duties</a>
      <a href="/document/download/ccc_en?filename=Weekly_Oil_Bulletin_Prices_History_maticni_4web.xlsx">history</a>
    `;
    expect(findHistoryWorkbookUrl(html, PAGE_URL)).toBe(
      "https://energy.ec.europa.eu/document/download/ccc_en?filename=Weekly_Oil_Bulletin_Prices_History_maticni_4web.xlsx",
    );
  });

  it("unescapes the query string of the link", () => {
    const html =
      '<a href="/document/download/ccc_en?filename=Weekly_Oil_Bulletin_Prices_History.xlsx&amp;x=1">h</a>';
    expect(findHistoryWorkbookUrl(html, PAGE_URL)).toContain("History.xlsx&x=1");
  });

  it("says so when the page stops linking the file", () => {
    expect(() => findHistoryWorkbookUrl("<a href=\"/other.pdf\">x</a>", PAGE_URL)).toThrow(
      OilBulletinUnavailableError,
    );
  });
});

describe("weekOf", () => {
  it("takes a date as the workbook hands it over", () => {
    expect(weekOf(new Date(Date.UTC(2026, 8, 7)))).toBe("2026-09-07");
  });

  it("decodes an Excel serial", () => {
    // 46272 is the serial of 2026-09-07 in the 1900 system.
    expect(weekOf(46272)).toBe("2026-09-07");
  });

  it("refuses anything that is not a day", () => {
    expect(weekOf("Date")).toBeNull();
    expect(weekOf(null)).toBeNull();
    expect(weekOf(0)).toBeNull();
  });
});

describe("parseWeeklyPrices", () => {
  const header = ["Consumer prices", "CTR", "EU_price_with_tax_euro95", "CTR", "DE_price_with_tax_euro95"];

  it("converts the quote per 1000 litres into a price per litre", () => {
    const rows = [
      header,
      ["Date", "", "1000 l", "", "1000 l"],
      [new Date(Date.UTC(2026, 8, 7)), "EU_", 2041.66, "DE_", 2331],
      [new Date(Date.UTC(2026, 7, 31)), "EU_", 1949.99, "DE_", 2236],
    ];
    expect(parseWeeklyPrices(rows, "DE_price_with_tax_euro95")).toEqual([
      { week: "2026-08-31", eurPerLitre: 2.236 },
      { week: "2026-09-07", eurPerLitre: 2.331 },
    ]);
  });

  it("skips a week the country did not report", () => {
    const rows = [
      header,
      [new Date(Date.UTC(2026, 8, 7)), "EU_", 2041.66, "DE_", 2331],
      [new Date(Date.UTC(2026, 8, 14)), "EU_", 2044.2, "DE_", undefined],
    ];
    expect(parseWeeklyPrices(rows, "DE_price_with_tax_euro95")).toHaveLength(1);
  });

  it("drops a figure that cannot be a pump price", () => {
    // If the source ever quotes per litre, 2.33 / 1000 lands far below the
    // band and must not be written as a price.
    const rows = [
      header,
      [new Date(Date.UTC(2026, 8, 7)), "EU_", 2.04, "DE_", 2.331],
      [new Date(Date.UTC(2026, 8, 14)), "EU_", 2.04, "DE_", MAX_PLAUSIBLE_EUR_PER_L * 1000 + 1],
    ];
    expect(parseWeeklyPrices(rows, "DE_price_with_tax_euro95")).toEqual([]);
  });

  it("names the column it could not find", () => {
    expect(() => parseWeeklyPrices([header], "FR_price_with_tax_euro95")).toThrow(
      /FR_price_with_tax_euro95/,
    );
  });

  it("refuses an empty sheet", () => {
    expect(() => parseWeeklyPrices([], "DE_price_with_tax_euro95")).toThrow(
      OilBulletinUnavailableError,
    );
  });
});

/**
 * Reads a workbook of the published shape end to end, so the row/column
 * offsets of the reader stay pinned to a real file rather than to a hand-made
 * matrix. The bytes are built here; nothing leaves the house.
 */
describe("EuOilBulletinClient", () => {
  async function bulletinWorkbook(): Promise<Buffer> {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Prices with taxes");
    sheet.addRow([
      "Consumer prices of petroleum products inclusive of duties and taxes",
      "CTR",
      "EU_price_with_tax_euro95",
      "CTR",
      "DE_price_with_tax_euro95",
      "DE_price_with_tax_diesel",
    ]);
    sheet.addRow([null, null, "Euro-super 95  (I)", null, "Euro-super 95  (I)", "Diesel"]);
    sheet.addRow(["Date", null, "1000 l", null, "1000 l", "1000 l"]);
    sheet.addRow([new Date(Date.UTC(2026, 8, 7)), "EU_", 2041.66, "DE_", 2331, 2328]);
    sheet.addRow([new Date(Date.UTC(2026, 7, 31)), "EU_", 1949.99, "DE_", 2236, 2250]);
    return (await workbook.xlsx.writeBuffer()) as Buffer;
  }

  function stubFetch(page: string, workbook: Buffer) {
    return async (input: string | URL): Promise<Response> => {
      const url = String(input);
      if (url.endsWith(".xlsx")) {
        return new Response(workbook, { status: 200 });
      }
      return new Response(page, { status: 200 });
    };
  }

  it("reads the wanted country and fuel out of the workbook", async () => {
    const page =
      '<a href="https://energy.ec.europa.eu/Weekly_Oil_Bulletin_Prices_History.xlsx">history</a>';
    const original = globalThis.fetch;
    globalThis.fetch = stubFetch(page, await bulletinWorkbook()) as typeof fetch;
    try {
      const client = new EuOilBulletinClient();
      expect(await client.weeklyPrices("DE", "euro95")).toEqual([
        { week: "2026-08-31", eurPerLitre: 2.236 },
        { week: "2026-09-07", eurPerLitre: 2.331 },
      ]);
      expect(await client.weeklyPrices("DE", "diesel")).toEqual([
        { week: "2026-08-31", eurPerLitre: 2.25 },
        { week: "2026-09-07", eurPerLitre: 2.328 },
      ]);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("reports an outage instead of an internal error", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => new Response("nope", { status: 503 })) as typeof fetch;
    try {
      await expect(new EuOilBulletinClient().weeklyPrices("DE", "euro95")).rejects.toThrow(
        OilBulletinUnavailableError,
      );
    } finally {
      globalThis.fetch = original;
    }
  });
});
