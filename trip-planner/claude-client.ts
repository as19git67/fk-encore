/**
 * The same question, asked of the Claude API instead of the local model (§11).
 *
 * §11.0 is explicit that the cloud track must be **measured before it is
 * bought**: the estimates in §11.1 ("brüchig", "deutlich besser") date
 * from the Qwen-7B era, and the local model has been replaced twice
 * since. This client exists so that the measurement is possible — it is
 * the second implementation of `askForJson`'s shape, and nothing in the
 * planner calls it yet.
 *
 * Deliberately the *same prompt* as the local track. A comparison in
 * which each side gets its own prompt measures prompt engineering, not
 * models; whatever this answers has to survive the same
 * `normalizeConstraints` gate as the local answer, for the same reason
 * (§10.4: nothing a model says is trusted).
 *
 * The key comes from the environment rather than Encore's secret
 * manager because there is no request path to protect yet — when §11 is
 * actually wired in, that is the line to change first.
 */

import Anthropic from "@anthropic-ai/sdk";

/** What §11 costs and what it can read is a property of the model. */
export const BENCH_MODEL = "claude-opus-5";

export class ClaudeUnavailableError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "ClaudeUnavailableError";
  }
}

export interface ClaudeAnswer {
  json: unknown;
  inputTokens: number;
  outputTokens: number;
  /** Wall-clock, so the two tracks can be compared on latency too. */
  millis: number;
}

let client: Anthropic | null = null;

function clientOrThrow(): Anthropic {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new ClaudeUnavailableError("ANTHROPIC_API_KEY is not set");
  }
  client ??= new Anthropic();
  return client;
}

/**
 * Put one prompt to Claude and hand back whatever JSON came out.
 *
 * Reading a sentence into fields is not hard work, so this runs at low
 * effort — the comparison is about whether the answer is *right*, and
 * paying for depth the task does not need would measure the wrong
 * thing. Thinking is left at its default (adaptive) rather than turned
 * off: a disabled-thinking Opus 5 has failure modes of its own.
 */
export async function askClaudeForJson(
  prompt: string,
  model: string = BENCH_MODEL,
): Promise<ClaudeAnswer> {
  const started = Date.now();
  let response;
  try {
    response = await clientOrThrow().messages.create({
      model,
      // A constraints object is a handful of fields; this is a
      // deliberately short output, not a lowballed one.
      max_tokens: 2_048,
      output_config: { effort: "low" },
      messages: [{ role: "user", content: prompt }],
    });
  } catch (err) {
    throw new ClaudeUnavailableError(
      err instanceof Error ? err.message : "the Claude API could not be reached",
    );
  }

  if (response.stop_reason === "refusal") {
    throw new ClaudeUnavailableError(
      `refused: ${response.stop_details?.category ?? "unknown"}`,
    );
  }

  const text = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("");

  return {
    json: parseJsonAnswer(text),
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
    millis: Date.now() - started,
  };
}

/**
 * Read the JSON out of an answer that was asked to be JSON alone.
 *
 * Both tracks are told "no explanation, no markdown", and both
 * occasionally add a fence anyway. Stripping it here rather than in the
 * scorer keeps the measurement about *understanding* rather than about
 * who is tidier — a wrapped-but-correct object is a correct answer.
 */
export function parseJsonAnswer(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed);
  const body = fenced ? fenced[1] : trimmed;
  try {
    return JSON.parse(body);
  } catch {
    // A model that wrote a sentence around the object: take the outermost
    // braces rather than declaring the answer unusable.
    const start = body.indexOf("{");
    const end = body.lastIndexOf("}");
    if (start === -1 || end <= start) {
      throw new ClaudeUnavailableError("the answer contained no JSON object");
    }
    try {
      return JSON.parse(body.slice(start, end + 1));
    } catch (err) {
      throw new ClaudeUnavailableError(
        `the answer was not valid JSON: ${err instanceof Error ? err.message : err}`,
      );
    }
  }
}
