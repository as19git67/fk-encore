/**
 * The critique of one photo in words (documentation/plans/foto-aesthetik.md,
 * stage 6).
 *
 * Gemma 4 looks at the picture through the llm-service and says in a few
 * sentences what works and what does not. It explains, it does not grade: the
 * score stays with the aesthetic scorer, the prompt asks for no numbers, and
 * a line that gives one anyway is dropped. Asked for on request only — a
 * button on the photo page and in the auto-pick review — and kept in
 * `photo_critique` until someone asks again.
 */

import fs from "fs";
import path from "path";
import { eq } from "drizzle-orm";
import db from "../db/database";
import { dbFirst } from "../db/adapter";
import { photoCritique, photos } from "../db/schema";
import { AI_PRIORITY, AiSlotTimeoutError, withAiSlot } from "../ai-queue/slot-helper";
import { isGpuLent, llmBudgetMs } from "../lib/llm-lease";
import { convertHeicToJpeg } from "./heic-convert.service";
import { resizeImageInPool } from "./image-pool";
import { getPhotoDiskPath } from "./photo.service";

const LLM_SERVICE_URL = (process.env.LLM_SERVICE_URL || "http://localhost:8002").replace(/\/$/, "");

/** Long edge the model sees. Enough for light and composition, cheap to prefill. */
const IMAGE_WIDTH = 896;
/** Somebody is waiting at the button, so the call queues ahead of batch jobs, but not forever. */
const SLOT_TIMEOUT_MS = 120_000;
const CALL_TIMEOUT_MS = 180_000;

const MAX_POINTS = 4;
const MAX_POINT_LENGTH = 200;
const MAX_SUMMARY_LENGTH = 600;

export interface PhotoCritique {
  photo_id: number;
  summary: string;
  strengths: string[];
  weaknesses: string[];
  model: string;
  created_at: string;
}

/** Why no critique could be written; the endpoint turns it into the user's message. */
export class CritiqueUnavailableError extends Error {
  constructor(
    readonly reason: "gpu_lent" | "busy" | "no_vision" | "no_image" | "model",
    message: string,
  ) {
    super(message);
    this.name = "CritiqueUnavailableError";
  }
}

export interface CritiqueScores {
  /** Q-Align (or provisional) aesthetics, 0–1. */
  aesthetics: number | null;
  /** Q-Align technical quality, 0–1. */
  quality: number | null;
}

/** A 0–1 score as the word the model gets: it may explain a judgement, never repeat a number. */
export function scoreBand(value: number | null): string | null {
  if (value == null || Number.isNaN(value)) return null;
  if (value < 0.35) return "schwach";
  if (value < 0.5) return "eher schwach";
  if (value < 0.65) return "mittel";
  if (value < 0.8) return "gut";
  return "sehr gut";
}

export interface CritiquePrompt {
  system: string;
  prompt: string;
  schema: Record<string, unknown>;
}

export const CRITIQUE_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    summary: { type: "string" },
    strengths: { type: "array", items: { type: "string" } },
    weaknesses: { type: "array", items: { type: "string" } },
  },
  required: ["summary", "strengths", "weaknesses"],
};

export function buildCritiquePrompt(scores: CritiqueScores): CritiquePrompt {
  const system =
    "Du bist eine erfahrene Fotografin, die Amateurfotos freundlich und konkret bespricht. " +
    "Du beschreibst, was du im Bild siehst: Licht, Bildaufbau, Schärfe, Farben, Moment und Ausdruck. " +
    "Du vergibst keine Noten, Punkte, Prozente oder Sterne und nennst keine Zahlen. " +
    "Du nennst keine Namen von Personen und rätst nicht, wer abgebildet ist oder wo das Bild entstand.";
  const hints: string[] = [];
  const aesthetic = scoreBand(scores.aesthetics);
  const quality = scoreBand(scores.quality);
  if (aesthetic) hints.push(`Ein Ästhetikmodell schätzt die Bildwirkung als „${aesthetic}“ ein.`);
  if (quality) hints.push(`Die technische Qualität schätzt es als „${quality}“ ein.`);
  const prompt = [
    "Bespreche dieses Foto auf Deutsch.",
    ...hints,
    hints.length > 0
      ? "Erkläre, was im Bild zu dieser Einschätzung führt. Wenn du es anders siehst, sag es und begründe es am Bild."
      : "",
    "Antworte als JSON-Objekt mit drei Feldern:",
    "- summary: zwei bis drei Sätze, wie das Bild wirkt und warum.",
    `- strengths: bis zu ${MAX_POINTS} kurze Stichpunkte, was gelingt.`,
    `- weaknesses: bis zu ${MAX_POINTS} kurze Stichpunkte, was schwächer ist oder besser ginge. Leer, wenn dir nichts auffällt.`,
    "Jeder Stichpunkt bezieht sich auf etwas, das im Bild zu sehen ist. Keine Zahlen, keine Bewertung auf einer Skala.",
  ]
    .filter(Boolean)
    .join("\n");
  return { system, prompt, schema: CRITIQUE_SCHEMA };
}

/** "7/10", "8 von 10", "85 %", "4 Sterne", "Note 2" — a grade the model was asked not to give. */
const GRADE = /\b\d+(?:[.,]\d+)?\s*(?:\/\s*\d+|von\s+\d+|%|prozent|punkte?n?\b|sterne?n?\b)|\bnote\s+\d/i;

function cleanLine(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/\s+/g, " ").trim().replace(/^[-•*]\s*/, "");
  if (!text || GRADE.test(text)) return null;
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

function cleanPoints(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    const line = cleanLine(item, MAX_POINT_LENGTH);
    if (line && !out.includes(line)) out.push(line);
    if (out.length === MAX_POINTS) break;
  }
  return out;
}

/** The model's answer as stored: trimmed, bounded, and without any sentence that grades. */
export function parseCritique(raw: unknown): Pick<PhotoCritique, "summary" | "strengths" | "weaknesses"> | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const sentences = typeof r.summary === "string" ? r.summary.match(/[^.!?]+[.!?]*/g) ?? [] : [];
  const summary = sentences
    .map((s) => s.trim())
    .filter((s) => s && !GRADE.test(s))
    .join(" ");
  const strengths = cleanPoints(r.strengths);
  const weaknesses = cleanPoints(r.weaknesses);
  const boundedSummary = cleanLine(summary, MAX_SUMMARY_LENGTH) ?? "";
  if (!boundedSummary && strengths.length === 0 && weaknesses.length === 0) return null;
  return { summary: boundedSummary, strengths, weaknesses };
}

export interface CritiqueDeps {
  isGpuLent(): Promise<boolean>;
  /** The photo as a JPEG the model can look at, or null when its file is gone. */
  image(photoId: number): Promise<Buffer | null>;
  scores(photoId: number): Promise<CritiqueScores>;
  ask(image: Buffer, prompt: CritiquePrompt): Promise<{ result: unknown; model: string }>;
  save(critique: Omit<PhotoCritique, "created_at">): Promise<PhotoCritique>;
}

/** Writes a new critique of `photoId`, replacing the old one. */
export async function writeCritique(photoId: number, deps: CritiqueDeps): Promise<PhotoCritique> {
  // On the CPU twin a look at a picture takes minutes, and a call given up on
  // keeps the service's one slot busy for everyone after it.
  if (await deps.isGpuLent()) {
    throw new CritiqueUnavailableError(
      "gpu_lent",
      "Während der nächtlichen Ästhetik-Bewertung kann die KI keine Bilder ansehen. Bitte später noch einmal versuchen.",
    );
  }
  const image = await deps.image(photoId);
  if (!image) throw new CritiqueUnavailableError("no_image", "Die Bilddatei ist nicht lesbar.");
  const prompt = buildCritiquePrompt(await deps.scores(photoId));
  const answer = await deps.ask(image, prompt);
  const parsed = parseCritique(answer.result);
  if (!parsed) throw new CritiqueUnavailableError("model", "Die KI hat keine brauchbare Antwort gegeben.");
  return deps.save({ photo_id: photoId, ...parsed, model: answer.model });
}

// ─── The real dependencies ───────────────────────────────────────────────────

export async function loadCritique(photoId: number): Promise<PhotoCritique | null> {
  const row = await dbFirst<PhotoCritique>(
    db.select().from(photoCritique).where(eq(photoCritique.photo_id, photoId)),
  );
  return row ?? null;
}

async function saveCritique(c: Omit<PhotoCritique, "created_at">): Promise<PhotoCritique> {
  const values = { ...c, created_at: new Date().toISOString() };
  const [row] = await db
    .insert(photoCritique)
    .values(values)
    .onConflictDoUpdate({ target: photoCritique.photo_id, set: values })
    .returning();
  return row as PhotoCritique;
}

async function photoImage(photoId: number): Promise<Buffer | null> {
  const photo = await dbFirst<{ filename: string; external_path: string | null }>(
    db.select({ filename: photos.filename, external_path: photos.external_path }).from(photos).where(eq(photos.id, photoId)),
  );
  if (!photo) return null;
  const filePath = getPhotoDiskPath(photo);
  if (!fs.existsSync(filePath)) return null;
  const ext = path.extname(photo.filename).toLowerCase();
  const bytes = ext === ".heic" || ext === ".heif" ? await convertHeicToJpeg(filePath) : await fs.promises.readFile(filePath);
  return resizeImageInPool(bytes, IMAGE_WIDTH);
}

async function photoScores(photoId: number): Promise<CritiqueScores> {
  const row = await dbFirst<{ details: Record<string, unknown> | null }>(
    db.select({ details: photos.ai_quality_details }).from(photos).where(eq(photos.id, photoId)),
  );
  const d = row?.details ?? {};
  const num = (v: unknown) => (typeof v === "number" ? v : null);
  return { aesthetics: num(d.clip_aesthetics), quality: num(d.qalign_quality) };
}

async function askModel(image: Buffer, prompt: CritiquePrompt): Promise<{ result: unknown; model: string }> {
  const url = `${LLM_SERVICE_URL}/vision/json-prompt`;
  const call = async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), await llmBudgetMs(CALL_TIMEOUT_MS));
    try {
      return await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          image_b64: image.toString("base64"),
          image_mime: "image/jpeg",
          system: prompt.system,
          prompt: prompt.prompt,
          schema: prompt.schema,
          max_tokens: 700,
          temperature: 0.3,
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  };

  let res: Response;
  try {
    res = await withAiSlot("llm", AI_PRIORITY.urgent, "photo:critique", call, SLOT_TIMEOUT_MS);
  } catch (err) {
    if (err instanceof AiSlotTimeoutError) {
      throw new CritiqueUnavailableError("busy", "Die KI ist gerade mit anderen Aufgaben beschäftigt. Bitte gleich noch einmal versuchen.");
    }
    throw new CritiqueUnavailableError("model", `Die KI ist nicht erreichbar: ${(err as Error).message}`);
  }
  if (res.status === 503) {
    const detail = await res.text().catch(() => "");
    throw detail.includes("projector")
      ? new CritiqueUnavailableError("no_vision", "Das geladene KI-Modell kann keine Bilder ansehen.")
      : new CritiqueUnavailableError("busy", "Die KI ist gerade beschäftigt. Bitte gleich noch einmal versuchen.");
  }
  if (!res.ok) throw new CritiqueUnavailableError("model", `Die KI hat mit Fehler ${res.status} geantwortet.`);
  const body = (await res.json()) as { result: unknown; model: string };
  return { result: body.result, model: body.model };
}

export const realCritiqueDeps: CritiqueDeps = {
  isGpuLent,
  image: photoImage,
  scores: photoScores,
  ask: askModel,
  save: saveCritique,
};

const inFlight = new Map<number, Promise<PhotoCritique>>();

/** A second click while the first is still being answered waits for the same answer. */
export function requestCritique(photoId: number, deps: CritiqueDeps = realCritiqueDeps): Promise<PhotoCritique> {
  const running = inFlight.get(photoId);
  if (running) return running;
  const p = writeCritique(photoId, deps).finally(() => inFlight.delete(photoId));
  inFlight.set(photoId, p);
  return p;
}
