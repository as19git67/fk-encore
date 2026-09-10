/**
 * Measuring the curation §11.3 expects the most from.
 *
 * Three tracks, not two, because here the incumbent is not a model:
 *
 *   - **scoring** — what the planner does today. `toCandidates()` gives
 *     every spot a weighted sum over its OSM tags, and the top of that
 *     list is the pool a day is built from. It cannot invent and it
 *     cannot notice that six of its picks are the same village church.
 *   - **local** — the same prompt to the model in the house.
 *   - **claude** — the same prompt to the Claude API.
 *
 * Usage:
 *
 *   npx tsx trip-planner/llm-bench/run-curation.ts
 *   npx tsx trip-planner/llm-bench/run-curation.ts --track=claude
 *   npx tsx trip-planner/llm-bench/run-curation.ts --json=out.json
 *
 * Same prerequisites as the sentence bench (`README.md`): the local
 * track needs `LLM_SERVICE_URL` and `INTERNAL_SERVICE_SECRET`, the
 * cloud track `ANTHROPIC_API_KEY`. The scoring track needs nothing and
 * always runs — it is the line the other two have to beat.
 */

import "../../lib/internal-service-auth";

import { writeFileSync } from "node:fs";
import { toCandidates } from "../candidates";
import { askClaudeForJson, BENCH_MODEL } from "../claude-client";
import { askForJson } from "../llm-client";
import { buildCuratePrompt, parseCuration } from "./curate";
import { CURATION_POOL, CURATION_REQUEST } from "./curation-cases";
import { faultsOf, scoreCuration, type CurationPick, type CurationScore } from "./curation-score";

type Track = "scoring" | "local" | "claude";

interface Attempt {
  track: Track;
  picks: CurationPick[];
  score: CurationScore | null;
  millis: number;
  error: string | null;
  inputTokens?: number;
  outputTokens?: number;
  unusable?: number;
}

const spots = CURATION_POOL.map((entry) => entry.spot);

/**
 * Today's answer: the weighted sum, best first.
 *
 * `requireProminence` is on because that is how the planner builds a
 * pool — which is also what makes this comparison fair rather than a
 * straw man: the everyday entries without an article are already gone
 * before the ranking starts, and the two that carry one are exactly the
 * case the sum cannot see.
 */
function scoringPicks(pool: readonly typeof spots[number][] = spots): CurationPick[] {
  return toCandidates(pool, { requireProminence: true })
    .sort((a, b) => b.score - a.score)
    .slice(0, CURATION_REQUEST.pick)
    .map((candidate) => ({
      osmRef: candidate.osmRef,
      why: candidate.reasons.join(", "),
    }));
}

/**
 * How much of the weighted sum's answer is actually the weighted sum.
 *
 * The score is built from a handful of half-point signals, so a pool
 * of a city produces long ties — everything with a Wikidata id and an
 * article lands on the same number. Where the cut falls inside such a
 * tie, the selection is decided by **the order the region search
 * happened to return**, which is not a judgement about anything.
 *
 * Measured rather than asserted: the same ranking is run again over a
 * reversed pool. A different set coming out is the proof.
 */
function tieDepth(): { tied: number; atScore: number } {
  const ranked = toCandidates(spots, { requireProminence: true })
    .sort((a, b) => b.score - a.score);
  const cut = ranked[CURATION_REQUEST.pick - 1];
  if (!cut) return { tied: 0, atScore: 0 };
  return {
    tied: ranked.filter((candidate) => candidate.score === cut.score).length,
    atScore: cut.score,
  };
}

async function run(track: Track): Promise<Attempt> {
  const started = Date.now();
  if (track === "scoring") {
    const picks = scoringPicks();
    return {
      track,
      picks,
      score: scoreCuration(CURATION_POOL, picks),
      millis: Date.now() - started,
      error: null,
    };
  }

  const prompt = buildCuratePrompt(spots, CURATION_REQUEST);
  try {
    const answer = track === "local"
      ? { json: await askForJson(prompt), inputTokens: undefined, outputTokens: undefined }
      : await askClaudeForJson(prompt);
    const parsed = parseCuration(answer.json);
    return {
      track,
      picks: parsed.picks,
      score: scoreCuration(CURATION_POOL, parsed.picks),
      millis: Date.now() - started,
      error: null,
      inputTokens: answer.inputTokens,
      outputTokens: answer.outputTokens,
      unusable: parsed.unusable,
    };
  } catch (err) {
    return {
      track,
      picks: [],
      score: null,
      millis: Date.now() - started,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const jsonPath = valueArg(args, "--json");
  const wanted = trackArg(args);

  const tracks: Track[] = [];
  for (const track of wanted) {
    if (track === "claude" && !process.env.ANTHROPIC_API_KEY) {
      console.log("übersprungen: claude — ANTHROPIC_API_KEY ist nicht gesetzt");
      continue;
    }
    tracks.push(track);
  }

  console.log(`Vorrat: ${spots.length} Orte · gesucht: ${CURATION_REQUEST.pick}`);
  console.log(`Anfrage: „${CURATION_REQUEST.sentence}"`);

  const attempts: Attempt[] = [];
  for (const track of tracks) attempts.push(await run(track));

  const byRef = new Map(CURATION_POOL.map((entry) => [entry.spot.osmRef, entry]));
  for (const attempt of attempts) {
    console.log(`\n── ${attempt.track} ${"─".repeat(Math.max(0, 30 - attempt.track.length))}`);
    if (attempt.error !== null) {
      console.log(`  FEHLER (${attempt.millis} ms): ${attempt.error}`);
      continue;
    }
    for (const pick of attempt.picks) {
      const entry = byRef.get(pick.osmRef);
      const marks = entry ? marksFor(entry.label) : " ⚠ nicht im Vorrat";
      console.log(`  ${(entry?.spot.name ?? pick.osmRef).padEnd(34)}${marks}`);
    }
    console.log(`  ${summary(attempt)}`);
  }

  console.log("\n────────────────────────────────────────");
  for (const attempt of attempts) {
    if (attempt.score === null) continue;
    console.log(`${attempt.track.padEnd(8)} Fehlgriffe ${faultsOf(attempt.score)}`);
  }

  // What the incumbent's answer rests on, said out loud.
  const tie = tieDepth();
  const reversed = scoringPicks([...spots].reverse());
  const overlap = new Set(scoringPicks().map((pick) => pick.osmRef));
  const same = reversed.filter((pick) => overlap.has(pick.osmRef)).length;
  console.log(
    `\nscoring: ${tie.tied} Kandidaten liegen bei ${tie.atScore} Punkten gleichauf — ` +
    `die Auswahl entscheidet dort die Reihenfolge der Suche.\n` +
    `Bei umgekehrter Vorratsreihenfolge bleiben ${same} von ${CURATION_REQUEST.pick} ` +
    `Orten dieselben (Fehlgriffe dann ${faultsOf(scoreCuration(CURATION_POOL, reversed))}).`,
  );
  console.log(
    "\nFehlgriffe = erfunden + Alltag + Einerlei über Budget + schlecht fürs Kind",
  );

  if (jsonPath) {
    writeFileSync(jsonPath, JSON.stringify({ model: BENCH_MODEL, attempts }, null, 2));
    console.log(`\nRohdaten: ${jsonPath}`);
  }
}

function marksFor(label: { landmark?: boolean; everyday?: boolean; cluster?: string; poorForChildren?: boolean }): string {
  const marks: string[] = [];
  if (label.landmark) marks.push("★");
  if (label.everyday) marks.push("Alltag");
  if (label.cluster) marks.push(label.cluster);
  if (label.poorForChildren) marks.push("nichts fürs Kind");
  return marks.length === 0 ? "" : ` ${marks.join(" · ")}`;
}

function summary(attempt: Attempt): string {
  const score = attempt.score!;
  const parts = [
    `${score.picked} gewählt`,
    `★ ${score.landmarksFound}/${score.landmarksTotal}`,
    `${score.categories.length} Kategorien`,
    `Fehlgriffe ${faultsOf(score)}`,
  ];
  if (score.invented.length > 0) parts.push(`erfunden ${score.invented.length}`);
  if (score.monotony.length > 0) {
    parts.push(...score.monotony.map((group) => `${group.cluster} ${group.taken}×`));
  }
  parts.push(`${attempt.millis} ms`);
  if (attempt.outputTokens !== undefined) {
    parts.push(`${attempt.inputTokens}+${attempt.outputTokens} Token`);
  }
  return parts.join(" · ");
}

function trackArg(args: readonly string[]): Track[] {
  const value = valueArg(args, "--track");
  if (value === "scoring" || value === "local" || value === "claude") return [value];
  return ["scoring", "local", "claude"];
}

function valueArg(args: readonly string[], name: string): string | null {
  const hit = args.find((arg) => arg.startsWith(`${name}=`));
  return hit ? hit.slice(name.length + 1) : null;
}

void main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
