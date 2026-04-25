/**
 * Finance-scoped HTTP client for the `llm-service` FastAPI container.
 *
 * Shares the URL and timeout handling with documents/llm-client.ts but
 * carries finance-specific prompts: `suggestTags` picks multi-label
 * tags from a vocabulary defined by the user's historical tag usage,
 * and `embed` produces the 768-d vector for the nearest-neighbour
 * lookup in tag-suggester.ts.
 *
 * All failures throw LlmServiceUnavailableError — callers treat it as
 * a soft failure (log and skip) rather than propagating to the user.
 */

console.log("[boot] finance/llm-client.ts: all imports resolved");

const LLM_SERVICE_URL =
  (process.env.LLM_SERVICE_URL || "http://localhost:8002").replace(/\/$/, "");
const DEFAULT_TIMEOUT_MS = parseInt(
  process.env.LLM_SERVICE_TIMEOUT_MS ?? "120000",
  10,
);

export class LlmServiceUnavailableError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "LlmServiceUnavailableError";
  }
}

// -----------------------------------------------------------------------
// Shared HTTP helper
// -----------------------------------------------------------------------

async function postJson<TBody, TResp>(
  path: string,
  body: TBody,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<TResp> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let resp: Response;
  try {
    resp = await fetch(`${LLM_SERVICE_URL}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err: any) {
    throw new LlmServiceUnavailableError(
      `llm-service ${path} failed: ${err?.message ?? err}`,
    );
  } finally {
    clearTimeout(timer);
  }
  if (!resp.ok) {
    throw new LlmServiceUnavailableError(
      `llm-service ${path} returned HTTP ${resp.status}`,
    );
  }
  try {
    return (await resp.json()) as TResp;
  } catch (err: any) {
    throw new LlmServiceUnavailableError(
      `llm-service ${path} produced invalid JSON: ${err?.message ?? err}`,
    );
  }
}

// -----------------------------------------------------------------------
// /embed
// -----------------------------------------------------------------------

interface EmbedRequest {
  // The Python service expects a batch (`{ texts }`) and returns
  // `{ embeddings, dim }`. We only ever embed one transaction snippet at
  // a time, so we wrap it in a single-element array and unwrap on the
  // response side.
  texts: string[];
}
interface EmbedResponse {
  embeddings: number[][];
  dim: number;
}

export async function embed(text: string): Promise<number[]> {
  const resp = await postJson<EmbedRequest, EmbedResponse>("/embed", {
    texts: [text],
  });
  const vec = resp?.embeddings?.[0];
  if (!Array.isArray(vec) || vec.length === 0) {
    throw new LlmServiceUnavailableError(
      "/embed response missing 'embeddings[0]' vector",
    );
  }
  return vec;
}

// -----------------------------------------------------------------------
// /json-prompt — generic JSON-mode chat completion.
//
// `/classify` on llm-service is a hardcoded document classifier
// (taxonomy → category_slug + tags + summary). The finance prompts don't
// fit that shape, so we use the generic endpoint and let our own
// prompt steer the LLM into the expected JSON object.
// -----------------------------------------------------------------------

interface JsonPromptRequest {
  prompt: string;
  system?: string;
  max_tokens?: number;
  temperature?: number;
}

export interface SuggestTagsInput {
  /** Transaction to annotate. */
  transaction: {
    purpose: string | null;
    counterparty: string | null;
    amount: string;
    currency_code: string;
    sign: "debit" | "credit"; // amount > 0 → credit, else debit
  };
  /**
   * Nearest-neighbour examples from the user's history. The LLM must
   * only reuse tags that appear in at least one example — no new
   * vocabulary is invented. This is enforced in the prompt and
   * re-checked post-hoc by tag-suggester.ts.
   */
  examples: Array<{
    purpose: string | null;
    counterparty: string | null;
    amount: string;
    sign: "debit" | "credit";
    user_tags: string[];
  }>;
}

export interface TagSuggestion {
  tag: string;
  confidence: number;
}

interface SuggestTagsResponse {
  tags?: TagSuggestion[];
}

export async function suggestTags(
  input: SuggestTagsInput,
): Promise<TagSuggestion[]> {
  const prompt = buildTagSuggestionPrompt(input);

  const resp = await postJson<JsonPromptRequest, SuggestTagsResponse>(
    "/json-prompt",
    { prompt },
  );

  const raw = resp?.tags;
  if (!Array.isArray(raw)) return [];
  const result: TagSuggestion[] = [];
  for (const entry of raw) {
    if (
      !entry ||
      typeof entry.tag !== "string" ||
      typeof entry.confidence !== "number"
    )
      continue;
    const tag = entry.tag.trim();
    if (!tag) continue;
    // Clamp confidence to [0,1] defensively; the schema should have done
    // this already but we mustn't trust the LLM blindly.
    const confidence = Math.max(0, Math.min(1, entry.confidence));
    result.push({ tag, confidence });
  }
  return result;
}

function buildTagSuggestionPrompt(input: SuggestTagsInput): string {
  const examples = input.examples
    .map((e, i) => {
      const tags = e.user_tags.join(", ") || "(keine)";
      return `Beispiel ${i + 1}:
  Gegenseite: ${e.counterparty ?? "-"}
  Verwendung: ${e.purpose ?? "-"}
  Betrag: ${e.sign === "debit" ? "-" : "+"}${e.amount}
  Tags: ${tags}`;
    })
    .join("\n\n");

  return `Du bist ein Assistent, der Bank-Transaktionen mit passenden Tags versieht.

Gegeben eine neue Transaktion und bis zu 20 bereits vom Nutzer getaggte Beispiel-Transaktionen: schlage 1 bis 5 passende Tags für die neue Transaktion vor.

Strikte Regeln:
- Verwende AUSSCHLIESSLICH Tags, die in mindestens einem der Beispiele vorkommen. Erfinde KEINE neuen Tag-Namen.
- Gib für jeden Tag eine Confidence zwischen 0 und 1 an, die deine Sicherheit widerspiegelt.
- Antworte als JSON mit einem 'tags'-Array, z. B. {"tags":[{"tag":"urlaub","confidence":0.87}]}.

Neue Transaktion:
  Gegenseite: ${input.transaction.counterparty ?? "-"}
  Verwendung: ${input.transaction.purpose ?? "-"}
  Betrag: ${input.transaction.sign === "debit" ? "-" : "+"}${input.transaction.amount} ${input.transaction.currency_code}

Historische Beispiele:

${examples}`;
}

// -----------------------------------------------------------------------
// /json-prompt (analysis — natural-language → AST)
// -----------------------------------------------------------------------

export interface AnalysisAst {
  /** User-tag names, always drawn from the available vocabulary. */
  tags: string[];
  /** AND = transaction must carry every tag; OR = at least one. */
  op: "AND" | "OR";
  /** Inclusive ISO-date range; omitted ⇒ no date filter. */
  timespan?: { from: string; to: string };
  /** Signed amount range; omitted ⇒ no amount filter. */
  amountRange?: { min?: number; max?: number };
}

export interface ParseAnalysisOptions {
  /** Optional hint the user supplied separately, e.g. "2024". */
  timespanHint?: string;
}

/**
 * Asks the LLM to turn a German free-text question into a tag-filter
 * AST. Only tags from `availableTags` are allowed in the response —
 * the LLM is not permitted to invent new vocabulary.
 */
export async function parseAnalysisQuery(
  question: string,
  availableTags: string[],
  opts: ParseAnalysisOptions = {},
): Promise<AnalysisAst> {
  const prompt = buildAnalysisPrompt(question, availableTags, opts.timespanHint);

  const resp = await postJson<
    JsonPromptRequest,
    {
      tags?: unknown;
      op?: unknown;
      timespan?: unknown;
      amountRange?: unknown;
    }
  >("/json-prompt", { prompt });

  const vocab = new Set(availableTags);
  const rawTags = Array.isArray(resp.tags) ? resp.tags : [];
  const tags = rawTags
    .filter((t): t is string => typeof t === "string")
    .map((t) => t.trim())
    .filter((t) => t.length > 0 && vocab.has(t));
  // Deduplicate
  const uniqueTags = [...new Set(tags)];

  const op = resp.op === "OR" ? "OR" : "AND";

  let timespan: AnalysisAst["timespan"];
  if (
    resp.timespan &&
    typeof resp.timespan === "object" &&
    !Array.isArray(resp.timespan)
  ) {
    const from = (resp.timespan as any).from;
    const to = (resp.timespan as any).to;
    if (typeof from === "string" && typeof to === "string") {
      timespan = { from: from.slice(0, 10), to: to.slice(0, 10) };
    }
  }

  let amountRange: AnalysisAst["amountRange"];
  if (
    resp.amountRange &&
    typeof resp.amountRange === "object" &&
    !Array.isArray(resp.amountRange)
  ) {
    const min = (resp.amountRange as any).min;
    const max = (resp.amountRange as any).max;
    const cleaned: { min?: number; max?: number } = {};
    if (typeof min === "number" && Number.isFinite(min)) cleaned.min = min;
    if (typeof max === "number" && Number.isFinite(max)) cleaned.max = max;
    if (cleaned.min !== undefined || cleaned.max !== undefined) {
      amountRange = cleaned;
    }
  }

  const result: AnalysisAst = { tags: uniqueTags, op };
  if (timespan) result.timespan = timespan;
  if (amountRange) result.amountRange = amountRange;
  return result;
}

function buildAnalysisPrompt(
  question: string,
  availableTags: string[],
  timespanHint?: string,
): string {
  const vocabBlock = availableTags.length > 0
    ? availableTags.map((t) => `- ${t}`).join("\n")
    : "(keine Tags vorhanden)";

  const hintBlock = timespanHint
    ? `\nZeitraum-Hinweis vom Nutzer: "${timespanHint}".`
    : "";

  return `Du übersetzt eine deutsche Frage zu Finanz-Transaktionen in einen strukturierten Filter (AST).

Strikte Regeln:
- 'tags' darf NUR Tags enthalten, die exakt in der Vokabel-Liste unten vorkommen. Erfinde KEINE neuen Tags.
- 'op' ist "AND" wenn die Frage nach einer Schnittmenge mehrerer Konzepte fragt (z. B. "Urlaub in Italien 2024"), "OR" wenn sie nach einer Vereinigung fragt (z. B. "alle Miete oder Nebenkosten").
- 'timespan' ist ein inklusiver ISO-Datum-Bereich { from, to } in YYYY-MM-DD-Format. Lasse das Feld weg, wenn die Frage keinen Zeitraum nennt.
- 'amountRange' { min, max } als Zahlen (negative Zahlen = Ausgaben, positive = Einnahmen). Lasse das Feld weg, wenn die Frage keine Grenze nennt.
- Antwort als JSON, kein Freitext drumherum.

Verfügbare Tags (Vokabular):
${vocabBlock}
${hintBlock}

Frage:
"${question}"`;
}
