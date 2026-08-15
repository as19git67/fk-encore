-- Named, switchable inference configurations for the llm_service.
--
-- Everything here has an LLM_* environment variable in docker-compose.yml
-- today. Moving the same knobs into a table lets an operator keep several
-- model setups side by side (a dense default, a MoE experiment, a smaller
-- fallback) and switch between them from the admin UI instead of editing
-- .env and recreating the container.
--
-- Precedence, deliberately: this table is *inert* until a row is activated.
-- The llm_service reads /models/.active_config.json first and falls back to
-- its environment when that file is absent, so a deployment that never
-- touches the UI keeps running exactly on its compose/.env values. The rows
-- seeded below are therefore all inactive — presets to start from, not a
-- claim about what is currently loaded.
CREATE TABLE llm_model_config (
    id                   BIGSERIAL PRIMARY KEY,
    label                TEXT NOT NULL UNIQUE,
    description          TEXT,
    is_active            BOOLEAN NOT NULL DEFAULT false,

    -- ── Weights ──────────────────────────────────────────────────────────
    -- model_filename is a bare basename, resolved against the service's
    -- MODELS_DIR. Keeping it relative means the same row works whether the
    -- volume is mounted at /models (container) or somewhere else (host test).
    model_filename       TEXT NOT NULL,
    model_url            TEXT,
    model_sha256         TEXT,
    -- Further shards of a split GGUF. model_filename points at the first.
    extra_urls           TEXT[] NOT NULL DEFAULT '{}'::text[],

    -- ── Inference ────────────────────────────────────────────────────────
    -- 'inproc' = llama-cpp-python in the FastAPI process (CPU image).
    -- 'server' = llama.cpp llama-server subprocess (GPU image), the only
    -- backend that can reach MoE expert offload.
    backend              TEXT NOT NULL DEFAULT 'inproc',
    accelerator          TEXT NOT NULL DEFAULT 'cpu',
    ctx_size             INTEGER NOT NULL DEFAULT 8192,
    gpu_layers           INTEGER NOT NULL DEFAULT 0,
    threads              INTEGER,
    batch_size           INTEGER NOT NULL DEFAULT 512,
    ubatch_size          INTEGER NOT NULL DEFAULT 512,
    flash_attn           BOOLEAN NOT NULL DEFAULT false,
    kv_type              TEXT NOT NULL DEFAULT 'f16',

    -- ── server backend only ──────────────────────────────────────────────
    -- Number of leading layers whose MoE expert tensors stay in system RAM.
    -- 0 is a no-op and correct for a dense model.
    n_cpu_moe            INTEGER NOT NULL DEFAULT 0,
    reasoning            TEXT NOT NULL DEFAULT 'off',
    server_extra_args    TEXT,
    ready_timeout_s      INTEGER NOT NULL DEFAULT 900,
    request_timeout_s    INTEGER NOT NULL DEFAULT 900,

    -- ── caller side ──────────────────────────────────────────────────────
    -- What the app allows a single /classify to take. Belongs with the model
    -- because a MoE split across RAM is minutes-per-document slower than the
    -- dense default, and the two have to move together.
    app_timeout_ms       INTEGER NOT NULL DEFAULT 120000,

    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT llm_model_config_backend_check
        CHECK (backend IN ('inproc', 'server')),
    CONSTRAINT llm_model_config_accelerator_check
        CHECK (accelerator IN ('cpu', 'cuda')),
    CONSTRAINT llm_model_config_kv_type_check
        CHECK (kv_type IN ('f16', 'q8_0', 'q5_1', 'q5_0', 'q4_0')),
    CONSTRAINT llm_model_config_reasoning_check
        CHECK (reasoning IN ('off', 'auto', 'think')),
    CONSTRAINT llm_model_config_ctx_check
        CHECK (ctx_size BETWEEN 512 AND 1048576),
    CONSTRAINT llm_model_config_filename_check
        CHECK (model_filename <> '' AND model_filename NOT LIKE '%/%')
);

-- At most one active row: the partial predicate keeps only the true rows in
-- the index, so uniqueness over the column itself makes a second one fail.
CREATE UNIQUE INDEX llm_model_config_single_active
    ON llm_model_config (is_active) WHERE is_active;

-- Presets, all inactive. The CPU row mirrors the compose defaults; the CUDA
-- rows are the two setups worth having on a 16 GB card. URLs are left NULL
-- for the dense CPU default because that file is what download_model.sh
-- already fetches from LLM_MODEL_URL.
INSERT INTO llm_model_config
    (label, description, model_filename, model_url, backend, accelerator,
     ctx_size, gpu_layers, batch_size, ubatch_size, flash_attn, kv_type,
     n_cpu_moe, app_timeout_ms)
VALUES
    ('Qwen2.5-7B Q4_K_M (CPU)',
     'Compose default. Dense 7B on CPU, no GPU required.',
     'qwen2.5-7b-instruct-q4_k_m.gguf',
     'https://huggingface.co/bartowski/Qwen2.5-7B-Instruct-GGUF/resolve/main/Qwen2.5-7B-Instruct-Q4_K_M.gguf',
     'inproc', 'cpu', 8192, 0, 512, 512, false, 'f16', 0, 120000),

    ('Qwen3-14B Q4_K_M (CUDA)',
     'Dense 14B, fits a 16 GB card whole. The quality baseline to measure against.',
     'Qwen3-14B-Q4_K_M.gguf',
     'https://huggingface.co/unsloth/Qwen3-14B-GGUF/resolve/main/Qwen3-14B-Q4_K_M.gguf',
     'server', 'cuda', 18000, -1, 2048, 512, true, 'q8_0', 0, 120000),

    ('Qwen3.6-35B-A3B UD-Q5_K_M (CUDA, MoE)',
     'Mixture-of-Experts, ~26 GB of weights. Needs n_cpu_moe tuned down until '
     'the card is nearly full; expect minutes per document, hence the raised timeout.',
     'Qwen3.6-35B-A3B-UD-Q5_K_M.gguf',
     'https://huggingface.co/unsloth/Qwen3.6-35B-A3B-GGUF/resolve/main/Qwen3.6-35B-A3B-UD-Q5_K_M.gguf',
     'server', 'cuda', 18000, -1, 2048, 512, true, 'q8_0', 32, 600000);
