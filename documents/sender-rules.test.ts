import { describe, it, expect } from "vitest";
import { SENDER_RULES, matchSenderRule, normalizeForMatch } from "./sender-rules";
import { flattenTaxonomy } from "./taxonomy";

describe("normalizeForMatch", () => {
  it("lowercases and strips spaces/punctuation, keeps umlauts and digits", () => {
    expect(normalizeForMatch("Contoso Software GmbH")).toBe("contososoftwaregmbh");
    expect(normalizeForMatch("HALLESCHE Krankenversicherung a.G.")).toBe("halleschekrankenversicherungag");
    expect(normalizeForMatch("Wüstenrot Bausparkasse AG")).toBe("wüstenrotbausparkasseag");
    expect(normalizeForMatch(null)).toBe("");
  });
});

describe("matchSenderRule", () => {
  it("returns null when there is no sender", () => {
    expect(matchSenderRule({ sender: null, title: "Rechnung" })).toBeNull();
    expect(matchSenderRule({ sender: "" })).toBeNull();
  });

  it("does not match owner/recipient names (the owner-as-sender bug yields no override)", () => {
    expect(matchSenderRule({ sender: "Anton Beispiel", title: "Irgendein Schreiben" })).toBeNull();
  });

  it("routes the employer to payslips regardless of OCR spacing/case", () => {
    expect(matchSenderRule({ sender: "Contoso Software GmbH", title: "Entgeltabrechnung 04/2024" }))
      .toBe("finanzen-gehalt");
    expect(matchSenderRule({ sender: "Contoso", title: "Gehaltsabrechnung 12/2019" }))
      .toBe("finanzen-gehalt");
    // The unguarded employer fallback still catches plain payslips.
    expect(matchSenderRule({ sender: "Contoso Software GmbH", title: "Lohnabrechnung" }))
      .toBe("finanzen-gehalt");
  });

  it("splits employer SV notifications from monthly payslips", () => {
    // Annual DEÜV social-insurance notice → its own category, not payslips.
    expect(
      matchSenderRule({ sender: "Contoso", title: "Sozialversicherungsnachweis" }),
    ).toBe("finanzen-sozialversicherung");
    expect(
      matchSenderRule({ sender: "Contoso Software GmbH", title: "Meldung zur Sozialversicherung" }),
    ).toBe("finanzen-sozialversicherung");
    // The monthly payslip from the same employer stays in finanzen-gehalt.
    expect(
      matchSenderRule({ sender: "Contoso Software GmbH", title: "Entgeltabrechnung 03/2024" }),
    ).toBe("finanzen-gehalt");
  });

  it("disambiguates a forwarded tax assessment from the same employer (rule order)", () => {
    expect(
      matchSenderRule({
        sender: "Contoso Software GmbH",
        title: "Einkommensteuerbescheid für 2022",
      }),
    ).toBe("behoerden-steuerbescheid");
  });

  it("routes banks, insurers, doctors and care to their categories", () => {
    expect(matchSenderRule({ sender: "comdirect bank AG" })).toBe("finanzen-wertpapiere");
    expect(matchSenderRule({ sender: "HALLESCHE Krankenversicherung" })).toBe("versicherungen-kranken");
    expect(matchSenderRule({ sender: "DKV Deutsche Krankenversicherung" })).toBe("versicherungen-kranken");
    expect(matchSenderRule({ sender: "Heidelberger Leben" })).toBe("altersvorsorge-lebensversicherung");
    expect(matchSenderRule({ sender: "Janitos Versicherung AG" })).toBe("versicherungen-sach");
    expect(matchSenderRule({ sender: "Zahnarztpraxis Dr. Kiesewetter" })).toBe("gesundheit-arzt");
    expect(matchSenderRule({ sender: "Caritas-Sozialstation" })).toBe("gesundheit-pflege");
    expect(matchSenderRule({ sender: "Wüstenrot Bausparkasse AG" })).toBe("finanzen-bausparen");
    expect(matchSenderRule({ sender: "LEW TelNet GmbH" })).toBe("vertraege-telekom");
    expect(matchSenderRule({ sender: "Clever Fit Mering" })).toBe("vertraege-abos");
  });

  it("routes the tax advisor, church-employer SV notices and bank statements", () => {
    expect(
      matchSenderRule({
        sender: "Treukontax Steuerberatungsgesellschaft mbH",
        title: "Einkommensteuererklärung 2022",
      }),
    ).toBe("finanzen-steuern");
    expect(
      matchSenderRule({
        sender: "Erzbischöfliches Verwaltungsstelle München",
        title: "Entgeltnachweis zur Sozialversicherung",
      }),
    ).toBe("finanzen-sozialversicherung");
    // …but a monthly payslip from the same church employer stays gehalt.
    expect(
      matchSenderRule({
        sender: "Pfarramt St. Beispiel",
        title: "Entgeltabrechnung 06/2023",
      }),
    ).toBe("finanzen-gehalt");
    expect(matchSenderRule({ sender: "MLP Banking AG", title: "Darlehenskontoauszug" })).toBe(
      "finanzen-kontoauszuege",
    );
    expect(
      matchSenderRule({ sender: "Commerzbank", title: "Kontoauszug und Rechnungsabschluss" }),
    ).toBe("finanzen-kontoauszuege");
  });

  it("keeps the bank-statement and church-employer rules from over-grabbing", () => {
    // MLP life insurance is a different sender token and lacks statement keywords.
    expect(matchSenderRule({ sender: "MLP Lebensversicherung AG", title: "Beitragsmitteilung" })).toBeNull();
    // Church mail without an SV/payslip keyword is left to the LLM.
    expect(matchSenderRule({ sender: "Erzb. Verwaltungsstelle München", title: "Rundschreiben" })).toBeNull();
  });

  it("routes telecom providers to Telekommunikation, but not their shares", () => {
    expect(
      matchSenderRule({ sender: "Telefónica Germany GmbH & Co. OHG", title: "Ihre Rechnung" }),
    ).toBe("vertraege-telekom");
    expect(
      matchSenderRule({ sender: "Vodafone GmbH", title: "Mobilfunkrechnung" }),
    ).toBe("vertraege-telekom");
    expect(
      matchSenderRule({ sender: "LEW TelNet GmbH", title: "Rechnung" }),
    ).toBe("vertraege-telekom");
    // Guard: a Deutsche-Telekom dividend statement names the provider but is
    // a securities document — the excludeAny keyword keeps it out of telecom.
    expect(
      matchSenderRule({ sender: "Deutsche Telekom AG", title: "Dividendengutschrift" }),
    ).toBeNull();
  });

  it("honours requireAny: DRV only routes to gesetzliche Rente for pension docs", () => {
    expect(
      matchSenderRule({ sender: "Deutsche Rentenversicherung Bund", title: "Renteninformation" }),
    ).toBe("altersvorsorge-gesetzlich");
    // No pension keyword → no deterministic override, let the LLM decide.
    expect(
      matchSenderRule({ sender: "Deutsche Rentenversicherung Bund", title: "Allgemeines Anschreiben" }),
    ).toBeNull();
  });

  it("honours requireAny for municipal fees", () => {
    expect(
      matchSenderRule({ sender: "Gemeinde Beispielstadt", title: "Bescheid Wasser und Abwasser 2023" }),
    ).toBe("wohnen-kommunale-abgaben");
    expect(
      matchSenderRule({ sender: "Gemeinde Beispielstadt", title: "Einladung Bürgerversammlung" }),
    ).toBeNull();
  });
});

describe("SENDER_RULES invariants", () => {
  it("every rule targets a slug that exists in the taxonomy", () => {
    const slugs = new Set(flattenTaxonomy().map((c) => c.slug));
    for (const rule of SENDER_RULES) {
      expect(slugs.has(rule.category), `unknown category slug: ${rule.category}`).toBe(true);
    }
  });

  it("sender fragments are already normalized (no spaces/uppercase)", () => {
    for (const rule of SENDER_RULES) {
      for (const frag of rule.senders) {
        expect(frag, `sender fragment not normalized: ${frag}`).toBe(normalizeForMatch(frag));
      }
    }
  });
});
