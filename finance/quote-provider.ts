/**
 * Where prices come from.
 *
 * A provider answers three questions: which of its symbols a security is
 * (from ISIN or WKN), what it costs now, and what it cost over a range.
 * The service behind it (`quotes.ts`) keeps every answer in the database,
 * so the history outlives the provider and a provider can be swapped
 * without losing a day.
 *
 * The installed provider is replaceable at runtime: tests install one
 * that answers from memory, and the setup file installs none, so a test
 * that forgets to does not reach the network.
 */

export interface QuoteSymbol {
  /** The provider's id for the security ("ABC.DE"). */
  symbol: string;
  name: string | null;
  exchange: string | null;
  currency: string | null;
}

export interface QuotePoint {
  /** ISO timestamp of the price. */
  at: string;
  price: number;
}

export interface QuoteSeries {
  symbol: string;
  currency: string | null;
  points: QuotePoint[];
}

/** How far back and how fine a history is asked for. */
export type HistoryRange = "intraday" | "recent_days" | "backfill";

export interface QuoteProvider {
  /** A short name stored with every price ("yahoo"). */
  readonly name: string;
  /** The provider's symbol for the security, or null when it knows none. */
  resolve(id: { isin: string | null; wkn: string | null; name: string | null }): Promise<QuoteSymbol | null>;
  /**
   * Prices of one symbol: "intraday" is today in minutes, "recent_days"
   * the closes of the last few days, "backfill" the closes of the last
   * years. Throws on a provider error; the caller decides what to retry.
   */
  history(symbol: string, range: HistoryRange): Promise<QuoteSeries>;
}

let installed: QuoteProvider | null = null;

export function setQuoteProvider(p: QuoteProvider | null): void {
  installed = p;
}

export function quoteProvider(): QuoteProvider {
  if (!installed) throw new Error("no quote provider installed");
  return installed;
}

/** Thrown when the provider turns the caller away for a while (HTTP 429). */
export class QuoteRateLimitedError extends Error {
  constructor(message = "quote provider rate limit") {
    super(message);
    this.name = "QuoteRateLimitedError";
  }
}
