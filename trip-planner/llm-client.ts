/**
 * Trip-planner-scoped client for the `llm-service` FastAPI container.
 *
 * Shares shape and failure handling with finance/llm-client.ts: the
 * generic `/json-prompt` endpoint, a hard timeout, and one error type
 * that callers treat as "the model is not available right now".
 *
 * The prompt asks for constraints, never for a plan. That boundary is
 * the concept's (§11.6): the model reads the sentence, the solver
 * decides the day. Whatever comes back is passed through
 * `normalizeConstraints` before anything acts on it — nothing here
 * trusts the response.
 */

const LLM_SERVICE_URL =
  (process.env.LLM_SERVICE_URL || "http://localhost:8002").replace(/\/$/, "");
const DEFAULT_TIMEOUT_MS = parseInt(process.env.LLM_SERVICE_TIMEOUT_MS ?? "120000", 10);

export class LlmServiceUnavailableError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "LlmServiceUnavailableError";
  }
}

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
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let resp: Response;
  try {
    resp = await fetch(`${LLM_SERVICE_URL}/json-prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt, temperature: 0 }),
      signal: controller.signal,
    });
  } catch (err) {
    throw new LlmServiceUnavailableError(
      `llm-service /json-prompt failed: ${(err as Error)?.message ?? err}`,
    );
  } finally {
    clearTimeout(timer);
  }

  if (!resp.ok) {
    throw new LlmServiceUnavailableError(
      `llm-service /json-prompt returned HTTP ${resp.status}`,
    );
  }
  try {
    return await resp.json();
  } catch (err) {
    throw new LlmServiceUnavailableError(
      `llm-service /json-prompt produced invalid JSON: ${(err as Error)?.message ?? err}`,
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
