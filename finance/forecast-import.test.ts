import { describe, it, expect } from "vitest";
import ExcelJS from "exceljs";

import { buildImportItem, contractNoFromLabel, readImportWorkbook, suggestType, type ImportRaw } from "./forecast-import";

// The workbook below is invented: labels, contract numbers and amounts are
// made up and only mimic the shape of a household overview.

const PERSONS = [
  { id: 1, label: "Alex" },
  { id: 2, label: "Kim" },
];

async function workbook(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const list = wb.addWorksheet("Liste");
  list.addRow([
    null,
    "Betrag",
    "jährliche Einnahmen (€)",
    "jährliche Ausgaben (€)",
    "einmalige Einnahmen/Ausgaben (€)",
    "Beitragszahlung bis",
    "Auszahlung im Jahr",
  ]);
  list.addRow(["Bar Alex (incl. Depot)", 10000, null, null, 10000, 2020]); // 2
  list.addRow(["Einkommen Kim (netto)", null, 24000]); // 3
  list.addRow(["Mieteinnahmen", null, 6000]); // 4
  list.addRow(["Fondsrente Beispiel", null, 0, null, 20000, null, 2030]); // 5
  list.addRow(["Bausparvertrag", null, null, 12000, 0, 2026, 2027]); // 6 positive expense
  list.addRow(["Zinsen Kredit", null, null, -1200]); // 7
  list.addRow(["Tilgung Kredit", null, null, -6000, null, 2027]); // 8
  list.addRow(["Tilgung Kredit Rest", null, null, null, -30000, 2028]); // 9
  list.addRow(["X-000111", null, null, -1200, { formula: "30000+0", result: 30000 }, 2035, 2036]); // 10 formula cell
  list.addRow(["Y-000222", null, null, -600, 15000]); // 11 no payout year → detail sheet
  list.addRow(["Z-000333", null, null, -900, 9000]); // 12 no year, no detail
  list.addRow(["Haftpflicht", null, null, -120]); // 13
  list.addRow(["Rente Alex", null, 18000, null, null, null, 2040]); // 14
  list.addRow(["Riester Kim", null, null, -1500]); // 15
  list.addRow(["Unterstützungskasse Kim", null, 2400, null, null, null, 2045]); // 16
  list.addRow(["Leben", null, null, -24000]); // 17
  list.addRow(["Nullvertrag (Alex)", null, null, 0]); // 18
  list.addRow(["Fondsausschüttung", null, 5000, null, 0, null, 2020, "Notiz zur Zeile"]); // 19

  const d1 = wb.addWorksheet("Y-000222");
  d1.addRow(["Bezeichnung", "Fondsgebundene LV"]);
  d1.addRow(["Versicherungsnummer", "Y-000222"]);
  d1.addRow(["Versicherte Person", "Kim Beispiel"]);
  d1.addRow(["Ablauf der Versicherung", new Date(Date.UTC(2040, 9, 1))]);
  d1.addRow(["Ablauf der Beitragszahlung", new Date(Date.UTC(2032, 9, 1))]);
  d1.addRow(["aktueller Anteilswert", 8000]);

  const d2 = wb.addWorksheet("LX000111");
  d2.addRow(["Versicherungsnummer", "X-000111"]);
  d2.addRow(["Versicherte Person", "Alex Beispiel"]);
  d2.addRow(["aktueller Anteilswert", 12000]);

  const plan = wb.addWorksheet("Plan");
  plan.addRow(["durchschnittliche angenommene Inflationsrate", 0.03]);
  plan.addRow(["angenommene Rentenanpassung jährlich", 0.015]);

  return (await wb.xlsx.writeBuffer()) as unknown as Buffer;
}

describe("readImportWorkbook", () => {
  it("finds the summary sheet, its rows and the assumptions", async () => {
    const p = await readImportWorkbook(await workbook(), PERSONS, [], 2026);
    expect(p.sheet).toBe("Liste");
    expect(p.rows).toHaveLength(18);
    expect(p.inflationRate).toBe(0.03);
    expect(p.pensionGrowthRate).toBe(0.015);
    expect(p.warnings).toEqual([]);
  });

  it("suggests a type and a person per row", async () => {
    const p = await readImportWorkbook(await workbook(), PERSONS, [], 2026);
    const by = Object.fromEntries(p.rows.map((r) => [r.label, r]));

    expect(by["Bar Alex (incl. Depot)"].suggestion).toMatchObject({ type: "asset", personId: 1, include: true });
    expect(by["Bar Alex (incl. Depot)"].summary).toContain("Konto");
    expect(by["Einkommen Kim (netto)"].suggestion).toMatchObject({ type: "salary", personId: 2, include: true });
    expect(by["Mieteinnahmen"].suggestion).toMatchObject({ type: "income", personId: null, include: true });
    expect(by["Fondsrente Beispiel"].suggestion).toMatchObject({ type: "income", include: true });
    expect(by["Bausparvertrag"].suggestion).toMatchObject({ type: "expense", include: false });
    expect(by["Zinsen Kredit"].suggestion).toMatchObject({ type: "expense", include: true });
    expect(by["Tilgung Kredit Rest"].suggestion.type).toBe("expense");
    expect(by["Rente Alex"].suggestion).toMatchObject({ type: "pension", personId: 1, include: true });
    expect(by["Unterstützungskasse Kim"].suggestion).toMatchObject({ type: "pension", personId: 2 });
    expect(by["Leben"].suggestion).toMatchObject({ type: "living_expense", include: true });
    expect(by["Nullvertrag (Alex)"].suggestion).toMatchObject({ type: null, include: false, reason: "Kein Betrag" });
    expect(by["Fondsausschüttung"].suggestion.reason).toMatch(/Vergangenheit/);
    expect(by["Fondsausschüttung"].raw.note).toBe("Notiz zur Zeile");
  });

  it("reads formula results and matches contracts to their detail sheets", async () => {
    const p = await readImportWorkbook(await workbook(), PERSONS, [], 2026);
    const by = Object.fromEntries(p.rows.map((r) => [r.label, r]));

    const x = by["X-000111"];
    expect(x.raw.once).toBe(30000);
    expect(x.raw.detail?.currentValue).toBe(12000);
    expect(x.suggestion).toMatchObject({ type: "life_insurance", personId: 1, include: true });
    expect(x.summary?.replace(/\u00a0/g, " ")).toBe("Beitrag 100 €/Monat bis 12/2035, Auszahlung 30.000 € 01/2036");

    // No payout year in the list: maturity and premium end come from the detail sheet.
    const y = by["Y-000222"];
    expect(y.raw.detail?.maturity).toBe("2040-10-01");
    expect(y.suggestion).toMatchObject({ type: "life_insurance", personId: 2, include: true });

    // No year anywhere: proposed, but left out until the user adds it.
    const z = by["Z-000333"];
    expect(z.suggestion).toMatchObject({ type: "life_insurance", include: false });
    expect(z.suggestion.reason).toMatch(/Ablaufjahr fehlt/);
  });

  it("guesses a person for personal items it cannot attribute, and flags it", async () => {
    const p = await readImportWorkbook(await workbook(), [{ id: 7, label: "Sam" }], [], 2026);
    const salary = p.rows.find((r) => r.label === "Einkommen Kim (netto)")!;
    expect(salary.suggestion.personId).toBe(7);
    expect(salary.suggestion.reason).toMatch(/Person nicht erkannt/);
  });

  it("leaves out rows that already exist and warns when there are no persons", async () => {
    const p = await readImportWorkbook(await workbook(), [], ["mieteinnahmen"], 2026);
    expect(p.rows.find((r) => r.label === "Mieteinnahmen")!.suggestion.include).toBe(false);
    expect(p.warnings[0]).toMatch(/keine Person/);
    // Without persons a salary cannot be built.
    expect(p.rows.find((r) => r.label === "Einkommen Kim (netto)")!.suggestion.include).toBe(false);
  });

  it("rejects a file that is not a workbook, or has no summary sheet", async () => {
    await expect(readImportWorkbook(Buffer.from("not a workbook"), PERSONS, [], 2026)).rejects.toThrow(/keine lesbare/);
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet("Leer").addRow(["irgendwas"]);
    const buf = (await wb.xlsx.writeBuffer()) as unknown as Buffer;
    await expect(readImportWorkbook(buf, PERSONS, [], 2026)).rejects.toThrow(/Keine Übersichtstabelle/);
  });
});

describe("buildImportItem", () => {
  const opts = { currentYear: 2026, pensionGrowthRate: 0.015 };
  const raw = (over: Partial<ImportRaw>): ImportRaw => ({
    amount: null,
    incomeYearly: null,
    expenseYearly: null,
    once: null,
    contributionUntilYear: null,
    payoutYear: null,
    note: null,
    detail: null,
    ...over,
  });

  it("builds monthly amounts from yearly ones", () => {
    const salary = buildImportItem("Einkommen", raw({ incomeYearly: 24000 }), "salary", 1, opts);
    expect(salary).toMatchObject({ type: "salary", data: { amount: 2000 } });
    const rent = buildImportItem("Miete", raw({ incomeYearly: 6000, contributionUntilYear: 2030 }), "income", null, opts);
    expect(rent).toMatchObject({ data: { amount: 500, frequency: "monthly", end: { kind: "date", date: "2031-01-01" } } });
  });

  it("builds one-off income and expenses at their year", () => {
    expect(buildImportItem("Auszahlung", raw({ once: 20000, payoutYear: 2030 }), "income", null, opts)).toMatchObject({
      data: { amount: 20000, frequency: "once", start: { kind: "date", date: "2030-01-01" } },
    });
    expect(buildImportItem("Rest", raw({ once: -30000, contributionUntilYear: 2028 }), "expense", null, opts)).toMatchObject({
      data: { amount: 30000, frequency: "once", start: { kind: "date", date: "2028-01-01" } },
    });
  });

  it("keeps loans at a fixed amount and lets other expenses follow inflation", () => {
    expect(buildImportItem("Zinsen Kredit", raw({ expenseYearly: -1200 }), "expense", null, opts)).toMatchObject({
      data: { amount: 1200, frequency: "yearly", growthRate: 0 },
    });
    expect(buildImportItem("Haftpflicht", raw({ expenseYearly: -120 }), "expense", null, opts)).toMatchObject({
      data: { growthRate: null },
    });
  });

  it("builds a life insurance from the list and the detail sheet", () => {
    const b = buildImportItem(
      "LV",
      raw({
        expenseYearly: -1200,
        once: 30000,
        contributionUntilYear: 2035,
        payoutYear: 2036,
        detail: { contractNo: "X", insuredPerson: null, insurer: null, maturity: "2037-10-01", premiumEnd: null, currentValue: 12000 },
      }),
      "life_insurance",
      1,
      opts,
    );
    expect(b).toMatchObject({
      data: {
        monthlyPremium: 100,
        premiumEnd: { kind: "date", date: "2036-01-01" },
        maturity: { kind: "date", date: "2036-01-01" }, // the list's payout year wins over the contract's end
        surrenderValue: 12000,
        projectedPayout: 30000,
      },
    });
  });

  it("builds pensions with the workbook's adjustment and the right kind", () => {
    expect(buildImportItem("Rente Alex", raw({ incomeYearly: 18000, payoutYear: 2040 }), "pension", 1, opts)).toMatchObject({
      data: { kind: "statutory", monthlyAmount: 1500, growthRate: 0.015, start: { kind: "date", date: "2040-01-01" } },
    });
    expect(buildImportItem("Riester Kim", raw({ incomeYearly: 3000, payoutYear: 2040 }), "pension", 2, opts)).toMatchObject({
      data: { kind: "private" },
    });
    expect(buildImportItem("Unterstützungskasse", raw({ incomeYearly: 3000, payoutYear: 2040 }), "pension", 2, opts)).toMatchObject({
      data: { kind: "company" },
    });
  });

  it("reports what is missing instead of guessing", () => {
    expect(buildImportItem("X", raw({ incomeYearly: 1000 }), "salary", null, opts)).toEqual({ error: "Dieser Eintrag braucht eine Person" });
    expect(buildImportItem("X", raw({ expenseYearly: -100, once: 5000 }), "life_insurance", 1, opts)).toEqual({ error: "Ablaufjahr fehlt" });
    expect(buildImportItem("X", raw({ incomeYearly: 1000 }), "pension", 1, opts)).toEqual({ error: "Rentenbeginn fehlt" });
    expect(buildImportItem("X", raw({}), "income", null, opts)).toEqual({ error: "Keine Einnahme" });
  });
});

describe("contract numbers", () => {
  it("finds a contract number in the label", () => {
    expect(contractNoFromLabel("X-000111")).toBe("X-000111");
    expect(contractNoFromLabel("Q-12345678-02 (BU)")).toBe("Q-12345678-02");
    expect(contractNoFromLabel("Anbieter 987654321 Kind")).toBe("987654321");
    expect(contractNoFromLabel("Tarif L 1.234.567 (Alex)")).toBe("L 1.234.567");
    expect(contractNoFromLabel("123456")).toBe("123456");
    expect(contractNoFromLabel("Rente Alex")).toBeNull();
    expect(contractNoFromLabel("Kredit 2025")).toBeNull();
  });

  it("stores the contract number and insurer on the built item", () => {
    const opts = { currentYear: 2026, pensionGrowthRate: 0.015 };
    const base: ImportRaw = { amount: null, incomeYearly: null, expenseYearly: -1200, once: 30000, contributionUntilYear: null, payoutYear: 2036, note: null, detail: null };
    // From the detail sheet, which wins over the label.
    const fromDetail = buildImportItem(
      "LV 555555",
      { ...base, detail: { contractNo: "X-000111", insuredPerson: null, insurer: "Beispiel Leben AG", maturity: null, premiumEnd: null, currentValue: 1000 } },
      "life_insurance",
      1,
      opts,
    );
    expect(fromDetail).toMatchObject({ data: { contractNo: "X-000111", insurer: "Beispiel Leben AG" } });
    // A suffix on the detail sheet's number is dropped.
    const suffixed = buildImportItem(
      "Zusatz",
      { ...base, detail: { contractNo: "X-000222-03 (BU)", insuredPerson: null, insurer: null, maturity: null, premiumEnd: null, currentValue: null } },
      "life_insurance",
      1,
      opts,
    );
    expect(suffixed).toMatchObject({ data: { contractNo: "X-000222-03" } });
    // From the label when there is no detail sheet.
    expect(buildImportItem("LV 555555", base, "life_insurance", 1, opts)).toMatchObject({ data: { contractNo: "555555" } });
    // Nothing when neither has one.
    const none = buildImportItem("Haftpflicht", { ...base, once: null, payoutYear: null }, "expense", null, opts);
    expect("error" in none ? none : none.data.contractNo).toBeUndefined();
  });
});

describe("suggestType", () => {
  it("treats an all-zero row as nothing to import", () => {
    expect(suggestType("Irgendwas", { amount: 0, incomeYearly: null, expenseYearly: 0, once: null, contributionUntilYear: null, payoutYear: null, note: null, detail: null }, 2026)).toMatchObject({
      type: null,
      include: false,
    });
  });
});
