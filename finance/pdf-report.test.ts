import { describe, expect, it } from "vitest";
import { createExpenseReportPdf } from "./pdf-report";

describe("createExpenseReportPdf", () => {
  it("creates a non-empty PDF document", async () => {
    const pdf = createExpenseReportPdf([{
      booking_date: "2026-07-06",
      counterparty: "Hotel Beispiel",
      purpose: "Übernachtung",
      amount: "-129.90",
      currency_code: "EUR",
      notice: "Dienstreise",
      tags: ["spesen"],
    }], "2026-07-06");
    const chunks: Buffer[] = [];
    pdf.on("data", chunk => chunks.push(Buffer.from(chunk)));
    pdf.end();
    await new Promise<void>((resolve, reject) => { pdf.on("end", resolve); pdf.on("error", reject); });
    const result = Buffer.concat(chunks);
    expect(result.subarray(0, 5).toString()).toBe("%PDF-");
    expect(result.length).toBeGreaterThan(500);
  });
});
