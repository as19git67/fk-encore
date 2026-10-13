/**
 * ISIN helpers without any imports (ISO 6166 check digit, OCR repair).
 *
 * A leaf module on purpose: the securities master, the document reader and
 * the derivation all need them, and the derivation imports the master. Had
 * the master imported them from the derivation, the two modules would
 * import each other — and since both import the database module, which
 * awaits at the top level, the bundled app waits on itself forever at boot.
 */

/** ISO 6166 check digit: letters to numbers (A=10 … Z=35), then Luhn over the digits. */
export function isinChecksumValid(isin: string): boolean {
  if (!/^[A-Z]{2}[A-Z0-9]{9}\d$/.test(isin)) return false;
  const digits = isin
    .split("")
    .map((c) => (/\d/.test(c) ? c : String(c.charCodeAt(0) - 55)))
    .join("");
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = Number(digits[i]);
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/** Letters OCR reads where an ISIN has a digit. */
const DIGIT_FOR: Record<string, string> = { O: "0", I: "1" };

/**
 * An ISIN as OCR read it, repaired. ISINs rarely use the letters O and I
 * after the country code, while OCR often reads a 0 or 1 as one ("DEOOO…"
 * for "DE000…" — read so by the rules and by a model copying the text
 * alike). So:
 *
 *   1. every O and I after the country code read as 0 and 1: taken when
 *      its check digit holds — even when the reading as printed passes
 *      too, which an O does by chance about one time in ten;
 *   2. otherwise the reading as printed, when its check digit holds;
 *   3. otherwise the one partial replacement whose check digit holds.
 *
 * Several or none: no guess, the reading stays as it is.
 */
export function repairIsin(raw: string): string {
  const isin = raw.toUpperCase();
  if (!/^[A-Z]{2}[A-Z0-9]{10}$/.test(isin)) return isin;
  const chars = isin.split("");
  const positions: number[] = [];
  for (let i = 2; i < 12; i++) if (DIGIT_FOR[chars[i]!] !== undefined) positions.push(i);
  if (positions.length === 0) return isin;
  const swapped = (mask: number) => {
    const v = [...chars];
    positions.forEach((p, k) => {
      if (mask & (1 << k)) v[p] = DIGIT_FOR[v[p]!]!;
    });
    return v.join("");
  };
  const all = swapped((1 << positions.length) - 1);
  if (isinChecksumValid(all)) return all;
  if (isinChecksumValid(isin)) return isin;
  const valid = new Set<string>();
  for (let mask = 1; mask < (1 << positions.length) - 1; mask++) {
    const candidate = swapped(mask);
    if (/\d$/.test(candidate) && isinChecksumValid(candidate)) valid.add(candidate);
  }
  return valid.size === 1 ? [...valid][0]! : isin;
}
