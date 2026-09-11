/**
 * Measuring the negotiation chat (§11.3, Weg 3).
 *
 * The last of §11.1's four tasks, and the only one with **no incumbent**:
 * the planner has no chat today. `interpretRequest` reads a sentence
 * into constraints, which covers perhaps a third of these cases and
 * cannot pin, hide or re-plan a day. So the line to beat here is not a
 * baseline but zero, and the question is not "better than what we have"
 * but *"good enough to let near a plan at all"*.
 *
 * Usage:
 *
 *   npx tsx trip-planner/llm-bench/run-chat.ts
 *   npx tsx trip-planner/llm-bench/run-chat.ts --track=claude --json=out.json
 *
 * Prerequisites as in `README.md`. Both tracks are asked for JSON rather
 * than given a native tool-use API — the local service has no tool
 * protocol, and giving one side a better interface would measure the
 * interface. That is a limit of this run and worth saying: Claude's own
 * tool use is sturdier than JSON in prose.
 */

import "../../lib/internal-service-auth";

import { writeFileSync } from "node:fs";
import { askClaudeForJson, BENCH_MODEL } from "../claude-client";
import { askForJson } from "../llm-client";
import { CHAT_CASES, CHAT_PLAN, CHAT_TOOLS, type ChatCase } from "./chat-cases";
import { scoreChat, totalsOfChat, type ChatScore, type ToolCall } from "./chat-score";

type Track = "local" | "claude";

interface Attempt {
  track: Track;
  caseId: string;
  calls: ToolCall[];
  score: ChatScore | null;
  millis: number;
  error: string | null;
  inputTokens?: number;
  outputTokens?: number;
}

export function buildChatPrompt(benchCase: ChatCase): string {
  const tools = CHAT_TOOLS.map((tool) => {
    const args = Object.entries(tool.args)
      .map(([name, type]) => `${name}: ${type}`)
      .join(", ");
    return `- ${tool.name}(${args}) — ${tool.description}`;
  });

  return [
    "Du bedienst einen Reiseplaner für eine Familie. Du redest nicht über den",
    "Plan, du änderst ihn — mit den Werkzeugen unten.",
    "",
    "Werkzeuge:",
    ...tools,
    "",
    "Der Plan, so wie er gerade steht:",
    JSON.stringify(CHAT_PLAN, null, 1),
    "",
    "Die Person sagt:",
    benchCase.utterance,
    "",
    "Antworte ausschließlich mit einem JSON-Objekt, ohne Erklärung, ohne Markdown:",
    '  { "calls": [ { "tool": "name", "args": { … } } ] }',
    "",
    "Regeln:",
    "- Nur Werkzeuge aus der Liste.",
    "- Tu nur, was der Satz verlangt — nicht mehr.",
    "- Sagt der Satz nicht, worauf er sich bezieht, frage nach (rueckfrage).",
    "- Verlangt der Satz keine Änderung, antworte mit nichts.",
  ].join("\n");
}

export function parseCalls(raw: unknown): ToolCall[] {
  const list = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as { calls?: unknown } | null)?.calls)
      ? ((raw as { calls: unknown[] }).calls)
      : [];

  const calls: ToolCall[] = [];
  for (const entry of list) {
    if (typeof entry === "string") {
      calls.push({ tool: entry, args: {} });
      continue;
    }
    const record = entry as Record<string, unknown> | null;
    const name = record?.tool ?? record?.name ?? record?.werkzeug;
    if (typeof name !== "string" || name.trim() === "") continue;
    const args = record?.args ?? record?.arguments ?? record?.parameter;
    calls.push({
      tool: name.trim(),
      args: (args && typeof args === "object" ? args : {}) as Record<string, unknown>,
    });
  }
  return calls;
}

async function run(track: Track, benchCase: ChatCase): Promise<Attempt> {
  const started = Date.now();
  const prompt = buildChatPrompt(benchCase);
  try {
    const answer = track === "local"
      ? { json: await askForJson(prompt), inputTokens: undefined, outputTokens: undefined }
      : await askClaudeForJson(prompt);
    const calls = parseCalls(answer.json);
    return {
      track,
      caseId: benchCase.id,
      calls,
      score: scoreChat(benchCase, calls),
      millis: Date.now() - started,
      error: null,
      inputTokens: answer.inputTokens,
      outputTokens: answer.outputTokens,
    };
  } catch (err) {
    return {
      track,
      caseId: benchCase.id,
      calls: [],
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
  if (tracks.length === 0) {
    console.log("Keine Spur lauffähig. Nichts zu messen.");
    process.exitCode = 1;
    return;
  }

  const attempts: Attempt[] = [];
  for (const benchCase of CHAT_CASES) {
    console.log(`\n[${benchCase.id}] „${benchCase.utterance}"`);
    console.log(`  ${benchCase.note}`);
    for (const track of tracks) {
      const attempt = await run(track, benchCase);
      attempts.push(attempt);
      console.log(`  ${track.padEnd(7)} ${lineFor(attempt)}`);
    }
  }

  console.log("\n────────────────────────────────────────");
  for (const track of tracks) {
    const mine = attempts.filter((attempt) => attempt.track === track);
    const totals = totalsOfChat(mine.map((attempt) => attempt.score));
    const median = medianOf(mine.map((attempt) => attempt.millis));
    console.log(
      `${track.padEnd(7)} getroffen ${totals.hits}/${totals.cases} · ` +
      `übergriffig ${totals.overreaching} · ungefragt dazu ${totals.extras} · ` +
      `Median ${median} ms` +
      (totals.failures > 0 ? ` · ${totals.failures} ohne Antwort` : ""),
    );
  }
  console.log(
    "\nübergriffig = ein Aufruf, den der Fall ausschließt — der Fehler, der Vertrauen kostet",
  );

  if (jsonPath) {
    writeFileSync(jsonPath, JSON.stringify({ model: BENCH_MODEL, attempts }, null, 2));
    console.log(`\nRohdaten: ${jsonPath}`);
  }
}

function lineFor(attempt: Attempt): string {
  if (attempt.error !== null) return `FEHLER (${attempt.millis} ms): ${attempt.error}`;
  const score = attempt.score!;
  const parts = [score.hit ? "getroffen" : "verfehlt"];
  if (score.produced.length > 0) parts.push(`[${score.produced.join(", ")}]`);
  if (!score.hit && score.missing.length > 0) parts.push(`fehlt: ${score.missing.join(", ")}`);
  if (score.overreach.length > 0) parts.push(`ÜBERGRIFFIG: ${score.overreach.join(", ")}`);
  parts.push(`${attempt.millis} ms`);
  if (attempt.outputTokens !== undefined) {
    parts.push(`${attempt.inputTokens}+${attempt.outputTokens} Token`);
  }
  return parts.join(" · ");
}

function medianOf(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length === 0 ? 0 : sorted[Math.floor(sorted.length / 2)];
}

function trackArg(args: readonly string[]): Track[] {
  const value = valueArg(args, "--track");
  if (value === "local" || value === "claude") return [value];
  return ["local", "claude"];
}

function valueArg(args: readonly string[], name: string): string | null {
  const hit = args.find((arg) => arg.startsWith(`${name}=`));
  return hit ? hit.slice(name.length + 1) : null;
}

void main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
