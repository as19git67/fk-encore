/**
 * Money values on tax evidence (documentation/plans/steuer-ausfuellhilfe.md).
 *
 * The model reads a value off a document and quotes it as printed; this
 * module turns the printed text into cents and checks that the number
 * really stands in the document. A value the text does not carry is never
 * taken, however plausible — the same anchoring the depot statements use.
 */

/**
 * Cents from a German-printed amount: "48.200,00", "1 234,5", "-12,30 €",
 * "1.234", and "48.200 78" with the cents from a Cent column of their own.
 */
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
  // A Cent column: "48.200 78". Two digits after a space never group thousands.
  const split = /^(\d[\d.]*)[ \u00a0]+(\d{2})$/.exec(s);
  if (split) s = `${split[1]},${split[2]}`;
  if (!/^\d[\d. \u00a0]*(?:,\d{1,2})?$/.test(s)) return null;
  const [whole, fraction = ""] = s.split(",");
  const digits = whole!.replace(/[. \u00a0]/g, "");
  // A dot or space only groups thousands: "1.23" is not 1,23.
  if (/[. \u00a0]/.test(whole!) && !/^\d{1,3}(?:[. \u00a0]\d{3})+$/.test(whole!)) return null;
  const cents = Number(digits) * 100 + Number(fraction.padEnd(2, "0") || "0");
  return Number.isSafeInteger(cents) ? sign * cents : null;
}

/**
 * The ways one amount can be printed: "48.200,00", "48200,00", "48 200,00",
 * and with the cents in a column of their own, "48.200 00" (the printout of
 * the elektronische Lohnsteuerbescheinigung has a Euro and a Cent column).
 */
function printedForms(cents: number): string[] {
  const abs = Math.abs(cents);
  const euros = Math.floor(abs / 100);
  const fraction = String(abs % 100).padStart(2, "0");
  const plain = String(euros);
  const grouped = plain.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  const spaced = plain.replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  const forms = new Set([
    `${grouped},${fraction}`, `${plain},${fraction}`, `${spaced},${fraction}`,
    `${grouped} ${fraction}`, `${plain} ${fraction}`,
  ]);
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
    const escaped = form.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s+");
    return new RegExp(`(?<![\\d.,])${escaped}(?![\\d]|[.,]\\d)`).test(flat);
  });
}

/**
 * The cents a whole-euro reading left behind in a Cent column: "48.200 78"
 * read as "48.200" gives 78. Null when the amount stands without such a
 * column. A line number that follows ("12.") is not a Cent column, nor is
 * a rate ("19 %").
 */
export function centsColumnAfter(text: string, cents: number): number | null {
  const abs = Math.abs(cents);
  if (abs % 100 !== 0) return null;
  const plain = String(abs / 100);
  const grouped = plain.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  const flat = text.replace(/\u00a0/g, " ");
  for (const form of new Set([grouped, plain])) {
    const escaped = form.replace(/\./g, "\\.");
    const m = new RegExp(`(?<![\\d.,])${escaped}\\s+(\\d{2})(?![\\d.,%])`).exec(flat);
    if (m) return Number(m[1]);
  }
  return null;
}
