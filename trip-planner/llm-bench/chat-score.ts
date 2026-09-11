/**
 * Scoring what the negotiation chat did with a sentence (§11.3, Weg 3).
 *
 * Three verdicts, and the order matters — they are not equally bad:
 *
 *   - **getroffen** — the expected call, with the arguments that decide
 *     which call it is. Extra arguments are fine; a wrong `ref` is not.
 *   - **verfehlt** — the expected call is missing, or came with the
 *     wrong argument. A plan that did not change is a plan somebody has
 *     to change by hand: annoying, visible, harmless.
 *   - **übergriffig** — a call nobody asked for. This is the one that
 *     costs trust rather than time: a model that answers "das ist mir zu
 *     viel Laufen" by also deleting three spots has changed a trip
 *     behind somebody's back, and §7.1 forbids exactly that. It is
 *     counted separately and never offset by a hit.
 */

import type { ChatCase, ExpectedCall } from "./chat-cases";

export interface ToolCall {
  tool: string;
  args: Record<string, unknown>;
}

export interface ChatScore {
  hit: boolean;
  /** Which expected calls were not produced. */
  missing: string[];
  /** Calls the case explicitly rules out. */
  overreach: string[];
  /** Calls beyond what was expected that are not explicitly forbidden. */
  extra: string[];
  produced: string[];
}

export function scoreChat(benchCase: ChatCase, calls: readonly ToolCall[]): ChatScore {
  const produced = calls.map((call) => call.tool);
  const forbidden = new Set(benchCase.forbidden ?? []);

  const matched = (expected: ExpectedCall) =>
    calls.some((call) => matches(expected, call));

  const primaryHit = benchCase.expected.every(matched);
  const alternativeHit = benchCase.orElse !== undefined && benchCase.orElse.every(matched);
  const hit = primaryHit || alternativeHit;

  // Whichever reading was answered decides what counts as "expected" —
  // otherwise the alternative's own calls would show up as extras.
  const answered = alternativeHit && !primaryHit ? benchCase.orElse! : benchCase.expected;
  const expectedNames = new Set(answered.map((call) => call.tool));
  return {
    hit,
    missing: hit ? [] : benchCase.expected.filter((call) => !matched(call)).map(describe),
    overreach: produced.filter((name) => forbidden.has(name)),
    extra: produced.filter((name) => !expectedNames.has(name) && !forbidden.has(name)),
    produced,
  };
}

/**
 * Does this call answer that expectation?
 *
 * Only the arguments named in the expectation are compared, and loosely
 * — `"1"` and `1` are the same day, `"relaxed"` and `"Relaxed"` the same
 * pace. What is compared strictly is *which* thing is meant: a `ref` is
 * an identity, and the wrong one is a different spot, not a phrasing.
 */
function matches(expected: ExpectedCall, call: ToolCall): boolean {
  if (call.tool !== expected.tool) return false;
  for (const [key, want] of Object.entries(expected.args ?? {})) {
    const have = call.args?.[key];
    if (have === undefined || have === null) return false;
    if (String(have).trim().toLowerCase() !== String(want).trim().toLowerCase()) {
      return false;
    }
  }
  return true;
}

function describe(call: ExpectedCall): string {
  const args = Object.entries(call.args ?? {})
    .map(([key, value]) => `${key}=${value}`)
    .join(", ");
  return args ? `${call.tool}(${args})` : call.tool;
}

export interface ChatTotals {
  cases: number;
  hits: number;
  overreaching: number;
  extras: number;
  failures: number;
}

export function totalsOfChat(scores: readonly (ChatScore | null)[]): ChatTotals {
  const scored = scores.filter((score): score is ChatScore => score !== null);
  return {
    cases: scores.length,
    hits: scored.filter((score) => score.hit).length,
    // Cases carrying at least one forbidden call, not calls: two
    // uninvited deletions in one answer are one act of overreach.
    overreaching: scored.filter((score) => score.overreach.length > 0).length,
    extras: scored.reduce((total, score) => total + score.extra.length, 0),
    failures: scores.length - scored.length,
  };
}
