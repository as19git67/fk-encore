/**
 * Reporting a flight price below the limit. The rule is the hotel watch's
 * (`alertDecision` in hotel-alerts.ts), applied to the best price the watch
 * knows across its date combinations; push and mail as there.
 */
import { push } from "~encore/clients";
import { appUrl, mailConfigured, sendFlightPriceAlertEmail } from "../user/mail";
import type { BookingOption } from "./flight-offers";

export interface FlightPriceAlert {
  userId: number;
  watchId: number;
  /** "FRA → JFK". */
  route: string;
  outbound: string;
  return: string | null;
  currency: string;
  price: number;
  limit: number;
  passengers: number;
  airlines: string;
  stops: number;
  /** Google's assessment of the price: "low", "typical", "high". */
  level: string | null;
  /** Who sells the flight, cheapest first; empty when not fetched. */
  bookings: BookingOption[];
  /** The Google Flights search for these dates. */
  link: string;
  newLow: boolean;
}

export interface FlightAlertSender {
  push(alert: FlightPriceAlert): Promise<void>;
  email(alert: FlightPriceAlert, to: string): Promise<void>;
}

const euro = (n: number, currency: string) =>
  new Intl.NumberFormat("de-DE", { style: "currency", currency, maximumFractionDigits: 0 }).format(n);

const day = (iso: string) => {
  const [y, m, d] = iso.split("-");
  return `${d}.${m}.${y}`;
};

const LEVEL: Record<string, string> = { low: "günstig", typical: "üblich", high: "teuer" };

export function stopsText(stops: number): string {
  return stops === 0 ? "nonstop" : stops === 1 ? "1 Umstieg" : `${stops} Umstiege`;
}

/** The words of a report, shared by push and mail. */
export function flightAlertText(a: FlightPriceAlert): { title: string; body: string; bookings: string | null } {
  const title = a.newLow ? `Neuer Tiefstpreis: ${a.route}` : `Flugpreis unter deiner Grenze: ${a.route}`;
  const dates = a.return ? `${day(a.outbound)}–${day(a.return)}` : `${day(a.outbound)}, einfach`;
  const who = a.passengers === 1 ? "1 Person" : `${a.passengers} Personen`;
  const level = a.level && LEVEL[a.level] ? `, laut Google ${LEVEL[a.level]}` : "";
  const body =
    `${euro(a.price, a.currency)} für ${who} (Grenze ${euro(a.limit, a.currency)}), ${dates}, ` +
    `${a.airlines}, ${stopsText(a.stops)}${level}`;
  const bookings = a.bookings.length
    ? "Buchbar bei " +
      a.bookings
        .slice(0, 4)
        .map((b) => (b.price !== null ? `${b.bookWith} (${euro(b.price, a.currency)})` : b.bookWith))
        .join(", ")
    : null;
  return { title, body, bookings };
}

/** The page of the watch, below the app's origin (the web app lives under /app). */
export function flightWatchPath(watchId: number): string {
  return `/app/reise/flugpreise?watch=${watchId}`;
}

export const defaultFlightAlertSender: FlightAlertSender = {
  async push(alert) {
    const { title, body } = flightAlertText(alert);
    await push.notifyFlightPrice({ userId: alert.userId, watchId: alert.watchId, title, body });
  },
  async email(alert, to) {
    if (!mailConfigured()) return;
    const { title, body, bookings } = flightAlertText(alert);
    await sendFlightPriceAlertEmail({
      to,
      subject: title,
      text: body,
      bookings,
      searchLink: alert.link,
      watchUrl: `${appUrl().replace(/\/+$/, "")}${flightWatchPath(alert.watchId)}`,
    });
  },
};

let sender: FlightAlertSender = defaultFlightAlertSender;

/** Tests swap the sender; `null` restores the real one. */
export function setFlightAlertSender(next: FlightAlertSender | null): void {
  sender = next ?? defaultFlightAlertSender;
}

export function flightAlertSender(): FlightAlertSender {
  return sender;
}
