import { describe, it, expect } from "vitest";
import {
  buildUmlautRestorationMap,
  detectSubjectPersonIds,
  detectSubjectPersonPersonalDeductionReview,
  extractDocumentDate,
  inferDateConvention,
  isMonthOnlyReading,
  normalizeDocumentDate,
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

describe("extractDocumentDate — the unlabelled letterhead date", () => {
  // Every value below is invented. German business letters set the date alone
  // at the top right with no label at all, which is the one common shape the
  // anchored patterns cannot see.
  const letter = (top: string) =>
    [
      "Muster Bauspar AG",
      "Postfach 1307",
      "12345 Musterstadt",
      "",
      "Frau",
      "Erika Beispiel",
      "Beispielstr. 10a",
      "12345 Musterstadt",
      "",
      top,
      "",
      "Sehr geehrte Frau Beispiel,",
      "",
      "vielen Dank für Ihre Mitteilung.",
    ].join("\n");

  it("takes a bare date above the salutation", () => {
    expect(extractDocumentDate(letter("24.04.2023"))).toBe("2023-04-24");
  });

  it("never outranks a labelled date", () => {
    // The last resort must stay last: an anchored date anywhere wins, even
    // when the bare one sits higher up the page.
    const text = letter("24.04.2023").replace(
      "vielen Dank für Ihre Mitteilung.",
      "Rechnungsdatum 18.01.2021",
    );
    expect(extractDocumentDate(text)).toBe("2021-01-18");
  });

  it("ignores a bare date below the salutation", () => {
    // Down there an unanchored date is what the letter is about — a deadline,
    // a period, a date being confirmed — not the letter's own.
    const text = [
      "Muster Bauspar AG",
      "",
      "Sehr geehrte Frau Beispiel,",
      "",
      "bitte überweisen Sie den Betrag bis 30.06.2024.",
    ].join("\n");
    expect(extractDocumentDate(text)).toBeNull();
  });

  it("returns nothing when there is no salutation to mark the letterhead", () => {
    // Without one there is no way to tell a letterhead date from any other.
    expect(extractDocumentDate("Anlage 3\n\n24.04.2023\n\nBetrag 100,00")).toBeNull();
  });

  it("takes the date nearest the salutation, not the postal apparatus", () => {
    // Franking marks and form revisions print numbers up there too. The letter
    // dates itself at the end of the letterhead run, closest to the salutation.
    const text = [
      "Muster Bauspar AG : Postfach 1307",
      "DV 04.23   0,85   Deutsche Post",
      "01.02.2020",
      "24.04.2023",
      "",
      "Sehr geehrte Frau Beispiel,",
    ].join("\n");
    expect(extractDocumentDate(text)).toBe("2023-04-24");
  });

  it("does not take the date of the letter being answered", () => {
    const text = [
      "Muster Bauspar AG",
      "Ihr Schreiben vom 12.03.2024",
      "",
      "Sehr geehrte Frau Beispiel,",
    ].join("\n");
    expect(extractDocumentDate(text)).toBeNull();
  });
});

describe("extractSender — the letterhead set across two lines", () => {
  it("prefers the fullest printing of the same name", () => {
    // The legal form lands on the second line, so the first candidate is the
    // tail of the name. Stored as-is it becomes the key the learned rules and
    // the correspondent folder are built on.
    const text = [
      "Muster Bauspar",
      "Bauspar AG",
      "",
      "Muster Bauspar AG : Postfach 1307",
      "12345 Musterstadt",
      "",
      "Sehr geehrte Frau Beispiel,",
    ].join("\n");
    expect(extractSender(text)).toBe("Muster Bauspar AG");
  });

  it("never swaps in a different organisation", () => {
    // A longer candidate wins only when it contains the first as a whole word.
    // Two unrelated names leave the first one standing.
    const text = [
      "Muster Bauspar AG",
      "Ein ganz anderes Beispielunternehmen GmbH",
      "",
      "Sehr geehrte Frau Beispiel,",
    ].join("\n");
    expect(extractSender(text)).toBe("Muster Bauspar AG");
  });

  it("reads a return address whose middle dot OCR turned into a colon", () => {
    // Without the colon in the separator class the tail stays attached, the
    // line then looks like "name, space, digits" — a street — and is dropped.
    const text = ["Muster Bauspar AG : Postfach 1307", "", "Sehr geehrte Frau Beispiel,"].join(
      "\n",
    );
    expect(extractSender(text)).toBe("Muster Bauspar AG");
  });
});

describe("normalizeDocumentDate — what the vision model read off the page", () => {
  // The model is told to copy the date exactly as printed, because
  // reformatting is where a small model quietly changes the day. So the
  // conversion happens here.
  it("reads the German numeric form", () => {
    expect(normalizeDocumentDate("24.04.2023")).toBe("2023-04-24");
  });

  it("reads it without leading zeros", () => {
    expect(normalizeDocumentDate("8.9.2017")).toBe("2017-09-08");
  });

  it("expands a two-digit year the same way every other route does", () => {
    expect(normalizeDocumentDate("11.08.14")).toBe("2014-08-11");
    expect(normalizeDocumentDate("31.12.98")).toBe("1998-12-31");
  });

  it("reads a written month", () => {
    expect(normalizeDocumentDate("8. September 2017")).toBe("2017-09-08");
  });

  it("accepts ISO from a model that reformatted anyway", () => {
    expect(normalizeDocumentDate("2023-04-24")).toBe("2023-04-24");
  });

  it("refuses an impossible date", () => {
    // Same validation every other route uses, so a misread digit contributes
    // nothing rather than a wrong day.
    expect(normalizeDocumentDate("31.02.2023")).toBeNull();
    expect(normalizeDocumentDate("24.13.2023")).toBeNull();
  });

  it("refuses a sentence", () => {
    expect(normalizeDocumentDate("kein Datum erkennbar")).toBeNull();
    expect(normalizeDocumentDate("")).toBeNull();
  });

  it("refuses a month name that is not one", () => {
    expect(normalizeDocumentDate("8. Beispielmonat 2017")).toBeNull();
  });
});

describe("inferDateConvention — which number is the day", () => {
  // The document's own numbers first, its language only after. Every value is
  // invented.
  it("reads a day above 12 as proof of day-first", () => {
    expect(inferDateConvention("Rechnungsdatum 25/12/2013")).toBe("dmy");
  });

  it("reads a second component above 12 as proof of month-first", () => {
    expect(inferDateConvention("Date of issue 12/25/2013")).toBe("mdy");
  });

  it("ignores a date that proves nothing", () => {
    // 03/04 is consistent with both readings and must not vote.
    expect(inferDateConvention("Datum 03/04/2013", "en")).toBe("mdy");
  });

  it("lets the document outvote its own language", () => {
    // The counter-example that rules out deciding on language alone: an
    // invoice written in English and dated the European way round.
    const invoice = "Invoice date 03/04/2013\nDue 25/12/2013\nThank you for your order.";
    expect(inferDateConvention(invoice, "en")).toBe("dmy");
  });

  it("falls back to the language when the numbers say nothing", () => {
    expect(inferDateConvention("Date 03/04/2013", "en")).toBe("mdy");
    expect(inferDateConvention("Datum 03/04/2013", "de")).toBe("dmy");
  });

  it("falls back to day-first with neither evidence", () => {
    // What this archive is full of.
    expect(inferDateConvention("Datum 03/04/2013")).toBe("dmy");
    expect(inferDateConvention("Datum 03/04/2013", null)).toBe("dmy");
  });

  it("does not let contradictory evidence pick a side", () => {
    // A mixed-format document or a misread digit: fall through rather than
    // trust a coin flip.
    expect(inferDateConvention("25/12/2013 and 12/25/2013", "en")).toBe("mdy");
    expect(inferDateConvention("25/12/2013 and 12/25/2013", "de")).toBe("dmy");
  });

  it("is not confused by dotted dates, which are never month-first", () => {
    expect(inferDateConvention("Rechnungsdatum 03.04.2013", "en")).toBe("mdy");
  });
});

describe("normalizeDocumentDate — English forms and the ambiguous one", () => {
  it("reads a month-first written date", () => {
    expect(normalizeDocumentDate("August 23, 2026")).toBe("2026-08-23");
    expect(normalizeDocumentDate("May 12, 2013")).toBe("2013-05-12");
  });

  it("reads an ordinal suffix", () => {
    expect(normalizeDocumentDate("August 23rd, 2026")).toBe("2026-08-23");
  });

  it("reads the hyphenated day-month form", () => {
    expect(normalizeDocumentDate("12-MAY-2013")).toBe("2013-05-12");
  });

  it("reads a dotted date day-first whatever the convention says", () => {
    // Nobody writes an American date with dots, so the convention must not be
    // able to reinterpret the format this archive is full of.
    expect(normalizeDocumentDate("03.04.2013", "mdy")).toBe("2013-04-03");
  });

  it("lets the convention decide a slash date, and only that", () => {
    expect(normalizeDocumentDate("03/04/2013", "dmy")).toBe("2013-04-03");
    expect(normalizeDocumentDate("03/04/2013", "mdy")).toBe("2013-03-04");
  });

  it("still refuses an impossible date under either convention", () => {
    expect(normalizeDocumentDate("25/12/2013", "mdy")).toBeNull();
    expect(normalizeDocumentDate("31/02/2013", "dmy")).toBeNull();
  });

  it("refuses an English month that is not one", () => {
    expect(normalizeDocumentDate("Smarch 23, 2026")).toBeNull();
  });
});

describe("normalizeDocumentDate — a letterhead that names only a month", () => {
  // The reported failure: the model read "Oktober 2012" off the page, the
  // anchor confirmed it, and the conversion returned null — so a document
  // whose date was found still ended up without one. The text scan has always
  // resolved this shape to the first of the month, which made the two readers
  // disagree about the same printed date for no defensible reason.
  it("resolves a month and year to the first of that month", () => {
    expect(normalizeDocumentDate("Oktober 2012")).toBe("2012-10-01");
    expect(normalizeDocumentDate("Juli 2024")).toBe("2024-07-01");
  });

  it("accepts the German letterhead phrasing", () => {
    // "Im Oktober 2012" is what is printed, and the model was told to copy
    // what is printed.
    expect(normalizeDocumentDate("Im Oktober 2012")).toBe("2012-10-01");
    expect(normalizeDocumentDate("im Oktober 2012")).toBe("2012-10-01");
  });

  it("accepts an English month", () => {
    expect(normalizeDocumentDate("October 2012")).toBe("2012-10-01");
  });

  it("accepts a numeric month and a four-digit year", () => {
    // No convention needed: a four-digit second component cannot be a day.
    expect(normalizeDocumentDate("10/2012")).toBe("2012-10-01");
  });

  it("reads a month name carrying an umlaut", () => {
    // The month-first pattern was ASCII-only, so every German month with an
    // umlaut failed in that position.
    expect(normalizeDocumentDate("März 2020")).toBe("2020-03-01");
    expect(normalizeDocumentDate("März 8, 2020")).toBe("2020-03-08");
  });

  it("refuses a word that is not a month", () => {
    expect(normalizeDocumentDate("Rechnung 2012")).toBeNull();
    expect(normalizeDocumentDate("Sehr geehrte")).toBeNull();
  });
});

describe("normalizeDocumentDate — a letter that names its place first", () => {
  // "Ort, Datum" is the letterhead convention across most of Europe, and the
  // model returns the place because it was told to copy what is printed. The
  // text scan has always read this shape; the vision path never could — not
  // even for the German form it has an anchored pattern for.
  it("reads the German letterhead form", () => {
    expect(normalizeDocumentDate("München, 05.03.2022")).toBe("2022-03-05");
    expect(normalizeDocumentDate("Musterstadt, den 8. September 2017")).toBe("2017-09-08");
  });

  it("reads a slash date after a place, with or without a space", () => {
    expect(normalizeDocumentDate("Caorle,03/09/2016", "dmy")).toBe("2016-09-03");
    expect(normalizeDocumentDate("Caorle, 03/09/2016", "dmy")).toBe("2016-09-03");
  });

  it("still lets the convention decide the order", () => {
    // Stripping the place must not settle a question the place cannot answer:
    // the document's own numbers and its language do that.
    expect(normalizeDocumentDate("Caorle,03/09/2016", "mdy")).toBe("2016-03-09");
  });

  it("reads a place before a month with no day", () => {
    expect(normalizeDocumentDate("Musterstadt, im Oktober 2012")).toBe("2012-10-01");
  });

  it("refuses a prefix carrying a number", () => {
    // A prefix with a digit is a reference, an address or a table row, not a
    // place. Dropping it would be a guess.
    expect(normalizeDocumentDate("Rechnung 5, 03/09/2016", "dmy")).toBeNull();
  });

  it("keeps isMonthOnlyReading reading the same string", () => {
    // The two must agree about what they are looking at, or a place-prefixed
    // month resolves to an assumed first while the guard sees a stated day —
    // and stops protecting the precise scan date it exists for.
    expect(isMonthOnlyReading("Musterstadt, im Oktober 2012")).toBe(true);
    expect(isMonthOnlyReading("München, 05.03.2022")).toBe(false);
  });
});

describe("extractDocumentDate — the place-prefixed slash letterhead", () => {
  it("reads it, the way the dotted form has always been read", () => {
    const letter = "Caorle, 03/09/2016\n\nSpett.le cliente,";
    expect(extractDocumentDate(letter, "dmy")).toBe("2016-09-03");
    expect(extractDocumentDate(letter, "mdy")).toBe("2016-03-09");
  });
});

describe("isMonthOnlyReading — was the day stated, or assumed", () => {
  // 2012-10-01 cannot be told from a genuine first once it is an ISO string,
  // so the question has to be asked of the raw reading.
  it("recognises the shapes that name no day", () => {
    expect(isMonthOnlyReading("Oktober 2012")).toBe(true);
    expect(isMonthOnlyReading("Im Oktober 2012")).toBe(true);
    expect(isMonthOnlyReading("10/2012")).toBe(true);
  });

  it("does not fire on a reading that states one", () => {
    expect(isMonthOnlyReading("8. März 2020")).toBe(false);
    expect(isMonthOnlyReading("24.04.2023")).toBe(false);
    expect(isMonthOnlyReading("August 23, 2026")).toBe(false);
    expect(isMonthOnlyReading("01.10.2012")).toBe(false);
  });
});

describe("extractDocumentDate — English documents", () => {
  it("reads a labelled month-first date", () => {
    expect(extractDocumentDate("Date of issue   August 23, 2026\n\nDear Sir,")).toBe(
      "2026-08-23",
    );
  });

  it("reads the hyphenated form without needing a label", () => {
    expect(extractDocumentDate("12-MAY-2013 (Entered Date)\n\nDear Sir,")).toBe("2013-05-12");
  });

  it("reads a labelled slash date the caller's way round", () => {
    const text = "Invoice date 03/04/2013\n\nDear Sir,";
    expect(extractDocumentDate(text, "mdy")).toBe("2013-03-04");
    expect(extractDocumentDate(text, "dmy")).toBe("2013-04-03");
  });

  it("does not read an unlabelled slash date at all", () => {
    // The shape where a wrong guess is silent, so it is only ever taken next
    // to a label. A reference or a period must not become a date.
    expect(extractDocumentDate("Ref 03/04/2013\n\nDear Sir,")).toBeNull();
  });

  it("never takes an English date of birth or due date", () => {
    expect(extractDocumentDate("Date of birth   August 23, 1970\n\nDear Sir,")).toBeNull();
    expect(extractDocumentDate("Due date   August 23, 2026\n\nDear Sir,")).toBeNull();
  });

  it("recognises an English salutation as the end of the letterhead", () => {
    // Without one there is no letterhead region and the bare-date rules never
    // run — the same failure the German salutation fix addresses.
    expect(extractDocumentDate("Muster Ltd\n\n23 August 2026\n\nDear Ms Beispiel,")).toBe(
      "2026-08-23",
    );
  });
});

describe("extractDocumentDate — the three findings from a real letter", () => {
  // All values invented; the shapes are what a scanned German insurance letter
  // actually produced.
  it("keeps the day of an unlabelled written-month letterhead date", () => {
    // The month-year rule matched the "Oktober 2023" inside it and defaulted
    // the day to the 1st. Eight days wrong looks right, which is worse than
    // empty.
    expect(extractDocumentDate("Muster AG\n\n09. Oktober 2023\n\nSehr geehrter Herr X,")).toBe(
      "2023-10-09",
    );
  });

  it("does not take the date something starts applying from", () => {
    // A subject line with no "Betreff:" in front of it, so the subject-line
    // guard cannot see it. The letter is dated October and announces a change
    // for January.
    const letter = [
      "Muster AG",
      "y   Änderung des Beitrags ab dem 1. Januar 2024",
      "09. Oktober 2023",
      "",
      "Sehr geehrter Herr X,",
    ].join("\n");
    expect(extractDocumentDate(letter)).toBe("2023-10-09");
  });

  it("finds the salutation even when OCR ran a reference number into it", () => {
    // Anchored on start-of-line this is not a salutation, the letter has no
    // letterhead, and every position rule silently stops applying.
    const letter = [
      "Muster AG",
      "09. Oktober 2023",
      "7933150000013509   Sehr geehrter Herr X,",
    ].join("\n");
    expect(extractDocumentDate(letter)).toBe("2023-10-09");
  });
});

describe("extractDocumentDate — a document that addresses nobody", () => {
  // A circular, a statement or a contribution notice dates itself at the top
  // and greets no one. The whole letterhead notion was tied to a salutation,
  // so for those the bare-date rules never ran at all.
  // A realistic shape: a sender block and an address, then the dating. A
  // three-line fragment has no "top" to speak of and is deliberately excluded
  // — see LETTERHEAD_MIN_LINES.
  const notice = (top: string) =>
    [
      "Muster Versicherung AG",
      "Beispielstraße 1",
      "12345 Musterstadt",
      "",
      "Frau",
      "Erika Beispiel",
      "Beispielweg 10a",
      "12345 Musterstadt",
      "",
      top,
      "",
      "Unsere Leistungen im Überblick",
    ].join("\n");

  it("dates itself from an unlabelled month and year", () => {
    expect(extractDocumentDate(notice("Im Januar 2020"))).toBe("2020-01-01");
  });

  it("does the same with a full date", () => {
    expect(extractDocumentDate(notice("24.04.2023"))).toBe("2023-04-24");
  });

  it("still refuses a month the document only mentions", () => {
    // The guard that makes the relaxation safe: a month named as the start of
    // something is not the document's own date.
    expect(extractDocumentDate(notice("Mitglied seit Januar 2020"))).toBeNull();
    expect(extractDocumentDate(notice("gültig ab Januar 2020"))).toBeNull();
  });

  it("does not reach a month named further down", () => {
    // Bounded by LETTERHEAD_MAX_LINES, so a date in a contract's body cannot
    // become the document's date just because nobody was greeted.
    const long = "Muster AG\n" + "Zeile\n".repeat(30) + "Im Januar 2020\n";
    expect(extractDocumentDate(long)).toBeNull();
  });

  it("never outranks a labelled date", () => {
    const both = notice("Im Januar 2020").replace(
      "Muster Versicherung AG",
      "Muster Versicherung AG\nRechnungsdatum 05.03.2021",
    );
    expect(extractDocumentDate(both)).toBe("2021-03-05");
  });

  it("leaves a letter with a salutation deciding exactly as before", () => {
    // The salutation stays the boundary wherever there is one.
    expect(extractDocumentDate("Muster AG\n\nIm Januar 2020\n\nSehr geehrte Damen,")).toBe(
      "2020-01-01",
    );
    expect(
      extractDocumentDate("Muster AG\n\nSehr geehrte Damen,\n\nIm Januar 2020 ändert sich"),
    ).toBeNull();
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
