/**
 * Admin endpoint: list every job registered with `lib/local-cron.ts`.
 *
 * Read-only on purpose for the first iteration. The data is the
 * in-memory snapshot from `inspectJobs()` — last_run / status reset
 * on container restart. A future iteration can add persistence
 * (`scheduled_job_state` table) plus pause/resume / run-now controls.
 *
 * Permission: `data.manage` (same gate as the other reindex /
 * maintenance endpoints in photo/photo.ts).
 */

import { api } from "encore.dev/api";
import { getAuthData } from "~encore/auth";

import { requirePermission } from "./auth-handler";
import { inspectJobs, type JobInspectEntry } from "../lib/local-cron";

console.log("[boot] user/scheduled-jobs.ts: all imports resolved");

interface ListResponse {
  jobs: JobInspectEntry[];
}

export const listScheduledJobs = api(
  {
    expose: true,
    method: "GET",
    path: "/admin/scheduled-jobs",
    auth: true,
  },
  async (): Promise<ListResponse> => {
    requirePermission(getAuthData()!, "data.manage");
    return { jobs: inspectJobs() };
  },
);
