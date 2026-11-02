/**
 * Whether the loaded model may answer questions (plan ki-assistent.md, open
 * question "how many tool rounds"). The CPU fallback Qwen2.5-7B passed 11
 * of 26 benchmark cases and answered from imagination without a tool call;
 * a user asking it gets a confident, wrong answer. So the verdict comes from
 * the measurement, not from the model's name: the latest finished benchmark
 * run (canned results) of the configuration llm-service runs now.
 *
 * - `ok`: passed at least the threshold on the GPU.
 * - `slow`: passed it on the CPU (the CPU twin while the GPU is lent at night).
 * - `blocked`: passed less; the assistant takes no questions.
 * - `unmeasured`: no run yet; it answers, and the page says so.
 * - `unknown`: llm-service did not say what it runs; the turn finds out itself.
 *
 * The verdict is kept for a minute and dropped when a benchmark run ends, so
 * a question reads one value from memory.
 */

import { and, desc, eq, sql } from "drizzle-orm";
import log from "encore.dev/log";
import { user } from "~encore/clients";
import db from "../db/database";
import { assistantBenchmarkRun } from "../db/schema";

export type ModelGateState = "ok" | "slow" | "blocked" | "unmeasured" | "unknown";

export interface ModelGate {
  state: ModelGateState;
  /** The label of the loaded configuration, when llm-service named it. */
  model: string | null;
  /** Share of the cases the latest run passed, 0–1; null without a run. */
  pass_rate: number | null;
  /** What `ok` and `slow` need. */
  threshold: number;
}

/** Below this share of passed benchmark cases the assistant takes no questions; `ASSISTANT_MIN_PASS_RATE` overrides it. */
export const DEFAULT_MIN_PASS_RATE = 0.85;
const TTL_MS = 60_000;

export function minPassRate(): number {
  const raw = Number(process.env.ASSISTANT_MIN_PASS_RATE);
  return Number.isFinite(raw) && raw > 0 && raw <= 1 ? raw : DEFAULT_MIN_PASS_RATE;
}

interface LiveConfig {
  label?: string;
  model_filename?: string;
  accelerator?: string;
  gpu_layers?: number;
}

/** No layer on the card or the CPU accelerator: the configuration runs on the CPU. */
export function onCpu(c: { accelerator?: string; gpu_layers?: number }): boolean | null {
  if (c.accelerator) return c.accelerator === "cpu";
  if (typeof c.gpu_layers === "number") return c.gpu_layers === 0;
  return null;
}

/** The verdict from a pass rate; pure, for tests. */
export function verdict(passRate: number | null, cpu: boolean, threshold: number): ModelGateState {
  if (passRate === null) return "unmeasured";
  if (passRate < threshold) return "blocked";
  return cpu ? "slow" : "ok";
}

/**
 * The latest finished run of this model file on the same kind of device. A run
 * filed before the device was recorded counts for both.
 */
async function latestPassRate(filename: string, cpu: boolean): Promise<number | null> {
  const rows = await db
    .select({ model: assistantBenchmarkRun.model, summary: assistantBenchmarkRun.summary })
    .from(assistantBenchmarkRun)
    .where(and(
      eq(assistantBenchmarkRun.status, "done"),
      eq(assistantBenchmarkRun.data_source, "canned"),
      sql`${assistantBenchmarkRun.model} ->> 'model_filename' = ${filename}`,
    ))
    .orderBy(desc(assistantBenchmarkRun.finished_at), desc(assistantBenchmarkRun.id))
    .limit(20);
  for (const row of rows) {
    const device = onCpu((row.model ?? {}) as LiveConfig);
    if (device !== null && device !== cpu) continue;
    const rate = Number((row.summary ?? {}).pass_rate);
    if (Number.isFinite(rate)) return rate;
  }
  return null;
}

let cached: { gate: ModelGate; at: number } | null = null;

/** Drops the kept verdict: a benchmark run ended, or a test wants a fresh one. */
export function forgetModelGate(): void {
  cached = null;
}

export async function modelGate(now = Date.now()): Promise<ModelGate> {
  if (cached && now - cached.at < TTL_MS) return cached.gate;
  const threshold = minPassRate();
  let gate: ModelGate;
  try {
    const status = (await user.getLlmGpuLease()) as unknown as { config?: LiveConfig } | undefined;
    const config = status?.config;
    if (!config?.model_filename) {
      gate = { state: "unknown", model: config?.label ?? null, pass_rate: null, threshold };
    } else {
      const cpu = onCpu(config) ?? false;
      const passRate = await latestPassRate(config.model_filename, cpu);
      gate = { state: verdict(passRate, cpu, threshold), model: config.label ?? config.model_filename, pass_rate: passRate, threshold };
    }
  } catch (err) {
    log.warn("assistant: model status unavailable for the gate", { error: String(err) });
    gate = { state: "unknown", model: null, pass_rate: null, threshold };
  }
  cached = { gate, at: now };
  return gate;
}

/** What the page and a refused question say, in the user's words. */
export function gateMessage(gate: ModelGate): string | null {
  const pct = (r: number) => `${Math.round(r * 100)} %`;
  switch (gate.state) {
    case "blocked":
      return `Der Assistent ist gerade nicht verfügbar: Das geladene KI-Modell hat im Test nur ${pct(gate.pass_rate ?? 0)} der Fragen richtig beantwortet (nötig sind ${pct(gate.threshold)}). Er ist wieder da, sobald ein besseres Modell läuft.`;
    case "slow":
      return "Das KI-Modell läuft gerade auf dem Prozessor statt auf der Grafikkarte. Antworten dauern deshalb deutlich länger.";
    case "unmeasured":
      return "Das geladene KI-Modell ist noch nicht getestet. Prüfe Antworten besonders sorgfältig.";
    default:
      return null;
  }
}
