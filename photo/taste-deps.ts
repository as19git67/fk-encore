/**
 * The embedding service behind the personal taste model (photo/taste-model.ts).
 * Kept apart from aesthetic-deps.ts so the auto-pick service can score with
 * it without pulling in the nightly run.
 */

import { fetchWithTimeout } from "./rpc-timeout";
import { NoTasteGroupsError, type TasteDeps, type TasteFit, type TasteReplayResult } from "./taste-model";

const EMBEDDING_SERVICE_URL = (process.env.EMBEDDING_SERVICE_URL || "http://localhost:8001").replace(/\/$/, "");

/** Five folds of a 1025-dimensional fit over a thousand groups: seconds, with headroom. */
const FIT_TIMEOUT_MS = 10 * 60_000;
const SCORE_TIMEOUT_MS = 2 * 60_000;

async function post<T>(pathname: string, body: unknown, timeoutMs: number): Promise<T> {
  const res = await fetchWithTimeout(`${EMBEDDING_SERVICE_URL}${pathname}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    timeoutMs,
    queue: "embedding",
  });
  if (res.status === 409 && pathname !== "/taste/score") {
    throw new NoTasteGroupsError("Keine entschiedene Gruppe, in der jedes Foto einen CLIP-Vektor hat");
  }
  if (!res.ok) {
    const text = await res.text();
    let detail = text.slice(0, 300) || res.statusText;
    try {
      const parsed = JSON.parse(text) as { detail?: unknown };
      if (typeof parsed.detail === "string") detail = parsed.detail;
    } catch {
      // not JSON
    }
    throw new Error(`embedding service ${pathname} ${res.status}: ${detail}`);
  }
  return (await res.json()) as T;
}

export function realTasteDeps(): TasteDeps {
  return {
    replay: (groups) => post<TasteReplayResult>("/taste/replay", { groups }, FIT_TIMEOUT_MS),
    train: async (groups) => (await post<{ model: TasteFit }>("/taste/train", { groups }, FIT_TIMEOUT_MS)).model,
    score: async (weights, photoIds) =>
      (await post<{ scores: { photo_id: string; value: number }[] }>(
        "/taste/score",
        { weights, photo_ids: photoIds },
        SCORE_TIMEOUT_MS,
      )).scores,
  };
}
