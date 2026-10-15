/**
 * Keeps rule collections current (#1548, stage 5): every hour each rule is
 * evaluated again, so a photo imported, a booking fetched or a meter added
 * joins the collections whose rule it matches.
 */

import { api } from "encore.dev/api";
import { everyMs, schedule } from "../lib/local-cron";
import { applyAllMemberRules } from "./rules";

export const runCollectionRules = api(
  { expose: false, method: "POST", path: "/internal/collections/apply-rules" },
  async (): Promise<{ collections: number; added: number; removed: number }> => {
    return await applyAllMemberRules();
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
