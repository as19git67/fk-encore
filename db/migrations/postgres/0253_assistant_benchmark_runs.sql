-- Runs of the assistant benchmark (documentation/plans/ki-assistent.md,
-- "Benchmark"): started on a button in Dokumente › Einstellungen ›
-- KI-Benchmark, kept so runs on different models can be compared.
--
-- `model` is what llm-service had loaded when the run started; `results`
-- holds one entry per case as it finishes, so a page can show progress and
-- a cancelled run keeps what it measured.
CREATE TABLE IF NOT EXISTS "assistant_benchmark_run" (
  "id" serial PRIMARY KEY,
  "user_id" integer REFERENCES "users"("id") ON DELETE SET NULL,
  "label" text NOT NULL,
  "model" jsonb,
  "status" text NOT NULL DEFAULT 'running',
  "case_ids" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "cases_total" integer NOT NULL,
  "cases_done" integer NOT NULL DEFAULT 0,
  "current_case" text,
  "results" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "summary" jsonb,
  "error" text,
  "started_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  "finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "assistant_benchmark_run_by_start" ON "assistant_benchmark_run" ("started_at");
