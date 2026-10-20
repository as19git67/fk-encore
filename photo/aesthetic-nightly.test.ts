import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AestheticRunStatus, AestheticRunTrigger } from "../db/schema";
import type { AestheticRun, AestheticSettings, RunPatch } from "./aesthetic-store";
import {
  BATCH_SIZE,
  MAX_CONSECUTIVE_FAILURES,
  _resetNightly,
  activeRun,
  aestheticTick,
  recover,
  stopActiveRun,
  tryStart,
  type NightDeps,
  type ScoreOutcome,
  type ScorerState,
} from "./aesthetic-nightly";

// 2026-10-20 23:30 UTC is 01:30 in Berlin (summer time).
const NIGHT = Date.parse("2026-10-20T23:30:00Z");
const NOON = Date.parse("2026-10-20T10:00:00Z");
const MINUTE = 60_000;

interface World {
  deps: NightDeps;
  calls: string[];
  runs: Map<number, AestheticRun>;
  photos: Map<number, string | null>;
  settings: AestheticSettings;
  clock: { t: number };
  lease: { active: boolean; swapPolls: number; state: string; detail: string | null };
  scorer: { state: ScorerState };
  llmBusy: boolean;
  /** Per photo id: what the scorer answers, or an error it throws. */
  outcome: (id: number) => ScoreOutcome | Error;
  /** Minutes each scored photo takes on the fake clock. */
  minutesPerPhoto: number;
  failGiveBack: boolean;
}

function world(photoCount: number, opts: Partial<Pick<World, "settings">> = {}): World {
  const w = {} as World;
  w.calls = [];
  w.runs = new Map();
  w.photos = new Map(Array.from({ length: photoCount }, (_, i) => [i + 1, null] as [number, string | null]));
  w.settings = opts.settings ?? { enabled: true, window_start: "01:00", window_end: "06:00", updated_at: "" };
  w.clock = { t: NIGHT };
  w.lease = { active: false, swapPolls: 0, state: "ready", detail: null };
  w.scorer = { state: "unloaded" };
  w.llmBusy = false;
  w.outcome = () => ({ kind: "scored", scores: { aesthetics: 4, quality: 3 } });
  w.minutesPerPhoto = 0;
  w.failGiveBack = false;

  const pending = (model: string) =>
    [...w.photos].filter(([, m]) => m !== model && m !== `${model}:failed`).map(([id]) => id);

  // A swap takes two polls: "loading", then "ready".
  const swap = (active: boolean) => {
    w.lease.state = "loading";
    w.lease.swapPolls = 1;
    w.lease.active = active;
  };

  w.deps = {
    now: () => new Date(w.clock.t),
    sleep: async (ms) => {
      w.clock.t += ms;
    },
    lease: async () => {
      if (w.lease.swapPolls > 0) w.lease.swapPolls--;
      else if (w.lease.state === "loading") w.lease.state = "ready";
      return { active: w.lease.active, reloadState: w.lease.state, reloadDetail: w.lease.detail };
    },
    lend: async () => {
      w.calls.push("lend");
      swap(true);
    },
    giveBack: async () => {
      w.calls.push("giveBack");
      if (w.failGiveBack) throw new Error("scorer still holds the card");
      swap(false);
    },
    llmBusy: async () => w.llmBusy,
    scorerStatus: async () => {
      if (w.scorer.state === "loading") w.scorer.state = "loaded";
      else if (w.scorer.state === "unloading") w.scorer.state = "unloaded";
      return { state: w.scorer.state, error: null, version: "qalign_v1" };
    },
    scorerLoad: async () => {
      w.calls.push("load");
      w.scorer.state = "loading";
    },
    scorerUnload: async () => {
      w.calls.push("unload");
      w.scorer.state = "unloading";
    },
    score: async (id) => {
      w.clock.t += w.minutesPerPhoto * MINUTE;
      const o = w.outcome(id);
      if (o instanceof Error) throw o;
      return o;
    },
    store: {
      getSettings: async () => w.settings,
      countBacklog: async (model) => pending(model).length,
      nextBatch: async (model, limit, skip) => pending(model).filter((id) => !skip.includes(id)).slice(0, limit),
      writeScore: async (id, model) => {
        w.photos.set(id, model);
      },
      markUnscorable: async (id, model) => {
        w.photos.set(id, `${model}:failed`);
      },
      startRun: async (trigger: AestheticRunTrigger, backlog: number) => {
        const id = w.runs.size + 1;
        w.runs.set(id, {
          id, trigger, status: "running", phase: null, model: null, backlog, scored: 0, failed: 0,
          remaining: null, ended_reason: null, error: null, gpu_returned: false, started_at: "", ended_at: null,
        });
        return id;
      },
      updateRun: async (id: number, patch: RunPatch) => {
        Object.assign(w.runs.get(id)!, patch);
      },
      finishRun: async (id: number, patch: RunPatch & { status: AestheticRunStatus }) => {
        Object.assign(w.runs.get(id)!, patch, { phase: null, ended_at: "now" });
      },
      runsToRecover: async (exceptId: number | null) =>
        [...w.runs.values()].filter((r) => r.id !== exceptId && (r.status === "running" || !r.gpu_returned)),
    },
  };
  return w;
}

async function runToEnd(w: World, trigger: AestheticRunTrigger = "window"): Promise<AestheticRun> {
  const result = await tryStart(trigger, w.deps);
  if (!result.started) throw new Error(`not started: ${result.reason}`);
  await result.done;
  return w.runs.get(result.runId)!;
}

beforeEach(() => {
  vi.stubEnv("TZ", "Europe/Berlin");
  _resetNightly();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("starting", () => {
  it("does nothing outside the window", async () => {
    const w = world(3);
    w.clock.t = NOON;
    expect(await aestheticTick(w.deps)).toBe("Außerhalb des Zeitfensters");
    expect(w.calls).toEqual([]);
    expect(w.runs.size).toBe(0);
  });

  it("does nothing while switched off", async () => {
    const w = world(3, { settings: { enabled: false, window_start: "01:00", window_end: "06:00", updated_at: "" } });
    expect(await aestheticTick(w.deps)).toBe("Der nächtliche Lauf ist ausgeschaltet");
    expect(w.calls).toEqual([]);
  });

  it("does not lend the GPU when every photo is scored", async () => {
    const w = world(0);
    expect(await aestheticTick(w.deps)).toBe("Alle Fotos sind bewertet");
    expect(w.calls).toEqual([]);
  });

  it("waits for an idle LLM in the window, but a manual start does not", async () => {
    const w = world(2);
    w.llmBusy = true;
    expect(await aestheticTick(w.deps)).toBe("Das KI-Modell beantwortet gerade eine Anfrage");
    expect(w.calls).toEqual([]);
    const run = await runToEnd(w, "manual");
    expect(run.status).toBe("done");
    expect(run.scored).toBe(2);
  });

  it("leaves a GPU alone that is already lent, e.g. to a benchmark run", async () => {
    const w = world(2);
    w.lease.active = true;
    expect(await aestheticTick(w.deps)).toBe("Die GPU ist schon verliehen, etwa an einen Benchmark-Lauf");
    expect(w.calls).toEqual([]);
  });

  it("runs one at a time", async () => {
    const w = world(2);
    const first = await tryStart("manual", w.deps);
    const second = await tryStart("manual", w.deps);
    expect(first.started).toBe(true);
    expect(second).toEqual({ started: false, reason: "Ein Lauf ist schon im Gang" });
    if (first.started) await first.done;
    expect(activeRun()).toBeNull();
  });
});

describe("a night", () => {
  it("hands the scored count to the after-run hook, but not for an empty run", async () => {
    const w = world(3);
    const seen: number[] = [];
    w.deps.afterRun = (n) => seen.push(n);
    await runToEnd(w);
    expect(seen).toEqual([3]);
    w.photos.set(4, null);
    w.outcome = () => ({ kind: "unscorable", reason: "not an image" });
    await runToEnd(w, "manual");
    expect(seen).toEqual([3]);
  });

  it("lends, loads, scores everything, unloads and gives the GPU back", async () => {
    const w = world(5);
    const run = await runToEnd(w);
    expect(w.calls).toEqual(["lend", "load", "unload", "giveBack"]);
    expect([...w.photos.values()].every((m) => m === "qalign_v1")).toBe(true);
    expect(run).toMatchObject({
      status: "done", scored: 5, failed: 0, remaining: 0, model: "qalign_v1",
      ended_reason: "Alle Fotos bewertet", error: null, gpu_returned: true,
    });
    expect(w.lease.active).toBe(false);
    expect(w.scorer.state).toBe("unloaded");
  });

  it("ends when the window closes and leaves the rest for the next night", async () => {
    const w = world(BATCH_SIZE + 50);
    w.settings = { ...w.settings, window_end: "03:00" };
    w.minutesPerPhoto = 1; // one batch takes past 03:00
    const run = await runToEnd(w);
    expect(run).toMatchObject({ status: "done", scored: BATCH_SIZE, remaining: 50, ended_reason: "Zeitfenster zu Ende" });
    expect(w.calls).toEqual(["lend", "load", "unload", "giveBack"]);
  });

  it("stops when an admin reloads the model, without returning a lease that is gone", async () => {
    const w = world(BATCH_SIZE + 10);
    let scored = 0;
    w.outcome = () => {
      if (++scored === BATCH_SIZE) w.lease.active = false; // /reload ended the lease
      return { kind: "scored", scores: { aesthetics: 3, quality: 3 } };
    };
    const run = await runToEnd(w);
    expect(run).toMatchObject({ status: "done", scored: BATCH_SIZE, ended_reason: "Das KI-Modell wurde neu geladen", gpu_returned: true });
    expect(w.calls).toEqual(["lend", "load", "unload"]);
  });

  it("marks an unreadable photo once instead of retrying it every night", async () => {
    const w = world(3);
    w.outcome = (id) => (id === 2 ? { kind: "unscorable", reason: "Datei fehlt" } : { kind: "scored", scores: { aesthetics: 4, quality: 4 } });
    const run = await runToEnd(w);
    expect(run).toMatchObject({ status: "done", scored: 2, failed: 1, remaining: 0 });
    expect(w.photos.get(2)).toBe("qalign_v1:failed");
  });

  it("gives up after repeated scorer errors and still hands everything back", async () => {
    const w = world(20);
    w.outcome = () => new Error("aesthetic-service /score 503: scorer is error");
    const run = await runToEnd(w);
    expect(run.status).toBe("failed");
    expect(run.failed).toBe(MAX_CONSECUTIVE_FAILURES);
    expect(run.error).toMatch(/Scorer antwortet nicht mehr/);
    expect(w.calls).toEqual(["lend", "load", "unload", "giveBack"]);
    expect(run.gpu_returned).toBe(true);
    expect([...w.photos.values()].every((m) => m === null)).toBe(true);
  });

  it("stops on request after the photo it is on", async () => {
    const w = world(10);
    let n = 0;
    w.outcome = () => {
      if (++n === 3) stopActiveRun();
      return { kind: "scored", scores: { aesthetics: 4, quality: 4 } };
    };
    const run = await runToEnd(w, "manual");
    expect(run).toMatchObject({ status: "stopped", scored: 3, ended_reason: "Angehalten", gpu_returned: true });
    expect(w.calls).toEqual(["lend", "load", "unload", "giveBack"]);
  });

  it("does not load the scorer when the llm-service rolled the lend back", async () => {
    const w = world(3);
    w.deps.lend = async () => {
      w.calls.push("lend");
      w.lease.state = "error";
      w.lease.detail = "not enough memory for the experts";
    };
    const run = await runToEnd(w);
    expect(run.status).toBe("failed");
    expect(run.error).toMatch(/not enough memory/);
    expect(run.gpu_returned).toBe(true);
    expect(w.calls).toEqual(["lend"]);
  });
});

describe("recovery", () => {
  it("retries a failed hand-back on the next tick", async () => {
    const w = world(2);
    w.failGiveBack = true;
    const run = await runToEnd(w);
    expect(run.status).toBe("failed");
    expect(run.gpu_returned).toBe(false);
    expect(w.lease.active).toBe(true);

    w.failGiveBack = false;
    w.clock.t = NOON;
    await aestheticTick(w.deps);
    expect(w.runs.get(run.id)!.gpu_returned).toBe(true);
    expect(w.lease.active).toBe(false);
  });

  it("closes a run a restart left open and unloads what it left on the card", async () => {
    const w = world(2);
    const id = await w.deps.store.startRun("window", 2);
    w.lease.active = true;
    w.scorer.state = "loaded";
    await recover(w.deps);
    expect(w.runs.get(id)).toMatchObject({ status: "failed", gpu_returned: true });
    expect(w.runs.get(id)!.error).toMatch(/unterbrochen/);
    expect(w.calls).toEqual(["unload", "giveBack"]);
  });
});
