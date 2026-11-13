/**
 * Flexible dates for one hotel: Google's price calendar
 * (`engine=google_hotels_price_calendar`) gives the best price of a
 * one-night stay for every arrival day in one search. A stay of several
 * nights is estimated as the mean of its nights; the check then reads the
 * real offers of the cheapest stay. The estimate only chooses the dates —
 * the price that counts is the one of the offers.
 *
 * Plain functions without I/O.
 */

export interface Stay {
  start: string;
  end: string;
}

export interface StayEstimate extends Stay {
  /** Mean of the one-night prices of the stay's nights. */
  perNight: number;
}

/** Stays a check keeps as "cheapest periods" for the page. */
export const KEPT_ESTIMATES = 5;

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Price per arrival day, taxes included where Google names them. */
export function calendarPrices(answer: any): Map<string, number> {
  const out = new Map<string, number>();
  for (const p of answer?.prices ?? []) {
    const date = typeof p?.date === "string" ? p.date : null;
    const price = num(p?.extracted_after_taxes_fees) ?? num(p?.extracted_display_price);
    if (date && price !== null) out.set(date, price);
  }
  return out;
}

function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/**
 * The estimate of every stay whose nights all have a price, cheapest first.
 * A night without a price leaves the stay out: Google lists no room then.
 */
export function estimateStays(prices: Map<string, number>, stays: Stay[]): StayEstimate[] {
  const out: StayEstimate[] = [];
  for (const s of stays) {
    let sum = 0;
    let nights = 0;
    let complete = true;
    for (let day = s.start; day < s.end; day = addDays(day, 1)) {
      const p = prices.get(day);
      if (p === undefined) {
        complete = false;
        break;
      }
      sum += p;
      nights++;
    }
    if (complete && nights > 0) out.push({ ...s, perNight: Math.round((sum / nights) * 100) / 100 });
  }
  return out.sort((a, b) => a.perNight - b.perNight || a.start.localeCompare(b.start));
}
