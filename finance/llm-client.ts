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

import { AiSlotTimeoutError, withLlmSlot } from "../ai-queue/slot-helper";
import { llmBudgetMs } from "../lib/llm-lease";

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
  // An embedding takes about a second and has its own short wait in the
  // service; everything else is a model run and waits its turn in the queue.
  if (path === "/embed") return send(path, body, timeoutMs);
  try {
    return await withLlmSlot(`finance:${path.slice(1)}`, () => send<TBody, TResp>(path, body, timeoutMs));
  } catch (err) {
    if (err instanceof AiSlotTimeoutError) throw new LlmServiceUnavailableError(err.message);
    throw err;
  }
}

async function send<TBody, TResp>(path: string, body: TBody, timeoutMs: number): Promise<TResp> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), await llmBudgetMs(timeoutMs));
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
// Relative periods ("this month", "last year") resolved to dates
// -----------------------------------------------------------------------

export interface RelativeTimespan {
  type: "this_year" | "last_year" | "last_n_years" | "last_n_months" | "this_month" | "last_month";
  n?: number;
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

// -----------------------------------------------------------------------
// /json-prompt (retirement forecast — values from an insurer statement, #1343)
// -----------------------------------------------------------------------

/** Statement texts run long; the values sit on the first pages. */
const STATEMENT_TEXT_LIMIT = 12_000;

/**
 * Asks the model for the values a pension or insurance statement states.
 * Returns the raw JSON object; forecast-statements-extract.ts validates it.
 * `fields` maps each key to a German description (LLM_FIELDS there).
 */
export async function extractStatementValues(
  text: string,
  fields: Record<string, string>,
  hint: { itemLabel: string; contractNo: string | null },
): Promise<Record<string, unknown>> {
  const keys = Object.entries(fields)
    .map(([k, d]) => `- "${k}": ${d}`)
    .join("\n");
  const system =
    "Du liest Standmitteilungen, Renteninformationen und Leistungsmitteilungen deutscher Versicherer und Versorgungseinrichtungen. " +
    "Antworte ausschließlich mit einem JSON-Objekt. Übernimm nur Werte, die wörtlich im Text stehen; erfinde nichts. " +
    "Fehlt ein Wert, setze null. Beträge als Zahl in Euro ohne Tausenderpunkte (z. B. 61234.5), Datumsangaben als YYYY-MM-DD.";
  const prompt =
    `Vertrag: ${hint.itemLabel}${hint.contractNo ? ` (Nummer ${hint.contractNo})` : ""}\n` +
    `Gib ein JSON-Objekt mit genau diesen Schlüsseln zurück:\n${keys}\n\n` +
    `Text der Mitteilung:\n"""\n${text.slice(0, STATEMENT_TEXT_LIMIT)}\n"""`;
  const resp = await postJson<JsonPromptRequest, Record<string, unknown>>("/json-prompt", {
    prompt,
    system,
    temperature: 0,
    max_tokens: 600,
  });
  if (!resp || typeof resp !== "object") {
    throw new LlmServiceUnavailableError("/json-prompt returned no object for the statement");
  }
  return resp;
}

// -----------------------------------------------------------------------
// /json-prompt (portfolio — values from a securities settlement, #1336)
// -----------------------------------------------------------------------

/** Settlements are short; the figures sit on the first page. */
const SETTLEMENT_TEXT_LIMIT = 8_000;

/**
 * Asks the model for the values a Wertpapierabrechnung or a dividend
 * statement states. Returns the raw JSON object; depot-settlement-merge.ts
 * validates it and checks it against the rule-based reading.
 */
/** What each field means on each kind of paper — told to the model once the rules know the kind. */
const SETTLEMENT_PAPER_HINTS: Record<string, string> = {
  trade:
    "Der Beleg ist eine Wertpapierabrechnung (Kauf oder Verkauf): price ist der Ausführungskurs je Stück, " +
    "gross der Kurswert, fees alle Entgelte einschließlich Börsen- und Fremdspesen, net der ausmachende Betrag.",
  dividend:
    "Der Beleg ist eine Dividenden- oder Ertragsgutschrift: price ist der Betrag je Stück, gross der Bruttobetrag, " +
    "tax die einbehaltenen Steuern einschließlich Quellensteuer, net der gutgeschriebene Betrag; fees meist null.",
  tax_statement:
    "Der Beleg ist eine Steuermitteilung zu einer Buchung, die einen eigenen Beleg hat: gross ist der Betrag vor Steuern, " +
    "net der Betrag nach Steuern, tax die abgeführten Steuern; price und fees sind null.",
  accumulation:
    "Der Beleg meldet eine Thesaurierung oder Vorabpauschale: ausgeschüttet wurde nichts. tax ist die tatsächlich " +
    "abgeführte Steuer (0, wenn kein Steuerabzug erfolgte); price, gross, fees und net sind null.",
};

export async function extractSettlementValues(
  text: string,
  /** The kind of paper the rules recognised (see PaperType), when they did. */
  paperType: string | null = null,
): Promise<Record<string, unknown>> {
  const system =
    "Du liest Wertpapierabrechnungen (Kauf, Verkauf) und Dividenden-/Ertragsgutschriften deutscher Banken und Broker. " +
    "Antworte ausschließlich mit einem JSON-Objekt. Übernimm nur Werte, die wörtlich im Text stehen; erfinde nichts und rechne nichts aus. " +
    "Fehlt ein Wert, setze null. Beträge als positive Zahl ohne Tausenderpunkte (z. B. 2966.40), Datumsangaben als YYYY-MM-DD.";
  const prompt =
    "Gib ein JSON-Objekt mit genau diesen Schlüsseln zurück:\n" +
    '- "is_settlement": true, wenn der Beleg eine Wertpapierabrechnung (Kauf/Verkauf) oder eine Dividenden-/Ertragsgutschrift einer Bank oder eines Brokers zu einem Depot ist; ' +
    'false bei allem anderen, insbesondere bei Versicherungen (Lebens-/Rentenversicherung, Standmitteilung, Überschussbeteiligung, Police), Kontoauszügen, Depotauszügen, Steuerbescheinigungen\n' +
    '- "kind": "buy" für Kauf/Zeichnung/Sparplan, "sell" für Verkauf, "dividend" für Dividende/Ausschüttung/Ertrag, sonst null\n' +
    '- "isin": die ISIN des Wertpapiers (12 Zeichen)\n' +
    '- "wkn": die WKN (6 Zeichen)\n' +
    '- "name": die Bezeichnung des Wertpapiers\n' +
    '- "depot_number": die Depotnummer, nur Ziffern\n' +
    '- "executed_at": Schlusstag/Handelstag; bei Dividenden der Zahltag/Valuta\n' +
    '- "quantity": Stückzahl bzw. Nominale\n' +
    '- "price": Ausführungskurs je Stück; bei Dividenden der Betrag je Stück\n' +
    '- "gross": Kurswert bzw. Bruttobetrag\n' +
    '- "fees": Summe aller Gebühren, Provisionen und Spesen\n' +
    '- "tax": Summe aller einbehaltenen Steuern (Kapitalertragsteuer, Solidaritätszuschlag, Kirchensteuer, Quellensteuer); ' +
    'ist eine Gesamtsumme der Steuern gedruckt ("abgeführte Steuern", "Summe Steuern", "Steuern insgesamt"), dann genau diese statt selbst zu addieren; ' +
    'sonst steht je Steuer ein Satz und eine Bemessungsgrundlage ("Kirchensteuer 8,00% auf 0,09 EUR 0,01- EUR"), zählt nur der Steuerbetrag am Ende, und jede Steuerzeile wird addiert; ' +
    'auch die Kirchensteuer zählt, wenn sie nach Kapitalertragsteuer und Solidaritätszuschlag als dritte Zeile folgt; ' +
    'eine Berechnungs- oder Bemessungsgrundlage ("Berechnungsgrundlage für die Kapitalertragsteuer") und die Erträge darüber ("Ermittlung steuerrelevante Erträge", "Veräußerungsgewinn") sind keine Steuern; ' +
    'ein negativ gedruckter Steuerbetrag unter "abgeführte" oder "einbehaltene" Steuern ist einbehalten, nicht erstattet; ' +
    'wurden Steuern erstattet statt einbehalten (Steuererstattung, erstattete Steuern), dann die erstattete Summe als negative Zahl\n' +
    '- "net": der ausmachende Betrag bzw. Endbetrag, der dem Konto belastet oder gutgeschrieben wird; ' +
    'steht ein Betrag vor und einer nach Steuern, dann der nach Steuern\n' +
    '- "currency": Währung des ausmachenden Betrags (z. B. "EUR")\n\n' +
    (paperType && SETTLEMENT_PAPER_HINTS[paperType] ? `${SETTLEMENT_PAPER_HINTS[paperType]}\n\n` : "") +
    `Text des Belegs:\n"""\n${text.slice(0, SETTLEMENT_TEXT_LIMIT)}\n"""`;
  const resp = await postJson<JsonPromptRequest, Record<string, unknown>>("/json-prompt", {
    prompt,
    system,
    temperature: 0,
    max_tokens: 500,
  });
  if (!resp || typeof resp !== "object") {
    throw new LlmServiceUnavailableError("/json-prompt returned no object for the settlement");
  }
  return resp;
}

// -----------------------------------------------------------------------
// /json-prompt (portfolio — which kind of securities paper is this?)
// -----------------------------------------------------------------------

/** The first page says what a paper is; a short excerpt keeps the question cheap. */
const PAPER_TYPE_TEXT_LIMIT = 4_000;

/**
 * Asks the model which kind of paper a document is, for papers with a
 * security identifier whose wording the rules do not recognise. Returns
 * the raw JSON object; depot-paper-type.ts validates it.
 */
export async function classifySecuritiesPaper(text: string): Promise<Record<string, unknown>> {
  const system =
    "Du ordnest Belege deutscher Banken, Broker, Fondsgesellschaften und Versicherer ein. " +
    "Antworte ausschließlich mit einem JSON-Objekt.";
  const prompt =
    "Gib ein JSON-Objekt mit genau diesem Schlüssel zurück:\n" +
    '- "paper_type": eine der folgenden Angaben\n' +
    '    "trade" — Abrechnung eines Kaufs oder Verkaufs von Wertpapieren (auch Sparplan-Ausführung, Zeichnung, Rücknahme von Fondsanteilen)\n' +
    '    "dividend" — Gutschrift einer Dividende, Ausschüttung oder eines Ertrags\n' +
    '    "tax" — Thesaurierung oder Vorabpauschale, bei der nur Steuer belastet wird\n' +
    '    "statement" — Depotauszug, Depotbestand, Vermögensübersicht oder Reporting mit einer Liste der gehaltenen Wertpapiere zu einem Stichtag\n' +
    '    "other" — alles andere: Kostenausweis, Kontoauszug, Steuerbescheinigung, Versicherungsmitteilung, Werbung, Vertragsunterlagen\n\n' +
    `Text des Belegs:\n"""\n${text.slice(0, PAPER_TYPE_TEXT_LIMIT)}\n"""`;
  const resp = await postJson<JsonPromptRequest, Record<string, unknown>>("/json-prompt", {
    prompt,
    system,
    temperature: 0,
    max_tokens: 60,
  });
  if (!resp || typeof resp !== "object") {
    throw new LlmServiceUnavailableError("/json-prompt returned no object for the paper type");
  }
  return resp;
}

// -----------------------------------------------------------------------
// /json-prompt (portfolio — positions from a depot statement or reporting)
// -----------------------------------------------------------------------

/** A reporting runs long and the positions table may sit behind a summary. */
const DEPOT_STATEMENT_TEXT_LIMIT = 16_000;

/**
 * Asks the model which positions a depot statement, a wealth overview or a
 * reporting lists, and for which day. Returns the raw JSON object;
 * depot-statement-parser.ts validates it and merges it with the rules.
 */
export async function extractStatementPositions(text: string): Promise<Record<string, unknown>> {
  const system =
    "Du liest Depotauszüge, Vermögensübersichten und Reportings deutscher Banken, Broker und Vermögensverwalter. " +
    "Antworte ausschließlich mit einem JSON-Objekt. Übernimm nur Werte, die wörtlich im Text stehen; erfinde nichts und rechne nichts aus. " +
    "Fehlt ein Wert, setze null. Beträge als Zahl ohne Tausenderpunkte (z. B. 2966.40), Datumsangaben als YYYY-MM-DD.";
  const prompt =
    "Gib ein JSON-Objekt mit genau diesen Schlüsseln zurück:\n" +
    '- "is_statement": true, wenn der Beleg einen Depotbestand zu einem Stichtag auflistet (Depotauszug, Depotbestand, Vermögensübersicht, Reporting mit Positionsliste); ' +
    "false bei Wertpapierabrechnungen (Kauf/Verkauf), Dividenden-/Ertragsgutschriften, Kontoauszügen, Steuerbescheinigungen und Versicherungsmitteilungen ohne Depotpositionen\n" +
    '- "as_of": der Stichtag, zu dem der Bestand gilt (z. B. "per 31.12.2025")\n' +
    '- "depot_number": die Depotnummer, nur Ziffern\n' +
    '- "positions": eine Liste der Wertpapierpositionen; je Position ein Objekt mit\n' +
    '    "isin" (12 Zeichen), "wkn" (6 Zeichen), "name" (Bezeichnung des Wertpapiers),\n' +
    '    "quantity" (Stückzahl bzw. Anteile), "price" (Kurs je Stück am Stichtag), "value" (Kurswert der Position),\n' +
    '    "currency" (Währung des Kurswerts, z. B. "EUR"), "acquisition_price" (Einstandskurs je Stück, falls gedruckt)\n\n' +
    "Nur Wertpapiere zählen: Aktien, Fonds, ETFs, Anleihen, Zertifikate. Keine Versicherungsverträge, Konten, Bausparverträge, Summen- oder Zwischensummenzeilen. " +
    "Eine Position ohne ISIN und ohne WKN lässt du weg.\n\n" +
    `Text des Belegs:\n"""\n${text.slice(0, DEPOT_STATEMENT_TEXT_LIMIT)}\n"""`;
  const resp = await postJson<JsonPromptRequest, Record<string, unknown>>("/json-prompt", {
    prompt,
    system,
    temperature: 0,
    max_tokens: 1500,
  });
  if (!resp || typeof resp !== "object") {
    throw new LlmServiceUnavailableError("/json-prompt returned no object for the depot statement");
  }
  return resp;
}
