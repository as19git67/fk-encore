/**
 * Reading one settlement document with the rules and the model (#1336).
 *
 * The rules (depot-settlement-parser) run on every read; they are instant.
 * The model (llm-service, /json-prompt) is asked once per document and its
 * answer kept in finance_document_settlement_llm, so the review page and
 * the inspection view — which re-read many documents — never wait on it.
 *
 *   mode "allow"      ask the model when there is no stored answer
 *                     (reading documents in, after classification);
 *   mode "cache-only" use a stored answer, never ask (dry runs, review);
 *   mode "off"        rules only.
 *
 * The model is only asked about text that looks like securities paperwork
 * at all, so an electricity bill never costs an LLM call.
 */

import { eq } from "drizzle-orm";

import db from "../db/database";
import { financeDocumentSettlementLlm } from "../db/schema";
import { extractIsin, extractWkn } from "./depot-derivation";
import {
  inspectSettlement,
  type SettlementInspection,
} from "./depot-settlement-parser";
import {
  mergeSettlement,
  parseLlmSettlement,
  type MergeResult,
  type SettlementValues,
} from "./depot-settlement-merge";
import { extractSettlementValues, LlmServiceUnavailableError } from "./llm-client";

export type LlmMode = "allow" | "cache-only" | "off";

/**
 * What happened with the model for this read:
 *   used        — asked now, answer stored
 *   cached      — an earlier answer was used
 *   unavailable — llm-service could not be reached or failed; rules only
 *   skipped     — not asked (no stored answer in cache-only mode, or the
 *                 text does not look like securities paperwork)
 *   off         — the caller asked for rules only
 */
export type LlmStatus = "used" | "cached" | "unavailable" | "skipped" | "off";

export interface SettlementReading {
  rules: SettlementInspection | null;
  llm: SettlementValues | null;
  merge: MergeResult;
  llmStatus: LlmStatus;
}

/**
 * Words securities paperwork uses in any layout. Deliberately broad: the
 * model is asked precisely because a bank may word things differently
 * than the rules expect ("Order ausgeführt", "Anteile", "Gegenwert").
 */
const SECURITIES_WORDS =
  /(wertpapier|dividend|ertrag|erträgnis|ausschüttung|kauf|verkauf|zeichnung|sparplan|fonds|aktie|order|anteil|stück|depot|kurs|nominal)/i;

/** Worth an LLM call: a security identifier plus wording that fits securities paperwork. */
export function looksLikeSecuritiesPaper(text: string): boolean {
  const identifier = extractIsin(text) !== null || extractWkn(text) !== null || /\bISIN\b|\bWKN\b/i.test(text);
  return identifier && SECURITIES_WORDS.test(text);
}

function rulesValues(r: SettlementInspection | null): SettlementValues | null {
  if (!r) return null;
  return {
    kind: r.kind,
    isin: r.isin,
    wkn: r.wkn,
    name: r.name,
    depotNumber: r.depotNumber,
    executedAt: r.executedAt,
    quantity: r.quantity,
    price: r.price,
    gross: r.gross,
    fees: r.fees,
    tax: r.tax,
    net: r.net,
    currency: r.currency,
  };
}

async function storedAnswer(documentId: number): Promise<SettlementValues | null> {
  const [row] = await db
    .select({ values: financeDocumentSettlementLlm.values })
    .from(financeDocumentSettlementLlm)
    .where(eq(financeDocumentSettlementLlm.document_id, documentId))
    .limit(1);
  return row ? parseLlmSettlement(row.values) : null;
}

export async function readSettlement(
  documentId: number,
  text: string | null,
  mode: LlmMode,
): Promise<SettlementReading> {
  const rules = inspectSettlement(text);
  const fromRules = rulesValues(rules);

  let llm: SettlementValues | null = null;
  let llmStatus: LlmStatus = mode === "off" ? "off" : "skipped";

  if (mode !== "off" && text && text.trim().length > 0) {
    llm = await storedAnswer(documentId);
    if (llm) {
      llmStatus = "cached";
    } else if (mode === "allow" && looksLikeSecuritiesPaper(text)) {
      try {
        const raw = await extractSettlementValues(text);
        // Store what the model said (as validated), so it is asked once.
        const parsed = parseLlmSettlement(raw);
        await db
          .insert(financeDocumentSettlementLlm)
          .values({ document_id: documentId, values: raw })
          .onConflictDoUpdate({
            target: financeDocumentSettlementLlm.document_id,
            set: { values: raw, created_at: new Date().toISOString() },
          });
        llm = parsed;
        llmStatus = "used";
      } catch (err) {
        if (!(err instanceof LlmServiceUnavailableError)) {
          console.warn(`[finance] settlement LLM read failed for document=${documentId}:`, (err as Error).message);
        }
        llmStatus = "unavailable";
      }
    }
  }

  return { rules, llm, merge: mergeSettlement(fromRules, llm), llmStatus };
}
