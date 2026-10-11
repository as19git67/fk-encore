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
 *   Three refinements, each from a real corpus: a scanner's counter and
 *   year in both file names (`Scan5652-Jahr_2025.pdf` beside
 *   `#5652-Jahr_2025 ….pdf`) is a provenance link like the hash and lets a
 *   pair in from `DUPLICATE_MIN_SCORE` up; the same digit runs in another
 *   order are the same numbers read column-wise; and digits only one side
 *   has are boilerplate, not content, when exactly that set turns up in
 *   `BOILERPLATE_MIN_PAIRS` pairs (a footer one rendering has as text).
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
  DUPLICATE_MIN_SCORE,
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
/** One-sided extra digit runs identical across this many pairs count as boilerplate. */
export const BOILERPLATE_MIN_PAIRS = 5;

/** Digit runs a pair needs before identical numbers alone carry it below the auto score. */
export const LOW_BAND_MIN_NUMBERS = 8;

/** What let a candidate in, for the report. */
export type AutoMergeVia = "hash" | "scan_number" | "numbers" | "numbers_low" | "order" | "boilerplate";

/** Which score band a content pair sits in: at the auto score or between DUPLICATE_MIN_SCORE and it. */
export type ScoreBand = "auto" | "low";

export type AutoMergeStage = "provenance" | "content";

export interface AutoMergeCandidate {
  stage: AutoMergeStage;
  via: AutoMergeVia;
  /** Content pairs only; null for a provenance link. */
  band: ScoreBand | null;
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
  /** For `numbers`: the digit runs only one side has, so the CSV shows what differs. */
  detail: string | null;
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
  /** Open pairs at the auto score that stage B passed on, by first failed check. */
  content_rejected: Record<ContentRejectReason, number>;
  /** The same for pairs between DUPLICATE_MIN_SCORE and the auto score. */
  content_rejected_low: Record<ContentRejectReason, number>;
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
    via: "hash",
    band: null,
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

/**
 * Do the two texts carry the same numbers? Token by token first; failing
 * that, as one digit string, because OCR splits or joins a number ("123 45"
 * against "12345") without changing a single digit — a different document
 * would have different digits, not different spacing.
 */
export function sameNumbers(na: string, nb: string): boolean {
  const ta = numberTokens(na);
  const tb = numberTokens(nb);
  if (sameSequence(ta, tb)) return true;
  return ta.join("") === tb.join("");
}

/** Which digit runs each side has that the other lacks, a few of each, for the report. */
export function numberDifference(na: string, nb: string, max = 5): string {
  const count = (tokens: string[]) => {
    const m = new Map<string, number>();
    for (const t of tokens) m.set(t, (m.get(t) ?? 0) + 1);
    return m;
  };
  const ca = count(numberTokens(na));
  const cb = count(numberTokens(nb));
  const only = (x: Map<string, number>, y: Map<string, number>) => {
    const out: string[] = [];
    for (const [t, n] of x) {
      const extra = n - (y.get(t) ?? 0);
      for (let i = 0; i < extra && out.length < max; i++) out.push(t);
    }
    return out;
  };
  const a = only(ca, cb);
  const b = only(cb, ca);
  const side = (label: string, list: string[]) => (list.length ? `${label}: ${list.join(", ")}` : null);
  return [side("A", a), side("B", b)].filter((x): x is string => x !== null).join(" | ") || "same digits, other order";
}

/**
 * The scanner's counter and the year a household's file names carry, as one
 * key: `Scan5652-Jahr_2025.pdf`, `#5652-Jahr_2025 Versicherung ….pdf` and
 * `Scan5652-Jahr_2025 2.pdf` all say "scan 5652 of 2025". Two documents
 * with the same key are the same scan stored twice; the year keeps a
 * counter that wrapped from matching across years.
 */
export function scanNumberKey(filename: string): string | null {
  const m = /(?:^|[\s_-])(?:scan|#)\s?(\d{3,6})-jahr_(\d{4})/i.exec(filename);
  return m ? `${Number(m[1])}-${m[2]}` : null;
}

/** The same digit runs, whatever their order: the numbers read column-wise. */
export function sameNumberMultiset(na: string, nb: string): boolean {
  const ta = numberTokens(na).sort();
  const tb = numberTokens(nb).sort();
  return sameSequence(ta, tb);
}

/**
 * The digit runs only one side has, when the other side has none of its
 * own — the shape of a footer one rendering carries as text. Null when both
 * sides have extras (that is content differing, not an addition).
 */
export function oneSidedExtras(na: string, nb: string): string[] | null {
  const count = (tokens: string[]) => {
    const m = new Map<string, number>();
    for (const t of tokens) m.set(t, (m.get(t) ?? 0) + 1);
    return m;
  };
  const ca = count(numberTokens(na));
  const cb = count(numberTokens(nb));
  const extras = (x: Map<string, number>, y: Map<string, number>) => {
    const out: string[] = [];
    for (const [t, n] of x) for (let i = (y.get(t) ?? 0); i < n; i++) out.push(t);
    return out.sort();
  };
  const a = extras(ca, cb);
  const b = extras(cb, ca);
  if (a.length > 0 && b.length > 0) return null;
  return a.length > 0 ? a : b;
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
export type ContentVerdict =
  | { ok: true; via: AutoMergeVia }
  | { ok: false; reason: ContentRejectReason; extras: string[] | null };

export function contentPairVerdict(a: ContentSide, b: ContentSide, score: number): ContentVerdict {
  if (a.pages_total == null || b.pages_total == null || a.pages_total !== b.pages_total) {
    return { ok: false, reason: "pages", extras: null };
  }
  const na = normalizeForSimilarity(a.extracted_text);
  const nb = normalizeForSimilarity(b.extracted_text);
  if (na.length === 0 || nb.length === 0) return { ok: false, reason: "text", extras: null };

  // The same scan stored twice: provenance, so the recorded score (at or
  // above DUPLICATE_MIN_SCORE, or the pair would not exist) is enough and
  // the numbers may differ by OCR.
  const ka = scanNumberKey(a.original_filename);
  const kb = scanNumberKey(b.original_filename);
  if (ka && kb && ka === kb) return { ok: true, via: "scan_number" };

  const same = sameNumbers(na, nb);
  const sameSet = !same && sameNumberMultiset(na, nb);
  if (!same && !sameSet) return { ok: false, reason: "numbers", extras: oneSidedExtras(na, nb) };
  if (na === nb) return { ok: true, via: "numbers" };
  const s = score >= DUPLICATE_AUTO_MIN_SCORE ? score : trigramJaccard(na, nb);
  if (s >= DUPLICATE_AUTO_MIN_SCORE) return { ok: true, via: same ? "numbers" : "order" };
  // Below the auto score identical numbers still carry the pair when there
  // are enough of them to be a fingerprint: every date, amount, account and
  // reference the same, and the text apart by OCR only.
  if (same && numberTokens(na).length >= LOW_BAND_MIN_NUMBERS) return { ok: true, via: "numbers_low" };
  return { ok: false, reason: "score", extras: null };
}

export function contentPairQualifies(a: ContentSide, b: ContentSide, score: number): boolean {
  return contentPairVerdict(a, b, score).ok;
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
  detail: string | null;
}

/**
 * Open pairs from `DUPLICATE_MIN_SCORE` up: those whose content qualifies,
 * and why the others do not, each tagged with its score band so the report
 * can tell the auto band from the one below it.
 */
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
          gte(documentDuplicateCandidates.score, DUPLICATE_MIN_SCORE - 1e-6),
        ),
      ),
  );
  const accepted: AutoMergeCandidate[] = [];
  const rejected: RejectedContentPair[] = [];
  // Number-rejected pairs whose extras sit on one side only, by that set:
  // the same set in BOILERPLATE_MIN_PAIRS pairs is a footer, not content.
  const byExtras = new Map<string, RejectedContentPair[]>();
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
    const verdict = contentPairVerdict(a, b, p.score);
    const band: ScoreBand = p.score >= DUPLICATE_AUTO_MIN_SCORE - 1e-6 ? "auto" : "low";
    const candidate: AutoMergeCandidate = {
      stage: "content",
      via: verdict.ok ? verdict.via : "numbers",
      band,
      keeper_id: keeper.id,
      loser_id: loser.id,
      keeper_filename: keeper.original_filename,
      loser_filename: loser.original_filename,
      score: p.score,
    };
    if (verdict.ok) {
      accepted.push(candidate);
      continue;
    }
    const detail =
      verdict.reason === "numbers"
        ? numberDifference(normalizeForSimilarity(a.extracted_text), normalizeForSimilarity(b.extracted_text))
        : null;
    const row: RejectedContentPair = { ...candidate, reason: verdict.reason, detail };
    rejected.push(row);
    if (verdict.reason === "numbers" && verdict.extras && verdict.extras.length > 0) {
      const key = verdict.extras.join(",");
      byExtras.set(key, [...(byExtras.get(key) ?? []), row]);
    }
  }
  const boilerplate = new Set<RejectedContentPair>();
  for (const group of byExtras.values()) {
    if (group.length < BOILERPLATE_MIN_PAIRS) continue;
    for (const r of group) {
      boilerplate.add(r);
      accepted.push({ ...r, via: "boilerplate" });
    }
  }
  return { accepted, rejected: rejected.filter((r) => !boilerplate.has(r)) };
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
    const item: AutoMergeItem = { ...c, outcome: "planned", error: null, reason: null, detail: null };
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
  const contentRejectedLow: Record<ContentRejectReason, number> = { pages: 0, numbers: 0, text: 0, score: 0 };
  for (const r of rejected) {
    (r.band === "low" ? contentRejectedLow : contentRejected)[r.reason] += 1;
    if (items.length < REPORT_ITEMS_MAX) items.push({ ...r, outcome: "rejected", error: null });
  }

  return {
    dry_run: !apply,
    provenance: counts.provenance,
    content: counts.content,
    content_rejected: contentRejected,
    content_rejected_low: contentRejectedLow,
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
