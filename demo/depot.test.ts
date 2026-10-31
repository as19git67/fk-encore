/**
 * The demo depot: trades at the day's close, holdings that add up, a
 * booking for each paper, and papers the pipeline's own parsers read back
 * to the same figures — so the depot fills itself from the documents.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { extractPdfText } from "../documents/text-extract";
import { parseSettlement } from "../finance/depot-settlement-parser";
import { inspectDepotStatement } from "../finance/depot-statement-parser";
import { closeOn, planDepot, type Closes } from "./depot";
import { planDocuments } from "./documents";
import { planHousehold } from "./household";
import { layoutDocument, renderPdf } from "./pdf-render";
import { DEMO_DEPOT_NUMBER, DEMO_SECURITIES } from "./securities";

const today = "2026-10-26";

/** Weekday closes, a gentle wave per fund — no network. */
function syntheticCloses(): Closes {
  const closes: Closes = new Map();
  DEMO_SECURITIES.forEach((s, i) => {
    const series: Array<{ day: string; price: number }> = [];
    for (let t = Date.parse("2023-09-01T12:00:00Z"); t <= Date.parse(`${today}T12:00:00Z`); t += 86_400_000) {
      const d = new Date(t);
      if (d.getUTCDay() === 0 || d.getUTCDay() === 6) continue;
      series.push({ day: d.toISOString().slice(0, 10), price: Math.round((40 + 25 * i) * (1 + 0.08 * Math.sin(t / 2e9)) * 100) / 100 });
    }
    closes.set(s.isin, series);
  });
  return closes;
}

const household = planHousehold(7, "full", today);
const closes = syntheticCloses();
const depot = planDepot(7, "full", household, closes);
household.bookings.push(...depot.bookings);
household.bookings.sort((a, b) => a.date.localeCompare(b.date));
const docs = planDocuments(7, "full", household, depot.documents).documents;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "demo-depot-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

async function textOf(key: string): Promise<string> {
  const d = docs.find((x) => x.key === key)!;
  const file = path.join(dir, `${key}.pdf`);
  fs.writeFileSync(file, await renderPdf(layoutDocument(d), d.subject));
  return (await extractPdfText(file)).text;
}

describe("planDepot", () => {
  it("is the same for the same seed and closes", () => {
    expect(planDepot(7, "full", household, closes)).toEqual(depot);
  });

  it("runs the savings plan every month and pays the distributing funds", () => {
    const kinds = depot.documents.map((d) => d.kind);
    expect(kinds.filter((k) => k === "securities_buy").length).toBeGreaterThanOrEqual(36);
    expect(kinds.filter((k) => k === "securities_sell")).toHaveLength(1);
    expect(kinds.filter((k) => k === "distribution").length).toBeGreaterThan(10);
    expect(kinds.filter((k) => k === "depot_statement").length).toBeGreaterThanOrEqual(11);
  });

  it("trades at the day's close and books the settlement's net on the giro account", () => {
    for (const d of depot.documents.filter((x) => x.kind === "securities_buy" || x.kind === "securities_sell")) {
      const fact = (label: string) => d.facts!.find((f) => f.label === label)!.value;
      const isin = fact("ISIN");
      const close = closeOn(closes.get(isin)!, d.date)!;
      expect(fact("Ausführungskurs")).toContain(close.price.toLocaleString("de-DE", { minimumFractionDigits: 2 }));
      const b = d.bookingRef!;
      expect(b.account).toBe("giro_self");
      expect(Math.abs(b.cents)).toBe(d.totalCents);
      expect(b.cents < 0).toBe(d.kind === "securities_buy");
      expect(b.purpose).toContain(isin);
    }
  });

  it("states on each quarter's end what the trades up to it add up to", () => {
    for (const st of depot.documents.filter((d) => d.kind === "depot_statement")) {
      for (const p of st.positions!) {
        const units = depot.documents
          .filter((d) => (d.kind === "securities_buy" || d.kind === "securities_sell") && d.date <= st.date && d.facts!.some((f) => f.label === "ISIN" && f.value === p.isin))
          .reduce((s, d) => {
            const q = Number(d.facts!.find((f) => f.label === "Stück")!.value.replace(/\./g, "").replace(",", "."));
            return s + (d.kind === "securities_buy" ? q : -q);
          }, 0);
        expect(p.quantity).toBeCloseTo(units, 3);
      }
    }
  });

  it("ties every paper but the statements to its booking in the merged plan", () => {
    for (const d of docs.filter((x) => ["securities_buy", "securities_sell", "distribution"].includes(x.kind))) {
      expect(d.booking).not.toBeNull();
      expect(Math.abs(household.bookings[d.booking!].cents)).toBe(d.totalCents);
    }
    expect(docs).toHaveLength(500);
  });

  it("stays empty without closes", () => {
    const empty = planDepot(7, "full", household, new Map());
    expect(empty.bookings).toHaveLength(0);
    expect(empty.documents).toHaveLength(0);
  });
});

describe("the depot papers, read back by the pipeline's parsers", () => {
  it("reads a savings plan buy", async () => {
    const d = docs.find((x) => x.kind === "securities_buy")!;
    const s = parseSettlement(await textOf(d.key))!;
    expect(s).toMatchObject({ kind: "buy", isin: DEMO_SECURITIES[0].isin, depotNumber: DEMO_DEPOT_NUMBER, executedAt: d.date });
    expect(Math.round(Math.abs(s.net!) * 100)).toBe(d.totalCents);
    expect(s.quantity).toBeGreaterThan(0);
  });

  it("reads the sale and a distribution", async () => {
    const sale = docs.find((x) => x.kind === "securities_sell")!;
    const s = parseSettlement(await textOf(sale.key))!;
    expect(s).toMatchObject({ kind: "sell", isin: DEMO_SECURITIES[2].isin, executedAt: sale.date });
    expect(Math.round(s.net! * 100)).toBe(sale.totalCents);

    const payout = docs.find((x) => x.kind === "distribution")!;
    const p = parseSettlement(await textOf(payout.key))!;
    expect(p.kind).toBe("dividend");
    expect(Math.round(p.net! * 100)).toBe(payout.totalCents);
  });

  it("reads a depot statement's date, depot and positions", async () => {
    const d = docs.find((x) => x.kind === "depot_statement")!;
    const r = inspectDepotStatement(await textOf(d.key))!;
    expect(r.statement).toBe(true);
    expect(r.asOf).toBe(d.date);
    expect(r.depotNumber).toBe(DEMO_DEPOT_NUMBER);
    expect(r.positions.map((p) => p.isin).sort()).toEqual(d.positions!.map((p) => p.isin).sort());
    for (const p of r.positions) {
      expect(p.quantity).toBeCloseTo(d.positions!.find((x) => x.isin === p.isin)!.quantity, 3);
    }
  });
});
