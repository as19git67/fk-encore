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
// Health check
// -----------------------------------------------------------------------

export async function isLlmServiceHealthy(timeoutMs = 2000): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${LLM_SERVICE_URL}/healthz`, { signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
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

/** Structured SEPA/MT940 fields extracted from a transaction. */
interface TransactionFields {
  purpose: string | null;
  counterparty: string | null;
  amount: string;
  sign: "debit" | "credit";
  /** MT940 entry text, e.g. "Lastschrift", "Gutschrift", "Überweisung". */
  entry_text?: string | null;
  /** Abweichender Auftraggeber (ABWA). */
  originator_name?: string | null;
  /** Abweichender Zahlungsempfänger (ABWE). */
  recipient_name?: string | null;
  /** SEPA Mandate reference — identifies recurring direct debits. */
  mandate_ref?: string | null;
  /** SEPA Creditor identifier — identifies the payee organisation. */
  creditor_id?: string | null;
}

export interface SuggestTagsInput {
  /** Transaction to annotate. */
  transaction: TransactionFields & { currency_code: string };
  /**
   * Nearest-neighbour examples from the user's history. The LLM must
   * only reuse tags that appear in at least one example — no new
   * vocabulary is invented. This is enforced in the prompt and
   * re-checked post-hoc by tag-suggester.ts.
   */
  examples: Array<TransactionFields & { user_tags: string[] }>;
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

/** Renders a single transaction's fields as indented lines for the prompt. */
function renderTxFields(
  f: {
    counterparty?: string | null;
    purpose?: string | null;
    entry_text?: string | null;
    originator_name?: string | null;
    recipient_name?: string | null;
    mandate_ref?: string | null;
    creditor_id?: string | null;
    sign: "debit" | "credit";
    amount: string;
    currency_code?: string;
  },
): string {
  const lines: string[] = [];
  lines.push(`  Gegenseite: ${f.counterparty?.trim() || "-"}`);
  lines.push(`  Verwendung: ${f.purpose?.trim() || "-"}`);
  if (f.entry_text?.trim())      lines.push(`  Buchungstext: ${f.entry_text.trim()}`);
  if (f.originator_name?.trim()) lines.push(`  Auftraggeber: ${f.originator_name.trim()}`);
  if (f.recipient_name?.trim())  lines.push(`  Zahlungsempfänger: ${f.recipient_name.trim()}`);
  if (f.mandate_ref?.trim())     lines.push(`  Mandatsreferenz: ${f.mandate_ref.trim()}`);
  if (f.creditor_id?.trim())     lines.push(`  Gläubiger-ID: ${f.creditor_id.trim()}`);
  const amountStr = f.currency_code
    ? `${f.sign === "debit" ? "-" : "+"}${f.amount} ${f.currency_code}`
    : `${f.sign === "debit" ? "-" : "+"}${f.amount}`;
  lines.push(`  Betrag: ${amountStr}`);
  return lines.join("\n");
}

function buildTagSuggestionPrompt(input: SuggestTagsInput): string {
  const examples = input.examples
    .map((e, i) => {
      const tags = e.user_tags.join(", ") || "(keine)";
      return `Beispiel ${i + 1}:\n${renderTxFields(e)}\n  Tags: ${tags}`;
    })
    .join("\n\n");

  return `Du bist ein Assistent, der Bank-Transaktionen mit passenden Tags versieht.

Gegeben eine neue Transaktion und bis zu 20 bereits vom Nutzer getaggte Beispiel-Transaktionen: schlage 1 bis 5 passende Tags für die neue Transaktion vor.

Strikte Regeln:
- Verwende AUSSCHLIESSLICH Tags, die in mindestens einem der Beispiele vorkommen. Erfinde KEINE neuen Tag-Namen.
- Gib für jeden Tag eine Confidence zwischen 0 und 1 an, die deine Sicherheit widerspiegelt.
- Antworte als JSON mit einem 'tags'-Array, z. B. {"tags":[{"tag":"urlaub","confidence":0.87}]}.

Neue Transaktion:
${renderTxFields(input.transaction)}

Historische Beispiele:

${examples}`;
}

// -----------------------------------------------------------------------
// /json-prompt (analysis — natural-language → AST)
// -----------------------------------------------------------------------

export interface RelativeTimespan {
  type: "this_year" | "last_year" | "last_n_years" | "last_n_months" | "this_month" | "last_month";
  n?: number;
}

export interface TagGroup {
  tags: string[];
  op: "AND" | "OR";
}

export interface AnalysisAst {
  /** User-tag names, always drawn from the available vocabulary. */
  tags: string[];
  /** AND = transaction must carry every tag; OR = at least one. */
  op: "AND" | "OR";
  /** Inclusive ISO-date range; omitted ⇒ no date filter. */
  timespan?: { from: string; to: string };
  /** Signed amount range; omitted ⇒ no amount filter. */
  amountRange?: { min?: number; max?: number };
  /**
   * Whether the question is about a single bounded occasion ("event",
   * e.g. one specific trip) or recurring/ongoing spending over time
   * ("ongoing"). Purely presentational: the monthly breakdown is only
   * meaningful for "ongoing" analyses and is hidden for events.
   * Omitted ⇒ treated as "ongoing".
   */
  kind?: "event" | "ongoing";
  /** Aggregation granularity for ongoing analyses: monthly or yearly. */
  interval?: "month" | "year";
  /** Relative time reference for saved queries that auto-adjust over time. */
  relativeTimespan?: RelativeTimespan;
  /**
   * Grouped tag expressions for complex filters (e.g. "Restaurant AND
   * (TagA OR TagB)"). When present and non-empty, takes precedence over
   * flat `tags`/`op`. UI-driven — the LLM continues producing flat format.
   */
  tagGroups?: TagGroup[];
  /** Logical operator joining the tag groups. Defaults to 'AND'. */
  groupOp?: "AND" | "OR";
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
      kind?: unknown;
      interval?: unknown;
      relativeTimespan?: unknown;
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

  const kind: AnalysisAst["kind"] = resp.kind === "event" ? "event" : "ongoing";
  const interval: AnalysisAst["interval"] =
    resp.interval === "year" ? "year" : "month";

  let relativeTimespan: AnalysisAst["relativeTimespan"];
  if (
    resp.relativeTimespan &&
    typeof resp.relativeTimespan === "object" &&
    !Array.isArray(resp.relativeTimespan)
  ) {
    const rt = resp.relativeTimespan as Record<string, unknown>;
    const validTypes = new Set([
      "this_year", "last_year", "last_n_years", "last_n_months",
      "this_month", "last_month",
    ]);
    if (typeof rt.type === "string" && validTypes.has(rt.type)) {
      relativeTimespan = { type: rt.type as RelativeTimespan["type"] };
      if (typeof rt.n === "number" && Number.isFinite(rt.n) && rt.n > 0) {
        relativeTimespan.n = Math.floor(rt.n);
      }
    }
  }

  // When the LLM returns a relativeTimespan, resolve it to a concrete
  // timespan so the initial query runs correctly.
  if (relativeTimespan && !timespan) {
    timespan = resolveRelativeTimespan(relativeTimespan);
  }

  const result: AnalysisAst = { tags: uniqueTags, op, kind, interval };
  if (timespan) result.timespan = timespan;
  if (amountRange) result.amountRange = amountRange;
  if (relativeTimespan) result.relativeTimespan = relativeTimespan;
  return result;
}

export function resolveRelativeTimespan(
  rel: RelativeTimespan,
  now: Date = new Date(),
): { from: string; to: string } {
  const y = now.getFullYear();
  const m = now.getMonth(); // 0-based
  const pad = (n: number) => String(n).padStart(2, "0");
  const isoDate = (yr: number, mo: number, day: number) =>
    `${yr}-${pad(mo)}-${pad(day)}`;
  const lastDay = (yr: number, mo: number) =>
    new Date(yr, mo, 0).getDate();

  switch (rel.type) {
    case "this_year":
      return { from: isoDate(y, 1, 1), to: isoDate(y, 12, 31) };
    case "last_year":
      return { from: isoDate(y - 1, 1, 1), to: isoDate(y - 1, 12, 31) };
    case "last_n_years": {
      const n = rel.n ?? 1;
      return { from: isoDate(y - n, 1, 1), to: isoDate(y, 12, 31) };
    }
    case "last_n_months": {
      const n = rel.n ?? 1;
      const d = new Date(y, m - n, 1);
      return {
        from: isoDate(d.getFullYear(), d.getMonth() + 1, 1),
        to: isoDate(y, m + 1, lastDay(y, m + 1)),
      };
    }
    case "this_month":
      return {
        from: isoDate(y, m + 1, 1),
        to: isoDate(y, m + 1, lastDay(y, m + 1)),
      };
    case "last_month": {
      const d = new Date(y, m - 1, 1);
      const mo = d.getMonth() + 1;
      const yr = d.getFullYear();
      return {
        from: isoDate(yr, mo, 1),
        to: isoDate(yr, mo, lastDay(yr, mo)),
      };
    }
    default:
      return { from: isoDate(y, 1, 1), to: isoDate(y, 12, 31) };
  }
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

  const today = new Date();
  const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;

  return `Du übersetzt eine deutsche Frage zu Finanz-Transaktionen in einen strukturierten Filter (AST).
Heutiges Datum: ${todayStr}

Strikte Regeln:
- 'tags' darf NUR Tags enthalten, die exakt in der Vokabel-Liste unten vorkommen. Erfinde KEINE neuen Tags.
- 'op' ist "AND" wenn die Frage nach einer Schnittmenge mehrerer Konzepte fragt (z. B. "Urlaub in Italien 2024"), "OR" wenn sie nach einer Vereinigung fragt (z. B. "alle Miete oder Nebenkosten").
- 'timespan' ist ein inklusiver ISO-Datum-Bereich { from, to } in YYYY-MM-DD-Format. Lasse das Feld weg, wenn die Frage keinen Zeitraum nennt. Berechne konkrete Daten basierend auf dem heutigen Datum.
- 'relativeTimespan' setze zusätzlich zu 'timespan', wenn die Frage einen relativen Zeitbezug enthält (z. B. "dieses Jahr", "letztes Jahr", "letzte 3 Jahre"). Möglich: { type: "this_year" }, { type: "last_year" }, { type: "last_n_years", n: 3 }, { type: "last_n_months", n: 6 }, { type: "this_month" }, { type: "last_month" }. Lasse weg bei absoluten Zeitangaben wie "2024" oder "August 2024".
- 'amountRange' { min, max } als Zahlen (negative Zahlen = Ausgaben, positive = Einnahmen). Lasse das Feld weg, wenn die Frage keine Grenze nennt.
- 'kind' ist "event" wenn sich die Frage auf einen einzelnen, zeitlich begrenzten Anlass bezieht (z. B. eine bestimmte Reise wie "Reise 2026 Japan", eine Feier, ein Umzug, eine größere Anschaffung). "ongoing" wenn es um laufende oder wiederkehrende Ausgaben über die Zeit geht (z. B. "Lebensmittel letztes Jahr", "monatliche Fixkosten", "ÖPNV insgesamt"). Im Zweifel "ongoing".
- 'interval' ist "year" wenn der Zeitraum mehrere Jahre umfasst oder ein Jahresvergleich gewünscht ist (z. B. "letzte 3 Jahre", "über die Jahre"). "month" bei kürzerem Zeitraum oder wenn monatliche Aufschlüsselung sinnvoller ist. Standard: "month".
- Antwort als JSON, kein Freitext drumherum.

Beispiele für 'kind':
- "Was hat mein Japan-Urlaub gekostet?" → "event"
- "Wie viel habe ich auf der Reise 2026 Japan ausgegeben?" → "event"
- "Ausgaben für die Hochzeit von Anna" → "event"
- "Was hat der Umzug nach Berlin gekostet?" → "event"
- "Wie teuer war die neue Waschmaschine inkl. Anschluss?" → "event"
- "Was habe ich auf der Konferenz in München ausgegeben?" → "event"
- "Wie viel gebe ich monatlich für Lebensmittel aus?" → "ongoing"
- "Meine Restaurant-Ausgaben im letzten Jahr" → "ongoing"
- "Wie viel zahle ich insgesamt für ÖPNV?" → "ongoing"
- "Entwicklung meiner Fixkosten über die Zeit" → "ongoing"
- "Alle Ausgaben für Mobilität & Transport 2025" → "ongoing"

Beispiele für 'relativeTimespan':
- "Lebensmittel dieses Jahr" → relativeTimespan: { type: "this_year" }, interval: "month"
- "Ausgaben letztes Jahr" → relativeTimespan: { type: "last_year" }, interval: "month"
- "Entwicklung über die letzten 3 Jahre" → relativeTimespan: { type: "last_n_years", n: 3 }, interval: "year"
- "Fixkosten letzte 6 Monate" → relativeTimespan: { type: "last_n_months", n: 6 }, interval: "month"
- "Ausgaben 2024" → KEIN relativeTimespan (absolutes Jahr), interval: "month"

Verfügbare Tags (Vokabular):
${vocabBlock}
${hintBlock}

Frage:
"${question}"`;
}

// -----------------------------------------------------------------------
// /json-prompt (analysis suggestions — automatic insight generation)
// -----------------------------------------------------------------------

export interface AnalysisSuggestion {
  name: string;
  question: string;
  ast: AnalysisAst;
}

export interface SuggestAnalysesInput {
  availableTags: string[];
  tagSummary: Array<{ tag: string; sum: string; count: number }>;
  topCounterparties: Array<{ name: string; sum: string; count: number }>;
  existingNames: string[];
  dataRange: { from: string; to: string };
}

export async function generateAnalysisSuggestions(
  input: SuggestAnalysesInput,
): Promise<AnalysisSuggestion[]> {
  const prompt = buildSuggestionPrompt(input);

  let resp: { suggestions?: unknown[] };
  try {
    resp = await postJson("/json-prompt", { prompt, temperature: 0.7 });
  } catch {
    return [];
  }

  if (!Array.isArray(resp?.suggestions)) return [];

  const vocab = new Set(input.availableTags);
  const results: AnalysisSuggestion[] = [];

  for (const raw of resp.suggestions) {
    if (!raw || typeof raw !== "object") continue;
    const s = raw as Record<string, unknown>;
    if (typeof s.name !== "string" || typeof s.question !== "string") continue;
    if (!s.ast || typeof s.ast !== "object") continue;

    const ast = s.ast as Record<string, unknown>;
    const rawTags = Array.isArray(ast.tags) ? ast.tags : [];
    const tags = [...new Set(
      rawTags
        .filter((t: unknown): t is string => typeof t === "string")
        .map((t: string) => t.trim())
        .filter((t: string) => t.length > 0 && vocab.has(t)),
    )];

    const op = ast.op === "OR" ? "OR" as const : "AND" as const;
    const kind: AnalysisAst["kind"] = ast.kind === "event" ? "event" : "ongoing";
    const interval: AnalysisAst["interval"] = ast.interval === "year" ? "year" : "month";

    const result: AnalysisAst = { tags, op, kind, interval };

    if (ast.timespan && typeof ast.timespan === "object" && !Array.isArray(ast.timespan)) {
      const t = ast.timespan as Record<string, unknown>;
      if (typeof t.from === "string" && typeof t.to === "string") {
        result.timespan = { from: t.from.slice(0, 10), to: t.to.slice(0, 10) };
      }
    }

    if (ast.relativeTimespan && typeof ast.relativeTimespan === "object") {
      const rt = ast.relativeTimespan as Record<string, unknown>;
      const validTypes = new Set([
        "this_year", "last_year", "last_n_years", "last_n_months",
        "this_month", "last_month",
      ]);
      if (typeof rt.type === "string" && validTypes.has(rt.type)) {
        result.relativeTimespan = { type: rt.type as RelativeTimespan["type"] };
        if (typeof rt.n === "number" && Number.isFinite(rt.n) && rt.n > 0) {
          result.relativeTimespan.n = Math.floor(rt.n);
        }
      }
    }

    if (result.relativeTimespan && !result.timespan) {
      result.timespan = resolveRelativeTimespan(result.relativeTimespan);
    }

    if (tags.length === 0 && !result.timespan) continue;

    results.push({ name: s.name.trim(), question: s.question.trim(), ast: result });
  }

  return results;
}

function buildSuggestionPrompt(input: SuggestAnalysesInput): string {
  const today = new Date();
  const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;

  const vocabBlock = input.availableTags.length > 0
    ? input.availableTags.map((t) => `- ${t}`).join("\n")
    : "(keine Tags vorhanden)";

  const tagSummaryBlock = input.tagSummary.length > 0
    ? input.tagSummary
        .slice(0, 30)
        .map((t) => `- ${t.tag}: ${t.count} Buchungen, Summe ${t.sum} €`)
        .join("\n")
    : "(keine Tag-Daten)";

  const counterpartyBlock = input.topCounterparties.length > 0
    ? input.topCounterparties
        .slice(0, 15)
        .map((c) => `- ${c.name}: ${c.count} Buchungen, Summe ${c.sum} €`)
        .join("\n")
    : "(keine Gegenseiten)";

  const existingBlock = input.existingNames.length > 0
    ? input.existingNames.map((n) => `- "${n}"`).join("\n")
    : "(keine)";

  return `Du bist ein Finanz-Analyst-Assistent. Analysiere die Transaktionsdaten eines Nutzers und schlage 3 bis 5 interessante Finanz-Rückblicke (Analysen) vor.
Heutiges Datum: ${todayStr}
Transaktionsdaten vorhanden von ${input.dataRange.from} bis ${input.dataRange.to}.

Dein Ziel: Finde Muster, Trends und interessante Einsichten in den Finanzdaten. Vorschläge sollen dem Nutzer helfen, seine Ausgaben besser zu verstehen.

Ideen für Vorschläge:
- Ausgabentrends nach Kategorie (z.B. "Lebensmittel dieses Jahr" vs. letztes Jahr)
- Auffällige oder hohe Ausgabenkategorien
- Saisonale Muster (z.B. "Urlaubsausgaben im Sommer")
- Entwicklung regelmäßiger Kosten über die Zeit
- Vergleich verschiedener Ausgabenkategorien

Strikte Regeln:
- Verwende NUR Tags aus der Vokabelliste.
- Schlage KEINE Analysen vor, die es bereits gibt (siehe "Bestehende Analysen").
- Nutze 'relativeTimespan' für zeitbezogene Vorschläge, damit sie mitwandern.
- Jeder Vorschlag braucht: name (kurzer deutscher Titel), question (deutsche Frage), ast (AnalysisAst).
- Der AST hat dieselbe Struktur wie der Analyse-Filter: tags, op, timespan, relativeTimespan, kind, interval.
- Antworte als JSON: { "suggestions": [ { "name": "...", "question": "...", "ast": {...} }, ... ] }

Verfügbare Tags (Vokabular):
${vocabBlock}

Ausgabenverteilung nach Tags:
${tagSummaryBlock}

Häufigste Gegenseiten:
${counterpartyBlock}

Bestehende Analysen (NICHT erneut vorschlagen):
${existingBlock}`;
}
