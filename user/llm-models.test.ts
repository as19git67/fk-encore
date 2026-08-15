/**
 * Admin endpoints for the llm_service's inference configuration.
 *
 * `fetch` is stubbed rather than pointed at a real llm-service: what is worth
 * testing here is the ordering (ask the service first, record second), the
 * validation that keeps a Postgres CHECK from surfacing as a 500, and the
 * intent-versus-reality reporting — none of which need a model to be loaded.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { getAuthData } from "~encore/auth";
import { eq } from "drizzle-orm";

import db from "../db/database";
import { llmModelConfig } from "../db/schema";
import {
  activateLlmConfig,
  cancelLlmDownload,
  createLlmConfig,
  deleteLlmConfig,
  deleteLlmModelFile,
  downloadLlmModel,
  getLlmStatus,
  listLlmConfigs,
  listLlmModelFiles,
  resetLlmConfig,
  updateLlmConfig,
  type LlmConfigInput,
} from "./llm-models";

function setAuth(permissions: string[] = ["data.manage"]) {
  vi.mocked(getAuthData).mockReturnValue({ userID: "1", permissions });
}

function input(overrides: Partial<LlmConfigInput> = {}): LlmConfigInput {
  return {
    label: `cfg-${Math.random().toString(36).slice(2, 10)}`,
    model_filename: "test-model.gguf",
    backend: "inproc",
    accelerator: "cpu",
    ctx_size: 8192,
    ...overrides,
  };
}

/** Canned llm-service responses, keyed by the path suffix they answer. */
function stubLlmService(routes: Record<string, { status?: number; body: unknown }>) {
  const calls: { url: string; method: string; body: unknown }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      calls.push({
        url: path,
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      const route = routes[path];
      if (!route) throw new Error(`unstubbed llm-service call: ${path}`);
      return {
        ok: (route.status ?? 200) < 400,
        status: route.status ?? 200,
        text: async () => JSON.stringify(route.body),
      } as Response;
    }),
  );
  return calls;
}

const RELOAD_ACCEPTED = {
  status: "accepted",
  reload: { state: "stopping", detail: null, label: "x", started_at: 1, finished_at: null },
};

function liveConfig(overrides: Record<string, unknown> = {}) {
  return {
    model_filename: "qwen2.5-7b-instruct-q4_k_m.gguf",
    backend: "inproc",
    accelerator: "cpu",
    ctx_size: 8192,
    gpu_layers: 0,
    n_cpu_moe: 0,
    kv_type: "f16",
    flash_attn: false,
    label: "",
    config_id: null,
    source: "env",
    model_present: true,
    ...overrides,
  };
}

const IDLE_DOWNLOAD = {
  state: "idle",
  filename: "",
  url: "",
  bytes_done: 0,
  bytes_total: null,
  percent: null,
  eta_seconds: null,
  bytes_per_second: null,
  file_index: 0,
  file_count: 0,
  error: null,
  completed: [],
};

beforeEach(async () => {
  setAuth();
  await db.delete(llmModelConfig);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ─── Permissions ──────────────────────────────────────────────────────────────

describe("permissions", () => {
  it("refuses a caller without data.manage", async () => {
    setAuth([]);
    await expect(listLlmConfigs()).rejects.toThrow(/data.manage/);
    await expect(createLlmConfig(input())).rejects.toThrow(/data.manage/);
    await expect(activateLlmConfig({ id: 1 })).rejects.toThrow(/data.manage/);
    await expect(resetLlmConfig()).rejects.toThrow(/data.manage/);
  });
});

// ─── CRUD ─────────────────────────────────────────────────────────────────────

describe("create", () => {
  it("stores a configuration with the documented defaults", async () => {
    const { config } = await createLlmConfig(input({ label: "Minimal" }));

    expect(config.label).toBe("Minimal");
    expect(config.is_active).toBe(false);
    expect(config.batch_size).toBe(512);
    expect(config.kv_type).toBe("f16");
    expect(config.n_cpu_moe).toBe(0);
    expect(config.app_timeout_ms).toBe(120_000);
    expect(config.extra_urls).toEqual([]);
  });

  it("stores a MoE configuration as given", async () => {
    const { config } = await createLlmConfig(
      input({
        label: "MoE",
        backend: "server",
        accelerator: "cuda",
        ctx_size: 18_000,
        gpu_layers: -1,
        batch_size: 2048,
        flash_attn: true,
        kv_type: "q8_0",
        n_cpu_moe: 32,
        request_timeout_s: 1800,
        app_timeout_ms: 600_000,
        extra_urls: ["https://host/shard-2.gguf"],
      }),
    );

    expect(config.backend).toBe("server");
    expect(config.n_cpu_moe).toBe(32);
    expect(config.app_timeout_ms).toBe(600_000);
    expect(config.extra_urls).toEqual(["https://host/shard-2.gguf"]);
  });

  it("rejects a duplicate label", async () => {
    await createLlmConfig(input({ label: "Same" }));
    await expect(createLlmConfig(input({ label: "Same" }))).rejects.toThrow();
  });
});

describe("validation", () => {
  it.each([
    ["an empty label", { label: "  " }],
    ["an empty filename", { model_filename: "" }],
    ["a path as filename", { model_filename: "../escape.gguf" }],
    ["a nested filename", { model_filename: "sub/model.gguf" }],
    ["an unknown backend", { backend: "magic" as never }],
    ["an unknown accelerator", { accelerator: "tpu" as never }],
    ["an unknown kv type", { kv_type: "q3_k" as never }],
    ["an unknown reasoning mode", { reasoning: "sometimes" as never }],
    ["a context below the floor", { ctx_size: 8 }],
    ["an absurd context", { ctx_size: 10_000_000 }],
    ["a fractional context", { ctx_size: 4096.5 }],
    ["a negative thread count", { threads: -1 }],
    ["a micro-batch larger than the batch", { batch_size: 512, ubatch_size: 1024 }],
  ])("rejects %s", async (_name, overrides) => {
    await expect(createLlmConfig(input(overrides as Partial<LlmConfigInput>))).rejects.toThrow();
  });

  it("rejects an app timeout that outlives the service's own", async () => {
    // Otherwise the service gives up first and leaves a generation running
    // with nobody to receive it.
    await expect(
      createLlmConfig(input({ request_timeout_s: 60, app_timeout_ms: 120_000 })),
    ).rejects.toThrow(/gives up first/);
  });

  it("accepts a null thread count as let-the-backend-choose", async () => {
    const { config } = await createLlmConfig(input({ threads: null }));
    expect(config.threads).toBeNull();
  });
});

describe("update", () => {
  it("changes the stored values", async () => {
    const { config } = await createLlmConfig(input({ ctx_size: 8192 }));
    const updated = await updateLlmConfig({
      id: config.id,
      ...input({ label: config.label, ctx_size: 16_384, n_cpu_moe: 8, backend: "server" }),
    });
    expect(updated.config.ctx_size).toBe(16_384);
    expect(updated.config.n_cpu_moe).toBe(8);
  });

  it("cannot flip the active flag", async () => {
    // Activation has its own endpoint precisely so a PUT cannot swap the
    // running model as a side effect of an edit.
    const { config } = await createLlmConfig(input());
    await db.update(llmModelConfig).set({ is_active: true }).where(eq(llmModelConfig.id, config.id));

    const updated = await updateLlmConfig({
      id: config.id,
      ...input({ label: config.label, is_active: false } as never),
    });
    expect(updated.config.is_active).toBe(true);
  });

  it("404s on an unknown id", async () => {
    await expect(updateLlmConfig({ id: 999_999, ...input() })).rejects.toThrow(/999999/);
  });
});

describe("delete", () => {
  it("removes an inactive configuration", async () => {
    const { config } = await createLlmConfig(input());
    await deleteLlmConfig({ id: config.id });
    expect((await listLlmConfigs()).configs).toHaveLength(0);
  });

  it("refuses to delete the active one", async () => {
    const { config } = await createLlmConfig(input());
    await db.update(llmModelConfig).set({ is_active: true }).where(eq(llmModelConfig.id, config.id));
    await expect(deleteLlmConfig({ id: config.id })).rejects.toThrow(/active/);
  });
});

// ─── Activation ───────────────────────────────────────────────────────────────

describe("activate", () => {
  it("sends the row to the llm-service and then records the intent", async () => {
    const { config } = await createLlmConfig(
      input({ label: "MoE", backend: "server", n_cpu_moe: 32, ctx_size: 18_000 }),
    );
    const calls = stubLlmService({ "/reload": { body: RELOAD_ACCEPTED } });

    const res = await activateLlmConfig({ id: config.id });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("POST");
    // Field names are the table's columns — the service's from_dict owns the
    // mapping, so a rename on either side has to be deliberate.
    expect(calls[0]!.body).toMatchObject({
      config_id: config.id,
      label: "MoE",
      model_filename: "test-model.gguf",
      backend: "server",
      ctx_size: 18_000,
      n_cpu_moe: 32,
    });
    expect(res.config.is_active).toBe(true);

    const [stored] = await db.select().from(llmModelConfig).where(eq(llmModelConfig.id, config.id));
    expect(stored!.is_active).toBe(true);
  });

  it("moves the flag off the previously active row", async () => {
    const first = (await createLlmConfig(input({ label: "First" }))).config;
    const second = (await createLlmConfig(input({ label: "Second" }))).config;
    stubLlmService({ "/reload": { body: RELOAD_ACCEPTED } });

    await activateLlmConfig({ id: first.id });
    await activateLlmConfig({ id: second.id });

    const rows = await db.select().from(llmModelConfig);
    expect(rows.filter((r) => r.is_active).map((r) => r.id)).toEqual([second.id]);
  });

  it("records nothing when the service refuses the configuration", async () => {
    const { config } = await createLlmConfig(input());
    stubLlmService({
      "/reload": { status: 422, body: { detail: "unsupported architecture" } },
    });

    await expect(activateLlmConfig({ id: config.id })).rejects.toThrow(/unsupported architecture/);

    const [stored] = await db.select().from(llmModelConfig).where(eq(llmModelConfig.id, config.id));
    expect(stored!.is_active).toBe(false);
  });

  it("leaves the previous row active when the service is unreachable", async () => {
    const first = (await createLlmConfig(input({ label: "First" }))).config;
    const second = (await createLlmConfig(input({ label: "Second" }))).config;
    await db.update(llmModelConfig).set({ is_active: true }).where(eq(llmModelConfig.id, first.id));

    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNREFUSED"); }));

    await expect(activateLlmConfig({ id: second.id })).rejects.toThrow(/unreachable/);

    const rows = await db.select().from(llmModelConfig);
    expect(rows.filter((r) => r.is_active).map((r) => r.id)).toEqual([first.id]);
  });

  it("relays a busy service as a conflict rather than a generic failure", async () => {
    const { config } = await createLlmConfig(input());
    stubLlmService({
      "/reload": { status: 409, body: { detail: "a reload is already running" } },
    });
    await expect(activateLlmConfig({ id: config.id })).rejects.toThrow(/already running/);
  });

  it("404s on an unknown id without calling the service", async () => {
    const calls = stubLlmService({ "/reload": { body: RELOAD_ACCEPTED } });
    await expect(activateLlmConfig({ id: 999_999 })).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });
});

describe("reset", () => {
  it("clears the active flag once the service has dropped the file", async () => {
    const { config } = await createLlmConfig(input());
    await db.update(llmModelConfig).set({ is_active: true }).where(eq(llmModelConfig.id, config.id));
    stubLlmService({
      "/config/reset": { body: { removed_file: true, reload: RELOAD_ACCEPTED.reload } },
    });

    const res = await resetLlmConfig();

    expect(res.removed_file).toBe(true);
    const rows = await db.select().from(llmModelConfig);
    expect(rows.every((r) => !r.is_active)).toBe(true);
  });
});

// ─── Status ───────────────────────────────────────────────────────────────────

describe("status", () => {
  it("reports in sync when nothing is activated and the service runs on env", async () => {
    stubLlmService({
      "/reload/status": {
        body: {
          reload: { state: "idle", detail: null, label: "", started_at: null, finished_at: null },
          config: liveConfig(),
          download: IDLE_DOWNLOAD,
          llm_loaded: true,
        },
      },
    });

    const status = await getLlmStatus();
    expect(status.intended).toBeNull();
    expect(status.live.source).toBe("env");
    expect(status.in_sync).toBe(true);
  });

  it("reports in sync when the loaded config is the activated one", async () => {
    const { config } = await createLlmConfig(input({ label: "Active" }));
    await db.update(llmModelConfig).set({ is_active: true }).where(eq(llmModelConfig.id, config.id));
    stubLlmService({
      "/reload/status": {
        body: {
          reload: { state: "ready", detail: null, label: "Active", started_at: 1, finished_at: 2 },
          config: liveConfig({ config_id: config.id, source: "file", label: "Active" }),
          download: IDLE_DOWNLOAD,
          llm_loaded: true,
        },
      },
    });

    const status = await getLlmStatus();
    expect(status.intended?.id).toBe(config.id);
    expect(status.in_sync).toBe(true);
  });

  it("reports out of sync after a rolled-back load", async () => {
    // The honest state to show: the operator asked for one model, another is
    // running, and the reload detail says why.
    const { config } = await createLlmConfig(input({ label: "Wanted" }));
    await db.update(llmModelConfig).set({ is_active: true }).where(eq(llmModelConfig.id, config.id));
    stubLlmService({
      "/reload/status": {
        body: {
          reload: {
            state: "error",
            detail: "RuntimeError: unsupported architecture",
            label: "Wanted",
            started_at: 1,
            finished_at: 2,
          },
          config: liveConfig(),
          download: IDLE_DOWNLOAD,
          llm_loaded: true,
        },
      },
    });

    const status = await getLlmStatus();
    expect(status.in_sync).toBe(false);
    expect(status.intended?.label).toBe("Wanted");
    expect(status.reload.detail).toMatch(/unsupported architecture/);
  });

  it("surfaces an unreachable service as unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNREFUSED"); }));
    await expect(getLlmStatus()).rejects.toThrow(/unreachable/);
  });
});

// ─── Model files ──────────────────────────────────────────────────────────────

describe("model files", () => {
  it("passes the volume listing through", async () => {
    stubLlmService({
      "/models/files": {
        body: {
          files: [{ filename: "a.gguf", size_bytes: 10, modified_at: 1, partial: false }],
          active_filename: "a.gguf",
          models_dir: "/models",
          disk: { total_bytes: 100, free_bytes: 50 },
          download: IDLE_DOWNLOAD,
        },
      },
    });
    const res = await listLlmModelFiles();
    expect(res.files[0]!.filename).toBe("a.gguf");
    expect(res.disk.free_bytes).toBe(50);
  });

  it("rejects a non-http download url before calling the service", async () => {
    const calls = stubLlmService({ "/models/download": { body: {} } });
    await expect(downloadLlmModel({ url: "file:///etc/passwd" })).rejects.toThrow(/http/);
    expect(calls).toHaveLength(0);
  });

  it("starts a download with its shards", async () => {
    const calls = stubLlmService({
      "/models/download": { body: { download: { ...IDLE_DOWNLOAD, state: "downloading" } } },
    });
    await downloadLlmModel({
      url: "https://host/m.gguf",
      sha256: "ab",
      extra_urls: ["https://host/m-2.gguf"],
    });
    expect(calls[0]!.body).toMatchObject({
      url: "https://host/m.gguf",
      sha256: "ab",
      extra_urls: ["https://host/m-2.gguf"],
    });
  });

  it("cancels a running download", async () => {
    stubLlmService({
      "/models/download/cancel": {
        body: { cancelled: true, download: { ...IDLE_DOWNLOAD, state: "cancelled" } },
      },
    });
    expect((await cancelLlmDownload()).cancelled).toBe(true);
  });

  it("refuses to delete a file a configuration still names", async () => {
    // Deleting it would quietly turn that row into one that re-downloads on
    // activation, or fails outright if it carries no URL.
    await createLlmConfig(input({ label: "Uses it", model_filename: "wanted.gguf" }));
    const calls = stubLlmService({ "/models/files/wanted.gguf": { body: {} } });

    await expect(deleteLlmModelFile({ filename: "wanted.gguf" })).rejects.toThrow(/Uses it/);
    expect(calls).toHaveLength(0);
  });

  it("deletes an unreferenced file", async () => {
    stubLlmService({
      "/models/files/old.gguf": {
        body: { filename: "old.gguf", disk: { total_bytes: 100, free_bytes: 90 } },
      },
    });
    const res = await deleteLlmModelFile({ filename: "old.gguf" });
    expect(res.filename).toBe("old.gguf");
  });
});
