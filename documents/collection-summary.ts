/**
 * The summary a Sammelmappe carries across all its documents.
 *
 * Not a concatenation of the per-document summaries: a folder is handed to
 * somebody who has not read any of them, and what they need first is what the
 * folder *is* — "Unterlagen zur Einkommensteuer 2024: Lohnsteuerbescheinigung,
 * zwei Spendenquittungen, Handwerkerrechnung" — not four paragraphs in a row.
 * So the model gets titles, senders, dates and the existing per-document
 * summaries, and is asked for one short text about the set.
 *
 * It is written by a background job rather than on the request that changed
 * the folder (see collection-summary-cron.ts). Adding ten documents to a
 * collection would otherwise mean ten model runs while the user waits, nine
 * of them describing a folder that no longer exists by the time they finish.
 * The membership change only sets `summary_stale`; the job coalesces.
 */

const LLM_SERVICE_URL = (process.env.LLM_SERVICE_URL || "http://localhost:8002").replace(/\/$/, "");
const DEFAULT_TIMEOUT_MS = parseInt(process.env.LLM_SERVICE_TIMEOUT_MS ?? "120000", 10);

/** How much of one document's own summary reaches the prompt. */
const PER_DOCUMENT_SUMMARY_CHARS = 400;
/** Cap on documents described in the prompt; the rest are counted, not listed. */
const MAX_LISTED_DOCUMENTS = 40;

console.log("[boot] documents/collection-summary.ts: all imports resolved");

export class LlmServiceUnavailableError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "LlmServiceUnavailableError";
  }
}

/** One member document, reduced to what the prompt needs. */
export interface CollectionSummaryMember {
  title: string | null;
  sender: string | null;
  doc_date: string | null;
  category_name: string | null;
  summary: string | null;
}

export interface CollectionSummaryInput {
  title: string;
  notes: string | null;
  members: CollectionSummaryMember[];
}

const SYSTEM_PROMPT = `Du fasst private Dokumentensammlungen für Menschen zusammen, die die einzelnen Dokumente nicht gelesen haben.
Antworte ausschließlich mit gültigem JSON (UTF-8, ohne Markdown-Fences) in der Form {"summary": "..."}.

Regeln:
- Schreibe auf Deutsch, sachlich, in 2 bis 5 Sätzen.
- Beschreibe die Sammlung als Ganzes: worum es geht, welche Arten von Dokumenten enthalten sind, welcher Zeitraum abgedeckt ist.
- Nenne wiederkehrende Absender oder Vorgänge, wenn sie die Sammlung prägen.
- Erfinde nichts. Wenn eine Angabe fehlt, lasse sie weg.
- Keine Aufzählung aller Dokumente, keine Wiederholung des Titels als erster Satz.`;

/**
 * The prompt. Exported so a test can pin its shape without a model: a member
 * field that silently stopped reaching the model would produce summaries that
 * merely look thinner, which nothing else would catch.
 */
export function buildCollectionSummaryPrompt(input: CollectionSummaryInput): string {
  const listed = input.members.slice(0, MAX_LISTED_DOCUMENTS);
  const lines = listed.map((member, index) => {
    const head = [
      member.title?.trim() || "(ohne Titel)",
      member.sender?.trim() || null,
      member.doc_date?.trim() || null,
      member.category_name?.trim() || null,
    ]
      .filter(Boolean)
      .join(" · ");
    const summary = member.summary?.trim();
    const body = summary
      ? `\n   ${summary.slice(0, PER_DOCUMENT_SUMMARY_CHARS).replace(/\s+/g, " ")}`
      : "";
    return `${index + 1}. ${head}${body}`;
  });
  const overflow = input.members.length - listed.length;
  if (overflow > 0) {
    lines.push(`… und ${overflow} weitere Dokumente derselben Sammlung.`);
  }

  const notes = input.notes?.trim();
  return [
    `Titel der Sammlung: ${input.title.trim() || "(ohne Titel)"}`,
    notes ? `Notiz zur Sammlung: ${notes}` : null,
    `Anzahl Dokumente: ${input.members.length}`,
    "",
    "Dokumente:",
    lines.join("\n"),
  ]
    .filter((part) => part !== null)
    .join("\n");
}

/** Pull the summary text out of whatever the model returned. */
export function parseCollectionSummary(raw: unknown): string {
  if (!raw || typeof raw !== "object") {
    throw new Error("llm-service returned a non-object response");
  }
  const value = (raw as Record<string, unknown>).summary;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("llm-service returned no summary text");
  }
  return value.trim();
}

/**
 * Ask the local model for the collection's summary.
 *
 * Throws `LlmServiceUnavailableError` when the service cannot be reached, so
 * the job can leave the collection stale and try again rather than storing an
 * empty summary over a usable one.
 */
export async function generateCollectionSummary(
  input: CollectionSummaryInput,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let resp: Response;
  try {
    resp = await fetch(`${LLM_SERVICE_URL}/json-prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        system: SYSTEM_PROMPT,
        prompt: buildCollectionSummaryPrompt(input),
        temperature: 0.2,
      }),
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
  let payload: unknown;
  try {
    payload = await resp.json();
  } catch (err) {
    throw new LlmServiceUnavailableError(
      `llm-service /json-prompt produced invalid JSON: ${(err as Error)?.message ?? err}`,
    );
  }
  return parseCollectionSummary(payload);
}
