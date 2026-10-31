/**
 * Demo data for a freshly installed system (documentation/plans/demodaten.md),
 * offered on Admin › Systemstatus:
 *
 *   GET  /admin/demo/status   untouched?, what the system holds, the current run
 *   POST /admin/demo/start    lays a demo household down in the background
 *   POST /admin/demo/cancel   stops a running run at its next batch
 *   POST /admin/demo/remove   takes everything the run wrote back
 *
 * Gate: `data.manage` and the Admin role — the demo creates a user and
 * writes into every module, which is an administrator's call.
 */

import { APIError, api } from "encore.dev/api";
import log from "encore.dev/log";
import { getAuthData } from "~encore/auth";
import { requirePermission } from "../user/auth-handler";
import { isAdminUser } from "../user/admin-guard";
import { removeRun } from "./remove";
import { DemoRefused, executeRun, fileRun, requestCancel } from "./run";
import { contentCounts, currentRun, isEmpty, type ContentCounts, type DemoRunRow } from "./state";

export interface DemoRunView {
  id: number;
  status: DemoRunRow["status"];
  stage: string | null;
  size: DemoRunRow["size"];
  progress: Record<string, { done: number; total: number }>;
  summary: Record<string, number> | null;
  error: string | null;
  started_at: string;
  finished_at: string | null;
}

export interface DemoStatusResponse {
  /** True when nobody has put anything in yet: the demo may be loaded. */
  untouched: boolean;
  /** What the system holds besides demo rows, per kind. */
  counts: ContentCounts;
  /** The demo the system holds or is loading; null when there is none. */
  run: DemoRunView | null;
}

async function requireAdmin(): Promise<number> {
  const auth = getAuthData()!;
  requirePermission(auth, "data.manage");
  const userId = Number(auth.userID);
  if (!(await isAdminUser(userId))) throw APIError.permissionDenied("only an administrator may load or remove demo data");
  return userId;
}

function view(run: DemoRunRow | null): DemoRunView | null {
  if (!run) return null;
  return {
    id: run.id,
    status: run.status,
    stage: run.stage,
    size: run.size,
    progress: run.progress ?? {},
    summary: Object.keys(run.summary ?? {}).length ? run.summary : null,
    error: run.error,
    started_at: String(run.started_at),
    finished_at: run.finished_at ? String(run.finished_at) : null,
  };
}

async function status(): Promise<DemoStatusResponse> {
  const counts = await contentCounts();
  return { untouched: isEmpty(counts), counts, run: view(await currentRun()) };
}

export const getDemoStatus = api(
  { expose: true, method: "GET", path: "/admin/demo/status", auth: true },
  async (): Promise<DemoStatusResponse> => {
    await requireAdmin();
    return status();
  },
);

interface StartParams {
  /** `small` is the quick household of the end-to-end tests. */
  size?: "full" | "small";
}

export const startDemo = api(
  { expose: true, method: "POST", path: "/admin/demo/start", auth: true },
  async (p: StartParams): Promise<DemoStatusResponse> => {
    const userId = await requireAdmin();
    let runId: number;
    try {
      runId = await fileRun(userId, { size: p.size });
    } catch (err) {
      if (err instanceof DemoRefused) throw APIError.failedPrecondition(err.message);
      throw err;
    }
    // In the background: the card polls the status.
    void executeRun(runId).catch((err) => log.error(err as Error, "demo run crashed", { runId }));
    return status();
  },
);

export const cancelDemo = api(
  { expose: true, method: "POST", path: "/admin/demo/cancel", auth: true },
  async (): Promise<DemoStatusResponse> => {
    await requireAdmin();
    const run = await currentRun();
    if (!run || run.status !== "running") throw APIError.failedPrecondition("no demo run is loading");
    await requestCancel(run.id);
    return status();
  },
);

export const removeDemo = api(
  { expose: true, method: "POST", path: "/admin/demo/remove", auth: true },
  async (): Promise<DemoStatusResponse> => {
    await requireAdmin();
    const run = await currentRun();
    if (!run) throw APIError.failedPrecondition("there is no demo to remove");
    if (run.status === "running" || run.status === "cancelling") {
      throw APIError.failedPrecondition("the demo is still loading — cancel it first");
    }
    if (run.status === "removing") throw APIError.failedPrecondition("the demo is being removed already");
    await removeRun(run.id);
    return status();
  },
);
