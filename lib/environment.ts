/**
 * The deployment's environment and its outbound paths
 * (documentation/plans/dev-system.md, "What the app does with
 * APP_ENVIRONMENT=dev").
 *
 * `APP_ENVIRONMENT=dev` marks the test stack that runs on a copy of
 * production. There, every path that reaches a real person, device or
 * account outside the host asks `outbound(kind)` at its lowest layer:
 *
 *   off       the path does not send; `assertOutbound` throws
 *             `OutboundOffError`, and the "is it configured?" checks of the
 *             path answer false, so callers that skip an unconfigured path
 *             skip this one too
 *   redirect  the path sends to a target of the dev stack instead (mail:
 *             the mail catcher; print: a file); a kind without a redirect
 *             target treats `redirect` as `off`
 *   on        the path sends as in prod, with whatever key the dev env
 *             file gives it (never prod's)
 *
 * The mode comes from `DEV_OUTBOUND_<KIND>` (e.g. `DEV_OUTBOUND_MAIL=on`);
 * without it the default below applies. Outside dev every kind is `on` and
 * nothing here changes behaviour.
 *
 * `llm` is not a path out of the host but prod's GPU: the dev stack shares
 * prod's llm-service, and background work on the copy's backlog would take
 * it from prod. `off` keeps the background workers and jobs that call the
 * model from starting; a user's own request (the assistant, a critique)
 * still runs.
 *
 * Read on every call, so a test can switch the environment.
 */

export type OutboundKind = "mail" | "push" | "fints" | "serpapi" | "eodhd" | "print" | "llm";
export type OutboundMode = "off" | "redirect" | "on";

export const OUTBOUND_KINDS: readonly OutboundKind[] = ["mail", "push", "fints", "serpapi", "eodhd", "print", "llm"];

/** The mode of each kind in dev when the env file says nothing. */
export const DEV_DEFAULTS: Readonly<Record<OutboundKind, OutboundMode>> = {
  mail: "redirect",
  push: "off",
  fints: "off",
  serpapi: "off",
  eodhd: "off",
  print: "off",
  llm: "off",
};

/** Kinds that have a target of their own in the dev stack. */
const REDIRECTABLE: ReadonlySet<OutboundKind> = new Set(["mail", "print"]);

/**
 * Jobs that act outward on their own, with the kinds they use. In dev a job
 * whose kind is `off` starts disabled on every boot (Admin › Jobs shows it as
 * "aus (Dev)" and it can be switched on by hand); the guard at the path's
 * lowest layer holds even then. `scripts/host/test-scrub.sql` switches off
 * the same names in the copy — a test keeps the two lists in step.
 */
export const OUTBOUND_JOBS: Readonly<Record<string, readonly OutboundKind[]>> = {
  "finance-sync-statements": ["fints"],
  "travel-hotel-watches": ["serpapi"],
  "travel-flight-watches": ["serpapi"],
  "collections-schedules": ["mail"],
  "documents-follow-ups-process-due": ["push"],
  "guest-digest": ["mail"],
  "trip-planner-live-activities": ["push"],
  "photo-aesthetic-nightly": ["llm"],
  "trip-planner-curation": ["llm"],
  "trip-planner-spot-descriptions": ["llm"],
  "trip-planner-spot-summaries": ["llm"],
  "documents-collection-summaries": ["llm"],
  "finance-depot-model-retry": ["llm"],
};

export function isDev(): boolean {
  return process.env.APP_ENVIRONMENT?.trim().toLowerCase() === "dev";
}

/** The mode of one outbound path in this deployment. */
export function outbound(kind: OutboundKind): OutboundMode {
  if (!isDev()) return "on";
  const raw = process.env[`DEV_OUTBOUND_${kind.toUpperCase()}`]?.trim().toLowerCase();
  const mode: OutboundMode =
    raw === "off" || raw === "redirect" || raw === "on" ? raw : DEV_DEFAULTS[kind];
  if (mode === "redirect" && !REDIRECTABLE.has(kind)) return "off";
  return mode;
}

/** Every kind with its mode, for the environment endpoint and the log. */
export function outboundModes(): Record<OutboundKind, OutboundMode> {
  return Object.fromEntries(OUTBOUND_KINDS.map((k) => [k, outbound(k)])) as Record<OutboundKind, OutboundMode>;
}

export class OutboundOffError extends Error {
  constructor(readonly kind: OutboundKind) {
    super(`${kind} ist im Dev-System aus (DEV_OUTBOUND_${kind.toUpperCase()}=off)`);
    this.name = "OutboundOffError";
  }
}

/** Throws when `kind` is off; otherwise returns its mode. */
export function assertOutbound(kind: OutboundKind): Exclude<OutboundMode, "off"> {
  const mode = outbound(kind);
  if (mode === "off") throw new OutboundOffError(kind);
  return mode;
}

/** True when a job's kinds keep it off in this deployment. */
export function jobOffInDev(name: string): boolean {
  const kinds = OUTBOUND_JOBS[name];
  return !!kinds && kinds.some((k) => outbound(k) === "off");
}
