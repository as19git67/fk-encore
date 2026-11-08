/**
 * Reading OpenStreetMap's `opening_hours` for one date (ideas plan,
 * stage 3).
 *
 * Only the common forms: weekday ranges and lists, hour ranges (one or
 * several, past midnight too), `off`/`closed`, `PH` and `24/7`, rules
 * separated by `;` where a later rule for the same day wins. That
 * covers what most museums, churches and markets carry.
 *
 * Everything else — months, dates, week numbers, `sunrise`, `||`,
 * comments, school holidays — makes the whole string "unknown". Never a
 * guess: a museum read as open on the Monday it is closed is the one
 * mistake a family cannot recover from on the day. The app says
 * "Öffnungszeiten unklar" instead.
 */

/** Minutes after midnight; `to` may pass 1440 for a night that runs on. */
export interface OpenWindow {
  from: number;
  to: number;
}

export type OpeningOn =
  | { state: "open"; windows: OpenWindow[] }
  | { state: "closed" }
  | { state: "unknown" };

const DAYS = ["su", "mo", "tu", "we", "th", "fr", "sa"] as const;

interface Rule {
  /** Weekday numbers (0 = Sunday) this rule names; null for every day. */
  days: Set<number> | null;
  holiday: boolean;
  /** Null for "off". */
  windows: OpenWindow[] | null;
}

/** The rules, or null when any part is beyond these forms. */
export function parseOpeningHours(spec: string | null | undefined): Rule[] | null {
  const text = (spec ?? "").trim();
  if (text.length === 0) return null;
  if (/^24\/7$/i.test(text)) return [{ days: null, holiday: false, windows: [{ from: 0, to: 1440 }] }];
  if (text.includes("||") || text.includes('"') || text.includes("[")) return null;

  const rules: Rule[] = [];
  for (const raw of text.split(";")) {
    const part = raw.trim();
    if (part.length === 0) continue;
    const rule = parseRule(part);
    if (!rule) return null;
    rules.push(rule);
  }
  return rules.length > 0 ? rules : null;
}

/** True when the string is one this module can read. */
export function understood(spec: string | null | undefined): boolean {
  return parseOpeningHours(spec) !== null;
}

/**
 * Open, closed or unknown on this date (YYYY-MM-DD). `holiday` says
 * whether the date is a public holiday where the place is; nobody here
 * knows that for every country, so the caller decides.
 */
export function openingOn(
  spec: string | null | undefined,
  date: string,
  opts: { holiday?: boolean } = {},
): OpeningOn {
  const rules = parseOpeningHours(spec);
  if (!rules) return { state: "unknown" };
  // Only what holds on holidays says nothing about an ordinary day.
  if (rules.every((r) => r.holiday && r.days === null) && opts.holiday !== true) return { state: "unknown" };
  const weekday = weekdayOf(date);
  if (weekday === null) return { state: "unknown" };

  let winner: Rule | null = null;
  for (const rule of rules) {
    const matches = rule.holiday
      ? opts.holiday === true || (rule.days?.has(weekday) ?? false)
      : rule.days === null || rule.days.has(weekday);
    if (matches) winner = rule;
  }
  // A string that names some days and not this one says it is closed.
  if (!winner || winner.windows === null) return { state: "closed" };
  return { state: "open", windows: winner.windows };
}

/** The dates among these on which the place is closed, for the idea row. */
export function closedDates(spec: string | null | undefined, dates: readonly string[]): string[] {
  if (!understood(spec)) return [];
  return dates.filter((date) => openingOn(spec, date).state === "closed");
}

function parseRule(part: string): Rule | null {
  const tokens = part.split(/\s+/);
  let days: Set<number> | null = null;
  let holiday = false;
  let rest = tokens;

  // A leading selector: "Mo-Fr", "Sa,Su", "PH", "Mo-Fr,PH".
  if (tokens.length > 0 && /^[A-Za-z]/.test(tokens[0]) && !/^(off|closed)$/i.test(tokens[0])) {
    const selector = parseSelector(tokens[0]);
    if (!selector) return null;
    days = selector.days;
    holiday = selector.holiday;
    rest = tokens.slice(1);
  }

  const body = rest.join(" ").trim();
  if (/^(off|closed)$/i.test(body)) return { days, holiday, windows: null };
  if (body.length === 0) {
    // "Mo-Fr" alone: open all day on those days.
    return days || holiday ? { days, holiday, windows: [{ from: 0, to: 1440 }] } : null;
  }
  const windows = parseWindows(body);
  if (!windows) return null;
  return { days, holiday, windows };
}

function parseSelector(text: string): { days: Set<number> | null; holiday: boolean } | null {
  const days = new Set<number>();
  let holiday = false;
  for (const piece of text.split(",")) {
    const item = piece.trim().toLowerCase();
    if (item === "ph") {
      holiday = true;
      continue;
    }
    const range = /^([a-z]{2})(?:-([a-z]{2}))?$/.exec(item);
    if (!range) return null;
    const from = DAYS.indexOf(range[1] as (typeof DAYS)[number]);
    const to = range[2] ? DAYS.indexOf(range[2] as (typeof DAYS)[number]) : from;
    if (from < 0 || to < 0) return null;
    // Week order is Monday first, so "Fr-Mo" wraps over the weekend.
    for (let d = from; ; d = (d + 1) % 7) {
      days.add(d);
      if (d === to) break;
    }
  }
  return { days: days.size > 0 ? days : null, holiday };
}

function parseWindows(text: string): OpenWindow[] | null {
  const windows: OpenWindow[] = [];
  for (const piece of text.split(",")) {
    const match = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/.exec(piece.trim());
    if (!match) return null;
    const from = Number(match[1]) * 60 + Number(match[2]);
    let to = Number(match[3]) * 60 + Number(match[4]);
    if (from >= 1440 || to > 1440 || Number(match[2]) >= 60 || Number(match[4]) >= 60) return null;
    if (to <= from) to += 1440;
    windows.push({ from, to });
  }
  return windows.sort((a, b) => a.from - b.from);
}

function weekdayOf(date: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const at = new Date(`${date}T12:00:00Z`);
  return Number.isNaN(at.getTime()) ? null : at.getUTCDay();
}

/** "10:00–18:00" for one window, for a chip. */
export function windowText(window: OpenWindow): string {
  const clock = (m: number) => {
    const minutes = m % 1440;
    return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
  };
  return `${clock(window.from)}–${window.to === 1440 ? "24:00" : clock(window.to)}`;
}
