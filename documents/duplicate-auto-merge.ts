/**
 * Automatic duplicate merge (#1481 follow-up).
 *
 * The review page is for pairs a person has to look at. Most of the pairs a
 * re-import from the documents volume produces need no eyes, because the
 * evidence is not a similarity but a fact:
 *
 * - **Stage A, provenance.** `relocate.ts` names every stored file
 *   `…__<8 hex of sha256>.pdf`. A file re-imported from the volume keeps that
 *   name as `original_filename`, so when one document's filename hash equals
 *   the first eight hex digits of another document's `sha256`, the first was
 *   exported from the second. That is a chain of custody, not a guess: a
 *   random eight-hex collision is one in four billion. Same owner scope and
 *   a page count that does not contradict are the only other conditions; the
 *   text score plays no part, so this stage also clears pairs the scan never
 *   recorded.
 *
 * - **Stage B, content.** For open pairs without that link the adversary is
 *   "the same form letter with other numbers". So the bar is not more
 *   percent but a check that rules exactly that out: every number in the two
 *   texts identical, in order; equal page count; text at or above
 *   `DOCUMENTS_DUPLICATE_AUTO_MIN_SCORE` (0.98) or word-identical after
 *   normalisation. `doc_date` and `correspondent_slug` are not compared:
 *   both are read out of the text by the classifier, so when every number in
 *   the two texts agrees, a differing date is the classifier's doing, not the
 *   document's — and such pairs were the bulk of what the first version left
 *   on the review page.
 *
 * Everything else stays on the review page. Dry run by default: the report
 * names every pair with its stage and the side that would stay; `apply` runs
 * the same `mergeDocuments` the manual button uses, one pair after another,
 * in the background (a few hundred merges take longer than a request may).
 */

import { and, eq, gte, sql } from "drizzle-orm";
import { api, APIError } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import { requirePermission } from "../user/auth-handler";
import db from "../db/database";
import { dbAll } from "../db/adapter";
import { documentDuplicateCandidates, documents } from "../db/schema";
import {
  defaultKeeper,
  looksLikeSpeakingName,
  mergeDocuments,
  normalizeForSimilarity,
  trigramJaccard,
} from "./duplicates";

console.log("[boot] documents/duplicate-auto-merge.ts: all imports resolved");

/** Text similarity an open pair needs before stage B even looks at it. */
export const DUPLICATE_AUTO_MIN_SCORE = parseFloat(
  process.env.DOCUMENTS_DUPLICATE_AUTO_MIN_SCORE ?? "0.98",
);
/** Report rows kept; the counts are complete either way. */
const REPORT_ITEMS_MAX = 5000;

export type AutoMergeStage = "provenance" | "content";

export interface AutoMergeCandidate {
  stage: AutoMergeStage;
  keeper_id: number;
  loser_id: number;
  keeper_filename: string;
  loser_filename: string;
  /** The recorded text score for a content pair; null for a provenance link. */
  score: number | null;
}

export type AutoMergeOutcome = "planned" | "merged" | "failed" | "rejected";

/** Why stage B passed on an open pair above the score. */
export type ContentRejectReason = "pages" | "numbers" | "text" | "score";

export interface AutoMergeItem extends AutoMergeCandidate {
  outcome: AutoMergeOutcome;
  error: string | null;
  /** Set on a rejected content pair: the first check it failed. */
  reason: ContentRejectReason | null;
}

export interface AutoMergeStageCount {
  found: number;
  merged: number;
  failed: number;
}

export interface AutoMergeReport {
  dry_run: boolean;
  provenance: AutoMergeStageCount;
  content: AutoMergeStageCount;
  /** Open pairs above the score that stage B passed on, by first failed check. */
  content_rejected: Record<ContentRejectReason, number>;
  items: AutoMergeItem[];
  items_total: number;
  truncated: boolean;
}

// ─── Stage A: provenance ────────────────────────────────────────────────────

type ProvenanceRow = {
  loser_id: number;
  loser_filename: string;
  keeper_id: number;
  keeper_filename: string;
};

/**
 * Every document whose filename carries another document's sha256 prefix,
 * within the same owner scope. The keeper is the document the hash names
 * (the original bytes); the loser the file that was exported from it.
 */
export async function findProvenancePairs(): Promise<AutoMergeCandidate[]> {
  const rows = await db.execute<ProvenanceRow>(sql`
    SELECT l.id AS loser_id,
           l.original_filename AS loser_filename,
           k.id AS keeper_id,
           k.original_filename AS keeper_filename
    FROM documents l
    JOIN documents k
      ON k.id <> l.id
     AND lower(left(k.sha256, 8)) =
         lower(substring(l.original_filename from '__([0-9a-fA-F]{8})\\.[A-Za-z0-9]+$'))
     AND (k.pages_total IS NULL OR l.pages_total IS NULL OR k.pages_total = l.pages_total)
     AND (
       (l.visibility = 'private' AND k.visibility = 'private' AND l.user_id = k.user_id)
       OR (l.visibility = 'group' AND k.visibility = 'group' AND l.group_id = k.group_id)
     )
    WHERE l.original_filename ~ '__[0-9a-fA-F]{8}\\.[A-Za-z0-9]+$'
    ORDER BY l.id
  `);
  return rows.rows.map((r) => ({
    stage: "provenance",
    keeper_id: Number(r.keeper_id),
    loser_id: Number(r.loser_id),
    keeper_filename: r.keeper_filename,
    loser_filename: r.loser_filename,
    score: null,
  }));
}

// ─── Stage B: content ───────────────────────────────────────────────────────

/** Every run of digits in the normalised text, in order. */
export function numberTokens(normalized: string): string[] {
  return normalized.match(/\d+/g) ?? [];
}

function sameSequence(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export interface ContentSide {
  id: number;
  original_filename: string;
  pages_total: number | null;
  doc_date: string | null;
  correspondent_slug: string | null;
  text_source: string | null;
  extracted_text: string | null;
}

/**
 * Does this pair read as the same document and not as the same form with
 * other numbers? Returns the first failed check, or null when it qualifies.
 * Pure, so the test can feed it two rows.
 */
export function contentPairVerdict(a: ContentSide, b: ContentSide, score: number): ContentRejectReason | null {
  if (a.pages_total == null || b.pages_total == null || a.pages_total !== b.pages_total) return "pages";
  const na = normalizeForSimilarity(a.extracted_text);
  const nb = normalizeForSimilarity(b.extracted_text);
  if (na.length === 0 || nb.length === 0) return "text";
  if (!sameSequence(numberTokens(na), numberTokens(nb))) return "numbers";
  if (na === nb) return null;
  const s = score >= DUPLICATE_AUTO_MIN_SCORE ? score : trigramJaccard(na, nb);
  return s >= DUPLICATE_AUTO_MIN_SCORE ? null : "score";
}

export function contentPairQualifies(a: ContentSide, b: ContentSide, score: number): boolean {
  return contentPairVerdict(a, b, score) === null;
}

/**
 * Which side stays for a content pair: the one that was not exported from
 * the volume when exactly one carries the speaking name, else the general
 * rule (the OCR'd scan over its text-layer copy, else the earlier import).
 */
export function contentKeeper(a: ContentSide, b: ContentSide): number {
  const aSpeaking = looksLikeSpeakingName(a.original_filename);
  const bSpeaking = looksLikeSpeakingName(b.original_filename);
  if (aSpeaking && !bSpeaking) return b.id;
  if (bSpeaking && !aSpeaking) return a.id;
  return defaultKeeper(a, b);
}

const contentColumns = {
  id: documents.id,
  original_filename: documents.original_filename,
  pages_total: documents.pages_total,
  doc_date: documents.doc_date,
  correspondent_slug: documents.correspondent_slug,
  text_source: documents.text_source,
  extracted_text: documents.extracted_text,
};

export interface RejectedContentPair extends AutoMergeCandidate {
  reason: ContentRejectReason;
}

/** Open pairs at or above the auto score: those whose content qualifies, and why the others do not. */
export async function findContentPairs(): Promise<{ accepted: AutoMergeCandidate[]; rejected: RejectedContentPair[] }> {
  const pairs = await dbAll<{ id: number; a: number | null; b: number | null; score: number }>(
    db
      .select({
        id: documentDuplicateCandidates.id,
        a: documentDuplicateCandidates.document_a_id,
        b: documentDuplicateCandidates.document_b_id,
        score: documentDuplicateCandidates.score,
      })
      .from(documentDuplicateCandidates)
      .where(
        and(
          eq(documentDuplicateCandidates.status, "open"),
          gte(documentDuplicateCandidates.score, DUPLICATE_AUTO_MIN_SCORE - 1e-6),
        ),
      ),
  );
  const accepted: AutoMergeCandidate[] = [];
  const rejected: RejectedContentPair[] = [];
  for (const p of pairs) {
    if (p.a == null || p.b == null) continue;
    const sides = await dbAll<ContentSide>(
      db.select(contentColumns).from(documents).where(sql`${documents.id} IN (${p.a}, ${p.b})`),
    );
    const a = sides.find((s) => s.id === p.a);
    const b = sides.find((s) => s.id === p.b);
    if (!a || !b) continue;
    const keeperId = contentKeeper(a, b);
    const [keeper, loser] = keeperId === a.id ? [a, b] : [b, a];
    const candidate: AutoMergeCandidate = {
      stage: "content",
      keeper_id: keeper.id,
      loser_id: loser.id,
      keeper_filename: keeper.original_filename,
      loser_filename: loser.original_filename,
      score: p.score,
    };
    const reason = contentPairVerdict(a, b, p.score);
    if (reason) rejected.push({ ...candidate, reason });
    else accepted.push(candidate);
  }
  return { accepted, rejected };
}

// ─── The run ────────────────────────────────────────────────────────────────

export interface AutoMergeProgress {
  /** Candidates found so far (both stages), or the total once merging. */
  found: number;
  /** Merges done so far; stays 0 in a dry run. */
  done: number;
}

/**
 * Both stages, then (when `apply`) the merges in order. A document a stage A
 * merge removed may be the keeper of a later candidate: the chain is
 * followed, so its work ends up on the final keeper rather than failing.
 */
export async function autoMergeDuplicates(
  apply: boolean,
  onProgress?: (p: AutoMergeProgress) => void,
): Promise<AutoMergeReport> {
  const provenance = await findProvenancePairs();
  onProgress?.({ found: provenance.length, done: 0 });
  const { accepted: content, rejected } = await findContentPairs();

  // Stage A wins when the same pair shows up in both.
  const seen = new Set(provenance.map((c) => `${Math.min(c.keeper_id, c.loser_id)}:${Math.max(c.keeper_id, c.loser_id)}`));
  const candidates: AutoMergeCandidate[] = [...provenance];
  for (const c of content) {
    const key = `${Math.min(c.keeper_id, c.loser_id)}:${Math.max(c.keeper_id, c.loser_id)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push(c);
  }
  onProgress?.({ found: candidates.length, done: 0 });

  const counts: Record<AutoMergeStage, AutoMergeStageCount> = {
    provenance: { found: provenance.length, merged: 0, failed: 0 },
    content: { found: candidates.length - provenance.length, merged: 0, failed: 0 },
  };
  const items: AutoMergeItem[] = [];
  const replaced = new Map<number, number>(); // loser → keeper, for chains
  const resolve = (id: number): number => {
    let cur = id;
    for (let i = 0; i < 50 && replaced.has(cur); i++) cur = replaced.get(cur)!;
    return cur;
  };

  let done = 0;
  for (const c of candidates) {
    const item: AutoMergeItem = { ...c, outcome: "planned", error: null, reason: null };
    if (apply) {
      const keeper = resolve(c.keeper_id);
      const loser = c.loser_id;
      if (replaced.has(loser) || keeper === loser) {
        // Already gone in an earlier merge of this run: nothing left to do.
        item.outcome = "merged";
        item.keeper_id = keeper;
        counts[c.stage].merged += 1;
      } else {
        try {
          await mergeDocuments(keeper, loser);
          replaced.set(loser, keeper);
          item.outcome = "merged";
          item.keeper_id = keeper;
          counts[c.stage].merged += 1;
        } catch (err: unknown) {
          item.outcome = "failed";
          item.error = err instanceof Error ? err.message : String(err);
          counts[c.stage].failed += 1;
          console.warn(`[documents.auto-merge] ${c.stage} ${loser} → ${keeper} failed: ${item.error}`);
        }
      }
      done += 1;
      if (done % 10 === 0) onProgress?.({ found: candidates.length, done });
    }
    if (items.length < REPORT_ITEMS_MAX) items.push(item);
  }
  onProgress?.({ found: candidates.length, done });

  // The pairs stage B looked at and passed on, so the report says why the
  // review page is still as long as it is.
  const contentRejected: Record<ContentRejectReason, number> = { pages: 0, numbers: 0, text: 0, score: 0 };
  for (const r of rejected) {
    contentRejected[r.reason] += 1;
    if (items.length < REPORT_ITEMS_MAX) items.push({ ...r, outcome: "rejected", error: null });
  }

  return {
    dry_run: !apply,
    provenance: counts.provenance,
    content: counts.content,
    content_rejected: contentRejected,
    items,
    items_total: candidates.length + rejected.length,
    truncated: candidates.length + rejected.length > items.length,
  };
}

// ─── Run state ──────────────────────────────────────────────────────────────

export type AutoMergeStatus = "idle" | "running" | "done" | "failed";

export interface AutoMergeState {
  status: AutoMergeStatus;
  apply: boolean;
  started_at: string | null;
  finished_at: string | null;
  progress: AutoMergeProgress;
  report: AutoMergeReport | null;
  error: string | null;
}

let runState: AutoMergeState = {
  status: "idle",
  apply: false,
  started_at: null,
  finished_at: null,
  progress: { found: 0, done: 0 },
  report: null,
  error: null,
};

export function getAutoMergeState(): AutoMergeState {
  return { ...runState, progress: { ...runState.progress } };
}

/** Tests only. */
export function resetAutoMergeState(): void {
  if (runState.status === "running") throw new Error("an auto-merge run is still active");
  runState = { ...runState, status: "idle", report: null, error: null };
}

export function startAutoMerge(apply: boolean): { started: boolean; state: AutoMergeState } {
  if (runState.status === "running") return { started: false, state: getAutoMergeState() };
  runState = {
    status: "running",
    apply,
    started_at: new Date().toISOString(),
    finished_at: null,
    progress: { found: 0, done: 0 },
    report: null,
    error: null,
  };
  void autoMergeDuplicates(apply, (p) => {
    runState.progress = p;
  })
    .then((report) => {
      runState = { ...runState, status: "done", report, finished_at: new Date().toISOString() };
    })
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[documents.auto-merge] run failed", { apply, error: message });
      runState = { ...runState, status: "failed", error: message, finished_at: new Date().toISOString() };
    });
  return { started: true, state: getAutoMergeState() };
}

// ─── Endpoints ──────────────────────────────────────────────────────────────

function requireAdmin(): void {
  const authData = getAuthData();
  if (!authData) throw APIError.unauthenticated("Unauthorized");
  requirePermission(authData, "module.documents");
  requirePermission(authData, "data.manage");
}

export interface AutoMergeStartRequest {
  /** When true, merge; otherwise only report (the default). */
  apply?: boolean;
}

export interface AutoMergeStartResponse {
  /** False when a run was already active; `state` then describes that one. */
  started: boolean;
  state: AutoMergeState;
}

/** `POST /documents/duplicates/auto-merge` — start a dry run or the merges. */
export const startDuplicateAutoMerge = api(
  { expose: true, method: "POST", path: "/documents/duplicates/auto-merge", auth: true },
  async (req: AutoMergeStartRequest): Promise<AutoMergeStartResponse> => {
    requireAdmin();
    return startAutoMerge(req.apply === true);
  },
);

/** `GET /documents/duplicates/auto-merge/status` — the current or last run. */
export const duplicateAutoMergeStatus = api(
  { expose: true, method: "GET", path: "/documents/duplicates/auto-merge/status", auth: true },
  async (): Promise<AutoMergeState> => {
    requireAdmin();
    return getAutoMergeState();
  },
);
