/**
 * Admin endpoints for the llm_service's inference configuration.
 *
 *   GET    /admin/llm-configs                 list configurations + live status
 *   POST   /admin/llm-configs                 create one
 *   PUT    /admin/llm-configs/:id             edit one
 *   DELETE /admin/llm-configs/:id             remove one
 *   POST   /admin/llm-configs/:id/activate    load it in the llm_service
 *   POST   /admin/llm-configs/reset           go back to the container's env
 *   GET    /admin/llm-status                  what is loaded right now
 *
 *   GET    /admin/llm-models/files            GGUF files on the models volume
 *   POST   /admin/llm-models/download         fetch a new one
 *   GET    /admin/llm-models/download/status  progress
 *   POST   /admin/llm-models/download/cancel  stop, keeping the partial file
 *   DELETE /admin/llm-models/files/:filename  remove one
 *
 * Permission: `data.manage`, same gate as the other maintenance endpoints.
 *
 * Activation is asynchronous on the far side: the llm_service answers 202 and
 * loads the model in the background, which takes minutes for a large one. This
 * endpoint records the *intent* in the database and returns; the frontend
 * polls /admin/llm-status, which reports the intent and what the service
 * actually has loaded side by side. They are shown separately rather than
 * reconciled behind the scenes — when a load fails, "you asked for X, Y is
 * running" is the useful thing to say, and a GET is the wrong place to be
 * silently rewriting rows.
 */

import { APIError, api } from "encore.dev/api";
import { eq, ne, sql } from "drizzle-orm";
import { getAuthData } from "~encore/auth";

import db from "../db/database";
import { llmModelConfig } from "../db/schema";
import { requirePermission } from "./auth-handler";

console.log("[boot] user/llm-models.ts: all imports resolved");

const LLM_SERVICE_URL = (process.env.LLM_SERVICE_URL || "http://localhost:8002").replace(/\/$/, "");

// Short: every call here is a control-plane request against a service that is
// either idle or busy loading — none of them wait on inference.
const CONTROL_TIMEOUT_MS = 15_000;

// NOTE: keep these written out as literal unions rather than
// `(typeof BACKENDS)[number]`. Encore.ts' source-code parser does not support
// indexed-access type queries and refuses to build the service if it sees one
// in a request or response schema — same trap as RegionStatus in
// osm-admin/state-machine.ts. The arrays below are annotated with the union,
// so a typo in either place is still a compile error.
export type LlmBackend = "inproc" | "server";
export type LlmAccelerator = "cpu" | "cuda";
export type LlmKvType = "f16" | "q8_0" | "q5_1" | "q5_0" | "q4_0";
export type LlmReasoning = "off" | "auto" | "think";

const BACKENDS: readonly LlmBackend[] = ["inproc", "server"];
const ACCELERATORS: readonly LlmAccelerator[] = ["cpu", "cuda"];
const KV_TYPES: readonly LlmKvType[] = ["f16", "q8_0", "q5_1", "q5_0", "q4_0"];
const REASONING_MODES: readonly LlmReasoning[] = ["off", "auto", "think"];

export interface LlmConfigRow {
  id: number;
  label: string;
  description: string | null;
  is_active: boolean;
  model_filename: string;
  model_url: string | null;
  model_sha256: string | null;
  extra_urls: string[];
  backend: LlmBackend;
  accelerator: LlmAccelerator;
  ctx_size: number;
  gpu_layers: number;
  threads: number | null;
  batch_size: number;
  ubatch_size: number;
  flash_attn: boolean;
  kv_type: LlmKvType;
  n_cpu_moe: number;
  reasoning: LlmReasoning;
  server_extra_args: string | null;
  ready_timeout_s: number;
  request_timeout_s: number;
  app_timeout_ms: number;
  created_at: string;
  updated_at: string;
}

/** Editable fields. `id`, `is_active` and the timestamps are not among them —
 * activation has its own endpoint, so a PUT cannot switch models by accident. */
export interface LlmConfigInput {
  label: string;
  description?: string | null;
  model_filename: string;
  model_url?: string | null;
  model_sha256?: string | null;
  extra_urls?: string[];
  backend?: LlmBackend;
  accelerator?: LlmAccelerator;
  ctx_size?: number;
  gpu_layers?: number;
  threads?: number | null;
  batch_size?: number;
  ubatch_size?: number;
  flash_attn?: boolean;
  kv_type?: LlmKvType;
  n_cpu_moe?: number;
  reasoning?: LlmReasoning;
  server_extra_args?: string | null;
  ready_timeout_s?: number;
  request_timeout_s?: number;
  app_timeout_ms?: number;
}

// ─── llm_service client ───────────────────────────────────────────────────────

async function llmFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONTROL_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${LLM_SERVICE_URL}${path}`, {
      ...init,
      signal: controller.signal,
      headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    });
  } catch (err) {
    throw APIError.unavailable(
      `llm-service unreachable at ${LLM_SERVICE_URL}${path}: ${(err as Error).message}`,
    );
  } finally {
    clearTimeout(timer);
  }

  const body = await res.text();
  if (!res.ok) {
    // The service's own detail is far more useful than a generic status line —
    // "this llama.cpp build cannot read that architecture" versus "422".
    let detail = body;
    try {
      const parsed = JSON.parse(body);
      if (typeof parsed?.detail === "string") detail = parsed.detail;
    } catch {
      // Keep the raw body.
    }
    if (res.status === 409) throw APIError.aborted(detail);
    if (res.status === 404) throw APIError.notFound(detail);
    if (res.status === 422 || res.status === 400) throw APIError.invalidArgument(detail);
    throw APIError.unavailable(`llm-service returned ${res.status}: ${detail}`);
  }
  return (body ? JSON.parse(body) : {}) as T;
}

/** The row as the llm_service's LlmConfig.from_dict expects it. */
function toReloadPayload(row: LlmConfigRow): Record<string, unknown> {
  return {
    config_id: row.id,
    label: row.label,
    model_filename: row.model_filename,
    model_url: row.model_url ?? "",
    model_sha256: row.model_sha256 ?? "",
    extra_urls: row.extra_urls,
    backend: row.backend,
    accelerator: row.accelerator,
    ctx_size: row.ctx_size,
    gpu_layers: row.gpu_layers,
    threads: row.threads,
    batch_size: row.batch_size,
    ubatch_size: row.ubatch_size,
    flash_attn: row.flash_attn,
    kv_type: row.kv_type,
    n_cpu_moe: row.n_cpu_moe,
    reasoning: row.reasoning,
    server_extra_args: row.server_extra_args ?? "",
    ready_timeout_s: row.ready_timeout_s,
    request_timeout_s: row.request_timeout_s,
  };
}

// ─── Validation ───────────────────────────────────────────────────────────────
//
// The table has CHECK constraints for all of this, but a Postgres constraint
// violation surfaces as a 500 with a message no operator should have to read.
// These run first so the UI gets a 400 naming the field.

function oneOf<T extends string>(
  value: T | undefined,
  allowed: readonly T[],
  field: string,
): void {
  if (value !== undefined && !allowed.includes(value)) {
    throw APIError.invalidArgument(`${field} must be one of ${allowed.join(", ")}`);
  }
}

function inRange(value: number | undefined, min: number, max: number, field: string): void {
  if (value === undefined) return;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw APIError.invalidArgument(`${field} must be an integer between ${min} and ${max}`);
  }
}

function validate(input: LlmConfigInput): void {
  if (!input.label?.trim()) throw APIError.invalidArgument("label must not be empty");

  const filename = input.model_filename?.trim();
  if (!filename) throw APIError.invalidArgument("model_filename must not be empty");
  // Must stay a bare name: it is joined onto the models directory inside the
  // container, and a path would point the loader outside the volume.
  if (filename.includes("/") || filename === "." || filename === "..") {
    throw APIError.invalidArgument("model_filename must be a bare file name, not a path");
  }

  oneOf(input.backend, BACKENDS, "backend");
  oneOf(input.accelerator, ACCELERATORS, "accelerator");
  oneOf(input.kv_type, KV_TYPES, "kv_type");
  oneOf(input.reasoning, REASONING_MODES, "reasoning");

  inRange(input.ctx_size, 512, 1_048_576, "ctx_size");
  inRange(input.batch_size, 1, 1_048_576, "batch_size");
  inRange(input.ubatch_size, 1, 1_048_576, "ubatch_size");
  inRange(input.n_cpu_moe, 0, 1024, "n_cpu_moe");
  inRange(input.ready_timeout_s, 1, 86_400, "ready_timeout_s");
  inRange(input.request_timeout_s, 1, 86_400, "request_timeout_s");
  inRange(input.app_timeout_ms, 1000, 86_400_000, "app_timeout_ms");
  if (input.threads !== undefined && input.threads !== null) {
    inRange(input.threads, 0, 4096, "threads");
  }

  const batch = input.batch_size;
  const ubatch = input.ubatch_size;
  if (batch !== undefined && ubatch !== undefined && ubatch > batch) {
    throw APIError.invalidArgument("ubatch_size must not exceed batch_size");
  }

  // A caller that gives up after the service does leaves a generation running
  // with nobody to receive it, which on a slow model wastes minutes of GPU.
  if (
    input.app_timeout_ms !== undefined &&
    input.request_timeout_s !== undefined &&
    input.app_timeout_ms > input.request_timeout_s * 1000
  ) {
    throw APIError.invalidArgument(
      "app_timeout_ms must not exceed request_timeout_s — the caller has to be the one that gives up first",
    );
  }
}

async function loadRow(id: number): Promise<LlmConfigRow> {
  const [row] = await db.select().from(llmModelConfig).where(eq(llmModelConfig.id, id));
  if (!row) throw APIError.notFound(`no llm configuration with id ${id}`);
  return row as LlmConfigRow;
}

// ─── CRUD ─────────────────────────────────────────────────────────────────────

export interface ListConfigsResponse {
  configs: LlmConfigRow[];
}

export const listLlmConfigs = api(
  { expose: true, method: "GET", path: "/admin/llm-configs", auth: true },
  async (): Promise<ListConfigsResponse> => {
    requirePermission(getAuthData()!, "data.manage");
    const configs = await db.select().from(llmModelConfig).orderBy(llmModelConfig.label);
    return { configs: configs as LlmConfigRow[] };
  },
);

export interface ConfigResponse {
  config: LlmConfigRow;
}

export const createLlmConfig = api(
  { expose: true, method: "POST", path: "/admin/llm-configs", auth: true },
  async (input: LlmConfigInput): Promise<ConfigResponse> => {
    requirePermission(getAuthData()!, "data.manage");
    validate(input);

    const [row] = await db
      .insert(llmModelConfig)
      .values({
        label: input.label.trim(),
        description: input.description ?? null,
        model_filename: input.model_filename.trim(),
        model_url: input.model_url ?? null,
        model_sha256: input.model_sha256 ?? null,
        extra_urls: input.extra_urls ?? [],
        backend: input.backend ?? "inproc",
        accelerator: input.accelerator ?? "cpu",
        ctx_size: input.ctx_size ?? 8192,
        gpu_layers: input.gpu_layers ?? 0,
        threads: input.threads ?? null,
        batch_size: input.batch_size ?? 512,
        ubatch_size: input.ubatch_size ?? 512,
        flash_attn: input.flash_attn ?? false,
        kv_type: input.kv_type ?? "f16",
        n_cpu_moe: input.n_cpu_moe ?? 0,
        reasoning: input.reasoning ?? "off",
        server_extra_args: input.server_extra_args ?? null,
        ready_timeout_s: input.ready_timeout_s ?? 900,
        request_timeout_s: input.request_timeout_s ?? 900,
        app_timeout_ms: input.app_timeout_ms ?? 120_000,
      })
      .returning();
    return { config: row as LlmConfigRow };
  },
);

export interface UpdateConfigParams extends LlmConfigInput {
  id: number;
}

export const updateLlmConfig = api(
  { expose: true, method: "PUT", path: "/admin/llm-configs/:id", auth: true },
  async ({ id, ...input }: UpdateConfigParams): Promise<ConfigResponse> => {
    requirePermission(getAuthData()!, "data.manage");
    validate(input);
    await loadRow(id);

    const [row] = await db
      .update(llmModelConfig)
      .set({
        label: input.label.trim(),
        description: input.description ?? null,
        model_filename: input.model_filename.trim(),
        model_url: input.model_url ?? null,
        model_sha256: input.model_sha256 ?? null,
        extra_urls: input.extra_urls ?? [],
        backend: input.backend ?? "inproc",
        accelerator: input.accelerator ?? "cpu",
        ctx_size: input.ctx_size ?? 8192,
        gpu_layers: input.gpu_layers ?? 0,
        threads: input.threads ?? null,
        batch_size: input.batch_size ?? 512,
        ubatch_size: input.ubatch_size ?? 512,
        flash_attn: input.flash_attn ?? false,
        kv_type: input.kv_type ?? "f16",
        n_cpu_moe: input.n_cpu_moe ?? 0,
        reasoning: input.reasoning ?? "off",
        server_extra_args: input.server_extra_args ?? null,
        ready_timeout_s: input.ready_timeout_s ?? 900,
        request_timeout_s: input.request_timeout_s ?? 900,
        app_timeout_ms: input.app_timeout_ms ?? 120_000,
        updated_at: sql`NOW()`,
      })
      .where(eq(llmModelConfig.id, id))
      .returning();
    return { config: row as LlmConfigRow };
  },
);

export interface ConfigIdParams {
  id: number;
}

export interface DeleteConfigResponse {
  deleted: number;
}

export const deleteLlmConfig = api(
  { expose: true, method: "DELETE", path: "/admin/llm-configs/:id", auth: true },
  async ({ id }: ConfigIdParams): Promise<DeleteConfigResponse> => {
    requirePermission(getAuthData()!, "data.manage");
    const row = await loadRow(id);
    if (row.is_active) {
      throw APIError.failedPrecondition(
        "this configuration is active — activate another one or reset to the container's environment first",
      );
    }
    await db.delete(llmModelConfig).where(eq(llmModelConfig.id, id));
    return { deleted: id };
  },
);

// ─── Activation ───────────────────────────────────────────────────────────────

export interface ActivateResponse {
  config: LlmConfigRow;
  /** The llm_service's reload state right after it accepted the request. */
  reload: LlmReloadState;
}

export const activateLlmConfig = api(
  { expose: true, method: "POST", path: "/admin/llm-configs/:id/activate", auth: true },
  async ({ id }: ConfigIdParams): Promise<ActivateResponse> => {
    requirePermission(getAuthData()!, "data.manage");
    const row = await loadRow(id);

    // Ask first, record second: if the service refuses the configuration
    // (unknown file, a backend this image cannot run) nothing has been written
    // and the previously active row keeps its flag.
    const accepted = await llmFetch<{ reload: LlmReloadState }>("/reload", {
      method: "POST",
      body: JSON.stringify(toReloadPayload(row)),
    });

    await db.transaction(async (tx) => {
      await tx
        .update(llmModelConfig)
        .set({ is_active: false })
        .where(ne(llmModelConfig.id, id));
      await tx
        .update(llmModelConfig)
        .set({ is_active: true, updated_at: sql`NOW()` })
        .where(eq(llmModelConfig.id, id));
    });

    return { config: { ...row, is_active: true }, reload: accepted.reload };
  },
);

export interface ResetResponse {
  reload: LlmReloadState;
  removed_file: boolean;
}

export const resetLlmConfig = api(
  { expose: true, method: "POST", path: "/admin/llm-configs/reset", auth: true },
  async (): Promise<ResetResponse> => {
    requirePermission(getAuthData()!, "data.manage");
    const res = await llmFetch<{ reload: LlmReloadState; removed_file: boolean }>(
      "/config/reset",
      { method: "POST" },
    );
    await db.update(llmModelConfig).set({ is_active: false }).where(eq(llmModelConfig.is_active, true));
    return res;
  },
);

// ─── Status ───────────────────────────────────────────────────────────────────

export interface LlmReloadState {
  state: string;
  detail: string | null;
  label: string;
  started_at: number | null;
  finished_at: number | null;
}

export interface LlmLiveConfig {
  model_filename: string;
  backend: string;
  accelerator: string;
  ctx_size: number;
  gpu_layers: number;
  n_cpu_moe: number;
  kv_type: string;
  flash_attn: boolean;
  label: string;
  config_id: number | null;
  /** "env" = running on the container's environment, "file" = an activated row. */
  source: string;
  model_present: boolean;
}

export interface LlmDownloadState {
  state: string;
  filename: string;
  url: string;
  bytes_done: number;
  bytes_total: number | null;
  percent: number | null;
  eta_seconds: number | null;
  bytes_per_second: number | null;
  file_index: number;
  file_count: number;
  error: string | null;
  completed: string[];
}

export interface LlmStatusResponse {
  /** What the database says should be loaded. Null when nothing is activated. */
  intended: LlmConfigRow | null;
  /** What the llm_service actually has loaded. */
  live: LlmLiveConfig;
  reload: LlmReloadState;
  download: LlmDownloadState;
  llm_loaded: boolean;
  /**
   * False when the service is running something other than the activated
   * configuration — a failed load that rolled back, or a container that was
   * started before the row was activated. The UI says so rather than this
   * endpoint quietly rewriting the row.
   */
  in_sync: boolean;
}

export const getLlmStatus = api(
  { expose: true, method: "GET", path: "/admin/llm-status", auth: true },
  async (): Promise<LlmStatusResponse> => {
    requirePermission(getAuthData()!, "data.manage");

    const [intended] = await db
      .select()
      .from(llmModelConfig)
      .where(eq(llmModelConfig.is_active, true));

    const status = await llmFetch<{
      reload: LlmReloadState;
      config: LlmLiveConfig;
      download: LlmDownloadState;
      llm_loaded: boolean;
    }>("/reload/status");

    const in_sync = intended
      ? status.config.config_id === intended.id
      : status.config.source === "env";

    return {
      intended: (intended as LlmConfigRow) ?? null,
      live: status.config,
      reload: status.reload,
      download: status.download,
      llm_loaded: status.llm_loaded,
      in_sync,
    };
  },
);

// ─── Model files on the volume ────────────────────────────────────────────────

export interface ModelFile {
  filename: string;
  size_bytes: number;
  modified_at: number;
  partial: boolean;
}

export interface DiskUsage {
  total_bytes: number | null;
  free_bytes: number | null;
}

export interface ModelFilesResponse {
  files: ModelFile[];
  active_filename: string;
  models_dir: string;
  disk: DiskUsage;
  download: LlmDownloadState;
}

export const listLlmModelFiles = api(
  { expose: true, method: "GET", path: "/admin/llm-models/files", auth: true },
  async (): Promise<ModelFilesResponse> => {
    requirePermission(getAuthData()!, "data.manage");
    return llmFetch<ModelFilesResponse>("/models/files");
  },
);

export interface DownloadRequest {
  url: string;
  filename?: string;
  sha256?: string;
  extra_urls?: string[];
}

export interface DownloadResponse {
  download: LlmDownloadState;
}

export const downloadLlmModel = api(
  { expose: true, method: "POST", path: "/admin/llm-models/download", auth: true },
  async (req: DownloadRequest): Promise<DownloadResponse> => {
    requirePermission(getAuthData()!, "data.manage");
    if (!/^https?:\/\//.test(req.url)) {
      throw APIError.invalidArgument("url must be an http(s) URL");
    }
    return llmFetch<DownloadResponse>("/models/download", {
      method: "POST",
      body: JSON.stringify({
        url: req.url,
        filename: req.filename || undefined,
        sha256: req.sha256 || undefined,
        extra_urls: req.extra_urls ?? [],
      }),
    });
  },
);

export const getLlmDownloadStatus = api(
  { expose: true, method: "GET", path: "/admin/llm-models/download/status", auth: true },
  async (): Promise<DownloadResponse> => {
    requirePermission(getAuthData()!, "data.manage");
    return llmFetch<DownloadResponse>("/models/download/status");
  },
);

export interface CancelDownloadResponse {
  cancelled: boolean;
  download: LlmDownloadState;
}

export const cancelLlmDownload = api(
  { expose: true, method: "POST", path: "/admin/llm-models/download/cancel", auth: true },
  async (): Promise<CancelDownloadResponse> => {
    requirePermission(getAuthData()!, "data.manage");
    return llmFetch<CancelDownloadResponse>("/models/download/cancel", { method: "POST" });
  },
);

export interface DeleteModelFileParams {
  filename: string;
}

export interface DeleteModelFileResponse {
  filename: string;
  disk: DiskUsage;
}

export const deleteLlmModelFile = api(
  { expose: true, method: "DELETE", path: "/admin/llm-models/files/:filename", auth: true },
  async ({ filename }: DeleteModelFileParams): Promise<DeleteModelFileResponse> => {
    requirePermission(getAuthData()!, "data.manage");

    // A file some configuration still names would silently turn that row into
    // one that re-downloads on activation — or fails, if it has no URL.
    const referencing = await db
      .select({ label: llmModelConfig.label })
      .from(llmModelConfig)
      .where(eq(llmModelConfig.model_filename, filename));
    if (referencing.length > 0) {
      throw APIError.failedPrecondition(
        `still used by: ${referencing.map((r) => r.label).join(", ")}`,
      );
    }

    return llmFetch<DeleteModelFileResponse>(
      `/models/files/${encodeURIComponent(filename)}`,
      { method: "DELETE" },
    );
  },
);
