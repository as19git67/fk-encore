/**
 * Linear depreciation (AfA) of a business's asset, the German way
 * (documentation/plans/betriebe-euer.md): a yearly rate of the cost, pro
 * rata by month in the year of acquisition (§ 7 Abs. 1 Satz 4 EStG: the
 * month of acquisition counts) and in the year of disposal, down to a
 * residual value of 1 € while the asset is still held. Land has a rate of
 * 0 and is never written off. Everything in cents, so the sums are exact.
 */

export interface DepreciableAsset {
  acquisition_date: string;
  acquisition_cost: string | number;
  afa_rate_pct: string | number;
  afa_start_date?: string | null;
  disposal_date?: string | null;
  disposal_proceeds?: string | number | null;
}

export interface DepreciationYear {
  year: number;
  /** Months of the year the asset was held and depreciated (0–12). */
  months: number;
  /** AfA of the year, EUR as a string with two decimals. */
  afa: string;
  /** Accumulated AfA at the end of the year. */
  accumulated: string;
  /** Book value at the end of the year. */
  book_value: string;
  /** In the year of disposal: proceeds minus the book value at disposal. */
  disposal_result: string | null;
}

/** The residual value an asset keeps on the books while held (Erinnerungswert). */
const RESIDUAL_CENTS = 100;

function cents(v: string | number | null | undefined): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

function eur(c: number): string {
  return (c / 100).toFixed(2);
}

function yearOf(iso: string): number {
  return Number(iso.slice(0, 4));
}

function monthOf(iso: string): number {
  return Number(iso.slice(5, 7));
}

/**
 * Months of `year` in which the asset is depreciated: from the start
 * month (inclusive) to the disposal month (inclusive) when disposed of in
 * that year.
 */
export function monthsHeld(year: number, start: string, disposal: string | null | undefined): number {
  if (year < yearOf(start)) return 0;
  if (disposal && year > yearOf(disposal)) return 0;
  const first = year === yearOf(start) ? monthOf(start) : 1;
  const last = disposal && year === yearOf(disposal) ? monthOf(disposal) : 12;
  return Math.max(0, last - first + 1);
}

/**
 * The schedule from the first year of depreciation to `untilYear` (or to
 * the year it ends: full depreciation or disposal), one row per year.
 */
export function depreciationSchedule(asset: DepreciableAsset, untilYear: number): DepreciationYear[] {
  const cost = cents(asset.acquisition_cost);
  const rate = Number(asset.afa_rate_pct) || 0;
  const start = asset.afa_start_date || asset.acquisition_date;
  const disposal = asset.disposal_date || null;
  const firstYear = yearOf(start);
  const lastYear = disposal ? Math.min(yearOf(disposal), untilYear) : untilYear;
  const yearly = Math.round((cost * rate) / 100);
  const depreciable = Math.max(0, cost - RESIDUAL_CENTS);

  const rows: DepreciationYear[] = [];
  let accumulated = 0;
  for (let year = firstYear; year <= lastYear; year++) {
    const months = monthsHeld(year, start, disposal);
    let afa = rate > 0 && months > 0 ? Math.round((yearly * months) / 12) : 0;
    const disposedThisYear = disposal !== null && year === yearOf(disposal);
    // Down to the residual value, never below; in the year of disposal the
    // residual value is not kept, the book value is settled against the
    // proceeds instead.
    const floor = disposedThisYear ? cost : depreciable;
    if (accumulated + afa > floor) afa = Math.max(0, floor - accumulated);
    accumulated += afa;
    const bookValue = cost - accumulated;
    const disposalResult = disposedThisYear ? cents(asset.disposal_proceeds) - bookValue : null;
    rows.push({
      year,
      months,
      afa: eur(afa),
      accumulated: eur(accumulated),
      book_value: eur(disposedThisYear ? 0 : bookValue),
      disposal_result: disposalResult === null ? null : eur(disposalResult),
    });
    if (rate > 0 && accumulated >= depreciable && !disposal) {
      // Fully written off: later years carry no AfA; stop at the residual.
      for (let y = year + 1; y <= lastYear; y++) {
        rows.push({ year: y, months: 12, afa: "0.00", accumulated: eur(accumulated), book_value: eur(cost - accumulated), disposal_result: null });
      }
      break;
    }
  }
  return rows;
}

/** The row of one year, or a zero row when the asset was not held then. */
export function depreciationOfYear(asset: DepreciableAsset, year: number): DepreciationYear {
  const rows = depreciationSchedule(asset, year);
  const row = rows.find((r) => r.year === year);
  if (row) return row;
  const cost = cents(asset.acquisition_cost);
  const start = asset.afa_start_date || asset.acquisition_date;
  const before = year < yearOf(start);
  return {
    year,
    months: 0,
    afa: "0.00",
    accumulated: before ? "0.00" : (rows.at(-1)?.accumulated ?? "0.00"),
    book_value: before ? "0.00" : (rows.at(-1)?.book_value ?? eur(cost)),
    disposal_result: null,
  };
}
