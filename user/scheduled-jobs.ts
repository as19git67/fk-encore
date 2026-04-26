/**
 * Admin endpoints for the local-cron scheduler.
 *
 *   GET    /admin/scheduled-jobs            list every registered job
 *   POST   /admin/scheduled-jobs/:name/pause     enabled=false
 *   POST   /admin/scheduled-jobs/:name/resume    enabled=true
 *   POST   /admin/scheduled-jobs/:name/run-now   trigger handler now
 *
 * Permission: `data.manage` (same gate as the other reindex /
 * maintenance endpoints in photo/photo.ts).
 *
 * `run-now` invokes the handler in-process and waits for it to
 * finish. For long-running jobs (finance-export-snapshot can take
 * minutes) the gateway timeout still applies — callers should treat
 * the realtime "scheduled-job.changed" stream as the authoritative
 * progress signal and not block the UI on the HTTP response.
 */

import { APIError, api } from "encore.dev/api";
import { getAuthData } from "~encore/auth";

import { requirePermission } from "./auth-handler";
import {
  inspectJobs,
  runJobNow,
  setJobEnabled,
  type JobInspectEntry,
} from "../lib/local-cron";

console.log("[boot] user/scheduled-jobs.ts: all imports resolved");

interface ListResponse {
  jobs: JobInspectEntry[];
}

interface JobActionParams {
  name: string;
}

interface JobActionResponse {
  job: JobInspectEntry;
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

export const pauseScheduledJob = api(
  {
    expose: true,
    method: "POST",
    path: "/admin/scheduled-jobs/:name/pause",
    auth: true,
  },
  async ({ name }: JobActionParams): Promise<JobActionResponse> => {
    requirePermission(getAuthData()!, "data.manage");
    const updated = await setJobEnabled(name, false);
    if (!updated) throw APIError.notFound(`unknown job '${name}'`);
    return { job: updated };
  },
);

export const resumeScheduledJob = api(
  {
    expose: true,
    method: "POST",
    path: "/admin/scheduled-jobs/:name/resume",
    auth: true,
  },
  async ({ name }: JobActionParams): Promise<JobActionResponse> => {
    requirePermission(getAuthData()!, "data.manage");
    const updated = await setJobEnabled(name, true);
    if (!updated) throw APIError.notFound(`unknown job '${name}'`);
    return { job: updated };
  },
);

export const runScheduledJobNow = api(
  {
    expose: true,
    method: "POST",
    path: "/admin/scheduled-jobs/:name/run-now",
    auth: true,
  },
  async ({ name }: JobActionParams): Promise<JobActionResponse> => {
    requirePermission(getAuthData()!, "data.manage");
    const result = await runJobNow(name);
    if (!result) throw APIError.notFound(`unknown job '${name}'`);
    return { job: result };
  },
);
