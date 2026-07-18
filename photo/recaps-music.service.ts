/**
 * Rueckblick-Musik — kuratierte, selbst gehostete Hintergrund-Tracks.
 *
 * Die Tracks liegen als Audiodateien in Mood-Unterordnern unter
 * RECAPS_MUSIC_DIR (Default: /mnt/data/recap-music):
 *
 *   recap-music/
 *   ├── upbeat/     — treibend, fuer Reisen & Highlights
 *   ├── warm/       — warm, fuer Personen-Rueckblicke
 *   ├── nostalgic/  — nostalgisch, fuer "Heute vor X Jahren"
 *   └── calm/       — ruhig, fuer Orte & Themen
 *
 * Es gibt bewusst keine Datenbanktabelle und kein Manifest: Dateien in den
 * Ordner legen genuegt. Titel werden aus dem Dateinamen abgeleitet, die
 * Zuordnung Recap-Art → Mood ist fest kodiert, und die Track-Auswahl pro
 * Rueckblick ist deterministisch (gleicher Rueckblick → gleicher Track).
 */

import * as fs from "fs";
import * as path from "path";
import type { RecapKind } from "./recaps.service";

export const RECAPS_MUSIC_DIR = path.resolve(
  process.env.RECAPS_MUSIC_DIR || "/mnt/data/recap-music"
);

export type RecapMood = "upbeat" | "warm" | "nostalgic" | "calm";

export const RECAP_MOODS: RecapMood[] = [
  "upbeat",
  "warm",
  "nostalgic",
  "calm",
];

/** Audio formats the web <audio> element and AVAudioPlayer both handle. */
const AUDIO_EXTENSIONS = new Map<string, string>([
  [".mp3", "audio/mpeg"],
  [".m4a", "audio/mp4"],
  [".aac", "audio/aac"],
  [".ogg", "audio/ogg"],
  [".wav", "audio/wav"],
]);

export interface MusicTrack {
  /** Stable id: `<mood>/<filename>` — doubles as the streaming path suffix. */
  id: string;
  mood: RecapMood;
  /** Human-readable title derived from the filename. */
  title: string;
  /** API path the clients stream from (relative, without host). */
  url: string;
}

/** Which mood backs which recap kind. */
export function moodForKind(kind: RecapKind): RecapMood {
  switch (kind) {
    case "trip":
    case "recent_highlights":
      return "upbeat";
    case "person":
      return "warm";
    case "on_this_day":
    case "scene_then_now":
      return "nostalgic";
    case "place":
    case "theme":
      return "calm";
  }
}

/** "01_sunny-road_trip.mp3" → "Sunny Road Trip" */
function titleFromFilename(filename: string): string {
  const base = path.basename(filename, path.extname(filename));
  const cleaned = base
    .replace(/^\d+[-_. ]*/, "") // strip leading track numbers
    .replace(/[-_.]+/g, " ")
    .trim();
  if (!cleaned) return base;
  return cleaned
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export function audioMimeType(filename: string): string | null {
  return AUDIO_EXTENSIONS.get(path.extname(filename).toLowerCase()) ?? null;
}

/**
 * Scan the music directory. A missing directory is not an error — recaps
 * simply play without music until someone drops files in.
 */
export async function listMusicTracks(
  dir: string = RECAPS_MUSIC_DIR
): Promise<MusicTrack[]> {
  const tracks: MusicTrack[] = [];
  for (const mood of RECAP_MOODS) {
    const moodDir = path.join(dir, mood);
    let entries: string[];
    try {
      entries = await fs.promises.readdir(moodDir);
    } catch {
      continue;
    }
    for (const entry of entries.sort()) {
      if (entry.startsWith(".")) continue;
      if (!audioMimeType(entry)) continue;
      const id = `${mood}/${entry}`;
      tracks.push({
        id,
        mood,
        title: titleFromFilename(entry),
        url: `/recaps-music/file/${encodeURIComponent(mood)}/${encodeURIComponent(entry)}`,
      });
    }
  }
  return tracks;
}

/**
 * Deterministically pick a track for a recap: prefer the kind's mood, fall
 * back to the whole pool so a sparsely filled music folder still yields
 * music everywhere. Returns null when no tracks exist at all.
 */
export function pickTrackForRecap(
  tracks: MusicTrack[],
  kind: RecapKind,
  recapId: number
): MusicTrack | null {
  if (tracks.length === 0) return null;
  const mood = moodForKind(kind);
  const pool = tracks.filter((t) => t.mood === mood);
  const effective = pool.length > 0 ? pool : tracks;
  // Simple multiplicative hash so consecutive recap ids don't all land on
  // the first track.
  const idx = Math.abs((recapId * 2654435761) % effective.length);
  return effective[idx] ?? null;
}

/**
 * Resolve a `<mood>/<filename>` track path to an absolute on-disk path.
 * Rejects traversal attempts and anything outside the known mood folders.
 * Returns null when the file does not exist.
 */
export async function resolveMusicFilePath(
  trackPath: string,
  dir: string = RECAPS_MUSIC_DIR
): Promise<string | null> {
  const segments = trackPath.split("/").filter((s) => s.length > 0);
  if (segments.length !== 2) return null;
  const [mood, filename] = segments;
  if (!RECAP_MOODS.includes(mood as RecapMood)) return null;
  if (!filename || filename.startsWith(".") || !audioMimeType(filename)) {
    return null;
  }

  const abs = path.resolve(dir, mood, filename);
  const rootWithSep = dir.endsWith(path.sep) ? dir : dir + path.sep;
  if (!abs.startsWith(rootWithSep)) return null;

  try {
    const stat = await fs.promises.stat(abs);
    if (!stat.isFile()) return null;
    return abs;
  } catch {
    return null;
  }
}
