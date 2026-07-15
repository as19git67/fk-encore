import { describe, it, expect } from "vitest";
import { applyInsuranceAdminTaxRule, applyKindergeldTaxRule } from "./tax-rules";

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
