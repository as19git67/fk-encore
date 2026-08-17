/**
 * Admin endpoints for the taxonomy-tools sidecar.
 *
 *   POST   /admin/tools/run/:tool      start a taxonomy tool run
 *   POST   /admin/tools/cancel/:tool   cancel a running tool
 *   GET    /admin/tools/status         check which tools are running
 *
 * Permission: `data.manage`.
 *
 * The sidecar (taxonomy_tools container) runs the actual scripts and
 * streams stdout as SSE. This endpoint relays each SSE line as a
 * realtime event on the "tools" channel so the admin frontend gets
 * a live log via the existing WebSocket infrastructure.
 */

import { APIError, api } from "encore.dev/api";
import { inArray } from "drizzle-orm";
import type { IncomingMessage, ServerResponse } from "node:http";
import { getAuthData } from "~encore/auth";
import { documents, realtime, user } from "~encore/clients";

import db from "../db/database";
import { documents as documentsTable } from "../db/schema";
import { requirePermission } from "./auth-handler";

console.log("[boot] user/taxonomy-tools.ts: all imports resolved");

const SIDECAR_URL =
  process.env.TAXONOMY_TOOLS_SERVICE_URL || "http://taxonomy_tools:8000";

const VALID_TOOLS = ["diagnose", "cloud-audit", "cloud-teacher", "scoreboard"] as const;
type ToolName = (typeof VALID_TOOLS)[number];

// The sidecar's own /health only knows about its subprocess, so it reports
// "not running" for the entire reclassify-then-measure sequence up until the
// sidecar is actually invoked — which can be minutes. Without this, the
// frontend's polling safety net (which treats "sidecar says not running" as
// "must have just finished" to catch missed SSE terminal events) fires within
// one poll tick and reports the run done with the previous, unchanged reports.
const _backgroundRunning = new Set<ToolName>();

// The scoreboard's label becomes part of a report filename on the sidecar.
// Mirrors LABEL_RE there and _LABEL_RE in model_scoreboard.py; checked here as
// well so a bad value is a 400 from the app rather than a 422 relayed from a
// service the operator cannot see.
const LABEL_RE = /^[A-Za-z0-9._-]{1,40}$/;

interface RunToolParams {
  tool: string;
}

interface RunToolBody {
  dry_run?: boolean;
  batch?: number;
  sample?: number;
  tax_sample?: number;
  focus_sections?: string;
  focus_categories?: string;
  // scoreboard only: the name this measurement is filed under (usually the
  // model), and optionally an earlier label to compare it against.
  label?: string;
  compare_with?: string;
  // scoreboard only: reclassify the reference-set documents with whatever
  // model is currently active before measuring, so the DB reflects that
  // model rather than whichever one classified them last.
  reclassify_reference?: boolean;
}

interface RunToolResponse {
  status: string;
}

interface CancelToolParams {
  tool: string;
}

interface CancelToolResponse {
  status: string;
}

interface ToolStatus {
  tool: string;
  running: boolean;
}

interface StatusResponse {
  tools: ToolStatus[];
}

function validateTool(name: string): ToolName {
  if (!VALID_TOOLS.includes(name as ToolName)) {
    throw APIError.invalidArgument(`unknown tool: ${name}`);
  }
  return name as ToolName;
}

async function getAdminUserIds(): Promise<string[]> {
  try {
    const { userIds } = await user.listUserIdsWithPermission({
      permission: "data.manage",
    });
    return userIds.map((id: number) => String(id));
  } catch {
    return [];
  }
}

async function publishToolEvent(
  tool: string,
  eventType: string,
  message: string,
  userIds: string[],
): Promise<void> {
  if (userIds.length === 0) return;
  try {
    await realtime.publishEvent({
      userIds,
      channel: "tools",
      type: eventType,
      resourceId: tool,
      payload: { message, tool },
    });
  } catch (err) {
    console.warn(
      `[taxonomy-tools] publish failed: ${(err as Error).message}`,
    );
  }
}

async function publishReportsEvent(
  tool: string,
  userIds: string[],
): Promise<void> {
  if (userIds.length === 0) return;
  try {
    const resp = await fetch(`${SIDECAR_URL}/reports/${tool}`);
    if (!resp.ok) return;
    const data = (await resp.json()) as {
      files: Array<{ name: string; size: number }>;
    };
    await realtime.publishEvent({
      userIds,
      channel: "tools",
      type: "reports",
      resourceId: tool,
      payload: { tool, files: data.files },
    });
  } catch (err) {
    console.warn(
      `[taxonomy-tools] reports publish failed: ${(err as Error).message}`,
    );
  }
}

async function relaySseStream(
  tool: string,
  response: Response,
  userIds: string[],
): Promise<void> {
  const reader = response.body?.getReader();
  if (!reader) return;

  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      let currentEvent = "log";
      for (const line of lines) {
        if (line.startsWith("event:")) {
          currentEvent = line.slice(6).trim();
        } else if (line.startsWith("data:")) {
          const data = line.slice(5).trim();
          await publishToolEvent(tool, `${currentEvent}`, data, userIds);
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  // The SSE stream only closes once the sidecar's subprocess has exited
  // (success, failure, or cancellation) and its terminal event was the
  // last thing yielded. Explicitly (re-)publish the report file list at
  // this point — a dedicated, guaranteed-after-completion signal the
  // frontend can rely on instead of only reacting to the relayed "done"/
  // "error" line, which can otherwise race with fast tool runs.
  await publishReportsEvent(tool, userIds);
}

/** POST /run/:tool on the sidecar and relay its SSE stream, publishing any
 * failure to start as a log event instead of throwing — used from the
 * reclassify-then-measure flow, where the caller's HTTP response is long
 * gone by the time this runs. */
async function startSidecarRun(
  tool: ToolName,
  body: Record<string, unknown>,
  userIds: string[],
): Promise<void> {
  let sseResponse: Response;
  try {
    sseResponse = await fetch(`${SIDECAR_URL}/run/${tool}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    await publishToolEvent(
      tool,
      "error",
      `taxonomy-tools sidecar unreachable: ${(err as Error).message}`,
      userIds,
    );
    return;
  }
  if (sseResponse.status === 409) {
    await publishToolEvent(tool, "error", `${tool} is already running`, userIds);
    return;
  }
  if (!sseResponse.ok) {
    const text = await sseResponse.text().catch(() => "");
    await publishToolEvent(tool, "error", `sidecar error ${sseResponse.status}: ${text}`, userIds);
    return;
  }
  await relaySseStream(tool, sseResponse, userIds);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Statuses the classification pipeline can still be working through. Mirrors
// documentStatusEnum in db/schema.ts minus its terminal members ("ready",
// "failed", "encrypted").
const DOCUMENT_IN_FLIGHT_STATUSES = new Set(["pending", "extracting", "classifying"]);

const RECLASSIFY_POLL_MS = 15_000;
// Generous on purpose: a MoE model split across system RAM can take minutes
// per document (see llm_model_config.app_timeout_ms), and the reference
// sample runs into the hundreds.
const RECLASSIFY_TIMEOUT_MS = 4 * 60 * 60 * 1000;

/** Reclassifies the scoreboard's reference-set documents with whatever model
 * is currently active, waits for the pipeline to settle, then runs the
 * scoreboard measurement. The caller has already received its "started"
 * response by the time this executes, so every failure is published as a
 * log/error event rather than thrown. */
async function reclassifyReferenceThenRunScoreboard(
  body: Record<string, unknown>,
  userIds: string[],
): Promise<void> {
  _backgroundRunning.add("scoreboard");
  try {
    await _reclassifyReferenceThenRunScoreboard(body, userIds);
  } finally {
    _backgroundRunning.delete("scoreboard");
  }
}

async function _reclassifyReferenceThenRunScoreboard(
  body: Record<string, unknown>,
  userIds: string[],
): Promise<void> {
  await publishToolEvent(
    "scoreboard",
    "log",
    "Reclassifying reference documents with the currently active model …",
    userIds,
  );

  let referenceDocIds: number[];
  try {
    const resp = await fetch(`${SIDECAR_URL}/scoreboard/reference-doc-ids`);
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`sidecar ${resp.status}: ${text}`);
    }
    const data = (await resp.json()) as { source: string; doc_ids: number[] };
    referenceDocIds = data.doc_ids;
    await publishToolEvent(
      "scoreboard",
      "log",
      `Reference: ${data.source} (${referenceDocIds.length} documents)`,
      userIds,
    );
  } catch (err) {
    await publishToolEvent(
      "scoreboard",
      "error",
      `Could not resolve the reference set: ${(err as Error).message}`,
      userIds,
    );
    return;
  }

  if (referenceDocIds.length === 0) {
    await publishToolEvent("scoreboard", "error", "Reference set is empty — nothing to reclassify", userIds);
    return;
  }

  try {
    // Auth propagates from this request automatically — batchReclassify only
    // touches documents visible to the same admin who started this run.
    const { affected_documents } = await documents.batchReclassify({ document_ids: referenceDocIds });
    const note =
      affected_documents < referenceDocIds.length ? " (the rest are not visible to this account)" : "";
    await publishToolEvent(
      "scoreboard",
      "log",
      `Queued ${affected_documents} of ${referenceDocIds.length} reference documents for reclassification${note}`,
      userIds,
    );
  } catch (err) {
    await publishToolEvent("scoreboard", "error", `Reclassify failed: ${(err as Error).message}`, userIds);
    return;
  }

  const deadline = Date.now() + RECLASSIFY_TIMEOUT_MS;
  let inFlight = referenceDocIds.length;
  while (Date.now() < deadline) {
    const rows = await db
      .select({ status: documentsTable.status })
      .from(documentsTable)
      .where(inArray(documentsTable.id, referenceDocIds));
    inFlight = rows.filter((r) => DOCUMENT_IN_FLIGHT_STATUSES.has(r.status)).length;
    if (inFlight === 0) break;
    await publishToolEvent(
      "scoreboard",
      "log",
      `Reclassifying … ${referenceDocIds.length - inFlight}/${referenceDocIds.length} done`,
      userIds,
    );
    await sleep(RECLASSIFY_POLL_MS);
  }

  if (inFlight > 0) {
    await publishToolEvent(
      "scoreboard",
      "error",
      `Timed out after ${Math.round(RECLASSIFY_TIMEOUT_MS / 60_000)} min waiting for reclassification ` +
        `(${inFlight} documents still in progress) — measuring against the current state anyway`,
      userIds,
    );
  } else {
    await publishToolEvent("scoreboard", "log", "Reclassification complete — starting the measurement", userIds);
  }

  await startSidecarRun("scoreboard", body, userIds);
}

export const runTool = api(
  {
    expose: true,
    method: "POST",
    path: "/admin/tools/run/:tool",
    auth: true,
  },
  async (params: RunToolParams & RunToolBody): Promise<RunToolResponse> => {
    requirePermission(getAuthData()!, "data.manage");
    const tool = validateTool(params.tool);

    const body: Record<string, unknown> = {};
    if (params.dry_run !== undefined) body.dry_run = params.dry_run;
    if (params.batch !== undefined) body.batch = params.batch;
    if (params.sample !== undefined) body.sample = params.sample;
    if (params.tax_sample !== undefined) body.tax_sample = params.tax_sample;
    if (params.focus_sections !== undefined)
      body.focus_sections = params.focus_sections;
    if (params.focus_categories !== undefined)
      body.focus_categories = params.focus_categories;

    if (tool === "scoreboard") {
      // Required rather than defaulted: the label is how this measurement is
      // found again and compared against, and a guessed one ("run-3") makes
      // the whole exercise unreadable a week later.
      const label = params.label?.trim();
      if (!label) {
        throw APIError.invalidArgument(
          "scoreboard needs a label — usually the model being measured",
        );
      }
      if (!LABEL_RE.test(label)) {
        throw APIError.invalidArgument(
          "label must be 1–40 characters from A–Z, a–z, 0–9, dot, dash or underscore",
        );
      }
      body.label = label;

      const compareWith = params.compare_with?.trim();
      if (compareWith) {
        if (!LABEL_RE.test(compareWith)) {
          throw APIError.invalidArgument(
            "compare_with must be 1–40 characters from A–Z, a–z, 0–9, dot, dash or underscore",
          );
        }
        body.compare_with = compareWith;
      }

      if (params.reclassify_reference) {
        const userIds = await getAdminUserIds();
        reclassifyReferenceThenRunScoreboard(body, userIds).catch((err) => {
          console.error(
            `[taxonomy-tools] reclassify-then-scoreboard error: ${(err as Error).message}`,
          );
        });
        return { status: "started" };
      }
    }

    const sidecarUrl = `${SIDECAR_URL}/run/${tool}`;

    let sseResponse: Response;
    try {
      sseResponse = await fetch(sidecarUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw APIError.unavailable(
        `taxonomy-tools sidecar unreachable: ${(err as Error).message}`,
      );
    }

    if (sseResponse.status === 409) {
      throw APIError.alreadyExists(`${tool} is already running`);
    }
    if (!sseResponse.ok) {
      const text = await sseResponse.text().catch(() => "");
      throw APIError.internal(`sidecar error ${sseResponse.status}: ${text}`);
    }

    const userIds = await getAdminUserIds();

    // Relay in the background — return immediately to the caller.
    relaySseStream(tool, sseResponse, userIds).catch((err) => {
      console.error(
        `[taxonomy-tools] SSE relay error for ${tool}: ${(err as Error).message}`,
      );
    });

    return { status: "started" };
  },
);

export const cancelTool = api(
  {
    expose: true,
    method: "POST",
    path: "/admin/tools/cancel/:tool",
    auth: true,
  },
  async (params: CancelToolParams): Promise<CancelToolResponse> => {
    requirePermission(getAuthData()!, "data.manage");
    const tool = validateTool(params.tool);

    try {
      const resp = await fetch(`${SIDECAR_URL}/cancel/${tool}`, {
        method: "POST",
      });
      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        if (resp.status === 404) {
          throw APIError.notFound(`${tool} is not running`);
        }
        throw APIError.internal(`sidecar error ${resp.status}: ${text}`);
      }
    } catch (err) {
      if (err instanceof APIError) throw err;
      throw APIError.unavailable(
        `taxonomy-tools sidecar unreachable: ${(err as Error).message}`,
      );
    }

    return { status: "cancelled" };
  },
);

export const toolsStatus = api(
  {
    expose: true,
    method: "GET",
    path: "/admin/tools/status",
    auth: true,
  },
  async (): Promise<StatusResponse> => {
    requirePermission(getAuthData()!, "data.manage");

    try {
      const resp = await fetch(`${SIDECAR_URL}/health`);
      if (!resp.ok) {
        throw APIError.unavailable("taxonomy-tools sidecar unhealthy");
      }
      const data = (await resp.json()) as {
        running: Record<string, boolean>;
      };
      return {
        tools: VALID_TOOLS.map((t) => ({
          tool: t,
          running: (data.running[t] ?? false) || _backgroundRunning.has(t),
        })),
      };
    } catch (err) {
      if (err instanceof APIError) throw err;
      throw APIError.unavailable(
        `taxonomy-tools sidecar unreachable: ${(err as Error).message}`,
      );
    }
  },
);

// ── Report download ──────────────────────────────────────────────────────

interface ReportFile {
  name: string;
  size: number;
}

interface ListReportsParams {
  tool: string;
}

interface ListReportsResponse {
  files: ReportFile[];
}

export const listReports = api(
  {
    expose: true,
    method: "GET",
    path: "/admin/tools/reports/:tool",
    auth: true,
  },
  async (params: ListReportsParams): Promise<ListReportsResponse> => {
    requirePermission(getAuthData()!, "data.manage");
    const tool = validateTool(params.tool);

    try {
      const resp = await fetch(`${SIDECAR_URL}/reports/${tool}`);
      if (!resp.ok) {
        throw APIError.internal(`sidecar error ${resp.status}`);
      }
      const data = (await resp.json()) as {
        files: Array<{ name: string; size: number }>;
      };
      return {
        files: data.files.map((f) => ({ name: f.name, size: f.size })),
      };
    } catch (err) {
      if (err instanceof APIError) throw err;
      throw APIError.unavailable(
        `taxonomy-tools sidecar unreachable: ${(err as Error).message}`,
      );
    }
  },
);

interface DownloadReportParams {
  tool: string;
  filename: string;
}

export const downloadReport = api.raw(
  {
    expose: true,
    method: "GET",
    path: "/admin/tools/reports/:tool/:filename",
    auth: true,
  },
  async (req: IncomingMessage, res: ServerResponse) => {
    try {
      requirePermission(getAuthData()!, "data.manage");
    } catch {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ code: "permission_denied", message: "forbidden" }));
      return;
    }

    const parts = (req.url ?? "").split("/");
    const filename = decodeURIComponent(parts[parts.length - 1] ?? "");
    const tool = decodeURIComponent(parts[parts.length - 2] ?? "");

    if (!VALID_TOOLS.includes(tool as ToolName)) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ code: "invalid_argument", message: `unknown tool: ${tool}` }));
      return;
    }

    try {
      const sidecarResp = await fetch(
        `${SIDECAR_URL}/reports/${tool}/${encodeURIComponent(filename)}`,
      );

      if (!sidecarResp.ok) {
        res.writeHead(sidecarResp.status, { "Content-Type": "application/json" });
        const body = await sidecarResp.text().catch(() => "");
        res.end(body);
        return;
      }

      const contentType =
        sidecarResp.headers.get("content-type") ?? "application/octet-stream";
      res.writeHead(200, {
        "Content-Type": contentType,
        "Content-Disposition": `attachment; filename="${filename}"`,
      });

      const reader = sidecarResp.body?.getReader();
      if (!reader) {
        res.end();
        return;
      }
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
      res.end();
    } catch {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ code: "unavailable", message: "sidecar unreachable" }));
    }
  },
);
