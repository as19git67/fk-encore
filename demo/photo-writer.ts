/**
 * Lays the demo photos down (documentation/plans/demodaten.md, stage 4):
 * finds or draws a picture for each planned shot, writes the shot's EXIF
 * (date, camera, position — never the original's), imports the folder
 * through a photo library like any archive, so thumbnails, embeddings,
 * aesthetics, duplicates and groups come from the real pipeline, and makes
 * the five albums.
 *
 * The library imports in "move" mode: the files end up in the app's photo
 * storage and the staging folder and the library are gone afterwards.
 * Every photo and album is registered; the chosen photos with their source
 * and licence go to `demo_photo`, so the next run loads the same set.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { and, desc, eq, inArray, lt } from "drizzle-orm";
import { exiftool } from "exiftool-vendored";
import log from "encore.dev/log";
import db from "../db/database";
import { albumPhotos, albums, demoPhoto, photos } from "../db/schema";
import { createLibrary, deleteLibrary, PHOTO_LIBRARIES_ROOT, scanLibrary } from "../photo/libraries.service";
import { hardDeletePhotoLogic } from "../photo/photo.service";
import {
  defaultPhotoDeps,
  downloadPhoto,
  drawPhoto,
  hasRecognisableFace,
  OPENVERSE_QUERIES,
  searchOpenverse,
  type OpenverseCandidate,
  type PhotoDeps,
} from "./photo-sources";
import { PHOTO_TOPICS, type PhotoPlan, type PhotoTopic, type PlannedShot } from "./photos";
import { register } from "./registry";
import { DemoCancelled, type WriteHooks } from "./writer";

export type PhotoSource = "openverse" | "drawn";

export interface WrittenPhotos {
  photos: number;
  openverse: number;
  drawn: number;
  albums: number;
  /** Why some or all photos were drawn although Openverse was asked for; null otherwise. */
  fallback: string | null;
}

/** Why the shots without a fitting candidate were drawn, for the Systemstatus card. */
function shortfallNote(usedUp: PhotoTopic[], faces: number, broken: number): string {
  const parts = [
    usedUp.length === PHOTO_TOPICS.length ? "Treffer aller Themen aufgebraucht" : usedUp.length ? `Treffer aufgebraucht für ${usedUp.join(", ")}` : null,
    faces ? `${faces} mit Gesicht verworfen` : null,
    broken ? `${broken} nicht ladbar` : null,
  ].filter((p): p is string => p !== null);
  return parts.join("; ") || "keine passenden Treffer";
}

/** Pages of 20 searched per query before the topic's next query is tried. */
const MAX_PAGES = 10;
/**
 * Candidates tried for one shot before it is drawn instead. Many fall away
 * (a face, a dead link), so this is generous: a drawn picture is the last resort.
 */
const MAX_TRIES = 30;

interface Chosen {
  shot: PlannedShot;
  fileName: string;
  candidate: OpenverseCandidate | null;
}

/** The Openverse candidates per topic: the previous run's set first, then fresh searches. */
class Pool {
  private queues = new Map<PhotoTopic, OpenverseCandidate[]>();
  /** Where the search of a topic stands: which of its queries, which page. */
  private cursor = new Map<PhotoTopic, { query: number; page: number }>();
  private exhausted = new Set<PhotoTopic>();
  private seen = new Set<string>();
  private searched = false;

  constructor(private deps: PhotoDeps, previous: Array<{ topic: string; candidate: OpenverseCandidate }>) {
    for (const p of previous) this.push(p.topic as PhotoTopic, [p.candidate]);
  }

  /** The topics whose searches have all run out. */
  get usedUp(): PhotoTopic[] {
    return PHOTO_TOPICS.filter((t) => this.exhausted.has(t));
  }

  private push(topic: PhotoTopic, list: OpenverseCandidate[]): void {
    const q = this.queues.get(topic) ?? [];
    for (const c of list) {
      if (this.seen.has(c.id)) continue;
      this.seen.add(c.id);
      q.push(c);
    }
    this.queues.set(topic, q);
  }

  async next(topic: PhotoTopic): Promise<OpenverseCandidate | null> {
    const queries = OPENVERSE_QUERIES[topic];
    for (;;) {
      const q = this.queues.get(topic);
      if (q && q.length) return q.shift()!;
      if (this.exhausted.has(topic)) return null;
      const at = this.cursor.get(topic) ?? { query: 0, page: 0 };
      at.page += 1;
      if (at.page > MAX_PAGES) {
        at.query += 1;
        at.page = 1;
      }
      this.cursor.set(topic, at);
      if (at.query >= queries.length) {
        this.exhausted.add(topic);
        return null;
      }
      if (this.searched && this.deps.searchPauseMs > 0) await new Promise((r) => setTimeout(r, this.deps.searchPauseMs));
      this.searched = true;
      const found = await searchOpenverse(this.deps, topic, at.page, queries[at.query]!);
      // No result at all on this page: the query is done, the next one starts on page 1.
      if (!found.length) at.page = MAX_PAGES;
      this.push(topic, found);
    }
  }
}

/** The previous run's Openverse photos, so a reload shows the same set. */
async function previousSet(runId: number): Promise<Array<{ topic: string; candidate: OpenverseCandidate }>> {
  const [prev] = await db
    .select({ run_id: demoPhoto.run_id })
    .from(demoPhoto)
    .where(and(lt(demoPhoto.run_id, runId), eq(demoPhoto.source, "openverse")))
    .orderBy(desc(demoPhoto.run_id))
    .limit(1);
  if (!prev) return [];
  const rows = await db
    .select()
    .from(demoPhoto)
    .where(and(eq(demoPhoto.run_id, prev.run_id), eq(demoPhoto.source, "openverse")))
    .orderBy(demoPhoto.position);
  return rows
    .filter((r) => r.openverse_id && r.image_url && r.license)
    .map((r) => ({
      topic: r.topic,
      candidate: {
        id: r.openverse_id!,
        title: r.title,
        creator: r.creator,
        license: r.license!,
        license_version: r.license_version,
        url: r.image_url!,
        landing_url: r.landing_url,
      },
    }));
}

function exifDate(takenAt: string): string {
  return `${takenAt.slice(0, 10).replace(/-/g, ":")}${takenAt.slice(10)}`;
}

/** The shot's EXIF, and nothing of where the picture came from. */
async function writeExif(file: string, shot: PlannedShot): Promise<void> {
  const when = exifDate(shot.takenAt);
  const tags: Record<string, string | number> = {
    DateTimeOriginal: when,
    CreateDate: when,
    ModifyDate: when,
    Make: shot.camera.make,
    Model: shot.camera.model,
  };
  if (shot.gps) {
    // Signed: exiftool-vendored derives the N/S and E/W references from the sign.
    tags.GPSLatitude = shot.gps.lat;
    tags.GPSLongitude = shot.gps.lon;
  }
  await exiftool.write(file, tags, ["-overwrite_original"]);
}

function fileName(shot: PlannedShot): string {
  return `Foto_${String(shot.index + 1).padStart(4, "0")}.jpg`;
}

/**
 * Writes the photos of `plan` for `ownerId`. With `source: "openverse"`
 * each shot gets a CC0/PDM photo without a recognisable face, other topics
 * fill in where one runs out, and a shot nothing fits is drawn; when
 * Openverse or the face detector fails midway, the rest is drawn and
 * `fallback` says why.
 */
export async function writePhotos(
  runId: number,
  ownerId: number,
  seed: number,
  plan: PhotoPlan,
  source: PhotoSource,
  hooks: WriteHooks = {},
  deps: PhotoDeps = defaultPhotoDeps(),
): Promise<WrittenPhotos> {
  const staging = path.join(PHOTO_LIBRARIES_ROOT, `demodaten-${runId}`);
  await fs.rm(staging, { recursive: true, force: true });
  await fs.mkdir(staging, { recursive: true });

  const pool = source === "openverse" ? new Pool(deps, await previousSet(runId)) : null;
  let fallback: string | null = null;
  let faces = 0;
  let broken = 0;
  const chosen: Chosen[] = [];
  let albumCount = 0;

  try {
    for (const shot of plan.shots) {
      if (hooks.cancelled && shot.index % 10 === 0 && (await hooks.cancelled())) throw new DemoCancelled();
      let jpeg: Buffer | null = null;
      let candidate: OpenverseCandidate | null = null;
      if (pool && !fallback) {
        try {
          // The shot's topic first, then the others in a fixed order.
          const topics = [shot.topic, ...PHOTO_TOPICS.filter((t) => t !== shot.topic)];
          let tries = 0;
          for (const topic of topics) {
            while (tries < MAX_TRIES) {
              const c = await pool.next(topic);
              if (!c) break;
              tries += 1;
              const img = await downloadPhoto(deps, c.url);
              if (!img) {
                broken += 1;
                continue;
              }
              if (await hasRecognisableFace(deps, img)) {
                faces += 1;
                continue;
              }
              jpeg = img;
              candidate = c;
              break;
            }
            if (jpeg || tries >= MAX_TRIES) break;
          }
        } catch (err) {
          fallback = (err as Error).message;
          log.warn("demo photos: Openverse or the face detector failed, drawing the rest", { runId, error: fallback });
        }
      }
      if (!jpeg) jpeg = await drawPhoto(shot.topic, (seed ^ 0x5eed) + shot.index);

      const name = fileName(shot);
      const file = path.join(staging, name);
      await fs.writeFile(file, jpeg);
      await writeExif(file, shot);
      chosen.push({ shot, fileName: name, candidate });
      if (shot.index % 5 === 0 || shot.index === plan.shots.length - 1) await hooks.progress?.(shot.index + 1, plan.shots.length);
    }

    // The import: a library on the staging folder, scanned like any archive.
    const library = await createLibrary(ownerId, { name: `Demodaten ${runId}`, path: staging, import_mode: "move" });
    try {
      await scanLibrary(library.id);
    } finally {
      const rows = await db
        .select({ id: photos.id, original_name: photos.original_name })
        .from(photos)
        .where(eq(photos.library_id, library.id));
      await register(runId, "photos", rows.map((r) => r.id));
      const idByName = new Map(rows.map((r) => [r.original_name, r.id]));

      await db.insert(demoPhoto).values(
        chosen.map((c) => ({
          run_id: runId,
          position: c.shot.index,
          topic: c.shot.topic,
          source: c.candidate ? ("openverse" as const) : ("drawn" as const),
          openverse_id: c.candidate?.id ?? null,
          title: c.candidate?.title ?? null,
          creator: c.candidate?.creator ?? null,
          license: c.candidate?.license ?? null,
          license_version: c.candidate?.license_version ?? null,
          image_url: c.candidate?.url ?? null,
          landing_url: c.candidate?.landing_url ?? null,
          file_name: c.fileName,
          photo_id: idByName.get(c.fileName) ?? null,
        })),
      );
      await deleteLibrary(library.id);

      // The albums, from the plan; the app's own suggestions come on top.
      for (const a of plan.albums) {
        const ids = chosen.filter((c) => c.shot.album === a.key).map((c) => idByName.get(c.fileName)).filter((id): id is number => id !== undefined);
        if (!ids.length) continue;
        try {
          const [album] = await db.insert(albums).values({ user_id: ownerId, name: a.name, cover_photo_id: ids[0] }).returning({ id: albums.id });
          await register(runId, "albums", [album.id]);
          await db.insert(albumPhotos).values(ids.map((photo_id) => ({ album_id: album.id, photo_id, added_by_user_id: ownerId })));
          albumCount += 1;
        } catch (err) {
          // An album of that name exists already: the demo leaves it alone.
          log.warn("demo photos: album not created", { runId, album: a.name, error: (err as Error).message });
        }
      }
    }

    const imported = chosen.filter((c) => c.candidate).length;
    const drawn = chosen.length - imported;
    if (pool && !fallback && drawn > 0) {
      fallback = shortfallNote(pool.usedUp, faces, broken);
      log.info("demo photos: some shots found no Openverse photo", { runId, drawn, faces, broken, usedUp: pool.usedUp });
    }
    return {
      photos: chosen.length,
      openverse: imported,
      drawn,
      albums: albumCount,
      fallback,
    };
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
}

/** Deletes the registered photos with their files and thumbnails. */
export async function removePhotos(ids: number[]): Promise<void> {
  if (!ids.length) return;
  const rows = await db.select({ id: photos.id, user_id: photos.user_id }).from(photos).where(inArray(photos.id, ids));
  for (const r of rows) await hardDeletePhotoLogic(r.user_id, r.id);
}
