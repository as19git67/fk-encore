/**
 * Real dockerode-backed implementation of `DockerDriver`.
 *
 * The host process talks to the local Docker daemon via the standard
 * unix socket `/var/run/docker.sock` (which must be bind-mounted into
 * the osm-admin container — see `docker-compose.osm-admin.yml`).
 *
 * Only the parts of the dockerode API we actually need are exercised
 * here; the wrapper keeps the surface tight and testable. The Docker
 * instance can be injected, so tests use a hand-rolled fake instead of
 * spawning containers.
 *
 * The driver is opt-in: nothing here activates unless
 * `OSM_ADMIN_DOCKER_DRIVER=dockerode`. The default stays
 * `InMemoryDockerDriver` so dev/test boxes don't pull in a Docker
 * socket.
 */

import Dockerode from "dockerode";
import {
  type ContainerDescriptor,
  type ContainerInfo,
  type ContainerState,
  type DockerDriver,
  type WaitHealthyOptions,
  setDockerDriver,
} from "./docker-driver";

/** Minimal slice of the dockerode container instance we use. */
export interface DockerodeContainerLike {
  start(): Promise<unknown>;
  stop(opts?: { t?: number }): Promise<unknown>;
  remove(opts?: { force?: boolean }): Promise<unknown>;
  inspect(): Promise<{
    State?: {
      Status?: string;
      Running?: boolean;
      ExitCode?: number;
    };
  }>;
}

/** Minimal slice of the dockerode client surface we use. */
export interface DockerodeClientLike {
  createContainer(opts: Record<string, unknown>): Promise<DockerodeContainerLike>;
  getContainer(id: string): DockerodeContainerLike;
}

export interface DockerodeDriverOptions {
  client?: DockerodeClientLike;
  /**
   * Default network name new containers are attached to. Per-region
   * Nominatim/Overpass instances share this network so the osm-admin
   * service can reach them via Docker DNS.
   */
  defaultNetwork?: string;
  /**
   * Healthcheck poll budget. Defaults: 300 attempts × 2 s = 10 min,
   * enough for a freshly imported Nominatim API to warm up.
   */
  healthcheck?: {
    maxAttempts?: number;
    intervalMs?: number;
    fetcher?: typeof fetch;
  };
}

export class DockerodeDriver implements DockerDriver {
  private readonly client: DockerodeClientLike;
  private readonly defaultNetwork: string | undefined;
  private readonly healthcheck: {
    maxAttempts: number;
    intervalMs: number;
    fetcher: typeof fetch;
  };

  constructor(opts: DockerodeDriverOptions = {}) {
    this.client =
      opts.client ?? (new Dockerode() as unknown as DockerodeClientLike);
    this.defaultNetwork = opts.defaultNetwork;
    this.healthcheck = {
      maxAttempts: opts.healthcheck?.maxAttempts ?? 300,
      intervalMs: opts.healthcheck?.intervalMs ?? 2_000,
      fetcher: opts.healthcheck?.fetcher ?? fetch,
    };
  }

  async ensureRunning(desc: ContainerDescriptor): Promise<ContainerInfo> {
    const existing = await this.tryInspect(desc.name);
    if (existing && existing.state === "running") return existing;

    if (existing && existing.state !== "missing") {
      // Stale instance (created/exited/removing). Force-remove and recreate
      // so we never carry over a half-baked container into the new tick.
      await this.remove(desc.name);
    }

    const container = await this.client.createContainer(
      this.buildCreateOptions(desc, /* autoRemove */ false),
    );
    await container.start();
    return { name: desc.name, state: "running" };
  }

  async stop(name: string, timeoutSec = 10): Promise<void> {
    const c = await this.tryGetRunning(name);
    if (!c) return;
    try {
      await c.stop({ t: timeoutSec });
    } catch (err) {
      if (!isAlreadyStoppedError(err)) throw err;
    }
  }

  async remove(name: string): Promise<void> {
    const existing = await this.tryInspect(name);
    if (!existing || existing.state === "missing") return;
    try {
      const c = this.client.getContainer(name);
      await c.remove({ force: true });
    } catch (err) {
      if (!isMissingError(err)) throw err;
    }
  }

  async inspect(name: string): Promise<ContainerInfo> {
    return (
      (await this.tryInspect(name)) ?? { name, state: "missing" }
    );
  }

  async waitHealthy(url: string, opts: WaitHealthyOptions = {}): Promise<boolean> {
    const maxAttempts = opts.maxAttempts ?? this.healthcheck.maxAttempts;
    const intervalMs = opts.intervalMs ?? this.healthcheck.intervalMs;
    for (let i = 0; i < maxAttempts; i++) {
      try {
        const res = await this.healthcheck.fetcher(url);
        if (res.ok) return true;
      } catch {
        // swallow and retry
      }
      if (i + 1 < maxAttempts) await sleep(intervalMs);
    }
    return false;
  }

  // ── internal helpers ──────────────────────────────────────────────

  private buildCreateOptions(
    desc: ContainerDescriptor,
    autoRemove: boolean,
  ): Record<string, unknown> {
    const env = Object.entries(desc.env ?? {}).map(([k, v]) => `${k}=${v}`);
    const binds = (desc.volumes ?? []).map(
      (v) => `${v.hostPath}:${v.containerPath}${v.readOnly ? ":ro" : ""}`,
    );
    const networkMode = desc.network ?? this.defaultNetwork;
    return {
      name: desc.name,
      Image: desc.image,
      Hostname: desc.hostname ?? desc.name,
      Env: env,
      Cmd: desc.cmd,
      HostConfig: {
        AutoRemove: autoRemove,
        Binds: binds.length > 0 ? binds : undefined,
        NetworkMode: networkMode,
        RestartPolicy: autoRemove
          ? undefined
          : { Name: "unless-stopped" as const },
      },
    };
  }

  private async tryInspect(name: string): Promise<ContainerInfo | null> {
    try {
      const c = this.client.getContainer(name);
      const info = await c.inspect();
      const status = info.State?.Status ?? "unknown";
      return { name, state: mapDockerState(status), exitCode: info.State?.ExitCode };
    } catch (err) {
      if (isMissingError(err)) return { name, state: "missing" };
      throw err;
    }
  }

  private async tryGetRunning(name: string): Promise<DockerodeContainerLike | null> {
    const info = await this.tryInspect(name);
    if (!info || info.state !== "running") return null;
    return this.client.getContainer(name);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function mapDockerState(status: string): ContainerState {
  switch (status) {
    case "created":
      return "created";
    case "running":
    case "restarting":
      return "running";
    case "exited":
    case "dead":
      return "exited";
    case "removing":
      return "removing";
    default:
      return "missing";
  }
}

function isMissingError(err: unknown): boolean {
  const status = (err as { statusCode?: number; status?: number })?.statusCode ??
    (err as { statusCode?: number; status?: number })?.status;
  if (status === 404) return true;
  const msg = (err as Error)?.message ?? "";
  return /no such container|not found/i.test(msg);
}

function isAlreadyStoppedError(err: unknown): boolean {
  const status = (err as { statusCode?: number; status?: number })?.statusCode ??
    (err as { statusCode?: number; status?: number })?.status;
  if (status === 304) return true;
  const msg = (err as Error)?.message ?? "";
  return /not running|container.*already stopped/i.test(msg);
}

/**
 * Install the dockerode driver as the process-wide active driver when
 * `OSM_ADMIN_DOCKER_DRIVER=dockerode`. No-op otherwise so the default
 * `InMemoryDockerDriver` stays active in dev/test/CI.
 */
export function registerDockerodeDriverIfEnabled(
  opts: DockerodeDriverOptions = {},
): boolean {
  if (process.env.OSM_ADMIN_DOCKER_DRIVER !== "dockerode") return false;
  setDockerDriver(new DockerodeDriver(opts));
  console.log("[osm-admin] dockerode driver active");
  return true;
}
