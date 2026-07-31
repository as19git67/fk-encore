import { describe, it, expect } from "vitest";
import {
  CONTENT_RULES,
  SENDER_RULES,
  matchContentRule,
  matchSenderRule,
  normalizeForMatch,
  type SenderRule,
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

  it("routes the tax advisor and bank statements", () => {
    expect(
      matchSenderRule({
        sender: "Treukontax Steuerberatungsgesellschaft mbH",
        title: "Einkommensteuererklärung 2022",
      }),
    ).toBe("finanzen-steuern");
    expect(matchSenderRule({ sender: "MLP Banking AG", title: "Darlehenskontoauszug" })).toBe(
      "finanzen-kontoauszuege",
    );
    expect(
      matchSenderRule({ sender: "Commerzbank", title: "Kontoauszug und Rechnungsabschluss" }),
    ).toBe("finanzen-kontoauszuege");
  });

  it("keeps the bank-statement rules from over-grabbing", () => {
    // MLP Lebensversicherung routes to life insurance (dedicated sender rule).
    expect(matchSenderRule({ sender: "MLP Lebensversicherung AG", title: "Beitragsmitteilung" })).toBe(
      "altersvorsorge-lebensversicherung",
    );
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
      matchSenderRule({ sender: "Gemeinde Musterhausen", title: "Bescheid Wasser und Abwasser 2023" }),
    ).toBe("wohnen-kommunale-abgaben");
    expect(
      matchSenderRule({ sender: "Gemeinde Musterhausen", title: "Einladung Bürgerversammlung" }),
    ).toBeNull();
  });
});

describe("matchSenderRule (household overrides, e.g. employer/parish)", () => {
  // Household-specific senders (the actual employer, parish, …) are NOT
  // hard-coded in SENDER_RULES — they're configured as DB-backed overrides
  // (migration 0141, see sender-rule-overrides.ts) and passed in here. This
  // exercises that mechanism with fictional example data, in the same shape
  // a real household's overrides would take.
  const employerOverrides: SenderRule[] = [
    {
      note: "Arbeitgeber leitet ausnahmsweise einen Einkommensteuerbescheid weiter",
      senders: ["contoso"],
      requireAny: ["einkommensteuerbescheid", "steuerbescheid"],
      category: "behoerden-steuerbescheid",
    },
    {
      note: "Arbeitgeber → jährliche Meldung/Entgeltnachweis zur Sozialversicherung (DEÜV)",
      senders: ["contoso"],
      requireAny: ["entgeltnachweis", "sozialversicherungsnachweis", "meldungzursozialversicherung"],
      category: "finanzen-sozialversicherung",
    },
    {
      note: "Arbeitgeber → monatliche Entgelt-/Gehaltsabrechnung (Fallback)",
      senders: ["contoso"],
      category: "finanzen-gehalt",
    },
    {
      note: "Kirchlicher Arbeitgeber → Meldung zur Sozialversicherung",
      senders: ["pfarramtstbeispiel"],
      requireAny: ["entgeltnachweis", "sozialversicherungsnachweis"],
      category: "finanzen-sozialversicherung",
    },
    {
      note: "Kirchlicher Arbeitgeber → Entgelt-/Gehaltsabrechnung",
      senders: ["pfarramtstbeispiel"],
      requireAny: ["entgeltabrechnung", "gehaltsabrechnung", "lohnabrechnung"],
      category: "finanzen-gehalt",
    },
  ];

  it("is not consulted when no overrides are passed", () => {
    expect(matchSenderRule({ sender: "Contoso Software GmbH", title: "Entgeltabrechnung 04/2024" })).toBeNull();
  });

  it("routes the employer to payslips regardless of OCR spacing/case", () => {
    expect(
      matchSenderRule({ sender: "Contoso Software GmbH", title: "Entgeltabrechnung 04/2024" }, employerOverrides),
    ).toBe("finanzen-gehalt");
    // The unguarded employer fallback still catches plain payslips.
    expect(
      matchSenderRule({ sender: "Contoso Software GmbH", title: "Lohnabrechnung" }, employerOverrides),
    ).toBe("finanzen-gehalt");
  });

  it("splits employer SV notifications from monthly payslips", () => {
    expect(
      matchSenderRule({ sender: "Contoso Software GmbH", title: "Sozialversicherungsnachweis" }, employerOverrides),
    ).toBe("finanzen-sozialversicherung");
    expect(
      matchSenderRule({ sender: "Contoso Software GmbH", title: "Entgeltabrechnung 03/2024" }, employerOverrides),
    ).toBe("finanzen-gehalt");
  });

  it("disambiguates a forwarded tax assessment from the same employer (override order)", () => {
    expect(
      matchSenderRule(
        { sender: "Contoso Software GmbH", title: "Einkommensteuerbescheid für 2022" },
        employerOverrides,
      ),
    ).toBe("behoerden-steuerbescheid");
  });

  it("routes a church employer's SV notice and payslip separately", () => {
    expect(
      matchSenderRule(
        { sender: "Pfarramt St. Beispiel", title: "Entgeltnachweis zur Sozialversicherung" },
        employerOverrides,
      ),
    ).toBe("finanzen-sozialversicherung");
    expect(
      matchSenderRule({ sender: "Pfarramt St. Beispiel", title: "Entgeltabrechnung 06/2023" }, employerOverrides),
    ).toBe("finanzen-gehalt");
    // Church mail without an SV/payslip keyword is left to the LLM.
    expect(matchSenderRule({ sender: "Pfarramt St. Beispiel", title: "Rundschreiben" }, employerOverrides)).toBeNull();
  });

  it("overrides win over the built-in SENDER_RULES", () => {
    // "familienkasse" is a built-in fragment; an override for the same
    // fragment (evaluated first) must take precedence.
    const familienkasseOverride: SenderRule[] = [
      { note: "test override", senders: ["familienkasse"], category: "finanzen-steuern" },
    ];
    expect(
      matchSenderRule({ sender: "Familienkasse Bayern Süd" }, familienkasseOverride),
    ).toBe("finanzen-steuern");
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
