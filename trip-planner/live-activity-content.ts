/**
 * What the Lock Screen says about the day, computed on the server (§8.5).
 *
 * Out of the first trial: "Mittag bis 14:00" was still on the Lock
 * Screen at dinner. The Live Activity is computed on the phone, and a
 * phone lying still in a pocket is never woken to recompute it. A push
 * at each block boundary is the one thing that reaches it then — and a
 * push needs the server to know what to say.
 *
 * This is `TripDayActivityContent.build` and `TripDayTimeline.position`
 * from the app, line for line, because the Activity must read the same
 * whether the phone or the server wrote the last update. A difference
 * between the two would flicker on every wake. Keep them together: a
 * change on one side is a change on the other.
 *
 * Pure: a day, a minute and the light in, a content state out.
 */

import type { LightKind } from "./sun";

export interface ActivityStop {
  osmRef: string;
  name: string | null;
  title?: string | null;
  category: string;
  dwellMinutes: number;
  travelFromPrevious: { minutes: number };
}

export interface ActivityBlock {
  label: string;
  kind: string;
  budgetMinutes: number;
  usedMinutes: number;
  startMinutes: number | null;
  carriedInMinutes?: number;
  stops: readonly ActivityStop[];
}

export interface ActivityLightWindow {
  kind: LightKind | string;
  fromMinutes: number;
  toMinutes: number;
}

export interface ActivitySpotLight {
  osmRef: string;
  best: ActivityLightWindow | null;
}

/**
 * The app's `TripDayActivityAttributes.ContentState`, key for key. The
 * app decodes it with Swift's synthesised `Codable`, so a renamed key
 * here is a blank Lock Screen there.
 */
export interface ActivityContentState {
  blockLabel: string | null;
  blockKind: string | null;
  blockEndMinutes: number | null;
  overrunMinutes: number;
  currentStopName: string | null;
  stopConfirmed: boolean;
  nextStopName: string | null;
  lightHintText: string | null;
}

/** `TripCategory` in the app — what an unnamed place is called. */
const CATEGORY_LABELS: Readonly<Record<string, string>> = {
  sight: "Sehenswürdigkeit",
  museum: "Museum",
  viewpoint: "Aussichtspunkt",
  worship: "Kirche oder Tempel",
  theatre: "Theater oder Kino",
  food: "Essen",
  cafe: "Café",
  essentials: "Alltägliches",
  outdoors: "Park oder Natur",
  route: "Strecke",
};

/** `TripStop.displayName`: the group's title, the map's name, or what it is. */
export function displayName(stop: ActivityStop): string {
  if (stop.title) return stop.title;
  if (stop.name) return stop.name;
  const label = CATEGORY_LABELS[stop.category];
  return label ? `${label}, ohne Namen` : "Unbenannter Ort";
}

/** `TripClock.format`: "09:05", wrapped into the day. */
export function clock(minutes: number): string {
  const wrapped = ((minutes % 1440) + 1440) % 1440;
  const h = Math.floor(wrapped / 60);
  const m = wrapped % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function lightLabel(kind: string): string {
  switch (kind) {
    case "golden": return "Goldene Stunde";
    case "blue": return "Blaue Stunde";
    default: return "Hohe Mittagssonne";
  }
}

/** `TripDayTimeline.block(in:at:)`: the block covering the minute. */
function blockAt(blocks: readonly ActivityBlock[], minutes: number): ActivityBlock | null {
  return blocks.find((b) =>
    b.startMinutes !== null && minutes >= b.startMinutes && minutes < b.startMinutes + Math.max(b.budgetMinutes, 1),
  ) ?? null;
}

/** `TripDayTimeline.position(in:at:)`: which stop the clock has them at. */
function stopAt(block: ActivityBlock, minutes: number): number | null {
  if (block.startMinutes === null || block.stops.length === 0) return null;
  const total = block.stops.reduce((sum, s) => sum + s.dwellMinutes + s.travelFromPrevious.minutes, 0);
  if (total <= 0) return 0;
  const elapsed = minutes - block.startMinutes;
  let cursor = 0;
  for (let index = 0; index < block.stops.length; index++) {
    const stop = block.stops[index];
    cursor += stop.dwellMinutes + stop.travelFromPrevious.minutes;
    const boundary = block.budgetMinutes > 0
      ? Math.trunc((cursor / total) * Math.min(total, block.budgetMinutes))
      : cursor;
    if (elapsed < boundary || index === block.stops.length - 1) return index;
  }
  return block.stops.length - 1;
}

/**
 * The state for `minutes` past midnight, or null when the day has
 * nothing to say then: before its first block, after its last, or a
 * plan without block times.
 */
export function buildActivityContent(
  blocks: readonly ActivityBlock[],
  minutes: number,
  light: readonly ActivitySpotLight[] = [],
): ActivityContentState | null {
  const block = blockAt(blocks, minutes);
  if (!block) return null;

  const index = stopAt(block, minutes);
  const stop = index === null ? null : block.stops[index];
  const next = index === null ? null : block.stops[index + 1] ?? null;

  const hintStop = stop ?? block.stops.find((s) => s.dwellMinutes > 0) ?? null;
  const window = hintStop ? light.find((l) => l.osmRef === hintStop.osmRef)?.best ?? null : null;
  const lightHintText = window && minutes < window.toMinutes
    ? `${lightLabel(window.kind)} ${clock(window.fromMinutes)}–${clock(window.toMinutes)}`
    : null;

  const startsLate = Math.max(0, block.carriedInMinutes ?? 0);
  return {
    blockLabel: block.label,
    blockKind: block.kind,
    blockEndMinutes: block.startMinutes === null ? null : block.startMinutes + block.budgetMinutes,
    overrunMinutes: Math.max(0, startsLate + block.usedMinutes - block.budgetMinutes),
    currentStopName: stop ? displayName(stop) : null,
    stopConfirmed: false,
    nextStopName: next ? displayName(next) : null,
    lightHintText,
  };
}

/** Minutes past midnight and the date, on the clock of a time zone. */
export function zonedClock(at: Date, timeZone: string): { date: string; minutes: number; offsetMinutes: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const date = `${parts.find((p) => p.type === "year")!.value}-${parts.find((p) => p.type === "month")!.value}-${parts.find((p) => p.type === "day")!.value}`;
  const minutes = get("hour") * 60 + get("minute");
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  const offsetMinutes = Math.round((asUtc - Math.floor(at.getTime() / 1000) * 1000) / 60_000);
  return { date, minutes, offsetMinutes };
}

/** Whether the identifier is a time zone this runtime knows. */
export function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/**
 * `TripDayActivityContent.staleDate`: the block's end on the local
 * clock, never earlier than a minute from now. Null without an end.
 */
export function staleDate(blockEndMinutes: number | null, now: Date, timeZone: string): Date | null {
  if (blockEndMinutes === null) return null;
  const local = zonedClock(now, timeZone);
  const end = new Date(now.getTime() + (blockEndMinutes - local.minutes) * 60_000);
  // Seconds off: the end is on the minute.
  end.setUTCSeconds(0, 0);
  return new Date(Math.max(end.getTime(), now.getTime() + 60_000));
}
