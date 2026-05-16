import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DockerodeDriver,
  registerDockerodeDriverIfEnabled,
  type DockerodeClientLike,
  type DockerodeContainerLike,
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
  readonly events: Array<{ op: string; name: string; opts?: unknown }> = [];
  /** Image names already "pulled" in this fake registry. */
  readonly pulledImages = new Set<string>();
  /** If non-null, createContainer will reject with this error before
   *  consulting the store. Cleared after one use (so retries succeed). */
  pendingCreateError: { statusCode?: number; message: string } | null = null;
  /** If true, pull() rejects instead of succeeding. */
  pullFails = false;

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
