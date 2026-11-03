import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The demo stack (documentation/plans/demodaten.md, "Demo deployment"):
 * its compose layer starts no llm-service of its own and loads the demo,
 * and the nightly reset refuses every env file that is not a demo's.
 * Read as text: the repo has no YAML parser.
 */

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (f: string) => readFileSync(path.join(root, f), "utf8");

describe("docker-compose.demo.yml", () => {
  const demo = read("docker-compose.demo.yml");

  it("keeps the app off its own llm-service and points it at prod's", () => {
    const dependsOn = /depends_on: !override\n([\s\S]*?)\n {4}environment:/.exec(demo)?.[1] ?? "";
    expect(dependsOn).toContain("postgres:");
    expect(dependsOn).not.toContain("llm_service");
    expect(demo).toMatch(/llm_service:\n {4}profiles: \["own-llm"\]/);
    expect(demo).toContain("LLM_SERVICE_URL: ${DEPLOY_LLM_SERVICE_URL:-http://fk-encore-llm:8000}");
    expect(demo).toMatch(/prod:\n {4}external: true/);
  });

  it("repeats every other dependency of the app in docker-compose.yml", () => {
    const base = read("docker-compose.yml");
    const app = base.split(/^ {2}app:\s*$/m)[1]!.split(/^ {2}[a-z_-]+:\s*$/m)[0]!;
    const deps = [.../depends_on:\n((?: {6}.*\n)+)/.exec(app)![1]!.matchAll(/^ {6}([a-z_-]+):/gm)].map((m) => m[1]);
    const demoDeps = [.../depends_on: !override\n((?: {6}.*\n)+)/.exec(demo)![1]!.matchAll(/^ {6}([a-z_-]+):/gm)].map((m) => m[1]);
    expect(demoDeps.sort()).toEqual(deps.filter((d) => d !== "llm_service").sort());
  });

  it("loads the demo and passes DEMO_DATA through on every stack", () => {
    expect(demo).toContain("DEMO_DATA: ${DEMO_DATA:-1}");
    expect(read("docker-compose.yml")).toContain("DEMO_DATA: ${DEMO_DATA:-}");
    expect(read("docker-compose.env.demo.example")).toMatch(/^COMPOSE_FILE=.*docker-compose\.demo\.yml$/m);
  });

  it("gives the demo to a visitors' account of its own, never to the admin", () => {
    expect(demo).toContain("DEMO_OWNER_EMAIL: ${DEMO_OWNER_EMAIL:-}");
    expect(demo).toContain("DEMO_OWNER_PASSWORD: ${DEMO_OWNER_PASSWORD:-}");
    const env = read("docker-compose.env.demo.example");
    const value = (key: string) => new RegExp(`^${key}=(.*)$`, "m").exec(env)?.[1];
    expect(value("DEMO_OWNER_EMAIL")).toBeTruthy();
    expect(value("DEMO_OWNER_EMAIL")).not.toBe(value("ADMIN_EMAIL"));
  });
});

describe("docker/Dockerfile.runtime", () => {
  it("hands /mnt/libraries to the apps user, so the demo photos can be staged without a mounted library", () => {
    const docker = read("docker/Dockerfile.runtime");
    expect(docker).toMatch(/mkdir -p [^\n]*\/mnt\/libraries /);
    expect(docker).toMatch(/chown -R 568:568 [^\n]*\/mnt\/libraries /);
  });

  it("ships the demo reset with the host scripts, so the host needs no checkout", () => {
    const docker = read("docker/Dockerfile.runtime");
    const copy = /COPY --chown=568:568 (scripts\/host\/[\s\S]*?)\/opt\/fk-encore\/host-scripts\//.exec(docker)?.[1] ?? "";
    expect(copy).toContain("scripts/host/demo-reset.sh");
    expect(read("backup/startup.ts")).toMatch(/MANAGED_HOST_SCRIPTS = \[[^\]]*"demo-reset\.sh"/);
  });
});

describe("scripts/host/demo-reset.sh", () => {
  const script = path.join(root, "scripts/host/demo-reset.sh");
  const run = (env: string, ...args: string[]) => {
    const dir = mkdtempSync(path.join(tmpdir(), "demo-reset-"));
    const file = path.join(dir, ".env.demo");
    writeFileSync(file, env);
    return spawnSync("bash", [script, ...args, file], { encoding: "utf8" });
  };
  const demoEnv = "DEMO_DATA=1\nDEPLOY_NAME_SUFFIX=-demo\nDEPLOY_DATA_ROOT=/mnt/data/fk-encore-demo\n";

  it("names what it would empty for a demo env file", () => {
    const r = run(demoEnv, "--now", "--dry-run");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("/mnt/data/fk-encore-demo/pgdata");
    expect(r.stdout).toContain("/mnt/data/fk-encore-demo/photos");
    expect(r.stdout).not.toContain("llm_models");
  });

  it("refuses prod, test and any data root that is not the demo's", () => {
    expect(run("DEPLOY_NAME_SUFFIX=\nDEPLOY_DATA_ROOT=/mnt/data/fk-encore\n", "--now", "--dry-run").status).toBe(1);
    expect(run("DEMO_DATA=\nDEPLOY_NAME_SUFFIX=-test\nDEPLOY_DATA_ROOT=/mnt/data/fk-encore-test\n", "--now", "--dry-run").status).toBe(1);
    expect(run("DEMO_DATA=1\nDEPLOY_NAME_SUFFIX=\nDEPLOY_DATA_ROOT=/mnt/data/fk-encore-demo\n", "--now", "--dry-run").status).toBe(1);
    expect(run("DEMO_DATA=1\nDEPLOY_NAME_SUFFIX=-demo\nDEPLOY_DATA_ROOT=/mnt/data/fk-encore\n", "--now", "--dry-run").status).toBe(1);
    expect(run("DEMO_DATA=1\nDEPLOY_NAME_SUFFIX=-demo\nDEPLOY_DATA_ROOT=./data-demo\n", "--now", "--dry-run").status).toBe(1);
    expect(run("DEMO_DATA=1\nDEPLOY_NAME_SUFFIX=-demo\nDEPLOY_DATA_ROOT=/mnt/demo/../data\n", "--now", "--dry-run").status).toBe(1);
  });

  it("empties the data directories but keeps the host scripts it is called from", () => {
    const base = mkdtempSync(path.join(tmpdir(), "demo-reset-run-"));
    const dataRoot = path.join(base, "fk-encore-demo");
    const bin = path.join(base, "bin");
    mkdirSync(bin);
    writeFileSync(path.join(bin, "docker"), "#!/bin/sh\nexit 0\n");
    chmodSync(path.join(bin, "docker"), 0o755);
    for (const f of ["pgdata/PG_VERSION", "photos/a.jpg", "backup/old.dump", "backup/host-scripts/demo-reset.sh", "backup/host-scripts/backup-token", "llm_models/m.gguf"]) {
      mkdirSync(path.dirname(path.join(dataRoot, f)), { recursive: true });
      writeFileSync(path.join(dataRoot, f), "x");
    }
    const file = path.join(base, ".env.demo");
    writeFileSync(file, `DEMO_DATA=1\nDEPLOY_NAME_SUFFIX=-demo\nDEPLOY_DATA_ROOT=${dataRoot}\n`);
    const r = spawnSync("bash", [script, "--now", file], { encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
    expect(r.status, r.stderr).toBe(0);
    expect(existsSync(path.join(dataRoot, "pgdata/PG_VERSION"))).toBe(false);
    expect(existsSync(path.join(dataRoot, "photos/a.jpg"))).toBe(false);
    expect(existsSync(path.join(dataRoot, "backup/old.dump"))).toBe(false);
    expect(existsSync(path.join(dataRoot, "backup/host-scripts/demo-reset.sh"))).toBe(true);
    expect(existsSync(path.join(dataRoot, "backup/host-scripts/backup-token"))).toBe(true);
    expect(existsSync(path.join(dataRoot, "llm_models/m.gguf"))).toBe(true);
  });

  it("does nothing outside the hour 18 of Los Angeles", () => {
    const hour = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", hour: "2-digit", hourCycle: "h23" }).format(new Date());
    if (hour === "18") return;
    const r = run(demoEnv, "--dry-run");
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
  });
});
