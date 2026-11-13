/**
 * Reading a Google Flights answer from SerpApi (`engine=google_flights`).
 *
 * The answer lists flights in `best_flights` and `other_flights`. On a round
 * trip these are the outbound flights, each with the price of the whole
 * round trip for all passengers; on a one-way trip the flights themselves.
 * `price_insights` carries Google's assessment (low/typical/high), the
 * typical range and a price history of the last weeks for these dates.
 *
 * No link of the answer is kept: booking links are POSTs to Google's click
 * redirect (`google.com/travel/clk/f`) that stop working after a while.
 * The page and the report link a Google Flights search built from the
 * watch instead (`googleFlightsLink`), which stays valid.
 *
 * Plain functions without I/O, so the tests feed them a synthetic answer.
 */

export interface FlightOffer {
  price: number;
  airlines: string;
  flightNumbers: string;
  /** Local time of the first departure and the last arrival, "YYYY-MM-DD HH:MM". */
  departsAt: string | null;
  arrivesAt: string | null;
  durationMin: number | null;
  stops: number;
  /** Layover airports, comma separated. */
  layovers: string;
  best: boolean;
  /** Round trip: the return flights of this outbound flight. */
  departureToken: string | null;
  /** One way (or a chosen return): its booking options. */
  bookingToken: string | null;
}

export interface PriceInsight {
  lowest: number | null;
  level: string | null;
  typicalLow: number | null;
  typicalHigh: number | null;
  /** Google's history for these dates: one price per day, oldest first. */
  history: { day: string; price: number }[];
}

export interface BookingOption {
  bookWith: string;
  price: number | null;
  optionTitle: string | null;
  extensions: string;
  /** Google's baggage lines of the option, joined ("1 free carry-on, 1st checked bag: 99"). */
  baggage: string;
  /**
   * The first checked bag per traveller: "included", its fee, or null when
   * the lines do not say. Separate tickets add the fees of both parts.
   */
  checkedBag: CheckedBag;
}

export type CheckedBag = "included" | number | null;

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

function unique(values: (string | null)[]): string[] {
  return [...new Set(values.filter((v): v is string => v !== null))];
}

function offerOf(item: any, best: boolean): FlightOffer | null {
  const price = num(item?.price);
  const legs: any[] = Array.isArray(item?.flights) ? item.flights : [];
  if (price === null || !legs.length) return null;
  const first = legs[0];
  const last = legs[legs.length - 1];
  return {
    price,
    airlines: unique(legs.map((l) => str(l?.airline))).join(", ") || "(unbekannt)",
    flightNumbers: unique(legs.map((l) => str(l?.flight_number))).join(", "),
    departsAt: str(first?.departure_airport?.time),
    arrivesAt: str(last?.arrival_airport?.time),
    durationMin: num(item.total_duration),
    stops: legs.length - 1,
    layovers: unique(((item.layovers ?? []) as any[]).map((l) => str(l?.id) ?? str(l?.name))).join(", "),
    best,
    departureToken: str(item.departure_token),
    bookingToken: str(item.booking_token),
  };
}

/** Every flight of the answer, cheapest first. */
export function flightsOf(answer: any): FlightOffer[] {
  const offers: FlightOffer[] = [];
  for (const item of answer?.best_flights ?? []) {
    const o = offerOf(item, true);
    if (o) offers.push(o);
  }
  for (const item of answer?.other_flights ?? []) {
    const o = offerOf(item, false);
    if (o) offers.push(o);
  }
  return offers.sort((a, b) => a.price - b.price || Number(b.best) - Number(a.best));
}

/** Google's price insight; the history's timestamps (seconds) become days in UTC. */
export function insightOf(answer: any): PriceInsight {
  const pi = answer?.price_insights ?? {};
  const range: unknown[] = Array.isArray(pi.typical_price_range) ? pi.typical_price_range : [];
  const byDay = new Map<string, number>();
  for (const point of (pi.price_history ?? []) as unknown[]) {
    if (!Array.isArray(point)) continue;
    const ts = num(point[0]);
    const price = num(point[1]);
    if (ts === null || price === null) continue;
    const ms = ts > 1e11 ? ts : ts * 1000;
    byDay.set(new Date(ms).toISOString().slice(0, 10), price);
  }
  const level = str(pi.price_level);
  return {
    lowest: num(pi.lowest_price),
    level: level ? level.toLowerCase() : null,
    typicalLow: num(range[0]),
    typicalHigh: num(range[1]),
    history: [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([day, price]) => ({ day, price })),
  };
}

/** Who sells the flight: together on one ticket, or as separate tickets. */
export function bookingOptionsOf(answer: any): BookingOption[] {
  const out: BookingOption[] = [];
  for (const opt of (answer?.booking_options ?? []) as any[]) {
    const together = opt?.together;
    if (together) {
      const bookWith = str(together.book_with);
      if (!bookWith) continue;
      const lines = baggageLines(together.baggage_prices);
      out.push({
        bookWith,
        price: num(together.price),
        optionTitle: str(together.option_title),
        extensions: unique(((together.extensions ?? []) as unknown[]).map(str)).join(", "),
        baggage: lines.join(", "),
        checkedBag: checkedBagOf(lines),
      });
      continue;
    }
    const parts = [opt?.departing, opt?.returning].filter(Boolean);
    const names = unique(parts.map((p: any) => str(p?.book_with)));
    if (!names.length) continue;
    const prices = parts.map((p: any) => num(p?.price));
    const partLines = parts.map((p: any) => baggageLines(p?.baggage_prices));
    out.push({
      bookWith: names.join(" + "),
      price: prices.every((p) => p !== null) ? prices.reduce<number>((s, p) => s + (p as number), 0) : null,
      optionTitle: "Getrennte Tickets",
      extensions: "",
      baggage: unique(partLines.flat()).join(", "),
      checkedBag: sumBags(partLines.map(checkedBagOf)),
    });
  }
  return out.sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity));
}

function baggageLines(v: unknown): string[] {
  if (Array.isArray(v)) return unique(v.map(str));
  const one = str(v);
  return one ? [one] : [];
}

/** A line about the checked bag, in English or German (the search asks with hl=de). */
const CHECKED = /checked|aufgegeben|aufgabe|koffer|reisegep[äa]ck/i;
const FREE = /\bfree\b|kostenlos|kostenfrei|gratis|inklusive|inkl\.|inbegriffen|included/i;
const NOT_OFFERED = /not (allowed|available|included)|nicht (enthalten|inbegriffen|m[öo]glich|erlaubt|verf[üu]gbar)/i;

/**
 * The first checked bag of an option from Google's baggage lines: free,
 * its fee (the first amount on the line), or null when no line says.
 * "1st checked bag up to 23 kg free" → included, "1st checked bag: 99" → 99.
 */
export function checkedBagOf(lines: string[]): CheckedBag {
  const line = lines.find((l) => CHECKED.test(l));
  if (!line || NOT_OFFERED.test(line)) return null;
  if (FREE.test(line)) return "included";
  // The fee: the first number after the colon (or the line's first), ranges
  // ("99-187") take the low end. Skip a leading count ("1st", "1.").
  const tail = line.includes(":") ? line.slice(line.indexOf(":") + 1) : line.replace(/^\s*\d+\s*(st|\.)?/i, "");
  const m = tail.match(/(\d{1,3}(?:[.\s]\d{3})*(?:,\d{1,2})?|\d+(?:\.\d{1,2})?)/);
  if (!m) return null;
  const raw = m[1]!;
  const value = /,\d{1,2}$/.test(raw)
    ? Number(raw.replace(/[.\s]/g, "").replace(",", "."))
    : Number(raw.replace(/[.\s]/g, ""));
  if (!Number.isFinite(value)) return null;
  return value === 0 ? "included" : value;
}

function sumBags(parts: CheckedBag[]): CheckedBag {
  if (!parts.length || parts.some((p) => p === null)) return null;
  const fees = parts.filter((p): p is number => typeof p === "number");
  return fees.length ? fees.reduce((s, f) => s + f, 0) : "included";
}

/** An option's price with one checked bag for each of `seated` travellers; null when unknown. */
export function priceWithBag(option: BookingOption, seated: number): number | null {
  if (option.price === null || option.checkedBag === null) return null;
  return option.checkedBag === "included" ? option.price : option.price + option.checkedBag * seated;
}

/** The cheapest option's price with a checked bag, or null when no option says what the bag costs. */
export function cheapestWithBag(options: BookingOption[], seated: number): number | null {
  let best: number | null = null;
  for (const o of options) {
    const p = priceWithBag(o, seated);
    if (p !== null && (best === null || p < best)) best = p;
  }
  return best;
}

/** The watch's "max stops" (null any, 0–2) as SerpApi's `stops` parameter. */
export function stopsParam(maxStops: number | null): number {
  return maxStops === null ? 0 : maxStops + 1;
}

const CLASS_WORDS: Record<number, string> = { 2: " premium economy", 3: " business class", 4: " first class" };

/**
 * A Google Flights search for the route and dates. It is an ordinary search
 * page, not a redirect, so it still works weeks later; Google parses the
 * words of `q`, the same as typing them into its search.
 */
export function googleFlightsLink(input: {
  origin: string;
  destination: string;
  outbound: string;
  return: string | null;
  travelClass: number;
  currency: string;
}): string {
  const places = (codes: string) => codes.split(",").map((c) => c.trim()).filter(Boolean).join(" or ");
  const q =
    `Flights to ${places(input.destination)} from ${places(input.origin)} on ${input.outbound}` +
    (input.return ? ` through ${input.return}` : " one way") +
    (CLASS_WORDS[input.travelClass] ?? "");
  const url = new URL("https://www.google.com/travel/flights");
  url.searchParams.set("q", q);
  url.searchParams.set("curr", input.currency);
  url.searchParams.set("hl", "de");
  return url.toString();
}
