/**
 * Reporting a price below the limit (stage 2 of reise-hotelpreise.md).
 *
 * The rule is plain: the daily job reports a watch when its matching price
 * is below the limit and either nothing has been reported since the price
 * last stood above the limit, or the price is a new low below what was
 * reported. A price back at or above the limit clears the report, so the
 * next drop is reported again. "Check now" on the page reports nothing; the
 * user is looking at the result already.
 *
 * Push goes through the push service (browser and iOS, the user's own
 * notification settings apply); the mail through the app's SMTP account.
 * Both are best-effort: a failed send is logged, the check stands.
 */
import { push } from "~encore/clients";
import { appUrl, mailConfigured, sendHotelPriceAlertEmail } from "../user/mail";

export interface PriceAlert {
  userId: number;
  watchId: number;
  hotel: string;
  checkIn: string;
  checkOut: string;
  nights: number;
  currency: string;
  perNight: number;
  limit: number;
  source: string;
  room: string;
  freeCancellation: boolean | null;
  cancelUntil: string | null;
  breakfast: boolean;
  link: string | null;
  /** True when an earlier report of this watch is undercut. */
  newLow: boolean;
}

export type AlertDecision =
  | { kind: "report"; newLow: boolean }
  /** The price is back at or above the limit (or gone): forget the last report. */
  | { kind: "reset" }
  | { kind: "none" };

/**
 * What a check means for the watch's report. `matching` is null when the
 * check found no offer meeting the conditions; a failed check never gets
 * here.
 */
export function alertDecision(
  limit: number | null,
  matching: number | null,
  notified: number | null,
): AlertDecision {
  if (limit === null) return notified === null ? { kind: "none" } : { kind: "reset" };
  if (matching === null || matching >= limit) return notified === null ? { kind: "none" } : { kind: "reset" };
  if (notified === null) return { kind: "report", newLow: false };
  return matching < notified ? { kind: "report", newLow: true } : { kind: "none" };
}

export interface AlertSender {
  push(alert: PriceAlert): Promise<void>;
  email(alert: PriceAlert, to: string): Promise<void>;
}

const euro = (n: number, currency: string) =>
  new Intl.NumberFormat("de-DE", { style: "currency", currency, maximumFractionDigits: 0 }).format(n);

const day = (iso: string) => {
  const [y, m, d] = iso.split("-");
  return `${d}.${m}.${y}`;
};

/** The words of a report, shared by push and mail. */
export function alertText(a: PriceAlert): { title: string; body: string; terms: string } {
  const title = a.newLow ? `Neuer Tiefstpreis: ${a.hotel}` : `Preis unter deiner Grenze: ${a.hotel}`;
  const terms = [
    a.freeCancellation === true
      ? a.cancelUntil
        ? `kostenlos stornierbar bis ${a.cancelUntil}`
        : "kostenlos stornierbar"
      : a.freeCancellation === false
        ? "nicht kostenlos stornierbar"
        : "Storno unbekannt",
    a.breakfast ? "mit Frühstück" : null,
  ]
    .filter(Boolean)
    .join(", ");
  const body =
    `${euro(a.perNight, a.currency)} pro Nacht bei ${a.source} (Grenze ${euro(a.limit, a.currency)}), ` +
    `${day(a.checkIn)}–${day(a.checkOut)}, ${terms}`;
  return { title, body, terms };
}

/** The page of the watch, below the app's origin (the web app lives under /app). */
export function watchPath(watchId: number): string {
  return `/app/reise/hotelpreise?watch=${watchId}`;
}

export const defaultAlertSender: AlertSender = {
  async push(alert) {
    const { title, body } = alertText(alert);
    await push.notifyHotelPrice({ userId: alert.userId, watchId: alert.watchId, title, body });
  },
  async email(alert, to) {
    if (!mailConfigured()) return;
    const { title, body } = alertText(alert);
    await sendHotelPriceAlertEmail({
      to,
      subject: title,
      text: body,
      offerLink: alert.link,
      offerSource: alert.source,
      watchUrl: `${appUrl().replace(/\/+$/, "")}${watchPath(alert.watchId)}`,
    });
  },
};

let sender: AlertSender = defaultAlertSender;

/** Tests swap the sender; `null` restores the real one. */
export function setAlertSender(next: AlertSender | null): void {
  sender = next ?? defaultAlertSender;
}

export function alertSender(): AlertSender {
  return sender;
}
