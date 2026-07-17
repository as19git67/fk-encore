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
import type { IncomingMessage, ServerResponse } from "node:http";
import { getAuthData } from "~encore/auth";
import { realtime, user } from "~encore/clients";

import { requirePermission } from "./auth-handler";

console.log("[boot] user/taxonomy-tools.ts: all imports resolved");

const SIDECAR_URL =
  process.env.TAXONOMY_TOOLS_SERVICE_URL || "http://taxonomy_tools:8000";

const VALID_TOOLS = ["diagnose", "cloud-audit", "cloud-teacher"] as const;
type ToolName = (typeof VALID_TOOLS)[number];

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
          running: data.running[t] ?? false,
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
