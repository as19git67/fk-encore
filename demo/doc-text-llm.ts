/**
 * The wording of a demo document from the local model
 * (documentation/plans/demodaten.md, stage 2). The code hands the model
 * the facts — kind, sender, recipient, date, the template's subject,
 * paragraphs and positions — and asks for the letter in its own words as
 * schema-bound JSON, through the `llm` queue at background priority, so a
 * waiting user always goes first.
 *
 * The model is never asked for names, addresses, account numbers or
 * amounts: those stay with the skeleton. A text that brings in a name or a
 * company the household does not know is thrown away and the template
 * stays (`textIsClean`).
 */

import { withLlmSlot } from "../ai-queue/slot-helper";
import { DEMO_HOUSEHOLD, DEMO_ORGANISATIONS } from "./names";
import { euro, germanDate, type PlannedDocument } from "./documents";
import type { DocTexts } from "./pdf-render";

const LLM_SERVICE_URL = (process.env.LLM_SERVICE_URL || "http://localhost:8002").replace(/\/$/, "");
const CALL_TIMEOUT_MS = 120_000;
/** A run of 500 documents waits behind other background work; one call does not wait forever. */
const SLOT_TIMEOUT_MS = 20 * 60_000;

/** Common German surnames: a text naming one of them brings in a person the demo does not have. */
const SURNAMES = [
  "Müller", "Schmidt", "Schneider", "Fischer", "Weber", "Meyer", "Meier", "Wagner", "Becker", "Schulz",
  "Hoffmann", "Schäfer", "Koch", "Bauer", "Richter", "Klein", "Wolf", "Schröder", "Neumann", "Schwarz",
  "Zimmermann", "Braun", "Krüger", "Hofmann", "Hartmann", "Lange", "Schmitt", "Werner", "Schmitz", "Krause",
  "Meier", "Lehmann", "Schmid", "Schulze", "Maier", "Köhler", "Herrmann", "König", "Walter", "Mayer",
  "Huber", "Kaiser", "Fuchs", "Peters", "Lang", "Scholz", "Möller", "Weiß", "Jung", "Hahn",
];

const KNOWN = new Set([...DEMO_ORGANISATIONS, DEMO_HOUSEHOLD.self, DEMO_HOUSEHOLD.spouse, DEMO_HOUSEHOLD.child]);

/** A company form the model would only write next to a firm's name. */
const COMPANY = /([A-ZÄÖÜ][\p{L}-]*(?:\s+[A-ZÄÖÜ&][\p{L}-]*){0,3})\s+(GmbH|AG|KG|eG|e\.\s?V\.|gGmbH|SE|OHG|mbH)\b/gu;
/** Doctor's titles before a name. */
const TITLE = /\b(?:Dr|Prof)\.\s+(?:med\.\s+)?([A-ZÄÖÜ][\p{L}-]+)/gu;
/** Long digit runs: account numbers, phone numbers the model invented. */
const NUMBERS = /\d[\d ]{7,}\d/;
/** An amount as the documents print it, without the currency sign. */
const AMOUNT = /\d{1,3}(?:\.\d{3})*,\d{2}/g;

/**
 * True when `text` names nobody and nothing outside the demo's own lists:
 * no common surname, no company or title that is not one of the
 * household's, no long digit run.
 */
export function textIsClean(text: string): boolean {
  for (const name of SURNAMES) {
    if (new RegExp(`\\b${name}\\b`, "u").test(text)) return false;
  }
  for (const m of text.matchAll(COMPANY)) {
    const full = m[0].trim();
    if (![...KNOWN].some((k) => k.includes(full) || full.includes(k))) return false;
  }
  for (const m of text.matchAll(TITLE)) {
    if (![...KNOWN].some((k) => k.includes(m[1]))) return false;
  }
  if (NUMBERS.test(text.replace(/\d{1,3}(?:\.\d{3})*,\d{2}/g, ""))) return false;
  return true;
}

const SYSTEM = [
  "Du schreibst den Text eines deutschen Geschäftsbriefs für einen Demodatensatz.",
  "Du bekommst Art, Absender, Empfänger, Datum, Betreff und eine Vorlage und formulierst Betreff, Absätze und Positionsbezeichnungen neu, sachlich und glaubwürdig.",
  "Nenne keine Personen, Firmen, Adressen, Telefonnummern, Konto- oder Vertragsnummern und keine Beträge, die nicht in der Vorlage stehen.",
  "Keine Anrede und kein Gruß: die stehen schon im Brief. Antworte nur mit JSON.",
].join(" ");

function promptFor(doc: PlannedDocument): string {
  return JSON.stringify({
    art: doc.kind,
    absender: doc.sender,
    empfaenger: doc.recipient === "self" ? DEMO_HOUSEHOLD.self : doc.recipient === "spouse" ? DEMO_HOUSEHOLD.spouse : "Familie Mustermann",
    datum: germanDate(doc.date),
    betreff: doc.subject,
    absaetze: doc.paragraphs,
    positionen: doc.lines.map((l) => ({ bezeichnung: l.text, betrag: l.cents === null ? null : euro(l.cents) })),
    gesamt: doc.totalCents === null ? null : euro(doc.totalCents),
  });
}

function schemaFor(doc: PlannedDocument): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      betreff: { type: "string", minLength: 5, maxLength: 120 },
      absaetze: { type: "array", minItems: 1, maxItems: 3, items: { type: "string", minLength: 20, maxLength: 400 } },
      positionen: { type: "array", minItems: doc.lines.length, maxItems: doc.lines.length, items: { type: "string", minLength: 2, maxLength: 70 } },
    },
    required: ["betreff", "absaetze", "positionen"],
  };
}

/**
 * Asks the model for the document's wording. `null` when the model is not
 * there, answers with something unusable or names something it must not —
 * the caller keeps the template then.
 */
export async function llmTexts(doc: PlannedDocument): Promise<DocTexts | null> {
  // A statement and a receipt are tables; there is nothing to word.
  if (doc.kind === "bank_statement" || doc.kind === "receipt") return null;
  let res: Response;
  try {
    res = await withLlmSlot(`demo:${doc.kind}`, async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS);
      try {
        return await fetch(`${LLM_SERVICE_URL}/json-prompt`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ system: SYSTEM, prompt: promptFor(doc), schema: schemaFor(doc), max_tokens: 700, temperature: 0.7 }),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
    }, SLOT_TIMEOUT_MS);
  } catch {
    return null;
  }
  if (!res.ok) return null;
  const body = (await res.json().catch(() => null)) as { betreff?: unknown; absaetze?: unknown; positionen?: unknown } | null;
  return parseLlmTexts(doc, body);
}

/** Checks the model's answer against the document; `null` when it does not fit. */
export function parseLlmTexts(doc: PlannedDocument, body: { betreff?: unknown; absaetze?: unknown; positionen?: unknown } | null): DocTexts | null {
  if (!body || typeof body.betreff !== "string" || !Array.isArray(body.absaetze) || !Array.isArray(body.positionen)) return null;
  const paragraphs = body.absaetze.filter((p): p is string => typeof p === "string" && p.trim().length > 0).map((p) => p.trim());
  const lineTexts = body.positionen.filter((p): p is string => typeof p === "string").map((p) => p.trim());
  if (!paragraphs.length || lineTexts.length !== doc.lines.length) return null;
  const all = [body.betreff, ...paragraphs, ...lineTexts].join("\n");
  if (!textIsClean(all)) return null;
  // Every amount the text names must be one of the document's: the model words, the code counts.
  const known = new Set([...doc.lines.map((l) => l.cents), doc.totalCents, ...doc.paragraphs.flatMap((p) => p.match(AMOUNT) ?? [])]
    .filter((c): c is number | string => c !== null)
    .map((c) => (typeof c === "number" ? euro(Math.abs(c)).replace(" €", "") : c)));
  if ((all.match(AMOUNT) ?? []).some((a) => !known.has(a))) return null;
  return { subject: body.betreff.trim(), paragraphs, lineTexts };
}

/** Whether the llm-service answers at all; checked once before a run asks it 500 times. */
export async function llmReachable(timeoutMs = 3000): Promise<boolean> {
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
