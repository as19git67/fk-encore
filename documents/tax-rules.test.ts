import { describe, it, expect } from "vitest";
import {
  applyAgricultureFiscalYearTaxRule,
  applyIncomeTaxAssessmentTaxRule,
  applyIncomeTaxReturnTaxRule,
  incomeTaxReturnYear,
  isIncomeTaxAssessment,
  isIncomeTaxReturn,
  applyInsuranceAdminTaxRule,
  applyKindergeldTaxRule,
  applyKirchensteuerBescheidYearTaxRule,
  applySecuritiesSettlementTaxRule,
} from "./tax-rules";

const AV = [{ slug: "anlage-av", confidence: 0.95 }];

describe("applyInsuranceAdminTaxRule", () => {
  it("makes an Erhöhungsnachtrag without a certificate a bezug and keeps anlage-av", () => {
    const out = applyInsuranceAdminTaxRule({
      text: "Erhöhungsnachtrag zur fondsgebundenen Rentenversicherung, Anpassung des Beitrags im Rahmen der Dynamik.",
      taxSections: AV,
      taxRole: "beleg",
    });
    expect(out.taxSections).toEqual(AV);
    expect(out.taxRole).toBe("bezug");
    expect(out.matched).toBe(true);
  });

  it("downgrades a Statusreport / Standmitteilung", () => {
    expect(
      applyInsuranceAdminTaxRule({
        text: "Statusreport Altersvorsorge — Vertragsstand in der Ansparphase",
        taxSections: AV,
        taxRole: "beleg",
      }).taxRole,
    ).toBe("bezug");
    expect(
      applyInsuranceAdminTaxRule({
        text: "Standmitteilung zu Ihrer Lebensversicherung",
        taxSections: [{ slug: "vorsorgeaufwand", confidence: 0.9 }],
        taxRole: "beleg",
      }).taxRole,
    ).toBe("bezug");
  });

  it("catches the fund-switch and contact-change admin variants", () => {
    expect(
      applyInsuranceAdminTaxRule({
        text: "Automatische Fondsersetzung im Portfolio Ihrer Riester-Rentenversicherung",
        taxSections: AV,
        taxRole: "beleg",
      }).taxRole,
    ).toBe("bezug");
    expect(
      applyInsuranceAdminTaxRule({
        text: "Änderung Ihrer Kontaktdaten zur Rentenversicherung",
        taxSections: AV,
        taxRole: "beleg",
      }).taxRole,
    ).toBe("bezug");
  });

  it("downgrades a Zulagenantrag / Deckungskapitalübertragung / Beitragsanpassung", () => {
    expect(
      applyInsuranceAdminTaxRule({
        text: "Antrag auf Zulagenantrag für Ihre Riester-Rentenversicherung",
        taxSections: AV,
        taxRole: "beleg",
      }).taxRole,
    ).toBe("bezug");
    expect(
      applyInsuranceAdminTaxRule({
        text: "Deckungskapitalübertragung gemäß § 1 Abs. 2 AltvDV",
        taxSections: AV,
        taxRole: "beleg",
      }).taxRole,
    ).toBe("bezug");
    expect(
      applyInsuranceAdminTaxRule({
        text: "Mitteilung über Beitragsanpassung Ihrer Rentenversicherung",
        taxSections: [{ slug: "vorsorgeaufwand", confidence: 0.9 }],
        taxRole: "beleg",
      }).taxRole,
    ).toBe("bezug");
  });

  it("downgrades a Leistungsabrechnung / Erstattungsabrechnung / Konsortium notice", () => {
    expect(
      applyInsuranceAdminTaxRule({
        text: "Erstattungsabrechnung zu Ihrer Krankenzusatzversicherung",
        taxSections: [{ slug: "vorsorgeaufwand", confidence: 0.9 }],
        taxRole: "beleg",
      }).taxRole,
    ).toBe("bezug");
    expect(
      applyInsuranceAdminTaxRule({
        text: "Leistungsabrechnung Nr. 12345 der Pflegeversicherung",
        taxSections: AV,
        taxRole: "beleg",
      }).taxRole,
    ).toBe("bezug");
    expect(
      applyInsuranceAdminTaxRule({
        text: "Information zur Konsortiumszusammensetzung Ihres Versicherungsvertrags",
        taxSections: AV,
        taxRole: "beleg",
      }).taxRole,
    ).toBe("bezug");
  });

  it("no longer treats bare 'Leistungsmitteilung' as a certificate marker", () => {
    // An employer Unterstützungskasse "Leistungsmitteilung gemäß Leistungsplan"
    // is mere status/anwartschaft — NOT a tax certificate. Previously the word
    // was in BELEG_MARKERS and would have shielded admin mail from the downgrade.
    const out = applyInsuranceAdminTaxRule({
      text: "Leistungsmitteilung gemäß Leistungsplan der Unterstützungskasse. Statusreport Ihrer Anwartschaft.",
      taxSections: AV,
      taxRole: "beleg",
    });
    expect(out.taxSections).toEqual(AV);
    expect(out.taxRole).toBe("bezug");
  });

  it("KEEPS a genuine Beitrags-/Zulagenbescheinigung even with an admin word present", () => {
    // A real certificate mail may also contain "Erhöhungsnachtrag" boilerplate;
    // the certificate marker wins.
    const out = applyInsuranceAdminTaxRule({
      text: "Zulagenbescheinigung nach § 92 EStG für Ihren Riester-Vertrag. Erhöhungsnachtrag anbei.",
      taxSections: AV,
      taxRole: "beleg",
    });
    expect(out.taxSections).toEqual(AV);
    expect(out.taxRole).toBe("beleg");
  });

  it("KEEPS when a §10a Beitragsbescheinigung is present", () => {
    const out = applyInsuranceAdminTaxRule({
      text: "Beitragsbescheinigung nach § 10a EStG über geleistete Altersvorsorgebeiträge",
      taxSections: [{ slug: "vorsorgeaufwand", confidence: 0.9 }],
      taxRole: "beleg",
    });
    expect(out.taxRole).toBe("beleg");
    expect(out.taxSections).toHaveLength(1);
  });

  it("does nothing when there is no insurance section (e.g. only aussergewoehnliche)", () => {
    const sections = [{ slug: "aussergewoehnliche", confidence: 0.85 }];
    const out = applyInsuranceAdminTaxRule({
      text: "Statusreport Erhöhungsnachtrag Dynamik", // admin words, but no insurance section
      taxSections: sections,
      taxRole: "beleg",
    });
    expect(out.taxSections).toEqual(sections);
    expect(out.taxRole).toBe("beleg");
  });

  it("does nothing when no admin marker is present", () => {
    const out = applyInsuranceAdminTaxRule({
      text: "Jährliche Beitragsübersicht Ihrer Rentenversicherung",
      taxSections: AV,
      taxRole: "beleg",
    });
    expect(out.taxSections).toEqual(AV);
    expect(out.taxRole).toBe("beleg");
  });

  it("keeps co-assigned sections on the downgraded document", () => {
    const sections = [
      { slug: "anlage-av", confidence: 0.95 },
      { slug: "aussergewoehnliche", confidence: 0.8 },
    ];
    const out = applyInsuranceAdminTaxRule({
      text: "Erhöhungsnachtrag Dynamik Rentenversicherung",
      taxSections: sections,
      taxRole: "beleg",
    });
    expect(out.taxSections).toEqual(sections);
    expect(out.taxRole).toBe("bezug");
  });

  it("reports no change when the document already is a bezug", () => {
    const out = applyInsuranceAdminTaxRule({
      text: "Erhöhungsnachtrag Dynamik Rentenversicherung",
      taxSections: AV,
      taxRole: "bezug",
    });
    expect(out.taxRole).toBe("bezug");
    expect(out.matched).toBe(false);
  });

  it("ignores the (unreliable) title — only the OCR text counts", () => {
    // Simulates audit doc 1358: title claims a certificate, text is a Widerspruch.
    const out = applyInsuranceAdminTaxRule({
      text: "Wir bestätigen Ihren Widerspruch gegen die dynamische Erhöhung. Der Beitrag bleibt unverändert.",
      taxSections: AV,
      taxRole: "beleg",
    });
    expect(out.taxRole).toBe("bezug");
  });
});

describe("applyKindergeldTaxRule", () => {
  it("replaces generic tax guesses with Anlage Kind for a Familienkasse decision", () => {
    const out = applyKindergeldTaxRule({
      text: "Familienkasse Bayern Süd. Ihre Kindergeldnummer: 123 FK 456. " +
        "Bescheid über Kindergeld nach dem Einkommensteuergesetz (EStG). " +
        "Die Festsetzung des Kindergeldes wird gemäß § 70 Absatz 2 geändert.",
      taxSections: [{ slug: "mantelbogen", confidence: 0.9 }],
      taxRole: "beleg",
    });
    expect(out).toEqual({
      taxSections: [{ slug: "anlage-kind", confidence: 0.98 }],
      taxRole: "beleg",
      matched: true,
    });
  });

  it("does not alter a tax assessment that only mentions Kindergeld", () => {
    const sections = [{ slug: "steuerbescheid", confidence: 0.9 }];
    expect(applyKindergeldTaxRule({
      text: "Einkommensteuerbescheid: Bei der Günstigerprüfung wurde Kindergeld berücksichtigt.",
      taxSections: sections,
      taxRole: "beleg",
    })).toEqual({ taxSections: sections, taxRole: "beleg", matched: false });
  });

  it("does not clear other family benefits such as Elterngeld", () => {
    const sections = [{ slug: "progressionsvorbehalt", confidence: 0.9 }];
    expect(applyKindergeldTaxRule({
      text: "Elterngeldbescheid über Leistungen mit Progressionsvorbehalt",
      taxSections: sections,
      taxRole: "beleg",
    })).toEqual({ taxSections: sections, taxRole: "beleg", matched: false });
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
  // Synthetischer Nachbau einer Dividendenabrechnung (keine echten
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

  it("makes a single dividend settlement a bezug with anlage-kap only", () => {
    const out = applySecuritiesSettlementTaxRule({
      text: DIVIDEND_TEXT,
      taxSections: [
        { slug: "anlage-kap", confidence: 0.95 },
        { slug: "sonderausgaben", confidence: 0.95 },
        { slug: "vorsorgeaufwand", confidence: 0.75 },
      ],
      taxRole: "beleg",
    });
    expect(out.taxSections).toEqual([{ slug: "anlage-kap", confidence: 0.95 }]);
    expect(out.taxRole).toBe("bezug");
    expect(out.matched).toBe(true);
  });

  it("also downgrades a Wertpapierabrechnung, Vorabpauschale and Zinsgutschrift", () => {
    for (const text of [
      "Wertpapierabrechnung Kauf, WKN / ISIN: 000000 / DE0000000000",
      "Steuerliche Behandlung: Vorabpauschale, ISIN DE0000000000, Kapitalertragsteuer",
      "Zinsgutschrift zum Depotkonto, Kapitalertragsteuer einbehalten",
    ]) {
      const out = applySecuritiesSettlementTaxRule({
        text,
        taxSections: [{ slug: "anlage-kap", confidence: 0.9 }],
        taxRole: "beleg",
      });
      expect(out.taxSections).toEqual([{ slug: "anlage-kap", confidence: 0.9 }]);
      expect(out.taxRole).toBe("bezug");
    }
  });

  it("reports no change when the settlement already is a bezug with anlage-kap", () => {
    const sections = [{ slug: "anlage-kap", confidence: 0.9 }];
    expect(
      applySecuritiesSettlementTaxRule({
        text: DIVIDEND_TEXT,
        taxSections: sections,
        taxRole: "bezug",
      }),
    ).toEqual({ taxSections: sections, taxRole: "bezug", matched: false });
  });

  it("gives a settlement the model found no section for its anlage-kap bezug", () => {
    expect(
      applySecuritiesSettlementTaxRule({
        text: DIVIDEND_TEXT,
        taxSections: [],
        taxRole: "keine",
      }),
    ).toEqual({ taxSections: [{ slug: "anlage-kap", confidence: 0.95 }], taxRole: "bezug", matched: true });
  });

  it("makes the Erträgnisaufstellung a bezug with anlage-kap — it is never the evidence", () => {
    const out = applySecuritiesSettlementTaxRule({
      text: "Erträgnisaufstellung 2025, Depotnummer 0000000, ISIN DE0000000000",
      taxSections: [{ slug: "anlage-n", confidence: 0.7 }],
      taxRole: "beleg",
    });
    expect(out.taxSections).toEqual([{ slug: "anlage-kap", confidence: 0.95 }]);
    expect(out.taxRole).toBe("bezug");
    expect(out.matched).toBe(true);
  });

  it("keeps the annual Jahressteuerbescheinigung in anlage-kap only", () => {
    const out = applySecuritiesSettlementTaxRule({
      text: "Jahressteuerbescheinigung 2025 — Depotnummer 0000000, Kapitalertragsteuer, Kirchensteuer als Sonderausgabe",
      taxSections: [
        { slug: "anlage-kap", confidence: 0.95 },
        { slug: "sonderausgaben", confidence: 0.8 },
      ],
      taxRole: "beleg",
    });
    expect(out.taxSections).toEqual([{ slug: "anlage-kap", confidence: 0.95 }]);
    expect(out.taxRole).toBe("beleg");
    expect(out.matched).toBe(true);
  });

  it("adds anlage-kap to an annual certificate the model mis-sectioned and forces beleg", () => {
    const out = applySecuritiesSettlementTaxRule({
      text: "Verlustbescheinigung nach § 43a EStG zum Depot, ISIN DE0000000000",
      taxSections: [],
      taxRole: "keine",
    });
    expect(out.taxSections).toEqual([{ slug: "anlage-kap", confidence: 0.95 }]);
    expect(out.taxRole).toBe("beleg");
  });

  it("treats a settlement stamped KEINE STEUERBESCHEINIGUNG as a settlement", () => {
    // The negation contains the word "Steuerbescheinigung" — it must not be
    // read as the annual certificate.
    const out = applySecuritiesSettlementTaxRule({
      text: "Dividendengutschrift, ISIN DE0000000000\nKEINE STEUERBESCHEINIGUNG",
      taxSections: [{ slug: "anlage-kap", confidence: 0.9 }],
      taxRole: "beleg",
    });
    expect(out.taxSections).toEqual([{ slug: "anlage-kap", confidence: 0.9 }]);
    expect(out.taxRole).toBe("bezug");
  });

  it("leaves a fund-linked pension statement alone", () => {
    const sections = [{ slug: "vorsorgeaufwand", confidence: 0.9 }];
    expect(
      applySecuritiesSettlementTaxRule({
        text: "Standmitteilung zur fondsgebundenen Rentenversicherung, Ausschüttung der Fonds, ISIN DE0000000000",
        taxSections: sections,
        taxRole: "beleg",
      }),
    ).toEqual({ taxSections: sections, taxRole: "beleg", matched: false });
  });

  it("leaves an Einkommensteuerbescheid alone", () => {
    const sections = [{ slug: "steuerbescheid", confidence: 0.95 }];
    expect(
      applySecuritiesSettlementTaxRule({
        text: "Finanzamt Musterstadt — Einkommensteuerbescheid für 2025: Kapitalertragsteuer, Ausschüttungen",
        taxSections: sections,
        taxRole: "beleg",
      }),
    ).toEqual({ taxSections: sections, taxRole: "beleg", matched: false });
  });

  it("does nothing without a securities context", () => {
    const sections = [{ slug: "sonderausgaben", confidence: 0.9 }];
    expect(
      applySecuritiesSettlementTaxRule({
        text: "Zuwendungsbestätigung — Ausschüttung von Spendengeldern an das Projekt",
        taxSections: sections,
        taxRole: "beleg",
      }).matched,
    ).toBe(false);
  });

  it("does nothing for ordinary depot mail that is neither settlement nor certificate", () => {
    const sections = [{ slug: "anlage-kap", confidence: 0.8 }];
    expect(
      applySecuritiesSettlementTaxRule({
        text: "Änderung der Konditionen zu Ihrem Depotkonto — Preis- und Leistungsverzeichnis",
        taxSections: sections,
        taxRole: "beleg",
      }),
    ).toEqual({ taxSections: sections, taxRole: "beleg", matched: false });
  });
});

describe("applyIncomeTaxReturnTaxRule", () => {
  // Synthetic texts: the user's own return and the Bescheid that answers it.
  const RETURN = [
    "Einkommensteuererklärung 2025",
    "Hauptvordruck ESt 1 A",
    "Transferticket: aa0000000000000000",
    "Anlage N Zeile 6 Bruttoarbeitslohn 23.456",
    "Anlage Vorsorgeaufwand Beiträge zur Basisrente (Rürup) 1.200",
    "Anlage AV Altersvorsorgebeiträge § 10a EStG (Riester)",
  ].join("\n");
  const PRINTOUT = [
    "Einkommensteuererklärung für 2025",
    "Anlage Sonderausgaben  Kirchensteuer 312",
    "Anlage KAP  Kapitalerträge 80",
  ].join("\n");
  const BESCHEID = [
    "Finanzamt Musterstadt",
    "Bescheid für 2024 über Einkommensteuer und Solidaritätszuschlag",
    "Abweichend von Ihrer Einkommensteuererklärung wurden die Werbungskosten … berücksichtigt.",
    "Anlage KAP, Anlage Vorsorgeaufwand",
    "Rechtsbehelfsbelehrung",
  ].join("\n");
  const SECTIONS = [
    { slug: "anlage-n", confidence: 0.9 },
    { slug: "anlage-v", confidence: 0.8 },
    { slug: "vorsorgeaufwand", confidence: 0.8 },
    { slug: "sonderausgaben", confidence: 0.7 },
  ];

  it("recognises the filed return by its form markers or its Anlagen", () => {
    expect(isIncomeTaxReturn(RETURN)).toBe(true);
    expect(isIncomeTaxReturn(PRINTOUT)).toBe(true);
  });

  it("leaves a Bescheid that quotes the return alone", () => {
    expect(isIncomeTaxReturn(BESCHEID)).toBe(false);
    expect(isIncomeTaxReturn("Ihre Einkommensteuererklärung ist eingegangen.")).toBe(false);
  });

  it("makes the return a bezug of the Mantelbogen instead of evidence for each Anlage", () => {
    const out = applyIncomeTaxReturnTaxRule({ text: RETURN, taxSections: SECTIONS, taxRole: "beleg" });
    expect(out).toEqual({ taxSections: [{ slug: "mantelbogen", confidence: 0.95 }], taxRole: "bezug", matched: true });
    const kept = applyIncomeTaxReturnTaxRule({ text: BESCHEID, taxSections: SECTIONS, taxRole: "beleg" });
    expect(kept).toEqual({ taxSections: SECTIONS, taxRole: "beleg", matched: false });
  });

  it("reads the year from the heading", () => {
    expect(incomeTaxReturnYear(RETURN)).toBe(2025);
    expect(incomeTaxReturnYear(PRINTOUT)).toBe(2025);
    expect(incomeTaxReturnYear("Einkommensteuererklärung für das Jahr 2024")).toBe(2024);
    expect(incomeTaxReturnYear("Einkommensteuererklärung")).toBeNull();
  });
});

describe("applyIncomeTaxAssessmentTaxRule", () => {
  // Synthetic Bescheid texts.
  const BESCHEID = [
    "Finanzamt Musterstadt",
    "Bescheid für 2024 über Einkommensteuer, Solidaritätszuschlag und Kirchensteuer",
    "Einkünfte aus nichtselbständiger Arbeit 23.456",
    "Kirchensteuer  Nachzahlung 42,00",
    "Rechtsbehelfsbelehrung",
  ].join("\n");
  const NO_CHURCH = "Bescheid für 2024 über Einkommensteuer und Solidaritätszuschlag\nEinkünfte aus nichtselbständiger Arbeit 23.456";
  const AS_EVIDENCE = [
    { slug: "anlage-n", confidence: 0.9 },
    { slug: "anlage-kap", confidence: 0.8 },
  ];

  it("recognises a Bescheid by its heading, never the user's own return", () => {
    expect(isIncomeTaxAssessment(BESCHEID)).toBe(true);
    expect(isIncomeTaxAssessment("Einkommensteuerbescheid 2024 … Rechtsbehelfsbelehrung")).toBe(true);
    expect(isIncomeTaxAssessment("Einkommensteuererklärung 2025\nHauptvordruck ESt 1 A")).toBe(false);
    expect(isIncomeTaxAssessment("Lohnsteuerbescheinigung 2025")).toBe(false);
  });

  it("takes the Bescheid out of the income Anlagen; only its Kirchensteuer stays evidence", () => {
    expect(applyIncomeTaxAssessmentTaxRule({ text: BESCHEID, taxSections: AS_EVIDENCE, taxRole: "beleg" })).toEqual({
      taxSections: [{ slug: "steuerbescheid", confidence: 0.95 }, { slug: "sonderausgaben", confidence: 0.8 }],
      taxRole: "beleg",
      matched: true,
    });
    expect(applyIncomeTaxAssessmentTaxRule({ text: NO_CHURCH, taxSections: AS_EVIDENCE, taxRole: "beleg" })).toEqual({
      taxSections: [{ slug: "steuerbescheid", confidence: 0.95 }],
      taxRole: "bezug",
      matched: true,
    });
  });
});
