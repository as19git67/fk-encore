/**
 * Reads again the settlement papers the model could not read.
 *
 * A paper read while the llm-service was away books nothing (see
 * `enrichDocument`, outcome "model_unavailable"): the rules alone may
 * take a number for the quantity that no price confirms. Hourly, the
 * papers still waiting for the model are read again; a new row may be
 * the first trace of a position, so its bookings are derived afterwards.
 */

import log from "encore.dev/log";
import { inArray, isNotNull, and } from "drizzle-orm";

import { everyMs, schedule } from "../lib/local-cron";
import db from "../db/database";
import { financeAccount } from "../db/schema";
import { retryPapersAwaitingModel } from "./depot-document-enrichment";
import { deriveDepotTransactionsForBankcontact } from "./depot-derivation";

console.log("[boot] finance/depot-model-retry-cron.ts: all imports resolved");

export async function retryDepotPapers(): Promise<void> {
  const stats = await retryPapersAwaitingModel();
  const accounts = [
    ...new Set(stats.results.filter((r) => r.outcome === "created" && r.account_id !== null).map((r) => r.account_id!)),
  ];
  if (accounts.length > 0) {
    const bankcontacts = await db
      .selectDistinct({ id: financeAccount.bankcontact_id })
      .from(financeAccount)
      .where(and(inArray(financeAccount.id, accounts), isNotNull(financeAccount.bankcontact_id)));
    for (const bc of bankcontacts) await deriveDepotTransactionsForBankcontact(bc.id!);
  }
  log.info("finance-depot-model-retry: read papers the model could not read", {
    examined: stats.documents_examined,
    created: stats.created,
    enriched: stats.enriched,
    linked: stats.linked,
    still_waiting: stats.waiting_for_model,
    errors: stats.errors.length,
  });
}

schedule({
  name: "finance-depot-model-retry",
  description: "Wertpapierbelege erneut lesen, die das KI-Modell noch nicht lesen konnte",
  service: "finance",
  scheduleLabel: "hourly",
  nextFire: everyMs(60 * 60 * 1000),
  run: () => retryDepotPapers(),
});
