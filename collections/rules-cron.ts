/**
 * Keeps rule collections current (#1548, stage 5): every hour each rule is
 * evaluated again, so a photo imported, a booking fetched or a meter added
 * joins the collections whose rule it matches. The same hourly run clears
 * export files whose week is up (#1548, stage 6).
 */

import { api } from "encore.dev/api";
import { everyMs, schedule } from "../lib/local-cron";
import { applyAllMemberRules } from "./rules";
import { purgeExpiredExports } from "./exports";

export const runCollectionRules = api(
  { expose: false, method: "POST", path: "/internal/collections/apply-rules" },
  async (): Promise<{ collections: number; added: number; removed: number; export_files_removed: number }> => {
    const rules = await applyAllMemberRules();
    return { ...rules, export_files_removed: await purgeExpiredExports() };
  },
);

schedule({
  name: "collections-rules",
  description: "Bring every rule-based collection up to date",
  service: "collections",
  scheduleLabel: "every hour",
  nextFire: everyMs(60 * 60_000),
  run: () => runCollectionRules(),
});
