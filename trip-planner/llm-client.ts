/**
 * Trip-planner-scoped client for the `llm-service` FastAPI container.
 *
 * Shares shape and failure handling with finance/llm-client.ts: the
 * generic `/json-prompt` endpoint, a hard timeout, and one error type
 * that callers on a request path treat as "the model is not available
 * right now".
 *
 * A background job must tell more apart, because "try again on the
 * next tick" is only right for an outage: an unusable answer
 * (`LlmAnswerUnusableError`) comes back the same at temperature 0, and
 * a timeout (`LlmTimeoutError`) kept the GPU busy for the whole budget.
 * Both are subclasses, so a request path sees no difference; a job asks
 * `isLlmOutage`.
 *
 * The prompt asks for constraints, never for a plan. That boundary is
 * the concept's (§11.6): the model reads the sentence, the solver
 * decides the day. Whatever comes back is passed through
 * `normalizeConstraints` before anything acts on it — nothing here
 * trusts the response.
 */

import { AiSlotTimeoutError, withLlmSlot } from "../ai-queue/slot-helper";
import { llmBudgetMs } from "../lib/llm-lease";

const LLM_SERVICE_URL =
  (process.env.LLM_SERVICE_URL || "http://localhost:8002").replace(/\/$/, "");
const DEFAULT_TIMEOUT_MS = parseInt(process.env.LLM_SERVICE_TIMEOUT_MS ?? "120000", 10);

export class LlmServiceUnavailableError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "LlmServiceUnavailableError";
  }
}

/**
 * The service answered, but with nothing to use: cut off at
 * `max_tokens` (422), not JSON (502), a prompt the model refused (400,
 * 500). The same prompt gets the same answer again, so a job must not
 * retry it on every tick: that was a minute of GPU every five minutes
 * for one stay's highlights.
 */
export class LlmAnswerUnusableError extends LlmServiceUnavailableError {
  constructor(reason: string, readonly status: number | null) {
    super(reason);
    this.name = "LlmAnswerUnusableError";
  }

  /** Cut off at `max_tokens`: nothing but a different prompt helps. */
  get cutOff(): boolean {
    return this.status === 422;
  }
}

/** The model worked for the whole budget and did not finish. */
export class LlmTimeoutError extends LlmServiceUnavailableError {
  constructor(reason: string) {
    super(reason);
    this.name = "LlmTimeoutError";
  }
}

/**
 * Nobody computed anything: the service is down, busy (503) or no slot
 * came free. The only failure a background job may retry right away.
 */
export function isLlmOutage(err: unknown): boolean {
  return err instanceof LlmServiceUnavailableError
    && !(err instanceof LlmAnswerUnusableError)
    && !(err instanceof LlmTimeoutError);
}

/** Statuses that mean "not now" rather than "not this prompt". */
const OUTAGE_STATUSES = new Set([429, 503]);

export interface CategoryVocabularyEntry {
  id: string;
  description: string;
}

/**
 * Ask the model to read one sentence into planning constraints.
 *
 * Returns the raw parsed object — validation is the caller's job, via
 * `normalizeConstraints`. Keeping the two apart means the validation
 * can be tested exhaustively without a model in the loop.
 */
export async function interpretTripRequest(
  text: string,
  categories: readonly CategoryVocabularyEntry[],
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<unknown> {
  return await askForJson(buildInterpretPrompt(text, categories), timeoutMs);
}

/**
 * Put one prompt to the model and hand back whatever JSON came out.
 *
 * The transport, and nothing else. Every caller pairs it with a
 * validator of its own — `normalizeConstraints` for a sentence,
 * `parseExtractedPlaces` for an article — because the one thing this
 * layer must not do is decide that a response is usable.
 */
export async function askForJson(
  prompt: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  options: { maxTokens?: number } = {},
): Promise<unknown> {
  try {
    return await withLlmSlot("trip-planner:json-prompt", () => postPrompt(prompt, timeoutMs, options));
  } catch (err) {
    if (err instanceof AiSlotTimeoutError) throw new LlmServiceUnavailableError(err.message);
    throw err;
  }
}

async function postPrompt(
  prompt: string,
  timeoutMs: number,
  options: { maxTokens?: number },
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), await llmBudgetMs(timeoutMs));
  let resp: Response;
  try {
    resp = await fetch(`${LLM_SERVICE_URL}/json-prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // The service's default of 768 tokens fits an answer about a
      // sentence; a translated section needs room for its own length.
      body: JSON.stringify({
        prompt,
        temperature: 0,
        ...(options.maxTokens ? { max_tokens: options.maxTokens } : {}),
      }),
      signal: controller.signal,
    });
  } catch (err) {
    const message = `llm-service /json-prompt failed: ${(err as Error)?.message ?? err}`;
    if (controller.signal.aborted) throw new LlmTimeoutError(message);
    throw new LlmServiceUnavailableError(message);
  } finally {
    clearTimeout(timer);
  }

  if (!resp.ok) {
    const message = `llm-service /json-prompt returned HTTP ${resp.status}`;
    if (OUTAGE_STATUSES.has(resp.status)) throw new LlmServiceUnavailableError(message);
    if (resp.status === 504) throw new LlmTimeoutError(message);
    throw new LlmAnswerUnusableError(message, resp.status);
  }
  try {
    return await resp.json();
  } catch (err) {
    throw new LlmAnswerUnusableError(
      `llm-service /json-prompt produced invalid JSON: ${(err as Error)?.message ?? err}`,
      null,
    );
  }
}

/**
 * The prompt. Exported so a test can assert it still names every
 * category the vocabulary carries — a category added in geo that never
 * reaches the prompt would be unreachable through natural language,
 * and nothing else would notice.
 */
export function buildInterpretPrompt(
  text: string,
  categories: readonly CategoryVocabularyEntry[],
): string {
  const vocabulary = categories.map((c) => `- ${c.id}: ${c.description}`).join("\n");
  return [
    "Du liest eine Urlaubsplanungs-Anfrage und übersetzt sie in Planungsvorgaben.",
    "Antworte ausschließlich mit einem JSON-Objekt, ohne Erklärung, ohne Markdown.",
    "",
    "Felder (alle optional — lass weg, was der Satz nicht hergibt):",
    '  "title":          string, kurzer Name für die Reise',
    '  "placeHint":      string, der genannte Ort (nur der Name, keine Koordinaten)',
    '  "days":           ganze Zahl, Anzahl Tage',
    '  "radiusM":        Zahl, Suchradius in Metern um den Ausgangspunkt',
    '  "pace":           "relaxed" | "normal" | "packed"',
    '  "maxWalkMinutes": Zahl, längster zumutbarer Einzelfußweg in Minuten',
    '  "categories":     Array aus der unten stehenden Liste',
    '  "interests":      Array freier Stichworte, die Vorschläge höher gewichten',
    '  "group":          { "withChildren": bool, "limitedMobility": bool }',
    "",
    "Erlaubte Werte für categories:",
    vocabulary,
    "",
    "Regeln:",
    "- Erfinde keine Kategorie, die nicht in der Liste steht.",
    "- Rate nichts, was der Satz nicht sagt. Ein fehlendes Feld ist besser als ein erfundenes.",
    '- "gemütlich"/"entspannt" → relaxed, "viel sehen"/"straff" → packed.',
    "- Kinder, Kinderwagen, Oma, Rollstuhl, schlecht zu Fuß → passendes group-Feld.",
    "- interests sind Themen (z. B. \"barock\", \"industriegeschichte\"), keine Kategorien.",
    "",
    "Anfrage:",
    text,
  ].join("\n");
}
