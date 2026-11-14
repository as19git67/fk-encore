import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import db from "../db/database";

/**
 * The test stack on a copy of production (documentation/plans/dev-system.md,
 * stage 1): the compose overlay keeps it off prod's keys and its own GPU
 * services, the refresh refuses every env file and dataset that is not the
 * test stack's, and the scrub runs on the schema the migrations build.
 * Compose files are read as text: the repo has no YAML parser.
 */

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (f: string) => readFileSync(path.join(root, f), "utf8");

describe("docker-compose.test.yml", () => {
  const overlay = read("docker-compose.test.yml");

  it("keeps the app off its own llm-service and points it at prod's", () => {
    expect(overlay).toMatch(/llm_service:\n {4}profiles: \["own-llm"\]/);
    expect(overlay).toMatch(/aesthetic_service:\n {4}profiles: \["own-llm"\]/);
    expect(overlay).toContain("LLM_SERVICE_URL: ${DEPLOY_LLM_SERVICE_URL:-http://fk-encore-llm:8000}");
    expect(overlay).toMatch(/prod:\n {4}external: true/);
  });

  it("repeats every other dependency of the app in docker-compose.yml", () => {
    const base = read("docker-compose.yml");
    const app = base.split(/^ {2}app:\s*$/m)[1]!.split(/^ {2}[a-z_-]+:\s*$/m)[0]!;
    const deps = [.../depends_on:\n((?: {6}.*\n)+)/.exec(app)![1]!.matchAll(/^ {6}([a-z_-]+):/gm)].map((m) => m[1]);
    const testDeps = [.../depends_on: !override\n((?: {6}.*\n)+)/.exec(overlay)![1]!.matchAll(/^ {6}([a-z_-]+):/gm)].map((m) => m[1]);
    expect(testDeps.sort()).toEqual(deps.filter((d) => d !== "llm_service").sort());
  });

  it("sends every mail to the catcher and gives the outward paths no key, whatever the env file says", () => {
    expect(overlay).toContain("SMTP_HOST: mail_catcher");
    expect(overlay).toMatch(/^ {2}mail_catcher:$/m);
    for (const key of ["VAPID_PRIVATE_KEY", "APNS_PRIVATE_KEY", "CUPS_SERVER_URL", "SERPAPI_API_KEY", "EODHD_API_TOKEN"]) {
      expect(overlay).toContain(`${key}: ""`);
    }
    expect(overlay).toContain("APP_ENVIRONMENT: dev");
  });

  it("is combined by the template's COMPOSE_FILE, with prod's database names", () => {
    const env = read("docker-compose.env.test.example");
    expect(env).toMatch(/^COMPOSE_FILE=docker-compose\.yml:docker-compose\.volumes\.yml:docker-compose\.test\.yml$/m);
    expect(env).toMatch(/^APP_ENVIRONMENT=dev$/m);
    expect(env).toMatch(/^DEPLOY_PG_DATABASE=encore$/m);
    expect(env).toMatch(/^DEPLOY_PG_EMBEDDINGS_DATABASE=embeddings$/m);
    expect(env).toMatch(/^DEPLOY_NAME_SUFFIX=-test$/m);
  });
});

describe("host scripts of the test stack", () => {
  it("ship with the image and are seeded onto every backup volume", () => {
    const docker = read("docker/Dockerfile.runtime");
    const copy = /COPY --chown=568:568 (scripts\/host\/[\s\S]*?)\/opt\/fk-encore\/host-scripts\//.exec(docker)?.[1] ?? "";
    expect(copy).toContain("scripts/host/test-refresh.sh");
    expect(copy).toContain("scripts/host/test-scrub.sql");
    const managed = /MANAGED_HOST_SCRIPTS = \[([^\]]*)\]/.exec(read("backup/startup.ts"))?.[1] ?? "";
    expect(managed).toContain('"test-refresh.sh"');
    expect(managed).toContain('"test-scrub.sql"');
  });

  it("leave a snapshot that a clone stands on to the backup's prune", () => {
    const backup = read("scripts/host/fk-encore-backup.sh");
    expect(backup).toContain("-o name,clones");
    expect(backup).toMatch(/keeping \$name: a clone stands on it/);
  });
});

describe("scripts/host/test-refresh.sh", () => {
  const script = path.join(root, "scripts/host/test-refresh.sh");
  const base = mkdtempSync(path.join(tmpdir(), "test-refresh-"));
  const bin = path.join(base, "bin");
  mkdirSync(bin);
  // A zfs that knows prod (with a child dataset and two snapshots) and a
  // previous copy; a docker that does nothing.
  writeFileSync(
    path.join(bin, "zfs"),
    `#!/usr/bin/env bash
args="$*"
last="\${!#}"
case "$args" in
  "list -H -o name "*)
    for d in $FZ_EXISTS; do [[ "$d" == "$last" ]] && exit 0; done; exit 1 ;;
  "get -H -o value mountpoint "*) echo "/mnt/$last" ;;
  "list -H -r -o name,origin "*) printf "%b" "$FZ_ORIGINS" ;;
  "list -H -p -d 1 -t snapshot "*) printf "%b" "$FZ_SNAPS" ;;
  "list -H -r -o name "*) printf "%b" "$FZ_TREE" ;;
  *) echo "fake zfs: $args" >&2; exit 9 ;;
esac
`,
  );
  writeFileSync(path.join(bin, "docker"), "#!/bin/sh\nexit 0\n");
  chmodSync(path.join(bin, "zfs"), 0o755);
  chmodSync(path.join(bin, "docker"), 0o755);

  const prod = "tank/f4mil";
  const fake = {
    FZ_EXISTS: `${prod} tank/f4mil_test tank/f4mil_test/prod-copy ${prod}/pgdata ${prod}@daily-2026-11-13_01-30 ${prod}@daily-2026-11-14_01-30 ${prod}/pgdata@daily-2026-11-14_01-30`,
    FZ_ORIGINS: `tank/f4mil_test/prod-copy\t${prod}@daily-2026-11-07_01-30\ntank/f4mil_test/prod-copy/pgdata\t${prod}/pgdata@daily-2026-11-07_01-30\n`,
    FZ_SNAPS: `${prod}@daily-2026-11-13_01-30\t1\n${prod}@weekly-2026-11-13_01-30\t2\n${prod}@daily-2026-11-14_01-30\t3\n`,
    FZ_TREE: `${prod}\n${prod}/pgdata\n`,
  };
  const testEnv = [
    "APP_ENVIRONMENT=dev",
    "DEPLOY_NAME_SUFFIX=-test",
    `PROD_DATASET=${prod}`,
    "TEST_DATASET=tank/f4mil_test/prod-copy",
    "DEPLOY_DATA_ROOT=/mnt/tank/f4mil_test/prod-copy/data",
  ].join("\n");

  const run = (env: string, extra: Record<string, string> = {}, ...args: string[]) => {
    const dir = mkdtempSync(path.join(base, "stack-"));
    const file = path.join(dir, ".env");
    writeFileSync(file, env + "\n");
    return spawnSync("bash", [script, ...args, file], {
      encoding: "utf8",
      env: { ...process.env, ...fake, ...extra, PATH: `${bin}:${process.env.PATH}` },
    });
  };
  const withLine = (key: string, value: string) =>
    testEnv.split("\n").filter((l) => !l.startsWith(`${key}=`)).concat(`${key}=${value}`).join("\n");

  it("names the newest daily snapshot and every dataset it would clone", () => {
    const r = run(testEnv, {}, "--dry-run");
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("would destroy tank/f4mil_test/prod-copy");
    expect(r.stdout).toContain(`would clone ${prod}@daily-2026-11-14_01-30 to tank/f4mil_test/prod-copy\n`);
    expect(r.stdout).toContain(`would clone ${prod}/pgdata@daily-2026-11-14_01-30 to tank/f4mil_test/prod-copy/pgdata`);
    expect(r.stdout).not.toContain("weekly");
  });

  it("refuses an env file that is not the test stack's", () => {
    expect(run(withLine("APP_ENVIRONMENT", ""), {}, "--dry-run").status).toBe(1);
    expect(run(withLine("DEPLOY_NAME_SUFFIX", ""), {}, "--dry-run").status).toBe(1);
    expect(run(withLine("DEPLOY_NAME_SUFFIX", "-demo"), {}, "--dry-run").status).toBe(1);
    expect(run(withLine("DEPLOY_DATA_ROOT", "/mnt/tank/f4mil/data"), {}, "--dry-run").status).toBe(1);
    expect(run(withLine("DEPLOY_DATA_ROOT", "./data"), {}, "--dry-run").status).toBe(1);
  });

  it("refuses a test dataset that is prod, lies in prod or has no \"test\" in it", () => {
    expect(run(withLine("TEST_DATASET", prod), {}, "--dry-run").status).toBe(1);
    expect(run(withLine("TEST_DATASET", `${prod}/test-copy`), {}, "--dry-run").status).toBe(1);
    expect(run(withLine("TEST_DATASET", "tank/f4mil_copy"), {}, "--dry-run").status).toBe(1);
    expect(run(withLine("TEST_DATASET", "/mnt/tank/f4mil_test/prod-copy"), {}, "--dry-run").status).toBe(1);
  });

  it("never destroys a test dataset that holds anything but clones of prod", () => {
    const r = run(testEnv, { FZ_ORIGINS: "tank/f4mil_test/prod-copy\t-\n" }, "--dry-run");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("is not a clone of a snapshot of tank/f4mil");
  });
});

describe("scripts/host/test-scrub.sql", () => {
  it("runs on the schema the migrations build and switches off the outbound jobs", async () => {
    const body = read("scripts/host/test-scrub.sql").replace(/^BEGIN;$/m, "").replace(/^COMMIT;$/m, "");
    const rollback = new Error("rollback");
    let jobs: { name: string; enabled: boolean }[] = [];
    await expect(
      db.transaction(async (tx) => {
        await tx.execute(sql.raw(body));
        const rows = await tx.execute(
          sql`SELECT name, enabled FROM scheduled_job_state WHERE name IN ('finance-sync-statements', 'guest-digest') ORDER BY name`,
        );
        jobs = rows.rows as typeof jobs;
        throw rollback;
      }),
    ).rejects.toBe(rollback);
    expect(jobs).toEqual([
      { name: "finance-sync-statements", enabled: false },
      { name: "guest-digest", enabled: false },
    ]);
  });
});
