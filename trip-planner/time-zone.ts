/**
 * Time zones of the itinerary (documentation/plans/reise-planen-und-unterwegs.md,
 * stage 1).
 *
 * Every time in a trip is local at its place: an arrival of 07:30 is
 * 07:30 where the group gets off. Nothing is converted on write. What
 * the zone adds is the reading: which zone a stay is in, and how far
 * the clock jumps on a journey that crosses zones ("+8 h").
 *
 * The zone follows from the coordinates, looked up offline: a request
 * never waits on a network call for it.
 */

import tzLookup from "tz-lookup";

/** The IANA zone at a point, or null when the lookup has none. */
export function zoneAt(point: { lat: number; lon: number } | null | undefined): string | null {
  if (!point || !Number.isFinite(point.lat) || !Number.isFinite(point.lon)) return null;
  if (Math.abs(point.lat) > 90 || Math.abs(point.lon) > 180) return null;
  try {
    return tzLookup(point.lat, point.lon);
  } catch {
    return null;
  }
}

/**
 * Minutes the zone is ahead of UTC on a calendar day (noon UTC of that
 * day, so a change of daylight saving time in the small hours does not
 * flip the answer). Null for a zone the runtime does not know.
 */
export function offsetMinutes(zone: string, day: string): number | null {
  const at = new Date(`${day}T12:00:00Z`);
  if (Number.isNaN(at.getTime())) return null;
  try {
    const name = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "longOffset" })
      .formatToParts(at)
      .find((p) => p.type === "timeZoneName")?.value;
    if (!name) return null;
    if (name === "GMT") return 0;
    const m = /^GMT([+-])(\d{1,2})(?::(\d{2}))?$/.exec(name);
    if (!m) return null;
    const minutes = Number(m[2]) * 60 + Number(m[3] ?? 0);
    return m[1] === "-" ? -minutes : minutes;
  } catch {
    return null;
  }
}

/**
 * How far the clock moves between two zones on a day: positive when
 * the arrival zone is ahead. Null when either zone is unknown. Without a
 * date the trip has no day to ask about, so today stands in — the jump
 * between two zones changes by an hour at most over a year.
 */
export function zoneShiftMinutes(
  from: string | null,
  to: string | null,
  day: string | null,
  today: () => string = () => new Date().toISOString().slice(0, 10),
): number | null {
  if (!from || !to) return null;
  const when = day ?? today();
  const a = offsetMinutes(from, when);
  const b = offsetMinutes(to, when);
  if (a === null || b === null) return null;
  return b - a;
}

/** Today's date where `zone` is, "YYYY-MM-DD"; UTC without a zone. */
export function localDateIn(zone: string | null, now: Date): string {
  if (!zone) return now.toISOString().slice(0, 10);
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: zone }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}
