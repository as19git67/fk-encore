/**
 * Daily cron: generate AI-powered finance analysis suggestions for all users.
 *
 * Mirrors the photo recaps pattern (photo/recaps-cron.ts): a daily
 * schedule that iterates all users with finance data and produces
 * AI-generated insights. Deduplication via fingerprint ensures the
 * same suggestion is never created twice.
 */

import { generateSuggestionsForAllUsers } from "./analysis-suggestions";
import { dailyAtUtc, schedule } from "../lib/local-cron";

console.log("[boot] finance/analysis-suggestions-cron.ts: all imports resolved");

schedule({
  name: "finance-analysis-suggestions",
  description: "KI-generierte Finanz-Rückblicke für alle Nutzer erzeugen",
  service: "finance",
  scheduleLabel: "daily 04:00 UTC",
  nextFire: dailyAtUtc(4, 0),
  run: () => generateSuggestionsForAllUsers(),
});
