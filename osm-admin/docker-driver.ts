/**
 * Docker driver abstraction for per-region Nominatim/Overpass containers.
 *
 * The driver interface is small on purpose — only the operations the
 * importer + router actually need. The default implementation
 * (`InMemoryDockerDriver`) records intent without touching Docker, which
 * is what the unit tests use and is also what production runs when the
 * dockerode driver is not explicitly activated.
 *
 * Architecture: each region is fully self-contained — one mediagis/
 * nominatim container with its bundled Postgres + one wiktorn/overpass
 * container, both backed by a per-region named Docker volume. Deleting
 * a region is just removing those two containers + their volumes. We
 * deliberately do not run a shared Postgres for all regions: it would
 * require patching the upstream images.
 *
 * Container naming convention used by the importer/router:
 *   nominatim-<slug-suffix>    long-running container (does its own
 *                              import on first start with empty volume)
 *   overpass-<slug-suffix>     long-running container (same model)
 * The slug suffix is `slugToContainerSuffix(slug)`-derived — no slashes.
 *
 * Healthcheck handling: `ensureRunning` only creates+starts the
 * container. Waiting for the HTTP healthcheck is a separate explicit
 * call (`waitHealthy`). This is what lets the importer ship long imports
 * across many short ticks instead of blocking a single request for hours.
 */

export type ContainerState =
  | "missing"
  | "created"
  | "running"
  | "exited"
  | "removing"
  | "removed";

export interface ContainerDescriptor {
  /** Container name (must be unique on the host's Docker engine). */
  name: string;
  image: string;
  /** Optional command override; otherwise the image's default CMD runs. */
  cmd?: string[];
  env?: Record<string, string>;
  /**
   * Host → container volume mounts. `hostPath` may be either an
   * absolute path (bind mount) or a named-volume identifier; Docker
   * interprets anything that doesn't start with `/` as a volume name
   * and creates it on demand.
   */
  volumes?: { hostPath: string; containerPath: string; readOnly?: boolean }[];
  /** Docker network name. Defaults handled by the caller. */
  network?: string;
  hostname?: string;
}

export interface ContainerInfo {
  name: string;
  state: ContainerState;
  exitCode?: number;
}

export interface WaitHealthyOptions {
  maxAttempts?: number;
  intervalMs?: number;
}

export interface ExecResult {
  exitCode: number;
  /** Captured stdout (UTF-8). Up to ~4 KB tail; longer runs are truncated. */
  stdout: string;
  /** Captured stderr (UTF-8). Same tail policy. */
  stderr: string;
}

export interface DockerDriver {
  /** Idempotent: create+start the container if it isn't already running. */
  ensureRunning(desc: ContainerDescriptor): Promise<ContainerInfo>;
  /** Gracefully stop the container. No-op if already stopped/missing. */
  stop(name: string, timeoutSec?: number): Promise<void>;
  /** Remove the container and its writable layer. No-op if missing. */
  remove(name: string): Promise<void>;
  /** Remove a named Docker volume. No-op if missing; throws if in use. */
  removeVolume(name: string): Promise<void>;
  inspect(name: string): Promise<ContainerInfo>;
  /**
   * Run a command inside an existing container. Used by the refresh
   * flow to invoke `nominatim replication --once` in the per-region
   * Nominatim shard without restarting the container.
   */
  exec(name: string, cmd: string[]): Promise<ExecResult>;
  /**
   * Ensure a docker bridge network exists, then attach the calling
   * process's own container to it. Idempotent; safe to call repeatedly.
   *
   * osm-admin owns this network rather than declaring it in
   * docker-compose.yml — that way `docker compose down` doesn't race
   * the per-region Nominatim/Overpass containers that keep it open.
   * Region containers are spawned with `NetworkMode = name`, and the
   * app reaches them via Docker DNS thanks to the self-attach.
   */
  ensureNetwork(name: string): Promise<void>;
  /**
   * Poll an HTTP healthcheck URL until it responds 2xx. Returns true
   * if it became healthy within the budget, false otherwise. Callers
   * pick the budget that fits the use case (e.g. the importer probes
   * once per tick, the cold-start router waits ~30 s).
   */
  waitHealthy(url: string, opts?: WaitHealthyOptions): Promise<boolean>;
}

/**
 * Test/dev driver — records every operation in memory and pretends
 * containers transition states cleanly. Useful for end-to-end importer
 * tests that don't depend on a real Docker engine.
 *
 * The driver is also what the live osm-admin service ships with when
 * the dockerode driver is not explicitly activated via env. That keeps
 * the state-machine flow exercised end-to-end (status transitions,
 * importer ticks, admin UI rendering) without requiring docker.sock.
 */
export class InMemoryDockerDriver implements DockerDriver {
  private containers = new Map<string, ContainerInfo>();
  private volumes = new Set<string>();
  /** Public for tests: every operation appended in order. */
  readonly events: Array<
    | { op: "ensureRunning"; name: string }
    | { op: "stop"; name: string }
    | { op: "remove"; name: string }
    | { op: "removeVolume"; name: string }
    | { op: "ensureNetwork"; name: string }
    | { op: "waitHealthy"; url: string; healthy: boolean }
    | { op: "exec"; name: string; cmd: string[]; exitCode: number }
  > = [];

  /** Configurable test seam: forces `waitHealthy` to return this value. */
  healthyByDefault = true;
  /** Configurable test seam: forces `exec` to return these. */
  execResult: ExecResult = { exitCode: 0, stdout: "", stderr: "" };

  async ensureRunning(desc: ContainerDescriptor): Promise<ContainerInfo> {
    this.events.push({ op: "ensureRunning", name: desc.name });
    const info: ContainerInfo = { name: desc.name, state: "running" };
    this.containers.set(desc.name, info);
    for (const v of desc.volumes ?? []) this.volumes.add(v.hostPath);
    return info;
  }

  async removeVolume(name: string): Promise<void> {
    this.events.push({ op: "removeVolume", name });
    this.volumes.delete(name);
  }

  async stop(name: string, _timeoutSec?: number): Promise<void> {
    this.events.push({ op: "stop", name });
    const existing = this.containers.get(name);
    if (existing) existing.state = "exited";
  }

  async remove(name: string): Promise<void> {
    this.events.push({ op: "remove", name });
    this.containers.delete(name);
  }

  async inspect(name: string): Promise<ContainerInfo> {
    return this.containers.get(name) ?? { name, state: "missing" };
  }

  async waitHealthy(url: string, _opts?: WaitHealthyOptions): Promise<boolean> {
    this.events.push({ op: "waitHealthy", url, healthy: this.healthyByDefault });
    return this.healthyByDefault;
  }

  async exec(name: string, cmd: string[]): Promise<ExecResult> {
    this.events.push({ op: "exec", name, cmd, exitCode: this.execResult.exitCode });
    return this.execResult;
  }

  async ensureNetwork(name: string): Promise<void> {
    this.events.push({ op: "ensureNetwork", name });
  }
}

/**
 * Singleton accessor — services and the importer share one driver per
 * process. The default is `InMemoryDockerDriver`; the real dockerode
 * driver registers itself here when `OSM_ADMIN_DOCKER_DRIVER=dockerode`.
 */
let activeDriver: DockerDriver = new InMemoryDockerDriver();

export function getDockerDriver(): DockerDriver {
  return activeDriver;
}

export function setDockerDriver(d: DockerDriver): void {
  activeDriver = d;
}
