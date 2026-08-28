import { afterEach, beforeEach, describe, it, expect } from "vitest";
import {
  alignPaddleLine,
  applySpanToRow,
  bestOcrCandidate,
  compareReadings,
  decideSpan,
  editDistance,
  expectedTypeFor,
  formatResolverTally,
  newResolverTally,
  overlapRatio,
  paddleConfirms,
  paddleReadingFor,
  shouldAskForFieldAssignment,
  tallyDecisions,
  validateFieldAssignment,
  validateVlmAnswer,
  type Candidate,
} from "./ocr-resolver";
import type { OcrWord } from "./ocr-layout";
import type { UncertaintyReason } from "./ocr-uncertainty";

const SPAN = { left: 100, top: 500, right: 230, bottom: 520 };

function line(text: string, box = SPAN, confidence = 0.9) {
  return { text, confidence, ...box };
}

function candidates(...pairs: Array<[Candidate["source"], string, number]>): Candidate[] {
  return pairs.map(([source, text, confidence]) => ({ source, text, confidence }));
}

describe("overlapRatio", () => {
  it("is the covered fraction of the span, not of the line", () => {
    // A Paddle line is normally much wider than the span it contains, so
    // measuring against the line's area would reject every real match.
    const wideLine = { left: 0, top: 495, right: 2000, bottom: 525 };
    expect(overlapRatio(SPAN, wideLine)).toBe(1);
  });

  it("is zero for boxes that do not touch", () => {
    expect(overlapRatio(SPAN, { left: 900, top: 500, right: 1000, bottom: 520 })).toBe(0);
  });
});

describe("alignPaddleLine", () => {
  it("picks the line that covers the span", () => {
    const lines = [
      line("Postanschrift", { left: 900, top: 500, right: 1200, bottom: 520 }),
      line("Rechnungsdatum 23 AUG 02", { left: 0, top: 495, right: 400, bottom: 525 }),
    ];
    expect(alignPaddleLine(SPAN, lines)?.text).toBe("Rechnungsdatum 23 AUG 02");
  });

  it("returns null when nothing covers the span", () => {
    // Paddle detecting nothing there is not the same as Paddle agreeing.
    expect(alignPaddleLine(SPAN, [line("x", { left: 900, top: 0, right: 950, bottom: 20 })])).toBe(
      null,
    );
  });
});

describe("compareReadings", () => {
  it("treats shape confusions as agreement", () => {
    expect(compareReadings("23 AUG 02", "23 AUC 02")).toBe("folded");
  });

  it("does not treat different amounts as agreement", () => {
    // The single most important assertion in this file: if this ever returns
    // anything but "differ", the resolver silently accepts a rewritten amount.
    expect(compareReadings("7.500", "7.800")).toBe("differ");
  });

  it("ignores whitespace differences", () => {
    expect(compareReadings("23  AUG 02", "23 AUG 02")).toBe("exact");
  });
});

describe("paddleConfirms", () => {
  it("finds the span's reading inside a longer line", () => {
    expect(paddleConfirms("23 AUG 02", line("Rechnungsdatum 23 AUG 02"))).toBe("folded");
  });

  it("reports disagreement when the line says something else", () => {
    expect(paddleConfirms("23 aus oz", line("Rechnungsdatum 23 AUG 02"))).toBe("differ");
  });
});

describe("paddleReadingFor", () => {
  it("cuts the span's share out of a longer line", () => {
    const wide = line("Rechnungsdatum 23 AUG 02", { left: 0, top: 495, right: 400, bottom: 525 });
    expect(paddleReadingFor({ ...SPAN, left: 220, right: 400 }, wide)).toContain("02");
  });

  it("falls back to the whole line when the cut comes out empty", () => {
    expect(paddleReadingFor(SPAN, line("x"))).toBe("x");
  });
});

describe("editDistance", () => {
  it("counts substitutions, insertions and deletions", () => {
    expect(editDistance("23 aus oz", "23 aug 02")).toBe(3);
    expect(editDistance("", "abc")).toBe(3);
    expect(editDistance("same", "same")).toBe(0);
  });
});

describe("validateVlmAnswer", () => {
  const weak: UncertaintyReason[] = ["low_confidence"];

  it("accepts a plausible correction of a weakly read date", () => {
    const verdict = validateVlmAnswer("23 AUG 02", candidates(["tesseract", "23 aus oz", 0.4]), weak, "date");
    expect(verdict.ok).toBe(true);
  });

  it("rejects an empty answer", () => {
    expect(validateVlmAnswer("  ", candidates(["tesseract", "23 aus oz", 0.4]), weak).ok).toBe(false);
  });

  it("rejects prose about the image", () => {
    const verdict = validateVlmAnswer(
      "The image appears to show a date printed in a small font.",
      candidates(["tesseract", "23 aus oz", 0.4]),
      weak,
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/length ratio|describes the image/);
  });

  it("rejects an answer that rewrites more than half the characters", () => {
    const verdict = validateVlmAnswer(
      "Rechnungsdatum",
      candidates(["tesseract", "23 aus oz", 0.4]),
      weak,
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/edit distance/);
  });

  it("rejects characters that cannot occur in the expected type", () => {
    const verdict = validateVlmAnswer(
      "etwa 7500",
      candidates(["tesseract", "7.5O0", 0.5]),
      weak,
      "amount",
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/charset/);
  });

  it("refuses a third reading when the only defect was engine disagreement", () => {
    // Neither engine was unsure — they simply read differently. The model is
    // arbitrating between two candidates, not resolving a weak glyph, so a
    // brand-new value is out of scope and would be unverifiable.
    const verdict = validateVlmAnswer(
      "7.300",
      candidates(["tesseract", "7.500", 0.95], ["paddleocr", "7.800", 0.93]),
      ["engine_disagreement"],
      "amount",
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/third reading/);
  });

  it("allows the model to pick one of the two engines' readings", () => {
    const verdict = validateVlmAnswer(
      "7.500",
      candidates(["tesseract", "7.500", 0.95], ["paddleocr", "7.800", 0.93]),
      ["engine_disagreement"],
      "amount",
    );
    expect(verdict.ok).toBe(true);
  });

  it("allows a new reading when OCR itself flagged the span as weak", () => {
    const verdict = validateVlmAnswer(
      "7.300",
      candidates(["tesseract", "7.500", 0.31], ["paddleocr", "7.800", 0.28]),
      ["low_confidence", "engine_disagreement"],
      "amount",
    );
    expect(verdict.ok).toBe(true);
  });
});

describe("bestOcrCandidate", () => {
  it("never returns the model's own answer as the fallback", () => {
    const best = bestOcrCandidate(
      candidates(["tesseract", "23 aus oz", 0.4], ["vlm", "23 AUG 02", 0.99]),
    );
    expect(best?.source).toBe("tesseract");
  });

  it("is null when there is no OCR reading at all", () => {
    expect(bestOcrCandidate(candidates(["vlm", "x", 0.9]))).toBe(null);
  });
});

describe("decideSpan", () => {
  const span = { bbox: SPAN, reasons: ["low_confidence"] as UncertaintyReason[], text: "23 aus oz" };

  it("takes an engine agreement without consulting the model", () => {
    const result = decideSpan(
      { ...span, text: "23 AUC 02" },
      candidates(["tesseract", "23 AUC 02", 0.6], ["paddleocr", "23 AUG 02", 0.94]),
      { vlm: { text: "something else entirely", confidence: 0.99 } },
    );
    expect(result.decision).toBe("ocr_agreement");
    expect(result.final_text).toBe("23 AUG 02");
  });

  it("takes a validated model answer when the engines differ", () => {
    const result = decideSpan(span, candidates(["tesseract", "23 aus oz", 0.4]), {
      vlm: { text: "23 AUG 02", confidence: 0.94 },
      expectedType: "date",
    });
    expect(result.decision).toBe("vlm_accepted");
    expect(result.final_text).toBe("23 AUG 02");
  });

  it("keeps the OCR reading when the model answer fails validation", () => {
    const result = decideSpan(span, candidates(["tesseract", "23 aus oz", 0.4]), {
      vlm: { text: "I can see a date in this image", confidence: 0.99 },
    });
    expect(result.decision).toBe("vlm_rejected");
    expect(result.final_text).toBe("23 aus oz");
    expect(result.rejection).toBeTruthy();
  });

  it("keeps the best OCR reading when no model answered", () => {
    const result = decideSpan(
      span,
      candidates(["tesseract", "23 aus oz", 0.4], ["paddleocr", "23 AUG 02", 0.94]),
    );
    expect(result.decision).toBe("ocr_kept");
    expect(result.final_text).toBe("23 AUG 02");
  });

  it("records every candidate it saw, whatever it decided", () => {
    // The debug artifact is what makes a bad decision diagnosable after the
    // fact; a decision that discards its inputs cannot be reviewed.
    const result = decideSpan(span, candidates(["tesseract", "23 aus oz", 0.4]), {
      vlm: { text: "23 AUG 02", confidence: 0.94 },
    });
    expect(result.candidates.map((c) => c.source)).toContain("tesseract");
    expect(result.reasons).toEqual(["low_confidence"]);
  });
});

describe("applySpanToRow", () => {
  function word(text: string, left: number, right: number): OcrWord {
    return { text, left, top: 500, right, bottom: 520, confidence: 40 };
  }

  it("replaces the span's words with the corrected reading, keeping the row", () => {
    const row = [
      word("Rechnungsdatum", 10, 90),
      word("23", 100, 130),
      word("aus", 140, 180),
      word("oz", 190, 230),
    ];
    const out = applySpanToRow(row, SPAN, "23 AUG 02");
    expect(out.map((w) => w.text)).toEqual(["Rechnungsdatum", "23 AUG 02"]);
    expect(out[1]).toMatchObject({ left: 100, right: 230 });
  });

  it("leaves a row the span does not touch alone", () => {
    const row = [word("Postanschrift", 900, 1100)];
    expect(applySpanToRow(row, SPAN, "23 AUG 02")).toEqual(row);
  });

  it("drops the stale confidence from the replaced word", () => {
    // Carrying the old 40 forward would make the resolved span look suspect
    // again on any later pass over the same words.
    const out = applySpanToRow([word("aus", 100, 230)], SPAN, "AUG");
    expect(out[0].confidence).toBeUndefined();
  });
});

describe("expectedTypeFor", () => {
  it("names the shape a damaged span nearly matched", () => {
    expect(expectedTypeFor("23 aus 02")).toBe("date");
    expect(expectedTypeFor("7.5O0")).toBe("amount");
  });

  it("falls back to free text", () => {
    expect(expectedTypeFor("Sehr geehrte Damen")).toBe("text");
  });
});

describe("shouldAskForFieldAssignment", () => {
  const label = (name: string, type: "date" | "amount" = "date") => ({
    label: name,
    labelBox: { left: 0, top: 0, right: 10, bottom: 10 },
    expectedType: type as "date" | "amount",
  });
  const pair = () =>
    ({
      label: "x",
      labelBox: SPAN,
      valueWords: [],
      valueText: "v",
      valueBox: SPAN,
      pairing: "same_row" as const,
      expectedType: "text" as const,
    });

  const base = {
    pairs: [] as any[],
    unpaired: [label("Rechnungsdatum"), label("Betrag", "amount")],
    hasUnresolvedSpan: true,
    pagesUsed: 0,
  };

  beforeEach(() => {
    process.env.DOCUMENTS_OCR_VLM = "1";
  });
  afterEach(() => {
    delete process.env.DOCUMENTS_OCR_VLM;
  });

  it("asks when several labels found no value and something is in doubt", () => {
    expect(shouldAskForFieldAssignment(base).ask).toBe(true);
  });

  it("does not ask when nothing on the page is in doubt", () => {
    // The precondition that keeps a whole page off clean documents: a better
    // pairing buys nothing where the text is already right.
    const decision = shouldAskForFieldAssignment({ ...base, hasUnresolvedSpan: false });
    expect(decision.ask).toBe(false);
    expect(decision.reason).toMatch(/in doubt/);
  });

  it("does not ask over a single unpaired label", () => {
    // One is usually a false positive — a `vom` inside prose, an empty column.
    const decision = shouldAskForFieldAssignment({ ...base, unpaired: [label("vom")] });
    expect(decision.ask).toBe(false);
    expect(decision.reason).toMatch(/1 unpaired/);
  });

  it("does not ask when most labels did pair", () => {
    // Two failures out of twelve labels is one field slipping, not a layout
    // the geometry cannot read.
    const decision = shouldAskForFieldAssignment({
      ...base,
      pairs: Array.from({ length: 10 }, pair),
    });
    expect(decision.ask).toBe(false);
    expect(decision.reason).toMatch(/% of labels unpaired/);
  });

  it("respects the per-document page budget", () => {
    expect(shouldAskForFieldAssignment({ ...base, pagesUsed: 1 }).ask).toBe(false);
  });

  it("never asks while the vlm stage is off", () => {
    process.env.DOCUMENTS_OCR_VLM = "0";
    expect(shouldAskForFieldAssignment(base).ask).toBe(false);
  });
});

describe("validateFieldAssignment", () => {
  function row(...words: Array<[string, number]>) {
    return words.map(([text, left]) => ({
      text,
      left,
      top: 100,
      right: left + 40 * text.length,
      bottom: 120,
      confidence: 90,
    }));
  }

  const unpaired = [
    {
      label: "Rechnungsdatum",
      labelBox: { left: 0, top: 0, right: 10, bottom: 10 },
      expectedType: "date" as const,
    },
  ];

  it("accepts a value that is printed on the page and recovers its box", () => {
    const rows = [row(["Rechnungsdatum", 100]), row(["23.08.2002", 900])];
    const result = validateFieldAssignment(
      [{ label: "Rechnungsdatum", value: "23.08.2002" }],
      rows,
      unpaired,
    );

    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0].bbox.left).toBe(900);
    expect(result.accepted[0].expectedType).toBe("date");
  });

  it("refuses a value that appears nowhere on the page", () => {
    // The safety property of handing over a whole page: the model may
    // rearrange what OCR read, never add to it. A plausible invented date is
    // exactly the answer this has to stop.
    const rows = [row(["Rechnungsdatum", 100]), row(["23.08.2002", 900])];
    const result = validateFieldAssignment(
      [{ label: "Rechnungsdatum", value: "01.01.2020" }],
      rows,
      unpaired,
    );

    expect(result.accepted).toEqual([]);
    expect(result.rejected[0].reason).toMatch(/not printed/);
  });

  it("keeps the page's own reading rather than the model's rendering of it", () => {
    // The call decides assignment, not transcription. Taking the model's
    // string here would smuggle a transcription in through the back door.
    const rows = [row(["23.O8.2002", 900])];
    const result = validateFieldAssignment(
      [{ label: "Rechnungsdatum", value: "23.08.2002" }],
      rows,
      unpaired,
    );

    expect(result.accepted[0].value).toBe("23.O8.2002");
  });

  it("refuses a label that was not among the unpaired ones", () => {
    const rows = [row(["23.08.2002", 900])];
    const result = validateFieldAssignment(
      [{ label: "Geburtsdatum", value: "23.08.2002" }],
      rows,
      unpaired,
    );
    expect(result.accepted).toEqual([]);
    expect(result.rejected[0].reason).toMatch(/not one of the unpaired/);
  });

  it("assigns each label at most once", () => {
    const rows = [row(["23.08.2002", 900]), row(["24.08.2002", 900])];
    const result = validateFieldAssignment(
      [
        { label: "Rechnungsdatum", value: "23.08.2002" },
        { label: "Rechnungsdatum", value: "24.08.2002" },
      ],
      rows,
      unpaired,
    );
    expect(result.accepted).toHaveLength(1);
    expect(result.rejected[0].reason).toMatch(/already assigned/);
  });
});

describe("tallyDecisions", () => {
  function resolved(
    decision: "ocr_agreement" | "vlm_accepted" | "vlm_rejected" | "ocr_kept",
    sources: Array<"tesseract" | "paddleocr" | "vlm">,
  ) {
    return {
      bbox: SPAN,
      reasons: [] as UncertaintyReason[],
      candidates: sources.map((source) => ({ source, text: "x", confidence: 0.5 })),
      final_text: "x",
      decision,
    };
  }

  it("splits ocr_kept by whether a second reading existed at all", () => {
    // The distinction the first production run could not make: 132 spans
    // reported as "ocr kept" said nothing about whether PaddleOCR disagreed or
    // simply had nothing to offer — opposite conclusions from one number.
    const tally = tallyDecisions([
      resolved("ocr_kept", ["tesseract", "paddleocr"]),
      resolved("ocr_kept", ["tesseract"]),
      resolved("ocr_kept", ["tesseract"]),
    ]);

    expect(tally.keptDisagreement).toBe(1);
    expect(tally.keptNoSecondReading).toBe(2);
  });

  it("counts the other decisions without touching the split", () => {
    const tally = tallyDecisions([
      resolved("ocr_agreement", ["tesseract", "paddleocr"]),
      resolved("vlm_accepted", ["tesseract", "vlm"]),
      resolved("vlm_rejected", ["tesseract", "vlm"]),
    ]);

    expect(tally).toMatchObject({
      spans: 3,
      agreement: 1,
      vlmAccepted: 1,
      vlmRejected: 1,
      keptDisagreement: 0,
      keptNoSecondReading: 0,
    });
  });

  it("accumulates across pages", () => {
    // One tally per document, fed a page at a time.
    const tally = newResolverTally();
    tallyDecisions([resolved("ocr_agreement", ["tesseract", "paddleocr"])], tally);
    tallyDecisions([resolved("ocr_kept", ["tesseract"])], tally);

    expect(tally.spans).toBe(2);
    expect(tally.agreement).toBe(1);
    expect(tally.keptNoSecondReading).toBe(1);
  });

  it("renders both figures in the summary line", () => {
    const line = formatResolverTally(
      tallyDecisions([
        resolved("ocr_agreement", ["tesseract", "paddleocr"]),
        resolved("ocr_kept", ["tesseract", "paddleocr"]),
        resolved("ocr_kept", ["tesseract"]),
      ]),
    );
    expect(line).toBe(
      "resolver: 3 span(s) — 1 engine agreement, 0 vlm accepted, 0 vlm rejected, " +
        "2 ocr kept (1 engine disagreement, 1 no second reading)",
    );
  });
});
