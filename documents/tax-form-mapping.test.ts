import { describe, expect, it } from "vitest";
import { mapToForm, type EvidenceValue } from "./tax-form-mapping";

const v = (documentId: number, evidenceKind: string, field: string, value: number, owner: EvidenceValue["owner"] = "self", status: EvidenceValue["status"] = "read"): EvidenceValue =>
  ({ documentId, evidenceKind, field, value, owner, status });

const find = (m: ReturnType<typeof mapToForm>, key: string, owner: string) => m.values.find((x) => x.field.key === key && x.owner === owner);

describe("mapToForm", () => {
  it("never guesses whose a value is under joint assessment when the document names neither spouse", () => {
    const joint = mapToForm(2025, [v(1, "lohnsteuerbescheinigung", "bruttoarbeitslohn", 3000000, "none")], { joint: true });
    const open = find(joint, "n.bruttoarbeitslohn", "person:?")!;
    expect(open.cents).toBe(3000000);
    expect(open.notes).toContain("Person zuordnen: der Beleg ist mit keinem der Ehegatten als Bezugsperson verknüpft.");
    expect(find(joint, "n.bruttoarbeitslohn", "self")).toBeUndefined();
    // Alone, there is only one person it can be.
    const single = mapToForm(2025, [v(1, "lohnsteuerbescheinigung", "bruttoarbeitslohn", 3000000, "none")], { joint: false });
    expect(find(single, "n.bruttoarbeitslohn", "self")!.cents).toBe(3000000);
  });

  it("sums several employers per person and keeps where each value came from", () => {
    const m = mapToForm(2025, [
      v(1, "lohnsteuerbescheinigung", "bruttoarbeitslohn", 3000000),
      v(2, "lohnsteuerbescheinigung", "bruttoarbeitslohn", 1200000),
      v(3, "lohnsteuerbescheinigung", "bruttoarbeitslohn", 2500000, "spouse"),
    ], { joint: true });
    const self = find(m, "n.bruttoarbeitslohn", "self")!;
    expect(self.cents).toBe(4200000);
    expect(self.contributions.map((c) => [c.documentId, c.cents])).toEqual([[1, 3000000], [2, 1200000]]);
    expect(self.notes).toContain("Vom Finanzamt elektronisch vorausgefüllt: nur prüfen.");
    expect(find(m, "n.bruttoarbeitslohn", "spouse")!.cents).toBe(2500000);
    // Each spouse files an Anlage N of their own: the same Kennzahl for both.
    expect([self.kennzahl, find(m, "n.bruttoarbeitslohn", "spouse")!.kennzahl]).toEqual(["110", "110"]);
  });

  it("puts the spouse's value under Person B's Kennzahl where one Vordruck holds both", () => {
    const m = mapToForm(2025, [
      v(1, "lohnsteuerbescheinigung", "rv_arbeitnehmer", 450000),
      v(3, "lohnsteuerbescheinigung", "rv_arbeitnehmer", 380000, "spouse"),
    ], { joint: true });
    expect(find(m, "vorsorge.rv_arbeitnehmer", "self")!.kennzahl).toBe("300");
    expect(find(m, "vorsorge.rv_arbeitnehmer", "spouse")!.kennzahl).toBe("400");
  });

  it("carries the stored value's id to its contribution, so it can be confirmed or corrected", () => {
    const m = mapToForm(2025, [{ ...v(1, "lohnsteuerbescheinigung", "lohnsteuer", 795040), id: 42 }], { joint: false });
    expect(find(m, "n.lohnsteuer", "self")!.contributions[0]!.valueId).toBe(42);
    expect(find(mapToForm(2025, [v(1, "lohnsteuerbescheinigung", "lohnsteuer", 795040)], { joint: false }), "n.lohnsteuer", "self")!.contributions[0]).not.toHaveProperty("valueId");
  });

  it("splits a shared bank certificate half and half under joint assessment", () => {
    const m = mapToForm(2025, [
      v(4, "jahressteuerbescheinigung", "ertraege", 120001, "joint"),
      v(4, "jahressteuerbescheinigung", "sparer_pauschbetrag", 120000, "joint"),
    ], { joint: true });
    expect(find(m, "kap.ertraege", "self")!.cents).toBe(60001);
    expect(find(m, "kap.ertraege", "spouse")!.cents).toBe(60001);
    expect(find(m, "kap.ertraege", "self")!.notes).toContain("Gemeinsamer Beleg: jedem Ehegatten zur Hälfte zugeordnet.");
    // Single assessment: the shared value stays with the taxpayer.
    expect(find(mapToForm(2025, [v(4, "jahressteuerbescheinigung", "ertraege", 120000, "joint")], { joint: false }), "kap.ertraege", "self")!.cents).toBe(120000);
  });

  it("warns when the banks together granted more than the Sparer-Pauschbetrag", () => {
    const m = mapToForm(2025, [
      v(5, "jahressteuerbescheinigung", "sparer_pauschbetrag", 150000),
      v(6, "jahressteuerbescheinigung", "sparer_pauschbetrag", 80000, "spouse"),
    ], { joint: true });
    expect(find(m, "kap.sparer_pauschbetrag", "self")!.notes.join(" ")).toContain("mehr als 1.000 €");
    expect(find(m, "kap.sparer_pauschbetrag", "spouse")!.notes.join(" ")).toContain("zusammen mehr als 2.000 €");
  });

  it("expects 5,5 % Soli on Kapitalertragsteuer, which has no Freigrenze", () => {
    const note = (m: ReturnType<typeof mapToForm>, key: string) => find(m, key, "self")!.notes.join(" ");
    const zero = mapToForm(2025, [
      v(8, "jahressteuerbescheinigung", "kapitalertragsteuer", 50000),
      v(8, "jahressteuerbescheinigung", "solidaritaetszuschlag", 0),
    ], { joint: false });
    expect(note(zero, "kap.solidaritaetszuschlag")).toContain("die Freigrenze gilt hier nicht");
    expect(note(zero, "kap.kapitalertragsteuer")).not.toContain("SolZG");
    // No Soli read at all: the note stands on the Kapitalertragsteuer.
    const missing = mapToForm(2025, [v(8, "jahressteuerbescheinigung", "kapitalertragsteuer", 50000)], { joint: false });
    expect(note(missing, "kap.kapitalertragsteuer")).toContain("etwa 27,50 €");
    // Two banks, each with its Soli: nothing to check.
    const right = mapToForm(2025, [
      v(8, "jahressteuerbescheinigung", "kapitalertragsteuer", 50000),
      v(8, "jahressteuerbescheinigung", "solidaritaetszuschlag", 2750),
      v(9, "jahressteuerbescheinigung", "kapitalertragsteuer", 10000),
      v(9, "jahressteuerbescheinigung", "solidaritaetszuschlag", 550),
    ], { joint: false });
    expect(note(right, "kap.solidaritaetszuschlag")).not.toContain("SolZG");
  });

  it("§ 35a: only the labour share, never a cash payment, with the reduction as a note", () => {
    const m = mapToForm(2025, [
      v(7, "handwerkerrechnung", "arbeitskosten", 80000),
      v(7, "handwerkerrechnung", "material", 40000),
      v(7, "handwerkerrechnung", "rechnungsbetrag", 120000),
      v(7, "handwerkerrechnung", "bargeld", 0),
      v(8, "handwerkerrechnung", "arbeitskosten", 30000),
      v(8, "handwerkerrechnung", "bargeld", 1),
      v(9, "nebenkostenabrechnung", "handwerker", 12000),
    ], { joint: true });
    const hw = find(m, "haushaltsnahe.handwerker", "return")!;
    expect(hw.cents).toBe(92000);
    expect(hw.contributions.map((c) => c.documentId)).toEqual([7, 9]);
    expect(hw.notes.join(" ")).toContain("§ 35a Abs. 3 EStG: Steuerermäßigung 20 % der Arbeitskosten, höchstens 1.200 € (hier 184,00 €)");
    expect(m.skipped.map((s) => [s.value.documentId, s.reason])).toContainEqual([8, "§ 35a Abs. 5 EStG: bar bezahlt, zählt nicht"]);
  });

  it("asks to check the payment when the invoice does not say", () => {
    const m = mapToForm(2025, [v(10, "dienstleistungsrechnung", "arbeitskosten", 2500000)], { joint: true });
    const hh = find(m, "haushaltsnahe.dienstleistungen", "return")!;
    expect(hh.notes).toContain("Zahlungsart prüfen: nach § 35a Abs. 5 EStG zählt nur unbare Zahlung.");
    expect(hh.notes.join(" ")).toContain("höchstens 4.000 € (hier 4.000,00 €)");
  });

  it("sends party donations to their own field", () => {
    const m = mapToForm(2025, [
      v(11, "zuwendungsbestaetigung", "betrag", 20000),
      v(12, "zuwendungsbestaetigung", "betrag", 10000),
      v(12, "zuwendungsbestaetigung", "partei", 1),
    ], { joint: true });
    expect(find(m, "sonder.spenden", "return")!.cents).toBe(20000);
    const party = find(m, "sonder.spenden_parteien", "return")!;
    expect(party.cents).toBe(10000);
    expect(party.notes.join(" ")).toContain("höchstens 1.650 €");
  });

  it("childcare by the year's rule, per child, and asks for a child it cannot tell", () => {
    const m = mapToForm(2025, [
      v(13, "kinderbetreuung", "betreuung", 600000, "child:1"),
      v(13, "kinderbetreuung", "verpflegung", 50000, "child:1"),
      v(14, "kinderbetreuung", "betreuung", 100000, "self"),
    ], { joint: true });
    const child = find(m, "kind.betreuungskosten", "child:1")!;
    expect(child.cents).toBe(600000);
    expect(child.notes.join(" ")).toContain("80 %, höchstens 4.800 € je Kind (hier 4.800,00 €)");
    expect(find(m, "kind.betreuungskosten", "child:?")!.notes).toContain("Kind zuordnen: der Beleg nennt kein Kind des Haushalts.");
    const before = mapToForm(2024, [v(13, "kinderbetreuung", "betreuung", 300000, "child:1")], { joint: true });
    expect(before.catalogueYear).toBe(2025);
    expect(find(before, "kind.betreuungskosten", "child:1")!.notes.join(" ")).toContain("zwei Drittel, höchstens 4.000 € je Kind (hier 2.000,00 €)");
  });

  it("leaves rejected values out and says why", () => {
    const m = mapToForm(2025, [
      v(15, "lohnsteuerbescheinigung", "lohnsteuer", 999999, "self", "rejected"),
      v(15, "lohnsteuerbescheinigung", "lohnsteuer", 795040, "self", "corrected"),
    ], { joint: true });
    expect(find(m, "n.lohnsteuer", "self")!.cents).toBe(795040);
    expect(m.skipped).toEqual([{ value: expect.objectContaining({ status: "rejected" }), reason: "rejected" }]);
  });

  it("orders the values as the form does, taxpayer before spouse", () => {
    const m = mapToForm(2025, [
      v(16, "zuwendungsbestaetigung", "betrag", 5000),
      v(17, "lohnsteuerbescheinigung", "lohnsteuer", 100000, "spouse"),
      v(17, "lohnsteuerbescheinigung", "bruttoarbeitslohn", 1000000, "spouse"),
      v(18, "lohnsteuerbescheinigung", "bruttoarbeitslohn", 2000000),
    ], { joint: true });
    expect(m.values.map((x) => `${x.field.key}|${x.owner}`)).toEqual([
      "n.bruttoarbeitslohn|self", "n.bruttoarbeitslohn|spouse", "n.lohnsteuer|spouse", "sonder.spenden|return",
    ]);
  });
});
