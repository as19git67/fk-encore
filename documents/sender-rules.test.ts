import { describe, it, expect } from "vitest";
import {
  CONTENT_RULES,
  SENDER_RULES,
  matchContentRule,
  matchSenderRule,
  normalizeForMatch,
} from "./sender-rules";
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

  it("routes Familienkasse documents to Familienleistungen", () => {
    expect(matchSenderRule({
      sender: "Bundesagentur für Arbeit, Familienkasse Bayern Süd",
      title: "Bescheid über Kindergeld",
    })).toBe("familie-familienleistungen");
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
    expect(matchSenderRule({ sender: "MLP Lebensversicherung AG" })).toBe("altersvorsorge-lebensversicherung");
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
    // MLP Lebensversicherung routes to life insurance (dedicated sender rule).
    expect(matchSenderRule({ sender: "MLP Lebensversicherung AG", title: "Beitragsmitteilung" })).toBe(
      "altersvorsorge-lebensversicherung",
    );
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

  it("routes gesetzliche Krankenkassen to gesundheit-kasse", () => {
    expect(matchSenderRule({ sender: "BARMER" })).toBe("gesundheit-kasse");
    expect(matchSenderRule({ sender: "Techniker Krankenkasse" })).toBe("gesundheit-kasse");
    expect(matchSenderRule({ sender: "AOK Bayern - Die Gesundheitskasse" })).toBe("gesundheit-kasse");
  });

  it("routes Grundsteuerbescheide from Stadtverwaltung Eutin to kommunale Abgaben", () => {
    expect(
      matchSenderRule({ sender: "Stadtverwaltung Eutin", title: "Grundsteuerbescheid 2024" }),
    ).toBe("wohnen-kommunale-abgaben");
    expect(
      matchSenderRule({ sender: "Stadt Eutin, Fachdienst Finanzen und Controlling", title: "Grundsteuerbescheid" }),
    ).toBe("wohnen-kommunale-abgaben");
    // Without Grundsteuer keyword → no override, let LLM decide
    expect(
      matchSenderRule({ sender: "Stadtverwaltung Eutin", title: "Bußgeldbescheid" }),
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

describe("matchContentRule", () => {
  it("routes strong Kindergeld-case markers but not a bare tax-document mention", () => {
    expect(matchContentRule({
      title: "Bescheid über Kindergeld nach dem Einkommensteuergesetz",
      text: "Ihre Kindergeldnummer: 123 FK 456",
    })).toBe("familie-familienleistungen");
    expect(matchContentRule({
      title: "Einkommensteuerbescheid 2025",
      text: "Bei der Günstigerprüfung wurde das ausgezahlte Kindergeld berücksichtigt.",
    })).toBeNull();
  });

  it("routes a Riester/§92 document to private Rentenversicherung", () => {
    expect(
      matchContentRule({
        title: "Statusreport Heidelberger Lebensversicherung",
        text: "MLP balanced invest, staatlich geförderte Riester-Rentenversicherung",
      }),
    ).toBe("altersvorsorge-rentenversicherung");
    expect(
      matchContentRule({ title: "Bescheinigung", text: "Zulagenbescheinigung nach § 92 EStG" }),
    ).toBe("altersvorsorge-rentenversicherung");
    expect(
      matchContentRule({ title: "Förder Rente invest DWS Premium", text: "" }),
    ).toBe("altersvorsorge-rentenversicherung");
  });

  it("does NOT steal an actual monthly payslip that lists a Riester deduction", () => {
    expect(
      matchContentRule({
        title: "Entgeltabrechnung 04/2024",
        text: "Gesamtbrutto 5000 Steuerbrutto 4800 Riester 100 Auszahlungsbetrag 3200",
      }),
    ).toBeNull();
  });

  it("routes Kfz-Kasko/Kraftfahrt documents to fahrzeug-versicherung", () => {
    expect(
      matchContentRule({ title: "Beitragsrechnung Kraftfahrtversicherung", text: "" }),
    ).toBe("fahrzeug-versicherung");
    expect(
      matchContentRule({ title: "Kfz-Haftpflicht", text: "Teilkasko, Vollkasko, Tesla Model 3" }),
    ).toBe("fahrzeug-versicherung");
  });

  it("routes a self-occupied Wohngebäudeversicherung but not a rented one", () => {
    expect(
      matchContentRule({ title: "Prämienrechnung Privatschutz", text: "Sparte Wohngebäude EFH" }),
    ).toBe("wohnen-haus-gebaeudeversicherung");
    // Rented object → Kapitalanlage branch, so the content rule must stay out.
    expect(
      matchContentRule({
        title: "Wohngebäudeversicherung",
        text: "Sondereigentum, vermietete Eigentumswohnung",
      }),
    ).toBeNull();
  });

  it("returns null when no keyword matches", () => {
    expect(matchContentRule({ title: "Kapital-Lebensversicherung", text: "Rückkaufswert, Deckungskapital" })).toBeNull();
    expect(matchContentRule({ title: "", text: "" })).toBeNull();
  });
});

describe("CONTENT_RULES invariants", () => {
  it("every rule targets a slug that exists in the taxonomy", () => {
    const slugs = new Set(flattenTaxonomy().map((c) => c.slug));
    for (const rule of CONTENT_RULES) {
      expect(slugs.has(rule.category), `unknown category slug: ${rule.category}`).toBe(true);
    }
  });

  it("keyword/exclude fragments are already normalized (no spaces/uppercase)", () => {
    for (const rule of CONTENT_RULES) {
      for (const frag of [...rule.keywords, ...(rule.excludeAny ?? [])]) {
        expect(frag, `fragment not normalized: ${frag}`).toBe(normalizeForMatch(frag));
      }
    }
  });
});
