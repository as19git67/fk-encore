/**
 * Docker driver abstraction for per-region Nominatim/Overpass containers.
 *
 * The driver interface is small on purpose — only the operations the
 * importer + router actually need. The default implementation
 * (`InMemoryDockerDriver`) records intent without touching Docker, which
 * is what the unit tests use and is also what production runs until the
 * real dockerode-based implementation lands in a follow-up slice.
 *
 * Container naming convention used by the importer/router:
 *   nominatim-<slug>    long-running API container
 *   overpass-<slug>     long-running API container
 *   nominatim-import-<slug>   one-shot, exits after import
 * (slug is `slugToPostgresDb`-style sanitised, no `/`.)
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
  /** Host → container volume mounts. */
  volumes?: { hostPath: string; containerPath: string; readOnly?: boolean }[];
  /** Docker network name. Defaults handled by the caller. */
  network?: string;
  hostname?: string;
  /** Healthcheck URL that returns 200 when the container is ready. */
  healthcheckUrl?: string;
}

export interface ContainerInfo {
  name: string;
  state: ContainerState;
  exitCode?: number;
}

export interface DockerDriver {
  /** Idempotent: create+start the container if it isn't already running. */
  ensureRunning(desc: ContainerDescriptor): Promise<ContainerInfo>;
  /** Gracefully stop the container. No-op if already stopped/missing. */
  stop(name: string, timeoutSec?: number): Promise<void>;
  /** Remove the container and its writable layer. No-op if missing. */
  remove(name: string): Promise<void>;
  inspect(name: string): Promise<ContainerInfo>;
  /**
   * Run a container to completion and return its exit code. The
   * container is removed after the run (autoremove semantics).
   */
  runOneShot(desc: ContainerDescriptor): Promise<number>;
}

/**
 * Test/dev driver — records every operation in memory and pretends
 * containers transition states cleanly. Useful for end-to-end importer
 * tests that don't depend on a real Docker engine.
 *
 * The driver is also what the live osm-admin service ships with until
 * the dockerode-based real driver lands. That keeps the state-machine
 * flow exercised end-to-end (status transitions, importer ticks,
 * admin UI rendering) without requiring docker.sock on the host.
 */
export class InMemoryDockerDriver implements DockerDriver {
  private containers = new Map<string, ContainerInfo>();
  /** Public for tests: every operation appended in order. */
  readonly events: Array<
    | { op: "ensureRunning"; name: string }
    | { op: "stop"; name: string }
    | { op: "remove"; name: string }
    | { op: "runOneShot"; name: string; exitCode: number }
  > = [];

  /** Configurable test seam: forces `runOneShot` to return this code. */
  oneShotExitCode = 0;

  async ensureRunning(desc: ContainerDescriptor): Promise<ContainerInfo> {
    this.events.push({ op: "ensureRunning", name: desc.name });
    const info: ContainerInfo = { name: desc.name, state: "running" };
    this.containers.set(desc.name, info);
    return info;
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

  async runOneShot(desc: ContainerDescriptor): Promise<number> {
    const exit = this.oneShotExitCode;
    this.events.push({ op: "runOneShot", name: desc.name, exitCode: exit });
    return exit;
  }
}

/**
 * Singleton accessor — services and the importer share one driver per
 * process. The default is `InMemoryDockerDriver`; the real dockerode
 * driver registers itself here once it lands.
 */
let activeDriver: DockerDriver = new InMemoryDockerDriver();

export function getDockerDriver(): DockerDriver {
  return activeDriver;
}

export function setDockerDriver(d: DockerDriver): void {
  activeDriver = d;
}
