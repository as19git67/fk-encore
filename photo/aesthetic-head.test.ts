import { beforeEach, describe, expect, it } from "vitest";
import {
  HEAD_MIN_SAMPLES,
  HEAD_SCORE_BATCH,
  _resetHeadJob,
  headJob,
  startHeadJob,
  type HeadDeps,
  type HeadReport,
} from "./aesthetic-head";

const HEAD = "vith_head_v1";

function report(active: boolean): HeadReport {
  return {
    version: HEAD, active, trained_at: "2026-10-20T04:00:00+00:00", samples: 900, train: 630,
    validation: 135, test: 135, ridge_lambda: 10, spearman_head: 0.7, spearman_zero_shot: 0.3, mae_head: 0.06,
  };
}

interface World {
  deps: HeadDeps;
  samples: number;
  active: boolean;
  /** Photo id → aesthetic_model; all images. */
  photos: Map<number, string | null>;
  /** Ids the embedding service has no vector for. */
  noVector: Set<number>;
  written: Map<number, number>;
  trained: number;
}

function world(photoCount: number): World {
  const w = {} as World;
  w.samples = 900;
  w.active = true;
  w.photos = new Map(Array.from({ length: photoCount }, (_, i) => [i + 1, null] as [number, string | null]));
  w.noVector = new Set();
  w.written = new Map();
  w.trained = 0;
  w.deps = {
    samples: async (_model, limit) =>
      Array.from({ length: Math.min(w.samples, limit) }, (_, i) => ({ photo_id: String(10_000 + i), score: 0.5 })),
    train: async () => {
      w.trained++;
      return report(w.active);
    },
    score: async (ids) => ({
      version: HEAD,
      scores: ids.filter((id) => !w.noVector.has(Number(id))).map((id) => ({ photo_id: id, score: 0.42 })),
      missing: ids.filter((id) => w.noVector.has(Number(id))),
    }),
    provisionalBatch: async (version, afterId, limit) =>
      [...w.photos]
        .filter(([id, m]) => id > afterId && !m?.startsWith("qalign") && m !== version)
        .map(([id]) => id)
        .slice(0, limit),
    writeScore: async (id, version, value) => {
      w.photos.set(id, version);
      w.written.set(id, value);
    },
  };
  return w;
}

beforeEach(() => _resetHeadJob());

describe("the provisional head job", () => {
  it("does not train before there are enough Q-Align scores", async () => {
    const w = world(3);
    w.samples = HEAD_MIN_SAMPLES - 1;
    await startHeadJob("after_run", w.deps).done;
    expect(w.trained).toBe(0);
    expect(headJob()).toMatchObject({ status: "skipped", applied: 0 });
    expect(headJob()?.note).toContain(String(HEAD_MIN_SAMPLES));
  });

  it("trains, then scores every photo without Q-Align across batches", async () => {
    const w = world(HEAD_SCORE_BATCH + 5);
    w.photos.set(2, "qalign_v1");
    w.photos.set(3, "qalign_v1:failed");
    w.noVector.add(4);
    await startHeadJob("manual", w.deps).done;
    const job = headJob()!;
    expect(job).toMatchObject({ status: "done", trigger: "manual", applied: HEAD_SCORE_BATCH + 2, without_vector: 1 });
    expect(job.report?.active).toBe(true);
    expect(job.ended_at).not.toBeNull();
    expect(w.photos.get(1)).toBe(HEAD);
    expect(w.photos.get(2)).toBe("qalign_v1");
    expect(w.photos.get(3)).toBe("qalign_v1:failed");
    expect(w.photos.get(4)).toBeNull();
    expect(w.written.get(HEAD_SCORE_BATCH + 5)).toBe(0.42);
  });

  it("keeps a head that does not beat zero-shot out of the photos", async () => {
    const w = world(3);
    w.active = false;
    await startHeadJob("after_run", w.deps).done;
    expect(headJob()).toMatchObject({ status: "skipped", applied: 0 });
    expect(w.written.size).toBe(0);
  });

  it("runs one job at a time and reports a failure", async () => {
    const w = world(3);
    w.deps.train = async () => {
      throw new Error("embedding service 500");
    };
    const first = startHeadJob("manual", w.deps);
    expect(startHeadJob("manual", w.deps).started).toBe(false);
    await first.done;
    expect(headJob()).toMatchObject({ status: "failed", error: "embedding service 500", phase: null });
    expect(startHeadJob("manual", world(1).deps).started).toBe(true);
  });
});
