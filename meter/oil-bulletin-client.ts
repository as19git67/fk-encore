/**
 * EU Weekly Oil Bulletin (European Commission, DG ENER) — consumer fuel
 * prices per member state, published every Thursday and kept as one history
 * workbook that reaches back to 2005.
 *
 * The comparison report values the kilometres an electric car did not drive
 * with `petrol_price`, a dated assumption. Filling it by hand for years of
 * buckets is busywork, and a single current price rewrites history: fuel cost
 * two euros in 2022 and one euro twenty in 2016, and the comparison is only
 * honest if each bucket is valued with the price of its own months. The
 * bulletin is the one free source that carries that history.
 *
 * Shape of the workbook (verified against the published file):
 *
 *   sheet "Prices with taxes"
 *   row 1   header, one column per country and fuel: `DE_price_with_tax_euro95`
 *   row 4+  one row per week; column A is the week's date
 *   values  EUR per 1000 litres, including all duties and taxes
 *
 * The download URL carries a UUID that changes whenever the Commission
 * re-uploads the file, so the link is read off the bulletin page instead of
 * being hardcoded. Host that has to be in the environment's network policy:
 * `energy.ec.europa.eu` (both the page and the document download).
 */

import ExcelJS from "exceljs";

const TIMEOUT_MS = 60_000;
const BULLETIN_PAGE = "https://energy.ec.europa.eu/data-and-analysis/weekly-oil-bulletin_en";
/** The link on that page whose filename contains this is the history workbook. */
const HISTORY_FILE_MARKER = "Weekly_Oil_Bulletin_Prices_History";
const PRICES_SHEET = "Prices with taxes";
/** The bulletin quotes per 1000 litres. */
const LITRES_PER_QUOTE = 1000;
/**
 * A pump price outside this band is not a price — it is the source having
 * changed its unit or its layout, and writing it would poison the report.
 */
export const MIN_PLAUSIBLE_EUR_PER_L = 0.2;
export const MAX_PLAUSIBLE_EUR_PER_L = 5;

/** The fuels the bulletin carries that a household car runs on. */
export type BulletinFuel = "euro95" | "diesel";

export interface WeeklyFuelPrice {
  /** The week the price was surveyed, `YYYY-MM-DD`. */
  week: string;
  eurPerLitre: number;
}

export interface OilBulletinClient {
  /** Every published week for one country, oldest first. */
  weeklyPrices(country: string, fuel: BulletinFuel): Promise<WeeklyFuelPrice[]>;
}

export class OilBulletinUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OilBulletinUnavailableError";
  }
}

/** The header the wanted column carries, e.g. `DE_price_with_tax_euro95`. */
export function priceColumnName(country: string, fuel: BulletinFuel): string {
  return `${country.toUpperCase()}_price_with_tax_${fuel}`;
}

/**
 * The history workbook's absolute URL, read off the bulletin page. Several
 * workbooks are linked there (a single week, the duties, the history); only
 * the history one carries the marker.
 */
export function findHistoryWorkbookUrl(html: string, pageUrl: string): string {
  for (const match of html.matchAll(/href="([^"]+)"/g)) {
    const href = match[1];
    if (!href.includes(HISTORY_FILE_MARKER)) continue;
    // The href is HTML-escaped and usually site-relative.
    return new URL(href.replaceAll("&amp;", "&"), pageUrl).toString();
  }
  throw new OilBulletinUnavailableError(
    "the oil bulletin page no longer links a price history workbook",
  );
}

/** A cell of column A as a calendar day, whether it arrives as a date or a serial. */
export function weekOf(value: unknown): string | null {
  if (value instanceof Date) {
    return `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, "0")}-${String(
      value.getUTCDate(),
    ).padStart(2, "0")}`;
  }
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    // Excel's 1900 serial, with its phantom leap day already in the offset.
    const ms = (value - 25_569) * 86_400_000;
    return new Date(ms).toISOString().slice(0, 10);
  }
  return null;
}

/**
 * Pulls one country's weekly prices out of the sheet, given its rows as plain
 * values. Row one is the header; a row without a date or without a number in
 * the wanted column is a gap (not every country reported every week) and is
 * skipped rather than guessed at.
 */
export function parseWeeklyPrices(
  rows: unknown[][],
  column: string,
): WeeklyFuelPrice[] {
  const header = rows[0];
  if (!header) throw new OilBulletinUnavailableError("the price sheet is empty");
  const index = header.findIndex((cell) => cell === column);
  if (index < 0) {
    throw new OilBulletinUnavailableError(`the price sheet has no column ${column}`);
  }

  const prices: WeeklyFuelPrice[] = [];
  for (const row of rows.slice(1)) {
    const week = weekOf(row[0]);
    if (!week) continue;
    const quoted = row[index];
    if (typeof quoted !== "number" || !Number.isFinite(quoted)) continue;
    const eurPerLitre = quoted / LITRES_PER_QUOTE;
    if (eurPerLitre < MIN_PLAUSIBLE_EUR_PER_L || eurPerLitre > MAX_PLAUSIBLE_EUR_PER_L) continue;
    prices.push({ week, eurPerLitre });
  }
  prices.sort((a, b) => a.week.localeCompare(b.week));
  return prices;
}

async function fetchWithTimeout(url: string, what: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new OilBulletinUnavailableError(`oil bulletin ${what} answered ${response.status}`);
    }
    return response;
  } catch (err) {
    if (err instanceof OilBulletinUnavailableError) throw err;
    throw new OilBulletinUnavailableError(
      err instanceof Error ? err.message : `oil bulletin ${what} could not be reached`,
    );
  } finally {
    clearTimeout(timer);
  }
}

export class EuOilBulletinClient implements OilBulletinClient {
  async weeklyPrices(country: string, fuel: BulletinFuel): Promise<WeeklyFuelPrice[]> {
    const page = await (await fetchWithTimeout(BULLETIN_PAGE, "page")).text();
    const workbookUrl = findHistoryWorkbookUrl(page, BULLETIN_PAGE);
    const body = await (await fetchWithTimeout(workbookUrl, "workbook")).arrayBuffer();

    const workbook = new ExcelJS.Workbook();
    try {
      await workbook.xlsx.load(Buffer.from(body));
    } catch (err) {
      throw new OilBulletinUnavailableError(
        `the oil bulletin workbook could not be read: ${err instanceof Error ? err.message : err}`,
      );
    }
    const sheet = workbook.getWorksheet(PRICES_SHEET);
    if (!sheet) {
      throw new OilBulletinUnavailableError(`the oil bulletin workbook has no sheet ${PRICES_SHEET}`);
    }

    // Walk by row number rather than `eachRow`, which skips empty rows: the
    // header has to stay the first entry for the column lookup to hold.
    const rows: unknown[][] = [];
    for (let number = 1; number <= sheet.rowCount; number++) {
      // `values` is 1-based with a hole at index 0; drop it so the header
      // index and the data index line up.
      rows.push((sheet.getRow(number).values as unknown[]).slice(1));
    }
    return parseWeeklyPrices(rows, priceColumnName(country, fuel));
  }
}

let client: OilBulletinClient = new EuOilBulletinClient();

export function getOilBulletinClient(): OilBulletinClient {
  return client;
}
/** Replace the client — tests never leave the house. */
export function setOilBulletinClient(next: OilBulletinClient): void {
  client = next;
}
export function resetOilBulletinClient(): void {
  client = new EuOilBulletinClient();
}
