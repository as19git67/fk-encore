import { describe, it, expect } from "vitest";
import {
  CONTENT_RULES,
  matchContentRule,
  matchSenderRule,
  normalizeForMatch,
  type SenderRule,
} from "./sender-rules";
import { flattenTaxonomy } from "./taxonomy";

describe("normalizeForMatch", () => {
  it("lowercases and strips spaces/punctuation, keeps umlauts and digits", () => {
    expect(normalizeForMatch("Contoso Software GmbH")).toBe("contososoftwaregmbh");
    expect(normalizeForMatch("BEISPIEL Krankenversicherung a.G.")).toBe("beispielkrankenversicherungag");
    expect(normalizeForMatch("Müster Bausparkasse AG 24")).toBe("müsterbausparkasseag24");
    expect(normalizeForMatch(null)).toBe("");
  });
});

describe("matchSenderRule", () => {
  // The rules are the household's data (document_sender_rule_overrides); the
  // code ships none. Fictional example data in the same shape.
  const rules: SenderRule[] = [
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
      note: "Kirchlicher Arbeitgeber → Entgelt-/Gehaltsabrechnung",
      senders: ["pfarramtstbeispiel"],
      requireAny: ["entgeltabrechnung", "gehaltsabrechnung", "lohnabrechnung"],
      category: "finanzen-gehalt",
    },
    {
      note: "Beispielbank Finanzreport → Kontoauszüge",
      senders: ["beispielbank"],
      requireAny: ["finanzreport"],
      category: "finanzen-kontoauszuege",
    },
    {
      note: "Beispielbank → Wertpapiere",
      senders: ["beispielbank"],
      category: "finanzen-wertpapiere",
    },
    {
      note: "Mustertelefon → Telekommunikation, nicht die Aktie",
      senders: ["mustertelefon"],
      excludeAny: ["dividende", "aktie"],
      category: "vertraege-telekom",
    },
  ];

  it("returns null when there is no sender", () => {
    expect(matchSenderRule({ sender: null, title: "Rechnung" }, rules)).toBeNull();
    expect(matchSenderRule({ sender: "" }, rules)).toBeNull();
  });

  it("returns null without rules: the code ships none", () => {
    expect(matchSenderRule({ sender: "Contoso Software GmbH", title: "Entgeltabrechnung 04/2024" }, [])).toBeNull();
  });

  it("does not match owner/recipient names (the owner-as-sender bug yields no override)", () => {
    expect(matchSenderRule({ sender: "Paul Beispiel", title: "Irgendein Schreiben" }, rules)).toBeNull();
  });

  it("matches regardless of OCR spacing/case", () => {
    expect(matchSenderRule({ sender: "CONTOSO  Software GmbH", title: "Lohnabrechnung" }, rules)).toBe(
      "finanzen-gehalt",
    );
  });

  it("evaluates top-to-bottom: a guarded rule beats the fallback for the same sender", () => {
    expect(
      matchSenderRule({ sender: "Contoso Software GmbH", title: "Einkommensteuerbescheid für 2022" }, rules),
    ).toBe("behoerden-steuerbescheid");
    expect(
      matchSenderRule({ sender: "Contoso Software GmbH", title: "Sozialversicherungsnachweis" }, rules),
    ).toBe("finanzen-sozialversicherung");
    expect(
      matchSenderRule({ sender: "Contoso Software GmbH", title: "Entgeltabrechnung 03/2024" }, rules),
    ).toBe("finanzen-gehalt");
    expect(matchSenderRule({ sender: "Beispielbank AG", title: "Finanzreport Nr. 3" }, rules)).toBe(
      "finanzen-kontoauszuege",
    );
    expect(matchSenderRule({ sender: "Beispielbank AG", title: "Dividendengutschrift" }, rules)).toBe(
      "finanzen-wertpapiere",
    );
  });

  it("honours requireAny: no keyword, no rule", () => {
    expect(matchSenderRule({ sender: "Pfarramt St. Beispiel", title: "Entgeltabrechnung 06/2023" }, rules)).toBe(
      "finanzen-gehalt",
    );
    expect(matchSenderRule({ sender: "Pfarramt St. Beispiel", title: "Rundschreiben" }, rules)).toBeNull();
  });

  it("honours excludeAny", () => {
    expect(matchSenderRule({ sender: "Mustertelefon GmbH", title: "Mobilfunkrechnung" }, rules)).toBe(
      "vertraege-telekom",
    );
    expect(matchSenderRule({ sender: "Mustertelefon AG", title: "Dividendengutschrift" }, rules)).toBeNull();
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
        title: "Statusreport Beispiel Lebensversicherung",
        text: "Beispielfonds balanced, staatlich geförderte Riester-Rentenversicherung",
      }),
    ).toBe("altersvorsorge-rentenversicherung");
    expect(
      matchContentRule({ title: "Bescheinigung", text: "Zulagenbescheinigung nach § 92 EStG" }),
    ).toBe("altersvorsorge-rentenversicherung");
    expect(
      matchContentRule({ title: "Förder Rente invest Beispielfonds", text: "" }),
    ).toBe("altersvorsorge-rentenversicherung");
  });

  it("files a Riester Zulage application under Rentenversicherung although it asks for the Kindergeldnummer", () => {
    expect(
      matchContentRule({
        title: "Antrag auf Altersvorsorgezulage 2023",
        text: "Dauerzulageverfahren. Kinderzulage: Kindergeldnummer 000FK000000, Familienkasse Beispielstadt",
      }),
    ).toBe("altersvorsorge-rentenversicherung");
  });

  it("routes a stand-alone BU policy, but not a BU rider on a pension contract", () => {
    expect(
      matchContentRule({ title: "Erhöhungsnachtrag zum Versicherungsschein", text: "Flexible Berufsunfähigkeitsversicherung" }),
    ).toBe("versicherungen-berufsunfaehigkeit");
    expect(
      matchContentRule({ title: "Nachtrag", text: "Berufsunfähigkeits-Zusatzversicherung zur Rentenversicherung" }),
    ).toBeNull();
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
      matchContentRule({ title: "Kfz-Haftpflicht", text: "Teilkasko, Vollkasko, Musterwagen" }),
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
