/**
 * DINOv2-embedding of POI reference images (Epic #383).
 *
 * For each cached `poi_references` row whose `embedded_at` is null,
 * we fetch the Commons image, ship it to the embedding_service's
 * raw-DINOv2 endpoint (`POST /dino/embed`), and persist the returned
 * vector + `embedded_at` timestamp. The vector column is written via
 * raw SQL because Drizzle has no native pgvector type.
 *
 * The function is idempotent and tolerant of partial network failures:
 * a Commons or embedding-service outage just leaves the row
 * un-embedded; the next tick re-tries.
 */

import { eq, sql } from "drizzle-orm";
import dbDefault from "../db/database";
import { poiReferences } from "../db/schema";

const EMBEDDING_SERVICE_URL =
  process.env.EMBEDDING_SERVICE_URL || "http://localhost:8001";

export interface EmbedderDeps {
  db?: typeof dbDefault;
  fetcher?: typeof fetch;
  /** Override the embedding-service URL for tests. */
  embeddingServiceUrl?: string;
  /** Inflate the per-call timeout if you're testing a slow stub. */
  timeoutMs?: number;
}

export interface EmbedOutcome {
  qid: string;
  embedded: boolean;
  /** Set when embedded=false explains why (no image url, fetch fail, …). */
  reason?: string;
}

/**
 * Ensure each given QID's `poi_references` row has a fresh DINOv2
 * embedding. Already-embedded rows are skipped without I/O.
 */
export async function ensurePoiEmbeddings(
  qids: string[],
  deps: EmbedderDeps = {},
): Promise<EmbedOutcome[]> {
  const db = deps.db ?? dbDefault;
  const fetcher = deps.fetcher ?? fetch;
  const serviceUrl = deps.embeddingServiceUrl ?? EMBEDDING_SERVICE_URL;
  const timeout = deps.timeoutMs ?? 30_000;

  const out: EmbedOutcome[] = [];
  for (const qid of qids) {
    if (!/^Q\d+$/.test(qid)) {
      out.push({ qid, embedded: false, reason: "invalid_qid" });
      continue;
    }
    const rows = await db
      .select()
      .from(poiReferences)
      .where(eq(poiReferences.qid, qid));
    const row = rows[0];
    if (!row) {
      out.push({ qid, embedded: false, reason: "not_in_cache" });
      continue;
    }
    if (row.embedded_at) {
      out.push({ qid, embedded: true });
      continue;
    }
    if (!row.commons_image_url) {
      out.push({ qid, embedded: false, reason: "no_image" });
      continue;
    }

    try {
      const imageBuffer = await fetchImage(fetcher, row.commons_image_url, timeout);
      const embedding = await embedImage(fetcher, serviceUrl, imageBuffer, timeout);
      await persistEmbedding(db, qid, embedding);
      out.push({ qid, embedded: true });
    } catch (err) {
      out.push({
        qid,
        embedded: false,
        reason: `error:${(err as Error).message ?? String(err)}`,
      });
    }
  }
  return out;
}

async function fetchImage(
  fetcher: typeof fetch,
  url: string,
  timeoutMs: number,
): Promise<Uint8Array> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetcher(url, {
      headers: {
        "User-Agent":
          "fk-encore/POI (https://github.com/as19git67/fk-encore; epic 383) Node.js",
      },
      signal: ctrl.signal,
      redirect: "follow",
    });
    if (!res.ok) {
      throw new Error(`commons HTTP ${res.status}`);
    }
    const ab = await res.arrayBuffer();
    return new Uint8Array(ab);
  } finally {
    clearTimeout(timer);
  }
}

async function embedImage(
  fetcher: typeof fetch,
  serviceUrl: string,
  image: Uint8Array,
  timeoutMs: number,
): Promise<number[]> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const form = new FormData();
    form.append("file", new Blob([image], { type: "image/jpeg" }), "ref.jpg");
    const res = await fetcher(`${serviceUrl}/dino/embed`, {
      method: "POST",
      body: form,
      signal: ctrl.signal,
    });
    if (!res.ok) {
      throw new Error(`embedding_service HTTP ${res.status}`);
    }
    const body = (await res.json()) as { embedding?: number[]; dim?: number };
    if (!Array.isArray(body.embedding) || body.embedding.length === 0) {
      throw new Error("embedding_service: empty response");
    }
    return body.embedding;
  } finally {
    clearTimeout(timer);
  }
}

async function persistEmbedding(
  db: typeof dbDefault,
  qid: string,
  embedding: number[],
): Promise<void> {
  // pgvector accepts a literal in the form `[v1,v2,…]`. We build it as
  // a parameterised string and let postgres cast on insert via the
  // column type.
  const literal = `[${embedding.join(",")}]`;
  await db.execute(sql`
    UPDATE poi_references
    SET embedding   = ${literal}::vector,
        embedded_at = NOW(),
        updated_at  = NOW()
    WHERE qid = ${qid}
  `);
}
