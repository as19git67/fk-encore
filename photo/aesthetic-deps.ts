/**
 * The real services behind the nightly aesthetic run: the llm-service's GPU
 * lease through the user service, the `llm` slot in ai-queue, the
 * aesthetic-service over HTTP, and the database store.
 */

import fs from "fs";
import path from "path";
import { eq } from "drizzle-orm";
import { aiqueue, user } from "~encore/clients";
import db from "../db/database";
import { dbFirst } from "../db/adapter";
import { photos } from "../db/schema";
import { convertHeicToJpeg } from "./heic-convert.service";
import { getPhotoDiskPath } from "./photo.service";
import * as store from "./aesthetic-store";
import type { LeaseView, NightDeps, ScoreOutcome, ScorerStatus } from "./aesthetic-nightly";

export const AESTHETIC_SERVICE_URL = (process.env.AESTHETIC_SERVICE_URL || "http://localhost:8004").replace(/\/$/, "");

const CONTROL_TIMEOUT_MS = 15_000;
/** One photo on the card takes well under a second; this is for a stuck request. */
const SCORE_TIMEOUT_MS = 120_000;

async function scorerFetch(pathname: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<Response> {
  const { timeoutMs = CONTROL_TIMEOUT_MS, ...rest } = init;
  try {
    return await fetch(`${AESTHETIC_SERVICE_URL}${pathname}`, { ...rest, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    throw new Error(`aesthetic-service unreachable at ${AESTHETIC_SERVICE_URL}${pathname}: ${(err as Error).message}`);
  }
}

async function detailOf(res: Response): Promise<string> {
  const body = await res.text();
  try {
    const parsed = JSON.parse(body) as { detail?: unknown };
    if (typeof parsed.detail === "string") return parsed.detail;
  } catch {
    // not JSON
  }
  return body.slice(0, 300) || res.statusText;
}

export async function scorerStatus(): Promise<ScorerStatus> {
  const res = await scorerFetch("/status");
  if (!res.ok) throw new Error(`aesthetic-service /status ${res.status}: ${await detailOf(res)}`);
  const body = (await res.json()) as { state: ScorerStatus["state"]; error?: string | null; version?: string | null };
  return { state: body.state, error: body.error ?? null, version: body.version ?? null };
}

/** POST /load or /unload; a 409 means the other transition is under way, which the wait then sees. */
async function lifecycle(pathname: "/load" | "/unload"): Promise<void> {
  const res = await scorerFetch(pathname, { method: "POST" });
  if (!res.ok && res.status !== 409) throw new Error(`aesthetic-service ${pathname} ${res.status}: ${await detailOf(res)}`);
}

/** The photo's bytes as the scorer reads them: HEIC converted, everything else as stored. */
async function photoBytes(photoId: number): Promise<Buffer | { missing: string }> {
  const photo = await dbFirst<{ filename: string; external_path: string | null }>(
    db
      .select({ filename: photos.filename, external_path: photos.external_path })
      .from(photos)
      .where(eq(photos.id, photoId)),
  );
  if (!photo) return { missing: "Foto gibt es nicht mehr" };
  const filePath = getPhotoDiskPath(photo);
  if (!fs.existsSync(filePath)) return { missing: "Datei fehlt" };
  const ext = path.extname(photo.filename).toLowerCase();
  if (ext === ".heic" || ext === ".heif") return convertHeicToJpeg(filePath);
  return fs.promises.readFile(filePath);
}

export async function scorePhoto(photoId: number): Promise<ScoreOutcome> {
  let bytes: Buffer | { missing: string };
  try {
    bytes = await photoBytes(photoId);
  } catch (err) {
    return { kind: "unscorable", reason: `Datei nicht lesbar: ${(err as Error).message}` };
  }
  if (!Buffer.isBuffer(bytes)) return { kind: "unscorable", reason: bytes.missing };

  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(bytes)]), `photo-${photoId}`);
  const res = await scorerFetch("/score", { method: "POST", body: form, timeoutMs: SCORE_TIMEOUT_MS });
  if (res.status === 422) return { kind: "unscorable", reason: await detailOf(res) };
  if (!res.ok) throw new Error(`aesthetic-service /score ${res.status}: ${await detailOf(res)}`);
  const body = (await res.json()) as { aesthetics: number; quality: number };
  return { kind: "scored", scores: { aesthetics: body.aesthetics, quality: body.quality } };
}

async function lease(): Promise<LeaseView> {
  const status = await user.getLlmGpuLease();
  return { active: status.lease.active, reloadState: status.reload.state, reloadDetail: status.reload.detail };
}

async function llmBusy(): Promise<boolean> {
  const { models } = await aiqueue.getQueueStatus();
  const llm = models.find((m: { model: string }) => m.model === "llm");
  return !!llm && (llm.activeSlot !== null || llm.waitingCount > 0);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

export function realNightDeps(): NightDeps {
  return {
    now: () => new Date(),
    sleep,
    lease,
    lend: async () => {
      await user.lendLlmGpu();
    },
    giveBack: async () => {
      await user.returnLlmGpu();
    },
    llmBusy,
    scorerStatus,
    scorerLoad: () => lifecycle("/load"),
    scorerUnload: () => lifecycle("/unload"),
    score: scorePhoto,
    store: {
      getSettings: store.getAestheticSettings,
      countBacklog: store.countBacklog,
      nextBatch: store.nextBatch,
      writeScore: store.writeAestheticScore,
      markUnscorable: store.markUnscorable,
      startRun: store.startRun,
      updateRun: store.updateRun,
      finishRun: store.finishRun,
      runsToRecover: store.runsToRecover,
    },
  };
}
