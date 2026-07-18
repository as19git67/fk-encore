/**
 * Rueckblick-Video-Export — rendert einen Rueckblick als MP4 (1080p, H.264
 * + AAC) mit Ken-Burns-Zoom, Crossfades und der Hintergrundmusik des
 * Rueckblicks.
 *
 * Pipeline:
 *   1. Frames vorbereiten: jedes Foto wird mit sharp EXIF-rotiert, am
 *      auto_crop-Fokuspunkt auf 16:9 beschnitten (gleiche Semantik wie
 *      CSS object-position im Player) und als JPEG in ein Temp-Verzeichnis
 *      geschrieben. Das loest nebenbei HEIC — ffmpeg muss keine
 *      Spezialformate dekodieren.
 *   2. ffmpeg: pro Frame ein zoompan (rein/raus alternierend, deterministisch
 *      per Foto-ID), verkettede xfade-Uebergaenge, optional die geloopte
 *      Musik-Spur mit Fade-out.
 *
 * ffmpeg ist eine optionale Host-Abhaengigkeit: fehlt das Binary, liefert
 * `ensureFfmpeg` einen klaren Fehler und der Export-Endpoint antwortet mit
 * failed_precondition. Jobs laufen asynchron (ein Job je user+recap) und
 * das fertige MP4 wird auf Platte gecacht, solange sich das Foto-Set des
 * Rueckblicks nicht aendert.
 */

import { execFile, spawn } from "child_process";
import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import sharp from "sharp";
import { convertHeicToJpeg } from "./heic-convert.service";

export const RECAPS_EXPORT_DIR = path.resolve(
  process.env.RECAPS_EXPORT_DIR || "/mnt/data/recap-exports"
);
const FFMPEG_BIN = process.env.FFMPEG_PATH || "ffmpeg";

// Output geometry / timing. 25 fps keeps zoompan expressions simple.
export const EXPORT_WIDTH = 1920;
export const EXPORT_HEIGHT = 1080;
// Frames are pre-rendered larger than the output so zoompan has real pixels
// to zoom into instead of interpolating upwards.
const FRAME_WIDTH = 2560;
const FRAME_HEIGHT = 1440;
const FPS = 25;
export const SLIDE_SECONDS = 3.5;
export const FADE_SECONDS = 0.6;
const ZOOM_AMOUNT = 0.12;
const MAX_EXPORT_PHOTOS = 30;

// ────────────────────────────────────────────────────────────────────────────
// Pure helpers (unit-tested)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Source crop rectangle for covering `targetAR` while keeping the focal
 * point (normalized 0..1) inside — mirrors the frontend's coverCropRect /
 * CSS object-position semantics: focal 0/1 aligns the crop with the
 * respective image edge.
 */
export function coverCrop(
  natW: number,
  natH: number,
  targetAR: number,
  focal?: { x: number; y: number } | null
): { left: number; top: number; width: number; height: number } {
  const clamp01 = (v: number | undefined | null) =>
    v == null || !Number.isFinite(v) ? 0.5 : Math.min(1, Math.max(0, v));
  let sw = natW;
  let sh = natW / targetAR;
  if (sh > natH) {
    sh = natH;
    sw = natH * targetAR;
  }
  const left = (natW - sw) * clamp01(focal?.x);
  const top = (natH - sh) * clamp01(focal?.y);
  return {
    left: Math.round(left),
    top: Math.round(top),
    width: Math.round(sw),
    height: Math.round(sh),
  };
}

/** Total video duration for n slides with overlapping crossfades. */
export function exportDurationSeconds(
  n: number,
  slideSeconds = SLIDE_SECONDS,
  fadeSeconds = FADE_SECONDS
): number {
  if (n <= 0) return 0;
  return n * slideSeconds - (n - 1) * fadeSeconds;
}

/**
 * Build the ffmpeg filter_complex for n image inputs (+ optional audio as
 * input n): per-slide zoompan (alternating in/out via `zoomIn[i]`), then a
 * chain of xfade transitions. Returns the graph and the output labels.
 */
export function buildExportFilterGraph(opts: {
  count: number;
  zoomIn: boolean[];
  withAudio: boolean;
  slideSeconds?: number;
  fadeSeconds?: number;
}): { filter: string; videoLabel: string; audioLabel: string | null; duration: number } {
  const slide = opts.slideSeconds ?? SLIDE_SECONDS;
  const fade = opts.fadeSeconds ?? FADE_SECONDS;
  const frames = Math.round(slide * FPS);
  const parts: string[] = [];

  for (let i = 0; i < opts.count; i++) {
    const zin = opts.zoomIn[i] ?? i % 2 === 0;
    // zoompan evaluates z per output frame ("on"). Linear ramp over the
    // slide; zoom-out starts at the max and eases back to 1.
    const z = zin
      ? `1+${ZOOM_AMOUNT}*on/${frames}`
      : `1+${ZOOM_AMOUNT}-${ZOOM_AMOUNT}*on/${frames}`;
    parts.push(
      `[${i}:v]zoompan=z='${z}':d=${frames}:x='(iw-iw/zoom)/2':y='(ih-ih/zoom)/2'` +
        `:s=${EXPORT_WIDTH}x${EXPORT_HEIGHT}:fps=${FPS},setsar=1[v${i}]`
    );
  }

  let videoLabel = "[v0]";
  if (opts.count > 1) {
    let prev = "v0";
    for (let i = 1; i < opts.count; i++) {
      const out = i === opts.count - 1 ? "vout" : `x${i}`;
      const offset = (slide - fade) * i;
      parts.push(
        `[${prev}][v${i}]xfade=transition=fade:duration=${fade}:offset=${offset.toFixed(3)}[${out}]`
      );
      prev = out;
    }
    videoLabel = "[vout]";
  }

  const duration = exportDurationSeconds(opts.count, slide, fade);
  let audioLabel: string | null = null;
  if (opts.withAudio) {
    const fadeOutStart = Math.max(0, duration - 2);
    parts.push(
      `[${opts.count}:a]atrim=0:${duration.toFixed(3)},afade=t=in:st=0:d=1.5,` +
        `afade=t=out:st=${fadeOutStart.toFixed(3)}:d=2[aout]`
    );
    audioLabel = "[aout]";
  }

  return { filter: parts.join(";"), videoLabel, audioLabel, duration };
}

/**
 * Cache filename for a recap export. Hashing the exact photo set (+ title)
 * invalidates the cached MP4 whenever the recap content changes; the hash
 * also makes the download URL non-guessable without knowing the content.
 */
export function exportFileName(
  recapId: number,
  photoIds: number[],
  title: string
): string {
  const hash = crypto
    .createHash("sha256")
    .update(`${recapId}|${photoIds.join(",")}|${title}`)
    .digest("hex")
    .slice(0, 20);
  return `recap-${recapId}-${hash}.mp4`;
}

// ────────────────────────────────────────────────────────────────────────────
// ffmpeg availability
// ────────────────────────────────────────────────────────────────────────────

let ffmpegAvailable: boolean | null = null;

export async function isFfmpegAvailable(): Promise<boolean> {
  if (ffmpegAvailable != null) return ffmpegAvailable;
  ffmpegAvailable = await new Promise<boolean>((resolve) => {
    execFile(FFMPEG_BIN, ["-version"], (err) => resolve(!err));
  });
  return ffmpegAvailable;
}

// ────────────────────────────────────────────────────────────────────────────
// Job management
// ────────────────────────────────────────────────────────────────────────────

export interface ExportJobStatus {
  status: "running" | "done" | "failed";
  /** 0..1 — coarse: frame prep counts as the first 30%, encoding the rest. */
  progress: number;
  error?: string;
  /** Set when status === "done". */
  file?: string;
}

interface ExportJob extends ExportJobStatus {
  outputPath?: string;
}

const jobs = new Map<string, ExportJob>();

function jobKey(userId: number, recapId: number): string {
  return `${userId}:${recapId}`;
}

export function getExportJob(
  userId: number,
  recapId: number
): ExportJobStatus | null {
  const job = jobs.get(jobKey(userId, recapId));
  if (!job) return null;
  return {
    status: job.status,
    progress: job.progress,
    error: job.error,
    file: job.file,
  };
}

export interface ExportPhotoInput {
  id: number;
  filePath: string;
  focal?: { x: number; y: number } | null;
}

/**
 * Start (or return the already-running/cached) export for a recap. The
 * caller resolves photo file paths and the optional music file up front so
 * this module stays free of DB access.
 */
export async function startExport(opts: {
  userId: number;
  recapId: number;
  title: string;
  photos: ExportPhotoInput[];
  musicFilePath: string | null;
}): Promise<ExportJobStatus> {
  const key = jobKey(opts.userId, opts.recapId);
  const existing = jobs.get(key);
  if (existing && existing.status === "running") {
    return getExportJob(opts.userId, opts.recapId)!;
  }

  const photos = opts.photos.slice(0, MAX_EXPORT_PHOTOS);
  const fileName = exportFileName(
    opts.recapId,
    photos.map((p) => p.id),
    opts.title
  );
  const outputPath = path.join(RECAPS_EXPORT_DIR, fileName);

  // Cached result from an earlier run — reuse without re-encoding.
  try {
    await fs.promises.access(outputPath);
    const done: ExportJob = {
      status: "done",
      progress: 1,
      file: fileName,
      outputPath,
    };
    jobs.set(key, done);
    return getExportJob(opts.userId, opts.recapId)!;
  } catch {
    // not cached — fall through to a fresh render
  }

  const job: ExportJob = { status: "running", progress: 0 };
  jobs.set(key, job);

  void (async () => {
    let tmpDir: string | null = null;
    try {
      await fs.promises.mkdir(RECAPS_EXPORT_DIR, { recursive: true });
      tmpDir = await fs.promises.mkdtemp(
        path.join(os.tmpdir(), `recap-export-${opts.recapId}-`)
      );

      // Phase 1: pre-render frames (30% of the progress bar).
      const framePaths: string[] = [];
      for (let i = 0; i < photos.length; i++) {
        const photo = photos[i];
        const framePath = path.join(tmpDir, `frame-${String(i).padStart(3, "0")}.jpg`);
        const ext = path.extname(photo.filePath).toLowerCase();
        const isHeic = ext === ".heic" || ext === ".heif";
        const input = isHeic
          ? await convertHeicToJpeg(photo.filePath)
          : photo.filePath;
        const img = sharp(input).rotate();
        const meta = await img.metadata();
        // metadata() reports pre-rotation dimensions; extract() after
        // rotate() works on the rotated image — swap for 90°-orientations.
        const swapped = (meta.orientation ?? 1) >= 5;
        const natW = (swapped ? meta.height : meta.width) ?? FRAME_WIDTH;
        const natH = (swapped ? meta.width : meta.height) ?? FRAME_HEIGHT;
        const crop = coverCrop(natW, natH, FRAME_WIDTH / FRAME_HEIGHT, photo.focal);
        await img
          .extract(crop)
          .resize(FRAME_WIDTH, FRAME_HEIGHT)
          .jpeg({ quality: 92 })
          .toFile(framePath);
        framePaths.push(framePath);
        job.progress = (0.3 * (i + 1)) / photos.length;
      }

      // Phase 2: encode.
      const zoomIn = photos.map((p) => p.id % 2 === 0);
      const graph = buildExportFilterGraph({
        count: framePaths.length,
        zoomIn,
        withAudio: opts.musicFilePath != null,
      });

      const args: string[] = ["-y"];
      for (const frame of framePaths) args.push("-i", frame);
      if (opts.musicFilePath) args.push("-stream_loop", "-1", "-i", opts.musicFilePath);
      args.push(
        "-filter_complex",
        graph.filter,
        "-map",
        graph.videoLabel,
        ...(graph.audioLabel ? ["-map", graph.audioLabel] : []),
        "-t",
        graph.duration.toFixed(3),
        "-c:v",
        "libx264",
        "-preset",
        "medium",
        "-crf",
        "20",
        "-pix_fmt",
        "yuv420p",
        ...(graph.audioLabel ? ["-c:a", "aac", "-b:a", "160k"] : []),
        "-movflags",
        "+faststart",
        outputPath
      );

      await runFfmpeg(args, graph.duration, (encodeProgress) => {
        job.progress = 0.3 + 0.7 * encodeProgress;
      });

      job.status = "done";
      job.progress = 1;
      job.file = fileName;
      job.outputPath = outputPath;
    } catch (err: any) {
      job.status = "failed";
      job.error = err?.message ?? String(err);
      console.error(
        `[recap-export] export failed for recap ${opts.recapId}:`,
        job.error
      );
      // A partially written file must not be served as a cached result.
      await fs.promises.rm(outputPath, { force: true }).catch(() => {});
    } finally {
      if (tmpDir) {
        await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      }
    }
  })();

  return getExportJob(opts.userId, opts.recapId)!;
}

/** Spawn ffmpeg, tracking `time=` from stderr for progress. */
function runFfmpeg(
  args: string[],
  totalSeconds: number,
  onProgress: (fraction: number) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG_BIN, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderrTail = "";
    proc.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderrTail = (stderrTail + text).slice(-4000);
      const m = /time=(\d+):(\d{2}):(\d{2})\.(\d+)/.exec(text);
      if (m && totalSeconds > 0) {
        const seconds =
          parseInt(m[1], 10) * 3600 + parseInt(m[2], 10) * 60 + parseInt(m[3], 10);
        onProgress(Math.min(1, seconds / totalSeconds));
      }
    });
    proc.on("error", (err) => reject(err));
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with code ${code}: ${stderrTail.slice(-500)}`));
    });
  });
}

/**
 * Resolve a previously exported file for download. Only files matching the
 * strict export naming scheme inside RECAPS_EXPORT_DIR are served.
 */
export async function resolveExportFilePath(fileName: string): Promise<string | null> {
  if (!/^recap-\d+-[0-9a-f]{20}\.mp4$/.test(fileName)) return null;
  const abs = path.resolve(RECAPS_EXPORT_DIR, fileName);
  const rootWithSep = RECAPS_EXPORT_DIR.endsWith(path.sep)
    ? RECAPS_EXPORT_DIR
    : RECAPS_EXPORT_DIR + path.sep;
  if (!abs.startsWith(rootWithSep)) return null;
  try {
    const stat = await fs.promises.stat(abs);
    return stat.isFile() ? abs : null;
  } catch {
    return null;
  }
}
