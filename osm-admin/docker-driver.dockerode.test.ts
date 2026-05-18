import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DockerodeDriver,
  registerDockerodeDriverIfEnabled,
  type DockerodeClientLike,
  type DockerodeContainerLike,
  type DockerodeNetworkLike,
  type DockerodeNetworkSummary,
} from "./docker-driver.dockerode";
import { getDockerDriver, InMemoryDockerDriver, setDockerDriver } from "./docker-driver";

interface FakeContainerState {
  status: string;
  exitCode?: number;
}

class FakeContainer implements DockerodeContainerLike {
  constructor(
    public readonly name: string,
    private readonly store: Map<string, FakeContainerState>,
    private readonly fake: FakeDocker,
  ) {}

  async start(): Promise<unknown> {
    this.fake.events.push({ op: "start", name: this.name });
    this.store.set(this.name, { status: "running" });
    return {};
  }

  async stop(_opts?: { t?: number }): Promise<unknown> {
    this.fake.events.push({ op: "stop", name: this.name });
    const cur = this.store.get(this.name);
    if (!cur) {
      const err = new Error("No such container");
      (err as { statusCode?: number }).statusCode = 404;
      throw err;
    }
    if (cur.status !== "running") {
      const err = new Error("container already stopped");
      (err as { statusCode?: number }).statusCode = 304;
      throw err;
    }
    this.store.set(this.name, { status: "exited", exitCode: 0 });
    return {};
  }

  async remove(_opts?: { force?: boolean }): Promise<unknown> {
    this.fake.events.push({ op: "remove", name: this.name });
    if (!this.store.has(this.name)) {
      const err = new Error("No such container");
      (err as { statusCode?: number }).statusCode = 404;
      throw err;
    }
    this.store.delete(this.name);
    return {};
  }

  async inspect(): Promise<{
    State?: { Status?: string; Running?: boolean; ExitCode?: number };
  }> {
    const cur = this.store.get(this.name);
    if (!cur) {
      const err = new Error("No such container");
      (err as { statusCode?: number }).statusCode = 404;
      throw err;
    }
    return {
      State: {
        Status: cur.status,
        Running: cur.status === "running",
        ExitCode: cur.exitCode,
      },
    };
  }
}

class FakeDocker implements DockerodeClientLike {
  readonly store = new Map<string, FakeContainerState>();
  readonly volumes = new Set<string>();
  readonly events: Array<{ op: string; name: string; opts?: unknown }> = [];
  /** Image names already "pulled" in this fake registry. */
  readonly pulledImages = new Set<string>();
  /** If non-null, createContainer will reject with this error before
   *  consulting the store. Cleared after one use (so retries succeed). */
  pendingCreateError: { statusCode?: number; message: string } | null = null;
  /** If true, pull() rejects instead of succeeding. */
  pullFails = false;
  /** Volumes that should reject removal as "in use" (409). */
  readonly volumesInUse = new Set<string>();
  /** networkName → set of attached container IDs/names. */
  readonly networks = new Map<string, Set<string>>();
  /** If non-null, createNetwork rejects once with this error then clears. */
  pendingCreateNetworkError: { statusCode?: number; message: string } | null = null;
  /** Container IDs that connect() should reject as already-attached. */
  readonly alreadyAttached = new Set<string>();

  async createContainer(opts: Record<string, unknown>): Promise<DockerodeContainerLike> {
    const name = opts.name as string;
    this.events.push({ op: "createContainer", name, opts });
    if (this.pendingCreateError) {
      const e = this.pendingCreateError;
      this.pendingCreateError = null;
      const err = new Error(e.message);
      (err as { statusCode?: number }).statusCode = e.statusCode;
      throw err;
    }
    this.store.set(name, { status: "created" });
    return new FakeContainer(name, this.store, this);
  }

  getContainer(id: string): DockerodeContainerLike {
    return new FakeContainer(id, this.store, this);
  }

  getVolume(name: string): import("./docker-driver.dockerode").DockerodeVolumeLike {
    return {
      remove: async (_opts?: { force?: boolean }) => {
        this.events.push({ op: "removeVolume", name });
        if (this.volumesInUse.has(name)) {
          const err = new Error("volume is in use");
          (err as { statusCode?: number }).statusCode = 409;
          throw err;
        }
        if (!this.volumes.has(name)) {
          const err = new Error("No such volume");
          (err as { statusCode?: number }).statusCode = 404;
          throw err;
        }
        this.volumes.delete(name);
        return {};
      },
    };
  }

  async listNetworks(opts?: { filters?: string }): Promise<DockerodeNetworkSummary[]> {
    this.events.push({ op: "listNetworks", name: opts?.filters ?? "" });
    // The real daemon's `name` filter is a substring match. Mirror that
    // so the driver's exact-match post-filter is exercised in tests.
    let needle: string | null = null;
    if (opts?.filters) {
      try {
        const parsed = JSON.parse(opts.filters) as { name?: string[] };
        needle = parsed.name?.[0] ?? null;
      } catch {
        needle = null;
      }
    }
    const all = Array.from(this.networks.keys()).map((n) => ({
      Name: n,
      Id: `id-${n}`,
    }));
    return needle ? all.filter((n) => n.Name.includes(needle!)) : all;
  }

  async createNetwork(opts: {
    Name: string;
    Driver?: string;
    CheckDuplicate?: boolean;
  }): Promise<DockerodeNetworkLike> {
    this.events.push({ op: "createNetwork", name: opts.Name, opts });
    if (this.pendingCreateNetworkError) {
      const e = this.pendingCreateNetworkError;
      this.pendingCreateNetworkError = null;
      const err = new Error(e.message);
      (err as { statusCode?: number }).statusCode = e.statusCode;
      throw err;
    }
    if (this.networks.has(opts.Name)) {
      const err = new Error(`network with name ${opts.Name} already exists`);
      (err as { statusCode?: number }).statusCode = 409;
      throw err;
    }
    this.networks.set(opts.Name, new Set());
    return this.getNetwork(opts.Name);
  }

  getNetwork(name: string): DockerodeNetworkLike {
    return {
      connect: async (cOpts: { Container: string }) => {
        this.events.push({ op: "connect", name, opts: cOpts });
        if (this.alreadyAttached.has(cOpts.Container)) {
          const err = new Error(
            `endpoint with name ${cOpts.Container} already exists in network ${name}`,
          );
          (err as { statusCode?: number }).statusCode = 403;
          throw err;
        }
        const attached = this.networks.get(name) ?? new Set();
        attached.add(cOpts.Container);
        this.networks.set(name, attached);
        return {};
      },
    };
  }

  async pull(image: string, _opts?: object): Promise<NodeJS.ReadableStream> {
    this.events.push({ op: "pull", name: image });
    this.pulledImages.add(image);
    // The dockerode driver only consumes the stream via
    // `modem.followProgress`, so returning a placeholder is enough.
    return { /* opaque */ } as NodeJS.ReadableStream;
  }

  modem = {
    followProgress: (
      _stream: NodeJS.ReadableStream,
      onFinished: (err: unknown, output?: unknown) => void,
    ): void => {
      if (this.pullFails) {
        setImmediate(() => onFinished(new Error("pull network error")));
      } else {
        setImmediate(() => onFinished(null, []));
      }
    },
  };
}

function okFetch(): typeof fetch {
  return (async () => ({ ok: true, status: 200 })) as unknown as typeof fetch;
}

describe("DockerodeDriver", () => {
  it("ensureRunning creates + starts (no healthcheck call)", async () => {
    const client = new FakeDocker();
    const driver = new DockerodeDriver({ client });
    const info = await driver.ensureRunning({
      name: "nominatim-bayern",
      image: "mediagis/nominatim:5.0",
      env: { PBF_URL: "https://example.com/x.pbf" },
    });
    expect(info.state).toBe("running");
    expect(client.events.map((e) => e.op)).toEqual(["createContainer", "start"]);
  });

  it("ensureRunning is a no-op when the container is already running", async () => {
    const client = new FakeDocker();
    client.store.set("nominatim-bayern", { status: "running" });
    const driver = new DockerodeDriver({ client });
    await driver.ensureRunning({
      name: "nominatim-bayern",
      image: "mediagis/nominatim:5.0",
    });
    expect(client.events.map((e) => e.op)).toEqual([]);
  });

  it("ensureRunning replaces a stale exited container", async () => {
    const client = new FakeDocker();
    client.store.set("nominatim-bayern", { status: "exited", exitCode: 137 });
    const driver = new DockerodeDriver({ client });
    await driver.ensureRunning({
      name: "nominatim-bayern",
      image: "mediagis/nominatim:5.0",
    });
    expect(client.events.map((e) => e.op)).toEqual([
      "remove",
      "createContainer",
      "start",
    ]);
  });

  it("waitHealthy returns true on first 2xx", async () => {
    const driver = new DockerodeDriver({
      client: new FakeDocker(),
      healthcheck: { fetcher: okFetch(), maxAttempts: 1, intervalMs: 0 },
    });
    const ok = await driver.waitHealthy("http://nominatim-bayern:8080/status");
    expect(ok).toBe(true);
  });

  it("waitHealthy returns false after the budget without throwing", async () => {
    const bad = (async () => ({ ok: false, status: 503 })) as unknown as typeof fetch;
    const driver = new DockerodeDriver({
      client: new FakeDocker(),
      healthcheck: { fetcher: bad, maxAttempts: 3, intervalMs: 0 },
    });
    const ok = await driver.waitHealthy("http://nominatim-bayern:8080/status");
    expect(ok).toBe(false);
  });

  it("waitHealthy respects per-call overrides", async () => {
    let calls = 0;
    const fetcher = (async () => {
      calls++;
      return { ok: false, status: 503 };
    }) as unknown as typeof fetch;
    const driver = new DockerodeDriver({
      client: new FakeDocker(),
      healthcheck: { fetcher, maxAttempts: 99, intervalMs: 0 },
    });
    await driver.waitHealthy("http://x/status", { maxAttempts: 2, intervalMs: 0 });
    expect(calls).toBe(2);
  });

  it("stop is a no-op for missing containers", async () => {
    const client = new FakeDocker();
    const driver = new DockerodeDriver({ client });
    await expect(driver.stop("nope")).resolves.toBeUndefined();
  });

  it("stop swallows the 304 already-stopped error", async () => {
    const client = new FakeDocker();
    client.store.set("nominatim-bayern", { status: "exited" });
    const driver = new DockerodeDriver({ client });
    await expect(driver.stop("nominatim-bayern")).resolves.toBeUndefined();
  });

  it("remove tolerates a missing container", async () => {
    const client = new FakeDocker();
    const driver = new DockerodeDriver({ client });
    await expect(driver.remove("nope")).resolves.toBeUndefined();
  });

  it("inspect reports `missing` when the container is gone", async () => {
    const client = new FakeDocker();
    const driver = new DockerodeDriver({ client });
    const info = await driver.inspect("nope");
    expect(info).toEqual({ name: "nope", state: "missing" });
  });

  it("removeVolume drops the named volume", async () => {
    const client = new FakeDocker();
    client.volumes.add("vol-a");
    const driver = new DockerodeDriver({ client });
    await driver.removeVolume("vol-a");
    expect(client.volumes.has("vol-a")).toBe(false);
  });

  it("removeVolume tolerates a missing volume (404)", async () => {
    const client = new FakeDocker();
    const driver = new DockerodeDriver({ client });
    await expect(driver.removeVolume("nope")).resolves.toBeUndefined();
  });

  it("removeVolume propagates 'in use' (409) so the caller can intervene", async () => {
    const client = new FakeDocker();
    client.volumes.add("vol-busy");
    client.volumesInUse.add("vol-busy");
    const driver = new DockerodeDriver({ client });
    await expect(driver.removeVolume("vol-busy")).rejects.toThrow(/in use/);
  });

  it("auto-pulls the image and retries when createContainer fails with 'No such image'", async () => {
    const client = new FakeDocker();
    // First createContainer call fails with the daemon's 404-with-
    // "No such image" message (real wording from the dockerode driver).
    client.pendingCreateError = {
      statusCode: 404,
      message: "(HTTP code 404) no such container - No such image: mediagis/nominatim:5.0",
    };
    vi.spyOn(console, "log").mockImplementation(() => {});

    const driver = new DockerodeDriver({ client });
    const info = await driver.ensureRunning({
      name: "nominatim-bayern",
      image: "mediagis/nominatim:5.0",
      env: { PBF_URL: "https://example.com/x.pbf" },
    });
    expect(info.state).toBe("running");
    expect(client.events.map((e) => e.op)).toEqual([
      "createContainer", // first attempt, throws image-not-found
      "pull",            // reactive pull
      "createContainer", // retry, succeeds
      "start",
    ]);
    expect(client.pulledImages.has("mediagis/nominatim:5.0")).toBe(true);
  });

  it("propagates a pull failure as a regular driver error", async () => {
    const client = new FakeDocker();
    client.pendingCreateError = {
      statusCode: 404,
      message: "(HTTP code 404) no such container - No such image: bad/image:1",
    };
    client.pullFails = true;
    vi.spyOn(console, "log").mockImplementation(() => {});

    const driver = new DockerodeDriver({ client });
    await expect(
      driver.ensureRunning({ name: "x", image: "bad/image:1" }),
    ).rejects.toThrow(/pull network error/);
  });

  it("propagates volumes + env + network through createContainer opts", async () => {
    const client = new FakeDocker();
    const driver = new DockerodeDriver({
      client,
      defaultNetwork: "osm-net",
    });
    await driver.ensureRunning({
      name: "nominatim-bayern",
      image: "mediagis/nominatim:5.0",
      env: { PBF_URL: "https://example.com/x.pbf" },
      volumes: [
        { hostPath: "fk-encore-osm-nominatim-bayern", containerPath: "/var/lib/postgresql/16/main" },
        { hostPath: "/etc/ssl", containerPath: "/etc/ssl", readOnly: true },
      ],
    });
    const opts = client.events[0].opts as Record<string, unknown>;
    expect(opts.Env).toEqual(["PBF_URL=https://example.com/x.pbf"]);
    const hc = opts.HostConfig as { Binds?: string[]; NetworkMode?: string };
    expect(hc.Binds).toEqual([
      "fk-encore-osm-nominatim-bayern:/var/lib/postgresql/16/main",
      "/etc/ssl:/etc/ssl:ro",
    ]);
    expect(hc.NetworkMode).toBe("osm-net");
  });

  it("ensureNetwork creates the bridge network and self-attaches", async () => {
    const client = new FakeDocker();
    const driver = new DockerodeDriver({
      client,
      selfContainer: "fk-encore-app",
    });
    await driver.ensureNetwork("osm-net");

    expect(client.events.map((e) => e.op)).toEqual([
      "listNetworks",
      "createNetwork",
      "connect",
    ]);
    expect(client.networks.get("osm-net")?.has("fk-encore-app")).toBe(true);
  });

  it("ensureNetwork skips createNetwork when the network already exists", async () => {
    const client = new FakeDocker();
    client.networks.set("osm-net", new Set());
    const driver = new DockerodeDriver({
      client,
      selfContainer: "fk-encore-app",
    });
    await driver.ensureNetwork("osm-net");

    expect(client.events.map((e) => e.op)).toEqual(["listNetworks", "connect"]);
  });

  it("ensureNetwork is idempotent across repeated calls (cached)", async () => {
    const client = new FakeDocker();
    const driver = new DockerodeDriver({
      client,
      selfContainer: "fk-encore-app",
    });
    await driver.ensureNetwork("osm-net");
    await driver.ensureNetwork("osm-net");
    await driver.ensureNetwork("osm-net");

    // listNetworks/createNetwork/connect should only fire on the first call.
    expect(client.events.filter((e) => e.op === "listNetworks")).toHaveLength(1);
    expect(client.events.filter((e) => e.op === "connect")).toHaveLength(1);
  });

  it("ensureNetwork swallows a concurrent-create 409", async () => {
    const client = new FakeDocker();
    client.pendingCreateNetworkError = {
      statusCode: 409,
      message: "network with name osm-net already exists",
    };
    const driver = new DockerodeDriver({
      client,
      selfContainer: "fk-encore-app",
    });
    // Should resolve cleanly even though createNetwork raced and lost.
    await expect(driver.ensureNetwork("osm-net")).resolves.toBeUndefined();
  });

  it("ensureNetwork tolerates an already-attached endpoint (403)", async () => {
    const client = new FakeDocker();
    client.networks.set("osm-net", new Set(["fk-encore-app"]));
    client.alreadyAttached.add("fk-encore-app");
    const driver = new DockerodeDriver({
      client,
      selfContainer: "fk-encore-app",
    });
    await expect(driver.ensureNetwork("osm-net")).resolves.toBeUndefined();
  });

  it("ensureNetwork's exact-name post-filter rejects substring matches", async () => {
    const client = new FakeDocker();
    // Daemon has `test-osm-net`; user asked for `osm-net`. The
    // substring-match filter would return `test-osm-net`, but the
    // driver must still create `osm-net` because the names differ.
    client.networks.set("test-osm-net", new Set());
    const driver = new DockerodeDriver({
      client,
      selfContainer: "fk-encore-app",
    });
    await driver.ensureNetwork("osm-net");

    expect(client.networks.has("osm-net")).toBe(true);
    expect(client.events.map((e) => e.op)).toContain("createNetwork");
  });
});

describe("registerDockerodeDriverIfEnabled", () => {
  let original = getDockerDriver();
  let prevEnv: string | undefined;

  beforeEach(() => {
    original = getDockerDriver();
    prevEnv = process.env.OSM_ADMIN_DOCKER_DRIVER;
  });
  afterEach(() => {
    setDockerDriver(original);
    if (prevEnv === undefined) delete process.env.OSM_ADMIN_DOCKER_DRIVER;
    else process.env.OSM_ADMIN_DOCKER_DRIVER = prevEnv;
    vi.restoreAllMocks();
  });

  it("is a no-op when the env var is unset", () => {
    delete process.env.OSM_ADMIN_DOCKER_DRIVER;
    setDockerDriver(new InMemoryDockerDriver());
    const before = getDockerDriver();
    const activated = registerDockerodeDriverIfEnabled({});
    expect(activated).toBe(false);
    expect(getDockerDriver()).toBe(before);
  });

  it("swaps in the dockerode driver when enabled", () => {
    process.env.OSM_ADMIN_DOCKER_DRIVER = "dockerode";
    const client = new FakeDocker();
    vi.spyOn(console, "log").mockImplementation(() => {});
    const activated = registerDockerodeDriverIfEnabled({ client });
    expect(activated).toBe(true);
    expect(getDockerDriver()).toBeInstanceOf(DockerodeDriver);
  });
});
