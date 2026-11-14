/**
 * The file a trip or an idea collection is written to and read back
 * from (`exchange.ts`).
 *
 * Typed and versioned: `format` says what the file holds, `version`
 * which shape it has. A reader refuses a version it does not know
 * rather than guessing, and says so in words. The shapes below are the
 * contract; `readTripFile` and `readIdeasFile` check an incoming file
 * against them field by field, so a mistake names the place it sits
 * ("reise.legs[1].days[0].blocks[0].stops[2].lat: Zahl erwartet").
 *
 * What the file never holds: row ids and account ids. Both mean
 * nothing on another system (or to another person on this one), so
 * the order of a list stands for its position and an import writes
 * new rows. For the same reason it leaves out what belongs to people
 * rather than to the plan: who it is shared with, the votes, the
 * visits, the change journal, splits and linked documents.
 *
 * Pure: no database, no Encore. Everything the endpoints need to turn
 * an unknown JSON value into a checked file lives here.
 */

import { isPriority, type IdeaPriority } from "./priority";
import { PIN_REASONS, type PinReason } from "./pin-reason";
import type { PlacedBy } from "./placed-by";
import type { TransportMode } from "./travel";

export const TRIP_FORMAT = "f4mil.trip";
export const IDEAS_FORMAT = "f4mil.ideas";
/** Everything of the trip planner in one file: every trip and the ideas. */
export const PLANNER_FORMAT = "f4mil.tripplanner";
/** The newest version this server writes and the newest it reads. */
export const EXCHANGE_VERSION = 1;

/** Generous bounds: a file past them is not a trip, it is a mistake. */
export const EXCHANGE_LIMITS = {
  trips: 500,
  legs: 100,
  daysPerLeg: 200,
  blocksPerDay: 30,
  stopsPerBlock: 100,
  poolPerLeg: 2_000,
  ideas: 10_000,
  text: 10_000,
} as const;

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export interface ExchangePoint {
  lat: number;
  lon: number;
}

export interface ExchangeExtent {
  end: ExchangePoint;
  lengthM?: number | null;
  ascentM?: number | null;
}

/** What a place is, wherever it stands: pool, day or idea collection. */
export interface ExchangeSpot {
  /** OpenStreetMap reference ("node:123") or `manual:…` for a find without one. */
  osmRef: string;
  name: string | null;
  localName: string | null;
  lat: number;
  lon: number;
  category: string;
  /** The OSM tag behind the category ("building=church"). */
  kind: string | null;
  dwellMinutes: number;
  note: string | null;
  sourceUrl: string | null;
  wikipediaUrl: string | null;
  facadeAzimuth: number | null;
  extent: ExchangeExtent | null;
}

export interface ExchangeStop extends ExchangeSpot {
  /** search | manual */
  origin: string;
  priority: IdeaPriority;
  openingHours: string | null;
  status: "planned" | "done" | "skipped";
  pinned: boolean;
  doneAt: string | null;
  placedBy: PlacedBy;
  travelMinutes: number;
  travelDistanceM: number;
  reasons: string[];
}

export interface ExchangeBlock {
  /** "morning", "day", "excursion:<id>" … — fixpoints and breaks refer to it. */
  templateId: string;
  label: string;
  kind: string;
  budgetMinutes: number;
  startMinutes: number | null;
  stops: ExchangeStop[];
}

export interface ExchangeFixpoint {
  kind: "appointment" | "departure";
  label: string;
  startMinutes: number;
  durationMinutes: number;
  travelMinutes: number;
  bufferMinutes: number;
  lat: number | null;
  lon: number | null;
  blockId: string | null;
  spotRef: string | null;
  pinReason: PinReason | null;
}

export interface ExchangeBreak {
  id: string;
  label: string;
  minutes: number;
  blockId: string;
  position: number;
}

export interface ExchangeExcursion {
  id: string;
  lat: number;
  lon: number;
  label: string | null;
  radiusM: number | null;
  departMinutes: number;
  returnMinutes: number;
  from?: string | null;
}

export interface ExchangeDayAnchor {
  lat: number;
  lon: number;
  label: string | null;
  radiusM: number | null;
  departMinutes: number | null;
  returnMinutes: number | null;
  waterDetourM: number | null;
  waterAround: string | null;
}

export interface ExchangeDay {
  detailed: boolean;
  bufferReason: string | null;
  anchor: ExchangeDayAnchor | null;
  breaks: ExchangeBreak[];
  excursions: ExchangeExcursion[];
  fixpoints: ExchangeFixpoint[];
  blocks: ExchangeBlock[];
}

export interface ExchangePoolEntry extends ExchangeSpot {
  origin: string;
  priority: IdeaPriority;
  openingHours: string | null;
  score: number;
  priorityBoost: number;
  unmatched: boolean;
  reasons: string[];
  searchScore: number | null;
}

export interface ExchangeSpotNote {
  osmRef: string;
  title: string | null;
  note: string | null;
  url: string | null;
  dwellMinutes: number | null;
  photoStop: boolean;
}

export interface ExchangeDismissedDayTrip {
  targetKey: string;
  name: string | null;
}

export interface ExchangeLeg {
  title: string | null;
  kind: "stay" | "transit";
  anchor: { lat: number; lon: number; label: string | null; radiusM: number | null };
  origin: { lat: number; lon: number; label: string | null } | null;
  arriveMinutes: number | null;
  departMinutes: number | null;
  endMinutes: number | null;
  mode: TransportMode;
  /** The OSM region database the leg was planned against. */
  regionDb: string;
  awaitingRegion: boolean;
  quartersAboard: boolean;
  tenderPort: boolean;
  departureNote: string | null;
  arrivalNote: string | null;
  /** YYYY-MM-DD, or null for "Tag 1, Tag 2, …". */
  startDate: string | null;
  radiusM: number | null;
  dayStartsAt: number | null;
  days: ExchangeDay[];
  pool: ExchangePoolEntry[];
  spotNotes: ExchangeSpotNote[];
  dismissedDayTrips: ExchangeDismissedDayTrip[];
}

/** Somebody on the trip without an account (a child, a friend). */
export interface ExchangeTraveller {
  label: string;
  birthDate: string | null;
  shortWalks: boolean;
  getsAbout: "foot" | "wheelchair" | "pram";
}

export interface ExchangeSegment {
  fromRef: string;
  toRef: string;
  mode: string;
  minutes: number;
  distanceM: number;
}

export interface ExchangeTrip {
  title: string | null;
  /** Pace, group, interests, day shape, ideas/voting flags — as stored. */
  constraints: Record<string, unknown>;
  home: { lat: number; lon: number; label: string | null } | null;
  travellers: ExchangeTraveller[];
  hiddenSpots: { osmRef: string; name: string | null }[];
  segments: ExchangeSegment[];
  legs: ExchangeLeg[];
}

export interface TripFile {
  format: "f4mil.trip";
  version: number;
  exportedAt: string;
  trip: ExchangeTrip;
}

export interface ExchangeIdea extends ExchangeSpot {
  /** What the family calls it, when that is not the map's name. */
  title: string | null;
  unmatched: boolean;
  photoStop: boolean;
  validFrom: string | null;
  validTo: string | null;
}

export interface IdeasFile {
  format: "f4mil.ideas";
  version: number;
  exportedAt: string;
  ideas: ExchangeIdea[];
}

/** Every trip the person is on and their own idea collection. */
export interface PlannerFile {
  format: "f4mil.tripplanner";
  version: number;
  exportedAt: string;
  trips: ExchangeTrip[];
  ideas: ExchangeIdea[];
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** A file that does not match the shape, with every place it went wrong. */
export class ExchangeFileError extends Error {
  constructor(readonly problems: string[]) {
    super(problems.slice(0, 5).join("; ") + (problems.length > 5 ? ` (und ${problems.length - 5} weitere)` : ""));
    this.name = "ExchangeFileError";
  }
}

/** Collects problems instead of stopping at the first. */
class Reader {
  readonly problems: string[] = [];

  fail(path: string, message: string): void {
    // Past fifty the list stops being useful and starts being slow.
    if (this.problems.length < 50) this.problems.push(`${path}: ${message}`);
  }

  object(v: unknown, path: string): Record<string, unknown> {
    if (v !== null && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
    this.fail(path, "Objekt erwartet");
    return {};
  }

  array(v: unknown, path: string, max: number): unknown[] {
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v)) {
      this.fail(path, "Liste erwartet");
      return [];
    }
    if (v.length > max) {
      this.fail(path, `höchstens ${max} Einträge, die Datei hat ${v.length}`);
      return v.slice(0, max);
    }
    return v;
  }

  string(v: unknown, path: string): string {
    if (typeof v === "string" && v.trim() !== "") return this.bounded(v, path);
    this.fail(path, "Text erwartet");
    return "";
  }

  optString(v: unknown, path: string): string | null {
    if (v === undefined || v === null) return null;
    if (typeof v === "string") return v === "" ? null : this.bounded(v, path);
    this.fail(path, "Text oder null erwartet");
    return null;
  }

  private bounded(v: string, path: string): string {
    if (v.length > EXCHANGE_LIMITS.text) {
      this.fail(path, `Text länger als ${EXCHANGE_LIMITS.text} Zeichen`);
      return v.slice(0, EXCHANGE_LIMITS.text);
    }
    return v;
  }

  number(v: unknown, path: string, range?: { min?: number; max?: number }): number {
    if (typeof v !== "number" || !Number.isFinite(v)) {
      this.fail(path, "Zahl erwartet");
      return 0;
    }
    if (range?.min !== undefined && v < range.min) this.fail(path, `mindestens ${range.min}`);
    if (range?.max !== undefined && v > range.max) this.fail(path, `höchstens ${range.max}`);
    return v;
  }

  optNumber(v: unknown, path: string, range?: { min?: number; max?: number }): number | null {
    if (v === undefined || v === null) return null;
    return this.number(v, path, range);
  }

  int(v: unknown, path: string, range?: { min?: number; max?: number }): number {
    const n = this.number(v, path, range);
    if (!Number.isInteger(n)) {
      this.fail(path, "ganze Zahl erwartet");
      return Math.round(n);
    }
    return n;
  }

  optInt(v: unknown, path: string, range?: { min?: number; max?: number }): number | null {
    if (v === undefined || v === null) return null;
    return this.int(v, path, range);
  }

  /** Minutes past midnight; a journey may run past the next midnight. */
  optMinutes(v: unknown, path: string): number | null {
    return this.optInt(v, path, { min: 0, max: 3 * 1440 });
  }

  bool(v: unknown, path: string, fallback = false): boolean {
    if (v === undefined || v === null) return fallback;
    if (typeof v === "boolean") return v;
    this.fail(path, "true oder false erwartet");
    return fallback;
  }

  oneOf<T extends string>(v: unknown, path: string, allowed: readonly T[], fallback?: T): T {
    if ((v === undefined || v === null) && fallback !== undefined) return fallback;
    if (typeof v === "string" && (allowed as readonly string[]).includes(v)) return v as T;
    this.fail(path, `einer von ${allowed.map((a) => `„${a}“`).join(", ")} erwartet`);
    return fallback ?? allowed[0];
  }

  date(v: unknown, path: string): string | null {
    if (v === undefined || v === null) return null;
    if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`))) {
      return v;
    }
    this.fail(path, "Datum als JJJJ-MM-TT erwartet");
    return null;
  }

  timestamp(v: unknown, path: string): string | null {
    if (v === undefined || v === null) return null;
    if (typeof v === "string" && !Number.isNaN(Date.parse(v))) return v;
    this.fail(path, "Zeitpunkt (ISO 8601) erwartet");
    return null;
  }

  lat(v: unknown, path: string): number {
    return this.number(v, path, { min: -90, max: 90 });
  }

  lon(v: unknown, path: string): number {
    return this.number(v, path, { min: -180, max: 180 });
  }

  strings(v: unknown, path: string): string[] {
    return this.array(v, path, 100).map((s, i) => this.string(s, `${path}[${i}]`));
  }
}

const MODES: readonly TransportMode[] = ["foot", "bike", "transit", "car", "ship", "plane"];
const STOP_STATUS = ["planned", "done", "skipped"] as const;
const PRIORITIES: readonly IdeaPriority[] = ["must", "want", "maybe"];
const PLACED_BY: readonly PlacedBy[] = ["hand", "fill"];
const GETS_ABOUT = ["foot", "wheelchair", "pram"] as const;

/** Format and version, before anything else is looked at. */
function header(r: Reader, raw: Record<string, unknown>, format: string, what: string): void {
  if (raw.format !== format) {
    const other = raw.format === TRIP_FORMAT
      ? "eine Reise"
      : raw.format === IDEAS_FORMAT
        ? "Ideen"
        : raw.format === PLANNER_FORMAT
          ? "alle Reisen und Ideen"
          : null;
    throw new ExchangeFileError([
      other
        ? `Die Datei enthält ${other}, hier wird eine ${what}-Datei erwartet.`
        : `Keine ${what}-Datei: „format“ muss „${format}“ sein.`,
    ]);
  }
  const version = raw.version;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
    throw new ExchangeFileError(["version: ganze Zahl ab 1 erwartet"]);
  }
  if (version > EXCHANGE_VERSION) {
    throw new ExchangeFileError([
      `Die Datei hat Version ${version}, dieser Server liest bis Version ${EXCHANGE_VERSION}. Bitte erst die App aktualisieren.`,
    ]);
  }
  r.timestamp(raw.exportedAt, "exportedAt");
}

function readExtent(r: Reader, v: unknown, path: string): ExchangeExtent | null {
  if (v === undefined || v === null) return null;
  const o = r.object(v, path);
  const end = r.object(o.end, `${path}.end`);
  return {
    end: { lat: r.lat(end.lat, `${path}.end.lat`), lon: r.lon(end.lon, `${path}.end.lon`) },
    lengthM: r.optNumber(o.lengthM, `${path}.lengthM`, { min: 0 }),
    ascentM: r.optNumber(o.ascentM, `${path}.ascentM`, { min: 0 }),
  };
}

function readSpot(r: Reader, o: Record<string, unknown>, path: string): ExchangeSpot {
  return {
    osmRef: r.string(o.osmRef, `${path}.osmRef`),
    name: r.optString(o.name, `${path}.name`),
    localName: r.optString(o.localName, `${path}.localName`),
    lat: r.lat(o.lat, `${path}.lat`),
    lon: r.lon(o.lon, `${path}.lon`),
    category: r.string(o.category, `${path}.category`),
    kind: r.optString(o.kind, `${path}.kind`),
    dwellMinutes: r.int(o.dwellMinutes, `${path}.dwellMinutes`, { min: 0, max: 1440 }),
    note: r.optString(o.note, `${path}.note`),
    sourceUrl: r.optString(o.sourceUrl, `${path}.sourceUrl`),
    wikipediaUrl: r.optString(o.wikipediaUrl, `${path}.wikipediaUrl`),
    facadeAzimuth: r.optNumber(o.facadeAzimuth, `${path}.facadeAzimuth`, { min: 0, max: 360 }),
    extent: readExtent(r, o.extent, `${path}.extent`),
  };
}

function readPriority(r: Reader, v: unknown, path: string): IdeaPriority {
  if (v === undefined || v === null) return "want";
  if (isPriority(v)) return v;
  return r.oneOf(v, path, PRIORITIES, "want");
}

function readStop(r: Reader, v: unknown, path: string): ExchangeStop {
  const o = r.object(v, path);
  return {
    ...readSpot(r, o, path),
    origin: r.optString(o.origin, `${path}.origin`) ?? "search",
    priority: readPriority(r, o.priority, `${path}.priority`),
    openingHours: r.optString(o.openingHours, `${path}.openingHours`),
    status: r.oneOf(o.status, `${path}.status`, STOP_STATUS, "planned"),
    pinned: r.bool(o.pinned, `${path}.pinned`),
    doneAt: r.timestamp(o.doneAt, `${path}.doneAt`),
    placedBy: r.oneOf(o.placedBy, `${path}.placedBy`, PLACED_BY, "hand"),
    travelMinutes: r.int(o.travelMinutes ?? 0, `${path}.travelMinutes`, { min: 0 }),
    travelDistanceM: r.int(o.travelDistanceM ?? 0, `${path}.travelDistanceM`, { min: 0 }),
    reasons: r.strings(o.reasons, `${path}.reasons`),
  };
}

function readBlock(r: Reader, v: unknown, path: string): ExchangeBlock {
  const o = r.object(v, path);
  return {
    templateId: r.string(o.templateId, `${path}.templateId`),
    label: r.string(o.label, `${path}.label`),
    kind: r.string(o.kind, `${path}.kind`),
    budgetMinutes: r.int(o.budgetMinutes, `${path}.budgetMinutes`, { min: 0, max: 1440 }),
    startMinutes: r.optMinutes(o.startMinutes, `${path}.startMinutes`),
    stops: r.array(o.stops, `${path}.stops`, EXCHANGE_LIMITS.stopsPerBlock)
      .map((s, i) => readStop(r, s, `${path}.stops[${i}]`)),
  };
}

function readFixpoint(r: Reader, v: unknown, path: string): ExchangeFixpoint {
  const o = r.object(v, path);
  const pinReason = o.pinReason === undefined || o.pinReason === null
    ? null
    : r.oneOf(o.pinReason, `${path}.pinReason`, PIN_REASONS);
  const lat = r.optNumber(o.lat, `${path}.lat`, { min: -90, max: 90 });
  const lon = r.optNumber(o.lon, `${path}.lon`, { min: -180, max: 180 });
  if ((lat === null) !== (lon === null)) r.fail(path, "lat und lon nur zusammen");
  return {
    kind: r.oneOf(o.kind, `${path}.kind`, ["appointment", "departure"] as const, "appointment"),
    label: r.string(o.label, `${path}.label`),
    startMinutes: r.int(o.startMinutes, `${path}.startMinutes`, { min: 0, max: 3 * 1440 }),
    durationMinutes: r.int(o.durationMinutes ?? 0, `${path}.durationMinutes`, { min: 0, max: 1440 }),
    travelMinutes: r.int(o.travelMinutes ?? 0, `${path}.travelMinutes`, { min: 0, max: 1440 }),
    bufferMinutes: r.int(o.bufferMinutes ?? 20, `${path}.bufferMinutes`, { min: 0, max: 1440 }),
    lat,
    lon,
    blockId: r.optString(o.blockId, `${path}.blockId`),
    spotRef: r.optString(o.spotRef, `${path}.spotRef`),
    pinReason,
  };
}

function readBreak(r: Reader, v: unknown, path: string): ExchangeBreak {
  const o = r.object(v, path);
  return {
    id: r.string(o.id, `${path}.id`),
    label: r.string(o.label, `${path}.label`),
    minutes: r.int(o.minutes, `${path}.minutes`, { min: 0, max: 1440 }),
    blockId: r.string(o.blockId, `${path}.blockId`),
    position: r.int(o.position, `${path}.position`, { min: 0 }),
  };
}

function readExcursion(r: Reader, v: unknown, path: string): ExchangeExcursion {
  const o = r.object(v, path);
  const excursion: ExchangeExcursion = {
    id: r.string(o.id, `${path}.id`),
    lat: r.lat(o.lat, `${path}.lat`),
    lon: r.lon(o.lon, `${path}.lon`),
    label: r.optString(o.label, `${path}.label`),
    radiusM: r.optInt(o.radiusM, `${path}.radiusM`, { min: 0 }),
    departMinutes: r.int(o.departMinutes, `${path}.departMinutes`, { min: 0, max: 3 * 1440 }),
    returnMinutes: r.int(o.returnMinutes, `${path}.returnMinutes`, { min: 0, max: 3 * 1440 }),
  };
  const from = r.optString(o.from, `${path}.from`);
  if (from !== null) excursion.from = from;
  return excursion;
}

function readDay(r: Reader, v: unknown, path: string): ExchangeDay {
  const o = r.object(v, path);
  let anchor: ExchangeDayAnchor | null = null;
  if (o.anchor !== undefined && o.anchor !== null) {
    const a = r.object(o.anchor, `${path}.anchor`);
    const p = `${path}.anchor`;
    anchor = {
      lat: r.lat(a.lat, `${p}.lat`),
      lon: r.lon(a.lon, `${p}.lon`),
      label: r.optString(a.label, `${p}.label`),
      radiusM: r.optInt(a.radiusM, `${p}.radiusM`, { min: 0 }),
      departMinutes: r.optMinutes(a.departMinutes, `${p}.departMinutes`),
      returnMinutes: r.optMinutes(a.returnMinutes, `${p}.returnMinutes`),
      waterDetourM: r.optInt(a.waterDetourM, `${p}.waterDetourM`, { min: 0 }),
      waterAround: r.optString(a.waterAround, `${p}.waterAround`),
    };
  }
  const blocks = r.array(o.blocks, `${path}.blocks`, EXCHANGE_LIMITS.blocksPerDay)
    .map((b, i) => readBlock(r, b, `${path}.blocks[${i}]`));
  const excursions = r.array(o.excursions, `${path}.excursions`, 50)
    .map((e, i) => readExcursion(r, e, `${path}.excursions[${i}]`));
  const excursionIds = new Set(excursions.map((e) => e.id));
  for (const [i, e] of excursions.entries()) {
    if (e.from && !excursionIds.has(e.from)) {
      r.fail(`${path}.excursions[${i}].from`, `kein Ausflug „${e.from}“ an diesem Tag`);
    }
  }
  return {
    detailed: r.bool(o.detailed, `${path}.detailed`, true),
    bufferReason: r.optString(o.bufferReason, `${path}.bufferReason`),
    anchor,
    breaks: r.array(o.breaks, `${path}.breaks`, 50).map((b, i) => readBreak(r, b, `${path}.breaks[${i}]`)),
    excursions,
    fixpoints: r.array(o.fixpoints, `${path}.fixpoints`, 50)
      .map((f, i) => readFixpoint(r, f, `${path}.fixpoints[${i}]`)),
    blocks,
  };
}

function readPoolEntry(r: Reader, v: unknown, path: string): ExchangePoolEntry {
  const o = r.object(v, path);
  return {
    ...readSpot(r, o, path),
    origin: r.optString(o.origin, `${path}.origin`) ?? "search",
    priority: readPriority(r, o.priority, `${path}.priority`),
    openingHours: r.optString(o.openingHours, `${path}.openingHours`),
    score: r.number(o.score ?? 0, `${path}.score`),
    priorityBoost: r.number(o.priorityBoost ?? 0, `${path}.priorityBoost`),
    unmatched: r.bool(o.unmatched, `${path}.unmatched`),
    reasons: r.strings(o.reasons, `${path}.reasons`),
    searchScore: r.optNumber(o.searchScore, `${path}.searchScore`),
  };
}

function readLeg(r: Reader, v: unknown, path: string): ExchangeLeg {
  const o = r.object(v, path);
  const a = r.object(o.anchor, `${path}.anchor`);
  let origin: ExchangeLeg["origin"] = null;
  if (o.origin !== undefined && o.origin !== null) {
    const g = r.object(o.origin, `${path}.origin`);
    origin = {
      lat: r.lat(g.lat, `${path}.origin.lat`),
      lon: r.lon(g.lon, `${path}.origin.lon`),
      label: r.optString(g.label, `${path}.origin.label`),
    };
  }
  const pool = r.array(o.pool, `${path}.pool`, EXCHANGE_LIMITS.poolPerLeg)
    .map((p, i) => readPoolEntry(r, p, `${path}.pool[${i}]`));
  const seen = new Set<string>();
  for (const [i, p] of pool.entries()) {
    if (seen.has(p.osmRef)) r.fail(`${path}.pool[${i}].osmRef`, `„${p.osmRef}“ steht doppelt in den Ideen`);
    seen.add(p.osmRef);
  }
  const notes = r.array(o.spotNotes, `${path}.spotNotes`, EXCHANGE_LIMITS.poolPerLeg).map((n, i) => {
    const p = `${path}.spotNotes[${i}]`;
    const x = r.object(n, p);
    return {
      osmRef: r.string(x.osmRef, `${p}.osmRef`),
      title: r.optString(x.title, `${p}.title`),
      note: r.optString(x.note, `${p}.note`),
      url: r.optString(x.url, `${p}.url`),
      dwellMinutes: r.optInt(x.dwellMinutes, `${p}.dwellMinutes`, { min: 0, max: 1440 }),
      photoStop: r.bool(x.photoStop, `${p}.photoStop`),
    };
  });
  const dismissed = r.array(o.dismissedDayTrips, `${path}.dismissedDayTrips`, 500).map((d, i) => {
    const p = `${path}.dismissedDayTrips[${i}]`;
    const x = r.object(d, p);
    return { targetKey: r.string(x.targetKey, `${p}.targetKey`), name: r.optString(x.name, `${p}.name`) };
  });
  return {
    title: r.optString(o.title, `${path}.title`),
    kind: r.oneOf(o.kind, `${path}.kind`, ["stay", "transit"] as const, "stay"),
    anchor: {
      lat: r.lat(a.lat, `${path}.anchor.lat`),
      lon: r.lon(a.lon, `${path}.anchor.lon`),
      label: r.optString(a.label, `${path}.anchor.label`),
      radiusM: r.optInt(a.radiusM, `${path}.anchor.radiusM`, { min: 0 }),
    },
    origin,
    arriveMinutes: r.optMinutes(o.arriveMinutes, `${path}.arriveMinutes`),
    departMinutes: r.optMinutes(o.departMinutes, `${path}.departMinutes`),
    endMinutes: r.optMinutes(o.endMinutes, `${path}.endMinutes`),
    mode: r.oneOf(o.mode, `${path}.mode`, MODES, "foot"),
    regionDb: r.string(o.regionDb, `${path}.regionDb`),
    awaitingRegion: r.bool(o.awaitingRegion, `${path}.awaitingRegion`),
    quartersAboard: r.bool(o.quartersAboard, `${path}.quartersAboard`),
    tenderPort: r.bool(o.tenderPort, `${path}.tenderPort`),
    departureNote: r.optString(o.departureNote, `${path}.departureNote`),
    arrivalNote: r.optString(o.arrivalNote, `${path}.arrivalNote`),
    startDate: r.date(o.startDate, `${path}.startDate`),
    radiusM: r.optInt(o.radiusM, `${path}.radiusM`, { min: 0 }),
    dayStartsAt: r.optMinutes(o.dayStartsAt, `${path}.dayStartsAt`),
    days: r.array(o.days, `${path}.days`, EXCHANGE_LIMITS.daysPerLeg).map((d, i) => readDay(r, d, `${path}.days[${i}]`)),
    pool,
    spotNotes: notes,
    dismissedDayTrips: dismissed,
  };
}

function readTrip(r: Reader, v: unknown, path: string): ExchangeTrip {
  const o = r.object(v, path);
  let home: ExchangeTrip["home"] = null;
  if (o.home !== undefined && o.home !== null) {
    const h = r.object(o.home, `${path}.home`);
    home = {
      lat: r.lat(h.lat, `${path}.home.lat`),
      lon: r.lon(h.lon, `${path}.home.lon`),
      label: r.optString(h.label, `${path}.home.label`),
    };
  }
  const constraints = o.constraints === undefined || o.constraints === null
    ? {}
    : r.object(o.constraints, `${path}.constraints`);
  const legs = r.array(o.legs, `${path}.legs`, EXCHANGE_LIMITS.legs).map((l, i) => readLeg(r, l, `${path}.legs[${i}]`));
  if (legs.length === 0) r.fail(`${path}.legs`, "eine Reise braucht mindestens einen Aufenthalt");
  return {
    title: r.optString(o.title, `${path}.title`),
    constraints,
    home,
    travellers: r.array(o.travellers, `${path}.travellers`, 50).map((t, i) => {
      const p = `${path}.travellers[${i}]`;
      const x = r.object(t, p);
      return {
        label: r.string(x.label, `${p}.label`),
        birthDate: r.date(x.birthDate, `${p}.birthDate`),
        shortWalks: r.bool(x.shortWalks, `${p}.shortWalks`),
        getsAbout: r.oneOf(x.getsAbout, `${p}.getsAbout`, GETS_ABOUT, "foot"),
      };
    }),
    hiddenSpots: r.array(o.hiddenSpots, `${path}.hiddenSpots`, 5_000).map((h, i) => {
      const p = `${path}.hiddenSpots[${i}]`;
      const x = r.object(h, p);
      return { osmRef: r.string(x.osmRef, `${p}.osmRef`), name: r.optString(x.name, `${p}.name`) };
    }),
    segments: r.array(o.segments, `${path}.segments`, 5_000).map((s, i) => {
      const p = `${path}.segments[${i}]`;
      const x = r.object(s, p);
      return {
        fromRef: r.string(x.fromRef, `${p}.fromRef`),
        toRef: r.string(x.toRef, `${p}.toRef`),
        mode: r.string(x.mode, `${p}.mode`),
        minutes: r.int(x.minutes, `${p}.minutes`, { min: 0 }),
        distanceM: r.int(x.distanceM, `${p}.distanceM`, { min: 0 }),
      };
    }),
    legs,
  };
}

/** Check an unknown JSON value against the trip file; throws `ExchangeFileError`. */
export function readTripFile(input: unknown): TripFile {
  const r = new Reader();
  const raw = r.object(input, "Datei");
  if (r.problems.length > 0) throw new ExchangeFileError(r.problems);
  header(r, raw, TRIP_FORMAT, "Reise");
  const trip = readTrip(r, raw.trip, "reise");
  if (r.problems.length > 0) throw new ExchangeFileError(r.problems);
  return {
    format: TRIP_FORMAT,
    version: raw.version as number,
    exportedAt: typeof raw.exportedAt === "string" ? raw.exportedAt : new Date().toISOString(),
    trip,
  };
}

function readIdeas(r: Reader, v: unknown, base: string): ExchangeIdea[] {
  return r.array(v, base, EXCHANGE_LIMITS.ideas).map((item, i) => {
    const path = `${base}[${i}]`;
    const o = r.object(item, path);
    const idea: ExchangeIdea = {
      ...readSpot(r, o, path),
      title: r.optString(o.title, `${path}.title`),
      unmatched: r.bool(o.unmatched, `${path}.unmatched`),
      photoStop: r.bool(o.photoStop, `${path}.photoStop`),
      validFrom: r.date(o.validFrom, `${path}.validFrom`),
      validTo: r.date(o.validTo, `${path}.validTo`),
    };
    if (idea.validFrom && idea.validTo && idea.validTo < idea.validFrom) {
      r.fail(`${path}.validTo`, "liegt vor validFrom");
    }
    return idea;
  });
}

/** Check an unknown JSON value against the ideas file; throws `ExchangeFileError`. */
export function readIdeasFile(input: unknown): IdeasFile {
  const r = new Reader();
  const raw = r.object(input, "Datei");
  if (r.problems.length > 0) throw new ExchangeFileError(r.problems);
  header(r, raw, IDEAS_FORMAT, "Ideen");
  const ideas = readIdeas(r, raw.ideas, "ideen");
  if (r.problems.length > 0) throw new ExchangeFileError(r.problems);
  return {
    format: IDEAS_FORMAT,
    version: raw.version as number,
    exportedAt: typeof raw.exportedAt === "string" ? raw.exportedAt : new Date().toISOString(),
    ideas,
  };
}

/** Check an unknown JSON value against the whole-planner file; throws `ExchangeFileError`. */
export function readPlannerFile(input: unknown): PlannerFile {
  const r = new Reader();
  const raw = r.object(input, "Datei");
  if (r.problems.length > 0) throw new ExchangeFileError(r.problems);
  header(r, raw, PLANNER_FORMAT, "Reiseplaner");
  const trips = r.array(raw.trips, "reisen", EXCHANGE_LIMITS.trips)
    .map((t, i) => readTrip(r, t, `reisen[${i}]`));
  const ideas = readIdeas(r, raw.ideas, "ideen");
  if (r.problems.length > 0) throw new ExchangeFileError(r.problems);
  return {
    format: PLANNER_FORMAT,
    version: raw.version as number,
    exportedAt: typeof raw.exportedAt === "string" ? raw.exportedAt : new Date().toISOString(),
    trips,
    ideas,
  };
}
