import { describe, it, expect } from "vitest";
import {
  applyAgricultureFiscalYearTaxRule,
  applyInsuranceAdminTaxRule,
  applyKindergeldTaxRule,
  applyKirchensteuerBescheidYearTaxRule,
  applySecuritiesSettlementTaxRule,
} from "./tax-rules";

const AV = [{ slug: "anlage-av", confidence: 0.95 }];

describe("applyInsuranceAdminTaxRule", () => {
  it("strips anlage-av from an Erhöhungsnachtrag without a certificate", () => {
    const out = applyInsuranceAdminTaxRule({
      text: "Erhöhungsnachtrag zur fondsgebundenen Rentenversicherung, Anpassung des Beitrags im Rahmen der Dynamik.",
      taxSections: AV,
      taxRelevant: true,
    });
    expect(out.taxSections).toEqual([]);
    expect(out.taxRelevant).toBe(false);
  });

  it("strips from a Statusreport / Standmitteilung", () => {
    expect(
      applyInsuranceAdminTaxRule({
        text: "Statusreport Altersvorsorge — Vertragsstand in der Ansparphase",
        taxSections: AV,
        taxRelevant: true,
      }).taxRelevant,
    ).toBe(false);
    expect(
      applyInsuranceAdminTaxRule({
        text: "Standmitteilung zu Ihrer Lebensversicherung",
        taxSections: [{ slug: "vorsorgeaufwand", confidence: 0.9 }],
        taxRelevant: true,
      }).taxSections,
    ).toEqual([]);
  });

  it("catches the fund-switch and contact-change admin variants", () => {
    expect(
      applyInsuranceAdminTaxRule({
        text: "Automatische Fondsersetzung im Portfolio Ihrer Riester-Rentenversicherung",
        taxSections: AV,
        taxRelevant: true,
      }).taxRelevant,
    ).toBe(false);
    expect(
      applyInsuranceAdminTaxRule({
        text: "Änderung Ihrer Kontaktdaten zur Rentenversicherung",
        taxSections: AV,
        taxRelevant: true,
      }).taxRelevant,
    ).toBe(false);
  });

  it("strips from a Zulagenantrag / Deckungskapitalübertragung / Beitragsanpassung", () => {
    expect(
      applyInsuranceAdminTaxRule({
        text: "Antrag auf Zulagenantrag für Ihre Riester-Rentenversicherung",
        taxSections: AV,
        taxRelevant: true,
      }).taxRelevant,
    ).toBe(false);
    expect(
      applyInsuranceAdminTaxRule({
        text: "Deckungskapitalübertragung gemäß § 1 Abs. 2 AltvDV",
        taxSections: AV,
        taxRelevant: true,
      }).taxRelevant,
    ).toBe(false);
    expect(
      applyInsuranceAdminTaxRule({
        text: "Mitteilung über Beitragsanpassung Ihrer Rentenversicherung",
        taxSections: [{ slug: "vorsorgeaufwand", confidence: 0.9 }],
        taxRelevant: true,
      }).taxRelevant,
    ).toBe(false);
  });

  it("strips from a Leistungsabrechnung / Erstattungsabrechnung / Konsortium notice", () => {
    expect(
      applyInsuranceAdminTaxRule({
        text: "Erstattungsabrechnung zu Ihrer Krankenzusatzversicherung",
        taxSections: [{ slug: "vorsorgeaufwand", confidence: 0.9 }],
        taxRelevant: true,
      }).taxRelevant,
    ).toBe(false);
    expect(
      applyInsuranceAdminTaxRule({
        text: "Leistungsabrechnung Nr. 12345 der Pflegeversicherung",
        taxSections: AV,
        taxRelevant: true,
      }).taxRelevant,
    ).toBe(false);
    expect(
      applyInsuranceAdminTaxRule({
        text: "Information zur Konsortiumszusammensetzung Ihres Versicherungsvertrags",
        taxSections: AV,
        taxRelevant: true,
      }).taxRelevant,
    ).toBe(false);
  });

  it("no longer treats bare 'Leistungsmitteilung' as a certificate marker", () => {
    // An employer Unterstützungskasse "Leistungsmitteilung gemäß Leistungsplan"
    // is mere status/anwartschaft — NOT a tax certificate. Previously the word
    // was in BELEG_MARKERS and would have shielded admin mail from stripping.
    const out = applyInsuranceAdminTaxRule({
      text: "Leistungsmitteilung gemäß Leistungsplan der Unterstützungskasse. Statusreport Ihrer Anwartschaft.",
      taxSections: AV,
      taxRelevant: true,
    });
    expect(out.taxSections).toEqual([]);
    expect(out.taxRelevant).toBe(false);
  });

  it("KEEPS a genuine Beitrags-/Zulagenbescheinigung even with an admin word present", () => {
    // A real certificate mail may also contain "Erhöhungsnachtrag" boilerplate;
    // the certificate marker wins.
    const out = applyInsuranceAdminTaxRule({
      text: "Zulagenbescheinigung nach § 92 EStG für Ihren Riester-Vertrag. Erhöhungsnachtrag anbei.",
      taxSections: AV,
      taxRelevant: true,
    });
    expect(out.taxSections).toEqual(AV);
    expect(out.taxRelevant).toBe(true);
  });

  it("KEEPS when a §10a Beitragsbescheinigung is present", () => {
    const out = applyInsuranceAdminTaxRule({
      text: "Beitragsbescheinigung nach § 10a EStG über geleistete Altersvorsorgebeiträge",
      taxSections: [{ slug: "vorsorgeaufwand", confidence: 0.9 }],
      taxRelevant: true,
    });
    expect(out.taxRelevant).toBe(true);
    expect(out.taxSections).toHaveLength(1);
  });

  it("does nothing when there is no insurance section (e.g. only aussergewoehnliche)", () => {
    const sections = [{ slug: "aussergewoehnliche", confidence: 0.85 }];
    const out = applyInsuranceAdminTaxRule({
      text: "Statusreport Erhöhungsnachtrag Dynamik", // admin words, but no insurance section
      taxSections: sections,
      taxRelevant: true,
    });
    expect(out.taxSections).toEqual(sections);
    expect(out.taxRelevant).toBe(true);
  });

  it("does nothing when no admin marker is present", () => {
    const out = applyInsuranceAdminTaxRule({
      text: "Jährliche Beitragsübersicht Ihrer Rentenversicherung",
      taxSections: AV,
      taxRelevant: true,
    });
    expect(out.taxSections).toEqual(AV);
    expect(out.taxRelevant).toBe(true);
  });

  it("only strips the insurance sections, keeping co-assigned non-insurance ones", () => {
    const out = applyInsuranceAdminTaxRule({
      text: "Erhöhungsnachtrag Dynamik Rentenversicherung",
      taxSections: [
        { slug: "anlage-av", confidence: 0.95 },
        { slug: "aussergewoehnliche", confidence: 0.8 },
      ],
      taxRelevant: true,
    });
    expect(out.taxSections).toEqual([{ slug: "aussergewoehnliche", confidence: 0.8 }]);
    expect(out.taxRelevant).toBe(true); // still relevant via the surviving section
  });

  it("ignores the (unreliable) title — only the OCR text counts", () => {
    // Simulates audit doc 1358: title claims a certificate, text is a Widerspruch.
    const out = applyInsuranceAdminTaxRule({
      text: "Wir bestätigen Ihren Widerspruch gegen die dynamische Erhöhung. Der Beitrag bleibt unverändert.",
      taxSections: AV,
      taxRelevant: true,
    });
    expect(out.taxRelevant).toBe(false);
  });
});

describe("applyKindergeldTaxRule", () => {
  it("replaces generic tax guesses with Anlage Kind for a Familienkasse decision", () => {
    const out = applyKindergeldTaxRule({
      text: "Familienkasse Bayern Süd. Ihre Kindergeldnummer: 123 FK 456. " +
        "Bescheid über Kindergeld nach dem Einkommensteuergesetz (EStG). " +
        "Die Festsetzung des Kindergeldes wird gemäß § 70 Absatz 2 geändert.",
      taxSections: [{ slug: "mantelbogen", confidence: 0.9 }],
      taxRelevant: true,
    });
    expect(out).toEqual({
      taxSections: [{ slug: "anlage-kind", confidence: 0.98 }],
      taxRelevant: true,
      matched: true,
    });
  });

  it("does not alter a tax assessment that only mentions Kindergeld", () => {
    const sections = [{ slug: "steuerbescheid", confidence: 0.9 }];
    expect(applyKindergeldTaxRule({
      text: "Einkommensteuerbescheid: Bei der Günstigerprüfung wurde Kindergeld berücksichtigt.",
      taxSections: sections,
      taxRelevant: true,
    })).toEqual({ taxSections: sections, taxRelevant: true, matched: false });
  });

  it("does not clear other family benefits such as Elterngeld", () => {
    const sections = [{ slug: "progressionsvorbehalt", confidence: 0.9 }];
    expect(applyKindergeldTaxRule({
      text: "Elterngeldbescheid über Leistungen mit Progressionsvorbehalt",
      taxSections: sections,
      taxRelevant: true,
    })).toEqual({ taxSections: sections, taxRelevant: true, matched: false });
  });
});

describe("applyAgricultureFiscalYearTaxRule", () => {
  it("uses the start year for the shifted Landwirtschaft fiscal year", () => {
    expect(applyAgricultureFiscalYearTaxRule({
      text: "Einnahmenüberschussrechnung für das Geschäftsjahr 01.07.2024 bis 30.06.2025",
      taxSections: [{ slug: "anlage-l", confidence: 0.94 }],
      taxYear: 2025,
      taxYearConfidence: 0.86,
    })).toEqual({ taxYear: 2024, taxYearConfidence: 0.99, matched: true });
  });

  it("does not change a non-agricultural EÜR with the same dates", () => {
    expect(applyAgricultureFiscalYearTaxRule({
      text: "Einnahmenüberschussrechnung für das Geschäftsjahr 01.07.2024 bis 30.06.2025",
      taxSections: [{ slug: "anlage-g", confidence: 0.94 }],
      taxYear: 2025,
      taxYearConfidence: 0.86,
    })).toEqual({ taxYear: 2025, taxYearConfidence: 0.86, matched: false });
  });

  it("accepts an explicit Landwirtschaft marker if Anlage L was missed", () => {
    expect(applyAgricultureFiscalYearTaxRule({
      text: "Land- und Forstwirtschaft – Wirtschaftsjahr 1/7/2024 - 30/6/2025",
      taxSections: [{ slug: "anlage-euer", confidence: 0.8 }],
      taxYear: 2025,
      taxYearConfidence: 0.7,
    })).toEqual({ taxYear: 2024, taxYearConfidence: 0.99, matched: true });
  });

  it("does not infer a year from an incomplete or non-standard period", () => {
    expect(applyAgricultureFiscalYearTaxRule({
      text: "Land- und Forstwirtschaft, Wirtschaftsjahr 01.01.2024 bis 31.12.2024",
      taxSections: [{ slug: "anlage-l", confidence: 0.94 }],
      taxYear: 2024,
      taxYearConfidence: 0.8,
    })).toEqual({ taxYear: 2024, taxYearConfidence: 0.8, matched: false });
  });
});

describe("applyKirchensteuerBescheidYearTaxRule", () => {
  const NOTICE_2019_SETTLED_2021 = [
    "Katholisches Kirchensteueramt Augsburg",
    "Abrechnung der Veranlagungs- und Vorauszahlungsjahre",
    "2019 verbleibende Steuer lt. Bescheid v. 19.04.2021",
    "Kirchensteuerbescheid 2019",
    "verbleibendes Guthaben 0,27",
    "verbleibende Kirchensteuer -120,27 €",
  ].join("\n");

  it("uses the settlement year, not the assessed year in the heading", () => {
    expect(applyKirchensteuerBescheidYearTaxRule({
      text: NOTICE_2019_SETTLED_2021,
      docDate: "2021-04-19",
      taxYear: 2019,
      taxYearConfidence: 0.9,
    })).toEqual({ taxYear: 2021, taxYearConfidence: 0.95, matched: true });
  });

  it("falls back to the document date when no Bescheid date is printed", () => {
    expect(applyKirchensteuerBescheidYearTaxRule({
      text: "Kirchensteuerbescheid 2019 — Erstattung der zu viel gezahlten Kirchensteuer",
      docDate: "2021-04-19",
      taxYear: 2019,
      taxYearConfidence: 0.9,
    })).toEqual({ taxYear: 2021, taxYearConfidence: 0.95, matched: true });
  });

  it("prefers an explicit due date over the Bescheid date", () => {
    expect(applyKirchensteuerBescheidYearTaxRule({
      text:
        "Kirchensteuerbescheid 2021, Bescheid vom 15.12.2022\n" +
        "Die Nachzahlung ist fällig am 20.01.2023",
      docDate: "2022-12-15",
      taxYear: 2021,
      taxYearConfidence: 0.9,
    })).toEqual({ taxYear: 2023, taxYearConfidence: 0.95, matched: true });
  });

  it("keeps the year when Bescheid and settlement fall into the same year", () => {
    expect(applyKirchensteuerBescheidYearTaxRule({
      text: "Kirchensteuerbescheid 2021 vom 03.11.2021, Nachzahlung 42,00 €",
      docDate: "2021-11-03",
      taxYear: 2021,
      taxYearConfidence: 0.88,
    })).toEqual({ taxYear: 2021, taxYearConfidence: 0.88, matched: true });
  });

  it("leaves a pure Vorauszahlungsbescheid untouched", () => {
    expect(applyKirchensteuerBescheidYearTaxRule({
      text:
        "Katholisches Kirchensteueramt — Vorauszahlungsbescheid\n" +
        "Festsetzung der Vorauszahlungen ab 2022, Nachzahlung je Quartal",
      docDate: "2021-11-03",
      taxYear: 2022,
      taxYearConfidence: 0.8,
    })).toEqual({ taxYear: 2022, taxYearConfidence: 0.8, matched: false });
  });

  it("ignores documents that merely mention Kirchensteuer", () => {
    expect(applyKirchensteuerBescheidYearTaxRule({
      text: "Jahressteuerbescheinigung 2021: Kapitalertragsteuer, Solidaritätszuschlag, Kirchensteuer, Erstattung",
      docDate: "2022-02-01",
      taxYear: 2021,
      taxYearConfidence: 0.95,
    })).toEqual({ taxYear: 2021, taxYearConfidence: 0.95, matched: false });
  });

  it("never moves the year backwards on a bad date extraction", () => {
    expect(applyKirchensteuerBescheidYearTaxRule({
      text: "Kirchensteuerbescheid 2019, Guthaben — Bescheid vom 19.04.2018",
      docDate: "2018-04-19",
      taxYear: 2019,
      taxYearConfidence: 0.9,
    })).toEqual({ taxYear: 2019, taxYearConfidence: 0.9, matched: false });
  });

  it("does nothing without any usable date", () => {
    expect(applyKirchensteuerBescheidYearTaxRule({
      text: "Kirchensteuerbescheid — Guthaben",
      docDate: null,
      taxYear: 2019,
      taxYearConfidence: 0.9,
    })).toEqual({ taxYear: 2019, taxYearConfidence: 0.9, matched: false });
  });
});

describe("applySecuritiesSettlementTaxRule", () => {
  // Synthetischer Nachbau einer comdirect-Dividendenabrechnung (keine echten
  // personenbezogenen Daten).
  const DIVIDEND_TEXT = `Steuerliche Behandlung: Ausländische Dividende vom 13.08.2026
Stk. 160 MUSTER INC., WKN / ISIN: 000000 / US0000000000
Depotnummer: 0000000 00
Zu Ihren Gunsten vor Steuern: EUR 31,75
Kapitalertragsteuer (2) EUR -3,67
Solidaritätszuschlag EUR -0,20
Kirchensteuer EUR -0,29
(2) Durch die Berücksichtigung der Kirchensteuer (8% bzw. 9%) als Sonderausgabe
reduziert sich der Kapitalertragsteuersatz auf 24,51% bzw. 24,45%.
KEINE STEUERBESCHEINIGUNG`;

  it("strips sonderausgaben and vorsorgeaufwand from a dividend settlement", () => {
    const out = applySecuritiesSettlementTaxRule({
      text: DIVIDEND_TEXT,
      taxSections: [
        { slug: "anlage-kap", confidence: 0.95 },
        { slug: "sonderausgaben", confidence: 0.95 },
        { slug: "vorsorgeaufwand", confidence: 0.75 },
      ],
      taxRelevant: true,
    });
    expect(out.taxSections).toEqual([{ slug: "anlage-kap", confidence: 0.95 }]);
    expect(out.taxRelevant).toBe(true);
    expect(out.matched).toBe(true);
  });

  it("adds anlage-kap when the model assigned only the wrong sections", () => {
    const out = applySecuritiesSettlementTaxRule({
      text: DIVIDEND_TEXT,
      taxSections: [{ slug: "sonderausgaben", confidence: 0.9 }],
      taxRelevant: true,
    });
    expect(out.taxSections).toEqual([{ slug: "anlage-kap", confidence: 0.95 }]);
    expect(out.taxRelevant).toBe(true);
  });

  it("keeps werbungskosten-kap and reports no change for a clean assignment", () => {
    const out = applySecuritiesSettlementTaxRule({
      text: DIVIDEND_TEXT,
      taxSections: [
        { slug: "anlage-kap", confidence: 0.9 },
        { slug: "werbungskosten-kap", confidence: 0.6 },
      ],
      taxRelevant: true,
    });
    expect(out.taxSections).toEqual([
      { slug: "anlage-kap", confidence: 0.9 },
      { slug: "werbungskosten-kap", confidence: 0.6 },
    ]);
    expect(out.matched).toBe(false);
  });

  it("also fires for a Wertpapierabrechnung and a Jahressteuerbescheinigung", () => {
    expect(
      applySecuritiesSettlementTaxRule({
        text: "Wertpapierabrechnung Kauf, WKN / ISIN: 000000 / DE0000000000",
        taxSections: [{ slug: "sonderausgaben", confidence: 0.8 }],
        taxRelevant: true,
      }).taxSections,
    ).toEqual([{ slug: "anlage-kap", confidence: 0.95 }]);
    expect(
      applySecuritiesSettlementTaxRule({
        text: "Jahressteuerbescheinigung 2025 — Depotnummer 0000000, Kapitalertragsteuer",
        taxSections: [{ slug: "anlage-n", confidence: 0.7 }],
        taxRelevant: true,
      }).taxSections,
    ).toEqual([{ slug: "anlage-kap", confidence: 0.95 }]);
  });

  it("leaves a fund-linked pension statement alone", () => {
    const sections = [{ slug: "vorsorgeaufwand", confidence: 0.9 }];
    expect(
      applySecuritiesSettlementTaxRule({
        text: "Standmitteilung zur fondsgebundenen Rentenversicherung, Ausschüttung der Fonds, ISIN DE0000000000",
        taxSections: sections,
        taxRelevant: true,
      }),
    ).toEqual({ taxSections: sections, taxRelevant: true, matched: false });
  });

  it("leaves an Einkommensteuerbescheid alone", () => {
    const sections = [{ slug: "steuerbescheid", confidence: 0.95 }];
    expect(
      applySecuritiesSettlementTaxRule({
        text: "Finanzamt Musterstadt — Einkommensteuerbescheid für 2025: Kapitalertragsteuer, Ausschüttungen",
        taxSections: sections,
        taxRelevant: true,
      }),
    ).toEqual({ taxSections: sections, taxRelevant: true, matched: false });
  });

  it("does nothing without a securities context", () => {
    const sections = [{ slug: "sonderausgaben", confidence: 0.9 }];
    expect(
      applySecuritiesSettlementTaxRule({
        text: "Zuwendungsbestätigung — Ausschüttung von Spendengeldern an das Projekt",
        taxSections: sections,
        taxRelevant: true,
      }).matched,
    ).toBe(false);
  });
});
