/**
 * Money values on tax evidence (documentation/plans/steuer-ausfuellhilfe.md).
 *
 * The model reads a value off a document and quotes it as printed; this
 * module turns the printed text into cents and checks that the number
 * really stands in the document. A value the text does not carry is never
 * taken, however plausible — the same anchoring the depot statements use.
 */

/** Cents from a German-printed amount: "48.200,00", "1 234,5", "-12,30 €", "1.234". */
export function parseGermanAmountCents(printed: string): number | null {
  let s = printed.replace(/\s*(?:€|EUR|Euro)\s*/gi, "").trim();
  let sign = 1;
  if (/^[-−–]/.test(s)) {
    sign = -1;
    s = s.slice(1).trim();
  } else if (/[-−–]$/.test(s)) {
    // Bank statements print "12,30-" for a debit.
    sign = -1;
    s = s.slice(0, -1).trim();
  }
  if (!/^\d[\d. \u00a0]*(?:,\d{1,2})?$/.test(s)) return null;
  const [whole, fraction = ""] = s.split(",");
  const digits = whole!.replace(/[. \u00a0]/g, "");
  // A dot or space only groups thousands: "1.23" is not 1,23.
  if (/[. \u00a0]/.test(whole!) && !/^\d{1,3}(?:[. \u00a0]\d{3})+$/.test(whole!)) return null;
  const cents = Number(digits) * 100 + Number(fraction.padEnd(2, "0") || "0");
  return Number.isSafeInteger(cents) ? sign * cents : null;
}

/** The ways one amount can be printed: "48.200,00", "48200,00", "48 200,00". */
function printedForms(cents: number): string[] {
  const abs = Math.abs(cents);
  const euros = Math.floor(abs / 100);
  const fraction = String(abs % 100).padStart(2, "0");
  const plain = String(euros);
  const grouped = plain.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  const spaced = plain.replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  const forms = new Set([`${grouped},${fraction}`, `${plain},${fraction}`, `${spaced},${fraction}`]);
  // Whole amounts are often printed without cents ("1.000 €").
  if (abs % 100 === 0) {
    forms.add(grouped);
    forms.add(plain);
  }
  return [...forms];
}

/**
 * True when `cents` stands in `text` as a number of its own — not as the
 * tail of a longer one ("200,00" inside "48.200,00") and not as the head of
 * one ("48" inside "48.200,00").
 */
export function amountAnchored(text: string, cents: number): boolean {
  const flat = text.replace(/\u00a0/g, " ");
  return printedForms(cents).some((form) => {
    const escaped = form.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s");
    return new RegExp(`(?<![\\d.,])${escaped}(?![\\d]|[.,]\\d)`).test(flat);
  });
}
