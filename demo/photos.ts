/**
 * The photos of the demo household (documentation/plans/demodaten.md,
 * stage 4): what was photographed when, with which camera and where. No
 * database and no network here: the plan says "a beach photo on the third
 * day of the summer holiday at this spot", the sources (`photo-sources.ts`)
 * find or draw the picture, the writer (`photo-writer.ts`) gives it this
 * EXIF and imports it.
 *
 * The household's year: a winter holiday in the mountains, a city trip in
 * spring, a summer holiday at the sea, the garden from spring to autumn,
 * two birthdays, Christmas and New Year's Eve, and everyday pictures in
 * between. Places only for the trips, at public squares and landmarks;
 * photos taken at home carry no position, as the household's address is
 * invented.
 */

import { createRandom, type Random } from "./random";
import type { DemoSize, HouseholdPlan } from "./household";

/** What a photo shows: the search term for Openverse and the scene the generator draws. */
export type PhotoTopic =
  | "beach"
  | "mountains"
  | "snow"
  | "city"
  | "landscape"
  | "garden"
  | "food"
  | "animals"
  | "sports"
  | "celebration"
  | "christmas"
  | "fireworks";

export const PHOTO_TOPICS: readonly PhotoTopic[] = [
  "beach", "mountains", "snow", "city", "landscape", "garden",
  "food", "animals", "sports", "celebration", "christmas", "fireworks",
];

export interface Camera {
  make: string;
  model: string;
}

/** Everyday pictures come from the phones, holidays from the camera. */
const PHONES: readonly Camera[] = [
  { make: "Apple", model: "iPhone 13" },
  { make: "Google", model: "Pixel 7" },
];
const CAMERA: Camera = { make: "FUJIFILM", model: "X-T30" };

interface Spot {
  name: string;
  lat: number;
  lon: number;
}

/** The invented trips go to public places only: squares, promenades, viewpoints. */
const TRIPS = {
  summer: {
    label: "Sommerurlaub",
    spots: [
      { name: "Praça do Comércio, Lissabon", lat: 38.7075, lon: -9.1364 },
      { name: "Praia da Rocha, Portimão", lat: 37.1176, lon: -8.5376 },
      { name: "Cabo de São Vicente", lat: 37.0227, lon: -8.9965 },
    ],
  },
  winter: {
    label: "Winterurlaub",
    spots: [
      { name: "Bahnhofstrasse, Zermatt", lat: 46.0207, lon: 7.7491 },
      { name: "Gornergrat", lat: 45.9833, lon: 7.7845 },
    ],
  },
  cityA: {
    label: "Städtereise Kopenhagen",
    spots: [
      { name: "Nyhavn, Kopenhagen", lat: 55.6798, lon: 12.5907 },
      { name: "Rådhuspladsen, Kopenhagen", lat: 55.6759, lon: 12.5691 },
    ],
  },
  cityB: {
    label: "Städtereise Wien",
    spots: [
      { name: "Stephansplatz, Wien", lat: 48.2085, lon: 16.3731 },
      { name: "Heldenplatz, Wien", lat: 48.2066, lon: 16.3634 },
    ],
  },
} satisfies Record<string, { label: string; spots: Spot[] }>;

/** One of the albums the generator makes; the app suggests its own beside them. */
export interface PlannedAlbum {
  key: string;
  name: string;
}

export interface PlannedShot {
  /** Position in the plan, 0-based: also the order the sources fill. */
  index: number;
  topic: PhotoTopic;
  /** Local wall time, "YYYY-MM-DD HH:MM:SS", as a camera writes it. */
  takenAt: string;
  camera: Camera;
  gps: { lat: number; lon: number } | null;
  /** The album the shot goes into, by `PlannedAlbum.key`. */
  album: string | null;
}

export interface PhotoPlan {
  shots: PlannedShot[];
  albums: PlannedAlbum[];
}

const SIZES: Record<DemoSize, number> = { full: 500, small: 12 };

/** A stretch of days the household photographs, with what it photographs and how much. */
interface PhotoEvent {
  from: string;
  to: string;
  topics: readonly PhotoTopic[];
  weight: number;
  hours: [number, number];
  camera: "phone" | "camera";
  spots: readonly Spot[] | null;
  album: PlannedAlbum | null;
}

function iso(y: number, m: number, d: number): string {
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return `${y}-${String(m + 1).padStart(2, "0")}-${String(Math.min(d, last)).padStart(2, "0")}`;
}

function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86_400_000);
}

function eventsOfYear(y: number): PhotoEvent[] {
  const city = y % 2 === 0 ? TRIPS.cityA : TRIPS.cityB;
  return [
    {
      from: iso(y, 1, 10), to: iso(y, 1, 16), topics: ["snow", "mountains", "sports", "food"], weight: 12,
      hours: [9, 17], camera: "camera", spots: TRIPS.winter.spots,
      album: { key: `winter-${y}`, name: `${TRIPS.winter.label} ${y}` },
    },
    {
      from: iso(y, 4, 1), to: iso(y, 4, 4), topics: ["city", "food"], weight: 8,
      hours: [10, 21], camera: "camera", spots: city.spots,
      album: { key: `city-${y}`, name: `${city.label} ${y}` },
    },
    {
      from: iso(y, 6, 25), to: iso(y, 7, 8), topics: ["beach", "landscape", "food", "city"], weight: 22,
      hours: [9, 21], camera: "camera", spots: TRIPS.summer.spots,
      album: { key: `summer-${y}`, name: `${TRIPS.summer.label} ${y}` },
    },
    {
      from: iso(y, 3, 1), to: iso(y, 8, 30), topics: ["garden"], weight: 14,
      hours: [10, 19], camera: "phone", spots: null,
      album: { key: "garden", name: "Garten" },
    },
    { from: iso(y, 2, 14), to: iso(y, 2, 14), topics: ["celebration", "food"], weight: 3, hours: [14, 20], camera: "phone", spots: null, album: null },
    { from: iso(y, 8, 9), to: iso(y, 8, 9), topics: ["celebration", "food"], weight: 3, hours: [14, 20], camera: "phone", spots: null, album: null },
    {
      from: iso(y, 11, 24), to: iso(y, 11, 26), topics: ["christmas", "food", "snow"], weight: 6,
      hours: [16, 22], camera: "phone", spots: null,
      album: { key: "christmas", name: "Weihnachten" },
    },
    { from: iso(y, 11, 31), to: iso(y, 11, 31), topics: ["fireworks"], weight: 2, hours: [23, 23], camera: "phone", spots: null, album: null },
    {
      from: iso(y, 0, 1), to: iso(y, 11, 31), topics: ["food", "animals", "sports", "landscape"], weight: 30,
      hours: [8, 20], camera: "phone", spots: null, album: null,
    },
  ];
}

function clip(e: PhotoEvent, from: string, to: string): PhotoEvent | null {
  const a = e.from > from ? e.from : from;
  const b = e.to < to ? e.to : to;
  if (a > b) return null;
  // A trip that is only partly in the span counts for the days that are.
  const share = (daysBetween(a, b) + 1) / (daysBetween(e.from, e.to) + 1);
  return { ...e, from: a, to: b, weight: e.weight * share };
}

function time(rnd: Random, [h0, h1]: [number, number]): string {
  const h = rnd.int(h0, h1);
  const m = h === 23 && h0 === 23 ? rnd.int(45, 59) : rnd.int(0, 59);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(rnd.int(0, 59)).padStart(2, "0")}`;
}

function jitter(rnd: Random, v: number): number {
  return Math.round((v + (rnd.next() - 0.5) * 0.004) * 1e6) / 1e6;
}

/**
 * Plans the household's photos over the span of its bookings. The same seed
 * gives the same shots; the count follows the size (500 or 12).
 */
export function planPhotos(seed: number, size: DemoSize, plan: Pick<HouseholdPlan, "from" | "to">): PhotoPlan {
  const rnd = createRandom(seed ^ 0xf070);
  const total = SIZES[size];
  const fy = Number(plan.from.slice(0, 4));
  const ty = Number(plan.to.slice(0, 4));
  const events: PhotoEvent[] = [];
  for (let y = fy; y <= ty; y++) {
    for (const e of eventsOfYear(y)) {
      const c = clip(e, plan.from, plan.to);
      if (c) events.push(c);
    }
  }

  // Shares by weight, rounded so they add up to the total.
  const weight = events.reduce((s, e) => s + e.weight, 0);
  const counts = events.map((e) => Math.floor((e.weight / weight) * total));
  let left = total - counts.reduce((s, n) => s + n, 0);
  const order = events.map((e, i) => i).sort((a, b) => events[b].weight - events[a].weight);
  for (let k = 0; left > 0; k++, left--) counts[order[k % order.length]] += 1;

  const drafts: Omit<PlannedShot, "index">[] = [];
  const albums = new Map<string, PlannedAlbum>();
  events.forEach((e, i) => {
    const span = daysBetween(e.from, e.to);
    for (let n = 0; n < counts[i]; n++) {
      const day = addDays(e.from, rnd.int(0, span));
      const spot = e.spots ? rnd.pick(e.spots) : null;
      drafts.push({
        topic: rnd.pick(e.topics),
        takenAt: `${day} ${time(rnd, e.hours)}`,
        camera: e.camera === "camera" ? CAMERA : rnd.pick(PHONES),
        gps: spot ? { lat: jitter(rnd, spot.lat), lon: jitter(rnd, spot.lon) } : null,
        album: e.album?.key ?? null,
      });
      if (e.album) albums.set(e.album.key, e.album);
    }
  });

  // Five albums: the latest holiday of each kind, the garden and Christmas.
  // The earlier holidays stay without one, as in most real archives.
  const latest = new Map<string, string>();
  for (const key of albums.keys()) {
    const kind = key.replace(/-\d{4}$/, "");
    if (!latest.has(kind) || key > latest.get(kind)!) latest.set(kind, key);
  }
  const kept = new Set(latest.values());
  for (const d of drafts) if (d.album && !kept.has(d.album)) d.album = null;

  drafts.sort((a, b) => a.takenAt.localeCompare(b.takenAt));
  const used = new Set(drafts.map((d) => d.album).filter((k): k is string => k !== null));
  return {
    shots: drafts.map((d, index) => ({ ...d, index })),
    albums: [...albums.values()].filter((a) => used.has(a.key)),
  };
}
