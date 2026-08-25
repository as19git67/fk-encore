import { describe, it, expect } from "vitest";
import {
  buildUmlautRestorationMap,
  detectSubjectPersonIds,
  detectSubjectPersonPersonalDeductionReview,
  extractDocumentDate,
  extractDocumentNumber,
  extractReferenceNumberTags,
  extractSender,
  isSubjectPersonSender,
  reconcileSubjectPersonTags,
  restoreUmlautSpellings,
} from "./metadata-extract";

describe("extractDocumentNumber", () => {
  it("returns the digits of a #1234 marker without the hash", () => {
    expect(extractDocumentNumber("… Beleg #2661160 vom 1.1.")).toBe("2661160");
    expect(extractDocumentNumber("Auftrag #4711 erteilt")).toBe("4711");
  });

  it("allows a single separator between the # and the digits", () => {
    expect(extractDocumentNumber("Beleg #.2661160")).toBe("2661160");
    expect(extractDocumentNumber("Beleg # 4711")).toBe("4711");
    expect(extractDocumentNumber("Beleg #-4711")).toBe("4711");
    expect(extractDocumentNumber("Beleg #/4711")).toBe("4711");
  });

  it("ignores numbers that are not marked with #", () => {
    expect(extractDocumentNumber("Rechnungsnummer 2661160")).toBeNull();
    expect(extractDocumentNumber("Vertragskonto 123456")).toBeNull();
  });

  it("requires at least four digits and returns null otherwise", () => {
    expect(extractDocumentNumber("Zimmer #12")).toBeNull();
    expect(extractDocumentNumber("kein Marker hier")).toBeNull();
  });
});

describe("extractDocumentDate", () => {
  it("reads the three production examples the LLM missed", () => {
    expect(extractDocumentDate("Datum: 11.08.14")).toBe("2014-08-11");
    expect(extractDocumentDate("Rechnungsdatum                       18.01.2021")).toBe("2021-01-18");
    expect(extractDocumentDate("Datum: 09.05.2014")).toBe("2014-05-09");
  });

  it("handles the compound *datum labels", () => {
    expect(extractDocumentDate("Bescheiddatum 03.12.2020")).toBe("2020-12-03");
    expect(extractDocumentDate("Ausstellungsdatum: 1.7.2019")).toBe("2019-07-01");
  });

  it("reads 'Rechnung vom …'", () => {
    expect(extractDocumentDate("Rechnung vom 18.01.2021 über …")).toBe("2021-01-18");
  });

  it("reads the 'Ort, TT.MM.JJJJ' letterhead convention", () => {
    expect(extractDocumentDate("München, 05.03.2022\nSehr geehrte …")).toBe("2022-03-05");
  });

  it("reads written-month dates like '8. September 2017'", () => {
    expect(extractDocumentDate("Datum: 8. September 2017")).toBe("2017-09-08");
    expect(extractDocumentDate("Rechnungsdatum 1. Juli 2024")).toBe("2024-07-01");
    expect(extractDocumentDate("Rechnung vom 8. September 2017")).toBe("2017-09-08");
    // Letterhead with "den": "München, den 8. September 2017"
    expect(extractDocumentDate("München, den 8. September 2017\nSehr geehrte …")).toBe("2017-09-08");
  });

  it("handles month abbreviations, umlauts and no-period days", () => {
    expect(extractDocumentDate("Datum: 3. Dez. 2019")).toBe("2019-12-03");
    expect(extractDocumentDate("Datum: 15 März 2020")).toBe("2020-03-15");
    expect(extractDocumentDate("Ausstellungsdatum: 1. Mai 2021")).toBe("2021-05-01");
  });

  it("skips a non-month word after the label and finds the real written date", () => {
    // "Datum: Sehr …" must not abort the scan; the real date is later.
    expect(extractDocumentDate("Datum: Sehr geehrte Damen. Rechnungsdatum 8. September 2017")).toBe(
      "2017-09-08",
    );
  });

  it("rejects an impossible written-month date", () => {
    expect(extractDocumentDate("Datum: 31. September 2017")).toBeNull(); // Sept has 30 days
  });

  it("expands two-digit years with the 00–68 / 69–99 pivot", () => {
    expect(extractDocumentDate("Datum 01.01.68")).toBe("2068-01-01");
    expect(extractDocumentDate("Datum 01.01.69")).toBe("1969-01-01");
    expect(extractDocumentDate("Datum 31.12.85")).toBe("1985-12-31");
  });

  it("rejects impossible calendar dates", () => {
    expect(extractDocumentDate("Datum: 31.02.2021")).toBeNull();
    expect(extractDocumentDate("Datum: 30.02.2020")).toBeNull();
    expect(extractDocumentDate("Datum: 29.02.2021")).toBeNull(); // 2021 not a leap year
    expect(extractDocumentDate("Datum: 29.02.2020")).toBe("2020-02-29"); // leap year ok
  });

  it("does not grab an unlabelled date from the body", () => {
    expect(extractDocumentDate("Bitte zahlen Sie bis zum 30.06.2021.")).toBeNull();
    expect(extractDocumentDate("geboren 12.04.1950 in …")).toBeNull();
  });

  it("stays on the label's own line (no jump to a later line)", () => {
    // The word "Datum" with no date after it must not pull the date two lines down.
    expect(extractDocumentDate("Datum:\nKundennummer 4711\nFällig 30.06.2021")).toBeNull();
  });

  it("returns null when there is no date at all", () => {
    expect(extractDocumentDate("Kein Datum in diesem Text")).toBeNull();
    expect(extractDocumentDate("")).toBeNull();
  });

  // Scanned German invoices routinely print the date as a table column with
  // the label above the value, which the same-line patterns cannot see.
  describe("column-header layout (label above the value)", () => {
    it("reads a date from the row under its column header", () => {
      // The production case: a scanned doctor's invoice, as ocr-layout.ts
      // reconstructs it (column breaks rendered as wide gaps).
      const text = [
        "Bitte bei Zahlung unbedingt angeben",
        "Datum      Rechnungs-Nr.   Endbetrag",
        "12.03.19   77213-9042          20,11",
      ].join("\n");
      expect(extractDocumentDate(text)).toBe("2019-03-12");
    });

    it("reads a single-column header/value pair", () => {
      expect(extractDocumentDate("Datum\n12.03.19")).toBe("2019-03-12");
      expect(extractDocumentDate("Rechnungsdatum\n18.01.2021")).toBe("2021-01-18");
    });

    it("picks the cell belonging to the date column, not another one", () => {
      const text = ["Kunden-Nr.   Datum        Betrag", "4711         18.01.2021   20,11"].join("\n");
      expect(extractDocumentDate(text)).toBe("2021-01-18");
    });

    it("reads a written-month date under the header", () => {
      expect(extractDocumentDate("Datum\n8. September 2017")).toBe("2017-09-08");
    });

    it("reads a mis-celled row by the column the date is printed in", () => {
      // One value cell missing, so the cell indices no longer correspond. This
      // used to return null on the grounds that picking any cell would be a
      // guess — but it is not a guess: the date is printed directly beneath the
      // word "Datum", which is the document saying which column it belongs to.
      // `extractAlignedColumnDate` compares character offsets and reads it.
      const text = ["Kunden-Nr.   Datum        Betrag", "4711         18.01.2021"].join("\n");
      expect(extractDocumentDate(text)).toBe("2021-01-18");
    });

    it("does not take a date printed under a different column", () => {
      // The offset pass must stay a column alignment and not degrade into
      // "any date on the following line".
      const text = ["Datum        Kunden-Nr.                     Betrag",
                    "             4711            30.06.2021    20,11"].join("\n");
      expect(extractDocumentDate(text)).toBeNull();
    });

    it("reads a header whose labels share one cell", () => {
      // Production shape: the header's own columns are not separated by wide
      // gaps at all, so no cell index corresponds to anything — but the date
      // still sits under the word "Datum".
      const text = ["Nummer Kunden-Nr, Datum     Seite",
                    "5135897          52312 14.09.2010       I"].join("\n");
      expect(extractDocumentDate(text)).toBe("2010-09-14");
    });

    it("does not treat a sentence mentioning 'Datum' as a column header", () => {
      const text = ["Das Datum entnehmen Sie bitte dem Beleg.", "30.06.2021"].join("\n");
      expect(extractDocumentDate(text)).toBeNull();
    });

    it("still requires an actual date in the row below", () => {
      expect(extractDocumentDate("Datum:\nKundennummer 4711\nFällig 30.06.2021")).toBeNull();
    });
  });

  describe("labels that name someone else's date", () => {
    it("ignores a Geburtsdatum on the same line", () => {
      expect(extractDocumentDate("Geburtsdatum: 17.11.1955")).toBeNull();
      expect(extractDocumentDate("Geburtsdatum 17. November 1955")).toBeNull();
    });

    it("ignores a Geburtsdatum used as a column header", () => {
      expect(extractDocumentDate("Geburtsdatum\n17.11.1955")).toBeNull();
    });

    it("ignores due and validity dates", () => {
      expect(extractDocumentDate("Fälligkeitsdatum: 30.06.2021")).toBeNull();
      expect(extractDocumentDate("Gültigkeitsdatum: 31.12.2025")).toBeNull();
      expect(extractDocumentDate("Ablaufdatum 31.12.2025")).toBeNull();
    });

    it("still finds the document's own date next to a birthdate", () => {
      // Both labels present — the real one must win regardless of order.
      expect(extractDocumentDate("Geburtsdatum: 17.11.1955\nRechnungsdatum: 12.03.2019")).toBe(
        "2019-03-12",
      );
      expect(extractDocumentDate("Rechnungsdatum: 12.03.2019\nGeburtsdatum: 17.11.1955")).toBe(
        "2019-03-12",
      );
    });
  });
});

describe("extractDocumentDate — month without a day", () => {
  it("reads the 'Ort, im Monat Jahr' letterhead convention as the 1st", () => {
    expect(extractDocumentDate("Musterstadt, im Mai 2009")).toBe("2009-05-01");
    expect(extractDocumentDate("Beispielheim, im September 2017\nSehr geehrte …")).toBe("2017-09-01");
  });

  it("prefers a fully stated date over a month-only one", () => {
    const text = "Musterstadt, im Mai 2009\nRechnungsdatum 18.06.2009";
    expect(extractDocumentDate(text)).toBe("2009-06-18");
  });

  it("does not read a month out of running prose", () => {
    // Why the "im" is required: without it this shape is indistinguishable
    // from an ordinary sentence naming a month.
    expect(extractDocumentDate("Der Vertrag, Mai 2009 geschlossen, endet …")).toBeNull();
  });
});

describe("extractDocumentDate — the letterhead dates the document", () => {
  it("prefers the month above the salutation over a full date in the body", () => {
    // Production case: a letter headed "Oktober 2025" that later mentions a
    // validity start in 2027 was filed under 2027. The old ordering ranked a
    // fully stated date above a month-only one regardless of where each sat,
    // so it was precise about the wrong date. A letter dates itself in its
    // letterhead; everything below the salutation belongs to what the letter
    // is about.
    const text = [
      "Beispiel AG",
      "",
      "Oktober 2025",
      "",
      "Sehr geehrte Damen und Herren,",
      "",
      "Ihr Vertrag ist gültig vom 01.01.2027 an.",
    ].join("\n");
    expect(extractDocumentDate(text)).toBe("2025-10-01");
  });

  it("applies the same rule to the 'Ort, im Monat Jahr' spelling", () => {
    const text = [
      "Musterstadt, im Oktober 2025",
      "",
      "Sehr geehrter Herr Muster,",
      "",
      "gültig vom 01.01.2027.",
    ].join("\n");
    expect(extractDocumentDate(text)).toBe("2025-10-01");
  });

  it("skips the reference block, which also sits above the salutation", () => {
    // "Ihr Schreiben vom …" names the date of the letter being answered. The
    // position rule would otherwise promote it over the real letterhead date,
    // making this change actively worse than what it replaces.
    const text = [
      "Beispiel AG",
      "Ihr Schreiben vom 12.03.2024",
      "Datum 05.04.2024",
      "",
      "Sehr geehrte Damen und Herren,",
    ].join("\n");
    expect(extractDocumentDate(text)).toBe("2024-04-05");
  });

  it("does not take a month named in the subject line", () => {
    // A subject line names the month the document is *about*.
    const text = [
      "Beispiel AG",
      "Musterstadt, 05.04.2024",
      "Betreff: Beitrag Oktober 2025",
      "",
      "Sehr geehrte Damen und Herren,",
    ].join("\n");
    expect(extractDocumentDate(text)).toBe("2024-04-05");
  });

  it("still ranks by anchor strength when there is no salutation", () => {
    // Invoices, statements and tables have no salutation, so nothing marks
    // where the letterhead ends. Those keep the old ordering entirely: a fully
    // stated date outranks a month-only one wherever it sits.
    expect(extractDocumentDate("Musterstadt, im Mai 2009\nRechnungsdatum 18.06.2009"))
      .toBe("2009-06-18");
  });

  it("still finds a date that only appears below the salutation", () => {
    const text = [
      "Beispiel AG",
      "",
      "Sehr geehrte Damen und Herren,",
      "",
      "Rechnungsdatum 18.01.2021",
    ].join("\n");
    expect(extractDocumentDate(text)).toBe("2021-01-18");
  });

  it("does not accept a bare month-year below the salutation", () => {
    // Above the letterhead boundary a lone month and year is the document
    // dating itself; below it, it is prose.
    expect(extractDocumentDate("Sehr geehrte Damen und Herren,\n\nab Oktober 2025 gilt …"))
      .toBeNull();
  });
});

describe("extractSender", () => {
  it("reads the comma-joined return address above the address window", () => {
    const text = [
      "MUSTER & BEISPIEL GmbH, Beispielstr. 19, D-72119 Musterhausen",
      "",
      "Erika Mustermann",
      "Beispielstraße 1",
      "12345 Musterstadt",
    ].join("\n");
    expect(extractSender(text)).toBe("MUSTER & BEISPIEL GmbH");
  });

  it("reads an address block whose name line names an organisation", () => {
    const text = [
      "Muster Lebensversicherung AG",
      "Beispielplatz 1",
      "50679 Musterstadt",
      "",
      "Ihre Rentenversicherung",
    ].join("\n");
    expect(extractSender(text)).toBe("Muster Lebensversicherung AG");
  });

  it("reads a bare letterhead line", () => {
    const text = ["Beispiel Finanzdienstleistungen AG", "", "Musterstadt, im Mai 2009"].join("\n");
    expect(extractSender(text)).toBe("Beispiel Finanzdienstleistungen AG");
  });

  it("takes the sender's block, not the recipient's", () => {
    // The recipient of a household's post is a household member, whose name
    // carries no legal form — which is what the organisation requirement buys.
    const text = [
      "Beispiel Versicherung AG",
      "Beispielallee 7",
      "50679 Musterstadt",
      "",
      "Herrn",
      "Max Mustermann",
      "Beispielstraße 1",
      "12345 Musterstadt",
    ].join("\n");
    expect(extractSender(text)).toBe("Beispiel Versicherung AG");
  });

  it("returns null rather than guessing when no organisation is named", () => {
    const text = ["Max Mustermann", "Beispielstraße 1", "12345 Musterstadt", "", "Hallo,"].join("\n");
    expect(extractSender(text)).toBeNull();
  });

  it("never returns a street, a postcode line or an address label", () => {
    expect(extractSender("Beispielstraße 1\n12345 Musterstadt")).toBeNull();
    expect(extractSender("Herrn\nFrau\nFirma")).toBeNull();
  });

  it("cuts the address off a line that carries both name and address", () => {
    // Production regression: this whole line was stored as the sender, and
    // then became the key the learned rules and the correspondent folder are
    // built on. Note the single comma — the return-address strategy needs two,
    // so the line fell through to the bare-letterhead one, which took it whole.
    expect(extractSender("Beispiel Lebensversicherungs-AG, 10850 Musterstadt Es betreut Sie"))
      .toBe("Beispiel Lebensversicherungs-AG");
    // Same without any comma at all.
    expect(extractSender("Beispiel Lebensversicherungs-AG 10850 Musterstadt"))
      .toBe("Beispiel Lebensversicherungs-AG");
    // …and with a PO box in between.
    expect(extractSender("Beispiel AG, Postfach 12 34 56, 10850 Musterstadt")).toBe("Beispiel AG");
  });

  it("cuts a return address separated by hyphens or dots rather than commas", () => {
    // Production letterhead shape: "<Name> - Postfach <n> - <PLZ> <Ort>".
    // Cutting only at the postcode left the box number attached to the name.
    for (const sep of [" - ", " · ", " | "]) {
      const line = `Beispiel Lebensversicherung AG${sep}Postfach 103969${sep}69029 Musterstadt`;
      expect(extractSender(line), line).toBe("Beispiel Lebensversicherung AG");
    }
  });

  it("keeps an unspaced hyphen, which belongs to the name", () => {
    // The separator must be spaced on both sides — "Beispiel-Versicherung AG"
    // and "Charles-de-Gaulle-Platz" are one token, not two fields.
    expect(extractSender("Beispiel-Versicherung AG, 10850 Musterstadt"))
      .toBe("Beispiel-Versicherung AG");
  });

  it("cuts a street tail even when no postcode follows it", () => {
    expect(extractSender("Beispiel Versicherung AG, Beispielstr. 19")).toBe("Beispiel Versicherung AG");
  });

  it("keeps a comma that belongs to the name", () => {
    // Why the cut is anchored on the address and not on the first comma: a
    // comma is not reliably a boundary in a German company name.
    expect(extractSender("Muster GmbH & Co. KG, Zweigniederlassung Musterstadt"))
      .toBe("Muster GmbH & Co. KG, Zweigniederlassung Musterstadt");
  });

  it("does not mistake a five-digit document number for a postcode", () => {
    // A postcode is only a postcode when a place name follows it. Without that
    // check this line was cut down to "Rechnung Nr.".
    expect(extractSender("Beispiel GmbH, Rechnung 12345 vom 01.02.2024"))
      .toBe("Beispiel GmbH, Rechnung 12345 vom 01.02.2024");
  });

  it("does not take a line that opens with the kind of document it is", () => {
    expect(extractSender("Rechnung Nr. 12345 der Beispiel GmbH")).toBeNull();
    expect(extractSender("Mahnung der Beispiel GmbH")).toBeNull();
  });

  it("ignores a letterhead far below the top of the document", () => {
    // Small print in a footer or an enclosed third-party document is not this
    // document's sender.
    const text = [...Array(45).fill("Fließtext ohne Absender."), "Beispiel Muster GmbH"].join("\n");
    expect(extractSender(text)).toBeNull();
  });
});

describe("isSubjectPersonSender", () => {
  const persons = [{ full_name: "Erika Mustermann" }, { full_name: "Anton Beispiel" }];

  it("matches the person's name in any order, with or without salutation", () => {
    expect(isSubjectPersonSender("Erika Mustermann", persons)).toBe(true);
    expect(isSubjectPersonSender("Mustermann, Erika", persons)).toBe(true);
    expect(isSubjectPersonSender("Frau Erika Mustermann", persons)).toBe(true);
    expect(isSubjectPersonSender("Anton Beispiel", persons)).toBe(true);
  });

  it("does not match a company that merely contains the surname", () => {
    expect(isSubjectPersonSender("Mustermann GmbH", persons)).toBe(false);
    expect(isSubjectPersonSender("HALLESCHE Krankenversicherung", persons)).toBe(false);
  });

  it("does not match on a lone first name or empty sender", () => {
    expect(isSubjectPersonSender("Erika", persons)).toBe(false);
    expect(isSubjectPersonSender(null, persons)).toBe(false);
    expect(isSubjectPersonSender("", persons)).toBe(false);
  });
});

describe("detectSubjectPersonIds", () => {
  const persons = [
    { id: 1, full_name: "Erika Mustermann" },
    { id: 2, full_name: "Anton Beispiel" },
  ];

  it("matches a person whose full name appears in any order", () => {
    expect(detectSubjectPersonIds("Patientin: Erika Mustermann, geb. 1950", persons)).toEqual([1]);
    expect(detectSubjectPersonIds("Rechnung an Mustermann, Erika", persons)).toEqual([1]);
    expect(detectSubjectPersonIds("Betreff Anton Beispiel und Erika Mustermann", persons)).toEqual([
      1, 2,
    ]);
  });

  it("requires every name token and ignores partial mentions", () => {
    expect(detectSubjectPersonIds("nur Erika wird erwähnt", persons)).toEqual([]);
    expect(detectSubjectPersonIds("kein Name hier", persons)).toEqual([]);
  });
});

describe("extractReferenceNumberTags", () => {
  it("captures labelled contract/insurance/order numbers as tags", () => {
    expect(extractReferenceNumberTags("Versicherungsnummer: ABC-12345")).toEqual([
      "versicherungsnr:abc-12345",
    ]);
    expect(extractReferenceNumberTags("Vertragskonto 123456")).toEqual(["vertragsnr:123456"]);
    expect(extractReferenceNumberTags("Ihre Auftragsnummer 778899 wurde erfasst")).toEqual([
      "auftragsnr:778899",
    ]);
    expect(extractReferenceNumberTags("Kunden-Nr. 4567890")).toEqual(["kundennr:4567890"]);
    expect(extractReferenceNumberTags("Policennummer 99001122")).toEqual([
      "versicherungsnr:99001122",
    ]);
  });

  it("requires a digit-bearing value and deduplicates", () => {
    expect(extractReferenceNumberTags("Vertragsnummer: ohne")).toEqual([]);
    expect(extractReferenceNumberTags("kein label hier 123456")).toEqual([]);
    expect(
      extractReferenceNumberTags("Vertragskonto 123456 … Vertragsnummer 123456"),
    ).toEqual(["vertragsnr:123456"]);
  });
});

describe("reconcileSubjectPersonTags", () => {
  const persons = [
    { id: 1, relation_tag: "Alex" },
    { id: 2, relation_tag: "Nina" },
    { id: 3, relation_tag: "Vater" },
    { id: 4, relation_tag: "Mutter" },
  ];

  it("drops relation tags the detector did not confirm (the reported bug)", () => {
    // LLM hallucinated Nina + Vater; only Alex was actually detected.
    const out = reconcileSubjectPersonTags(
      ["Alex", "Nina", "Vater", "sprachreise"],
      persons,
      [1],
    );
    expect(out).toContain("Alex");
    expect(out).toContain("sprachreise"); // content tag untouched
    expect(out).not.toContain("Nina");
    expect(out).not.toContain("Vater");
  });

  it("drops all person tags when the detector confirms none (OCR-garbled names)", () => {
    const out = reconcileSubjectPersonTags(["Alex", "Nina", "Vater"], persons, []);
    expect(out).toEqual([]);
  });

  it("does not auto-add detected persons the LLM intentionally omitted", () => {
    // The LLM decides who is relevant; the detector only removes hallucinations.
    // A detected name (e.g. child on a payslip) that the LLM did not tag stays out.
    const out = reconcileSubjectPersonTags(["plymouth"], persons, [4]);
    expect(out).toEqual(["plymouth"]);
  });

  it("leaves documents without Bezugspersonen untouched", () => {
    const out = reconcileSubjectPersonTags(["rechnung", "o2"], [], []);
    expect(out).toEqual(["rechnung", "o2"]);
  });

  it("matches relation tags case-insensitively and de-duplicates", () => {
    const out = reconcileSubjectPersonTags(["alex", "Alex", "ALEX"], persons, [1]);
    expect(out).toEqual(["alex"]);
  });
});

describe("detectSubjectPersonPersonalDeductionReview", () => {
  it("flags personal deduction sections for review when the document concerns a Bezugsperson", () => {
    expect(
      detectSubjectPersonPersonalDeductionReview({
        detectedSubjectPersonIds: [4],
        taxSections: [
          { slug: "sonderausgaben" },
          { slug: "haushaltsnahe" },
        ],
      }),
    ).toEqual({
      shouldReview: true,
      reviewSlugs: ["sonderausgaben", "haushaltsnahe"],
    });
  });

  it("does not flag when no Bezugsperson was detected", () => {
    expect(
      detectSubjectPersonPersonalDeductionReview({
        detectedSubjectPersonIds: [],
        taxSections: [{ slug: "haushaltsnahe" }],
      }),
    ).toEqual({ shouldReview: false, reviewSlugs: [] });
  });

  it("does not flag non-personal tax sections such as Anlage Unterhalt or income sections", () => {
    expect(
      detectSubjectPersonPersonalDeductionReview({
        detectedSubjectPersonIds: [4],
        taxSections: [
          { slug: "anlage-unterhalt" },
          { slug: "anlage-r" },
          { slug: "steuerbescheid" },
        ],
      }),
    ).toEqual({ shouldReview: false, reviewSlugs: [] });
  });

  it("deduplicates and normalises review slugs", () => {
    expect(
      detectSubjectPersonPersonalDeductionReview({
        detectedSubjectPersonIds: [4],
        taxSections: [
          { slug: " Haushaltsnahe " },
          { slug: "haushaltsnahe" },
        ],
      }),
    ).toEqual({ shouldReview: true, reviewSlugs: ["haushaltsnahe"] });
  });
});

describe("umlaut restoration (buildUmlautRestorationMap / restoreUmlautSpellings)", () => {
  const source =
    "Gebührenbescheid der Stadt München über die Prüfung der Straßenreinigung. " +
    "Zusätzliche Gebühren für die Müllabfuhr.";
  const map = buildUmlautRestorationMap(source);

  it("restores transliterated tags to the spelling found in the document", () => {
    expect(restoreUmlautSpellings("pruefung", map)).toBe("prüfung");
    expect(restoreUmlautSpellings("gebuehren", map)).toBe("gebühren");
    expect(restoreUmlautSpellings("muellabfuhr", map)).toBe("müllabfuhr");
  });

  it("restores words inside longer text and keeps the casing shape", () => {
    expect(
      restoreUmlautSpellings("Gebuehrenbescheid der Stadt Muenchen zur Pruefung", map),
    ).toBe("Gebührenbescheid der Stadt München zur Prüfung");
    expect(restoreUmlautSpellings("MUENCHEN", map)).toBe("MÜNCHEN");
  });

  it("restores ß spellings (strassenreinigung → straßenreinigung)", () => {
    expect(restoreUmlautSpellings("strassenreinigung", map)).toBe("straßenreinigung");
  });

  it("leaves words alone that have no umlauted counterpart in the document", () => {
    // "michael" contains "ae" but the document never spells a word whose
    // transliteration is "michael" — must NOT become "michäl".
    expect(restoreUmlautSpellings("michael", map)).toBe("michael");
    expect(restoreUmlautSpellings("Suedbayern kasse", map)).toBe("Suedbayern kasse");
  });

  it("passes through null/empty and words already carrying umlauts", () => {
    expect(restoreUmlautSpellings(null, map)).toBeNull();
    expect(restoreUmlautSpellings("", map)).toBe("");
    expect(restoreUmlautSpellings("prüfung", map)).toBe("prüfung");
  });

  it("prefers the most frequent source spelling on key collisions", () => {
    const m = buildUmlautRestorationMap("Maße Maße Masse");
    // "Maße" appears twice, so the restored form is the frequent one.
    expect(restoreUmlautSpellings("masse", m)).toBe("maße");
  });

  it("returns the input untouched when the document has no umlauts at all", () => {
    const empty = buildUmlautRestorationMap("Invoice without any special letters");
    expect(restoreUmlautSpellings("pruefung", empty)).toBe("pruefung");
  });
});
