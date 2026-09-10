/**
 * Running both tracks over the same sentences and printing the result (§11.0).
 *
 * §11.0: *"Vor jeder Entscheidung für die kostenpflichtige Spur gehört
 * deshalb erst die lokale gemessen — sonst kauft man Qualität ein, die
 * man schon hat."* This is that measurement, and it is a script rather
 * than an endpoint on purpose: it costs money and it takes minutes.
 *
 * Usage:
 *
 *   npx tsx trip-planner/llm-bench/run.ts                  # both tracks
 *   npx tsx trip-planner/llm-bench/run.ts --track=local    # only the local one
 *   npx tsx trip-planner/llm-bench/run.ts --json=out.json  # also write the raw answers
 *
 * The local track needs `llm-service` reachable (`LLM_SERVICE_URL`,
 * default `http://localhost:8002`) **and** `INTERNAL_SERVICE_SECRET`,
 * which is what that service authenticates with; the cloud track needs
 * `ANTHROPIC_API_KEY`. A track whose prerequisite is missing is skipped
 * with a line saying so, rather than failing the run — half a
 * measurement is still worth having.
 *
 * The category vocabulary is read from the geo service, exactly as
 * `interpret.ts` reads it, so the prompt under test is the prompt in
 * production. Without geo running, `--categories=<file.json>` takes a
 * `[{ "id": …, "description": … }]` array instead; copying the list
 * into this directory would be a second source of truth waiting to
 * drift.
 *
 * **Both tracks get the identical prompt** (`buildInterpretPrompt`) and
 * both answers go through `normalizeConstraints` before they are
 * scored. That is the only way the number means what it appears to
 * mean: anything else compares prompts, or compares a raw model against
 * a validated one.
 */

// The llm-service refuses anything without `Authorization: Bearer
// $INTERNAL_SERVICE_SECRET`, and the header is attached by patching
// global fetch on import — the services get it from their
// `encore.service.ts`. A script is not a service, so it has to say so
// itself; without this line the local track collects ten 401s.
import "../../lib/internal-service-auth";

import { readFileSync, writeFileSync } from "node:fs";
import { getGeoClient } from "../../osm-admin/geo-client";
import { normalizeConstraints, type NlConstraints } from "../constraints";
import { askClaudeForJson, BENCH_MODEL, ClaudeUnavailableError } from "../claude-client";
import { askForJson, buildInterpretPrompt, LlmServiceUnavailableError } from "../llm-client";
import { BENCH_CASES, type BenchCase } from "./cases";
import { scoreCase, totalsOf, type CaseScore, type RunTotals } from "./score";

type Track = "local" | "claude";

interface Attempt {
  track: Track;
  case: BenchCase;
  constraints: NlConstraints | null;
  rejected: string[];
  score: CaseScore | null;
  millis: number;
  /** Why there is no score, when there is none. */
  error: string | null;
  inputTokens?: number;
  outputTokens?: number;
}

interface Vocabulary {
  id: string;
  description: string;
}

async function loadCategories(fromFile: string | null): Promise<Vocabulary[]> {
  if (fromFile !== null) {
    const parsed: unknown = JSON.parse(readFileSync(fromFile, "utf8"));
    if (!Array.isArray(parsed)) throw new Error(`${fromFile} is not a JSON array`);
    return parsed as Vocabulary[];
  }
  return await getGeoClient().poiCategories();
}

async function runCase(
  track: Track,
  benchCase: BenchCase,
  categories: readonly Vocabulary[],
  categoryIds: readonly string[],
): Promise<Attempt> {
  const prompt = buildInterpretPrompt(benchCase.text, categories);
  const started = Date.now();
  try {
    const answer = track === "local"
      ? { json: await askForJson(prompt), inputTokens: undefined, outputTokens: undefined }
      : await askClaudeForJson(prompt);
    const { constraints, rejected } = normalizeConstraints(answer.json, [...categoryIds]);
    return {
      track,
      case: benchCase,
      constraints,
      rejected,
      score: scoreCase(benchCase.expected, constraints),
      millis: Date.now() - started,
      error: null,
      inputTokens: answer.inputTokens,
      outputTokens: answer.outputTokens,
    };
  } catch (err) {
    // A track that cannot answer is a result too — but it is not a
    // wrong answer, and lumping the two together would flatter whichever
    // track happens to be down.
    return {
      track,
      case: benchCase,
      constraints: null,
      rejected: [],
      score: null,
      millis: Date.now() - started,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const wanted = trackArg(args);
  const jsonPath = valueArg(args, "--json");

  let categories: Vocabulary[];
  try {
    categories = await loadCategories(valueArg(args, "--categories"));
  } catch (err) {
    console.error(
      "Kategorien nicht ladbar — geo erreichbar? Sonst --categories=<datei.json>.\n" +
      (err instanceof Error ? err.message : String(err)),
    );
    process.exitCode = 1;
    return;
  }
  const categoryIds = categories.map((category) => category.id);

  const tracks: Track[] = [];
  for (const track of wanted) {
    const missing = missingPrerequisite(track);
    if (missing) {
      console.log(`übersprungen: ${track} — ${missing}`);
      continue;
    }
    tracks.push(track);
  }
  if (tracks.length === 0) {
    console.log("Keine Spur lauffähig. Nichts zu messen.");
    process.exitCode = 1;
    return;
  }

  const attempts: Attempt[] = [];
  for (const benchCase of BENCH_CASES) {
    for (const track of tracks) {
      // Sequential on purpose: two tracks answering at once would make
      // the latency column meaningless, and that column is half the
      // question §11.0 asks.
      attempts.push(await runCase(track, benchCase, categories, categoryIds));
    }
  }

  report(attempts, tracks);
  if (jsonPath) {
    writeFileSync(jsonPath, JSON.stringify({ model: BENCH_MODEL, attempts }, null, 2));
    console.log(`\nRohdaten: ${jsonPath}`);
  }
}

function report(attempts: readonly Attempt[], tracks: readonly Track[]): void {
  for (const benchCase of BENCH_CASES) {
    console.log(`\n[${benchCase.kind}] ${benchCase.id}`);
    console.log(`  „${benchCase.text}"`);
    console.log(`  ${benchCase.note}`);
    for (const track of tracks) {
      const attempt = attempts.find((a) => a.track === track && a.case.id === benchCase.id);
      if (!attempt) continue;
      console.log(`  ${track.padEnd(7)} ${lineFor(attempt)}`);
      for (const field of attempt.score?.fields ?? []) {
        if (field.verdict === "hit") continue;
        console.log(
          `          ${field.verdict.padEnd(9)} ${field.field}: ` +
          `erwartet ${show(field.expected)}, bekommen ${show(field.got)}`,
        );
      }
      if (attempt.rejected.length > 0) {
        console.log(`          verworfen: ${attempt.rejected.join("; ")}`);
      }
    }
  }

  console.log("\n────────────────────────────────────────");
  for (const track of tracks) {
    const totals = totalsOf(
      attempts.filter((attempt) => attempt.track === track).map((attempt) => attempt.score),
    );
    console.log(`${track.padEnd(7)} ${summary(totals, medianMillis(attempts, track))}`);
  }
  console.log(
    "\nrichtig = vom Satz gesagt und gelesen · erfunden = nicht gesagt und trotzdem geliefert",
  );
}

function lineFor(attempt: Attempt): string {
  if (attempt.error !== null) return `FEHLER (${attempt.millis} ms): ${attempt.error}`;
  const score = attempt.score!;
  const tokens = attempt.outputTokens === undefined
    ? ""
    : ` · ${attempt.inputTokens}+${attempt.outputTokens} Token`;
  return `richtig ${score.hits}, verpasst ${score.missed}, falsch ${score.wrong}, ` +
    `erfunden ${score.invented} (${attempt.millis} ms${tokens})`;
}

function summary(totals: RunTotals, median: number): string {
  const stated = totals.hits + totals.missed + totals.wrong;
  const failed = totals.failures > 0 ? `, ${totals.failures} ohne Antwort` : "";
  // A track that answered nothing has no accuracy. Printing "0 %" would
  // read as "answered everything wrong", which is a different finding.
  if (stated === 0) return `keine auswertbare Antwort${failed}`;
  return `${(totals.accuracy * 100).toFixed(0)} % richtig (${totals.hits}/${stated}), ` +
    `erfunden ${totals.invented}, Median ${median} ms${failed}`;
}

function medianMillis(attempts: readonly Attempt[], track: Track): number {
  const times = attempts
    .filter((attempt) => attempt.track === track && attempt.error === null)
    .map((attempt) => attempt.millis)
    .sort((a, b) => a - b);
  if (times.length === 0) return 0;
  return times[Math.floor(times.length / 2)];
}

function show(value: unknown): string {
  if (value === undefined) return "—";
  return JSON.stringify(value);
}

function trackArg(args: readonly string[]): Track[] {
  const value = valueArg(args, "--track");
  if (value === "local") return ["local"];
  if (value === "claude") return ["claude"];
  return ["local", "claude"];
}

function valueArg(args: readonly string[], name: string): string | null {
  const hit = args.find((arg) => arg.startsWith(`${name}=`));
  return hit ? hit.slice(name.length + 1) : null;
}

function missingPrerequisite(track: Track): string | null {
  if (track === "claude" && !process.env.ANTHROPIC_API_KEY) {
    return "ANTHROPIC_API_KEY ist nicht gesetzt";
  }
  // Not a skip: someone may be pointing LLM_SERVICE_URL at a bare
  // llama.cpp server that never asked for a token. Against the service
  // in the stack it is a guaranteed 401, so it is worth saying out loud
  // before ten cases fail identically.
  if (track === "local" && !process.env.INTERNAL_SERVICE_SECRET) {
    console.log(
      "Hinweis: INTERNAL_SERVICE_SECRET ist nicht gesetzt — der llm-service " +
      "im Stack antwortet darauf mit 401.",
    );
  }
  return null;
}

void main().catch((err) => {
  // Not an expected failure of a track — those are caught per case.
  console.error(err instanceof LlmServiceUnavailableError || err instanceof ClaudeUnavailableError
    ? err.message
    : err);
  process.exitCode = 1;
});
