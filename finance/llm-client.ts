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
  text: string;
}
interface EmbedResponse {
  embedding: number[];
}

export async function embed(text: string): Promise<number[]> {
  const resp = await postJson<EmbedRequest, EmbedResponse>("/embed", {
    text,
  });
  if (!Array.isArray(resp?.embedding) || resp.embedding.length === 0) {
    throw new LlmServiceUnavailableError(
      "/embed response missing 'embedding' array",
    );
  }
  return resp.embedding;
}

// -----------------------------------------------------------------------
// /classify (used for finance tag suggestion)
// -----------------------------------------------------------------------

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

interface ClassifyRequest {
  /** The `/classify` endpoint on llm-service is generic; we pass a
   * finance-specific prompt so the existing route can stay unchanged. */
  prompt: string;
  schema: Record<string, unknown>;
}

interface ClassifyResponse {
  tags?: TagSuggestion[];
}

export async function suggestTags(
  input: SuggestTagsInput,
): Promise<TagSuggestion[]> {
  const prompt = buildTagSuggestionPrompt(input);
  const schema = {
    type: "object",
    properties: {
      tags: {
        type: "array",
        items: {
          type: "object",
          properties: {
            tag: { type: "string" },
            confidence: { type: "number", minimum: 0, maximum: 1 },
          },
          required: ["tag", "confidence"],
        },
      },
    },
    required: ["tags"],
  };

  const resp = await postJson<ClassifyRequest, ClassifyResponse>("/classify", {
    prompt,
    schema,
  });

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
