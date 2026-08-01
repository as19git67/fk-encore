/**
 * Taxonomy KPI Cockpit: daily snapshot cron + admin API.
 *
 * The cron captures lightweight SQL metrics every day at 04:30 UTC and
 * persists them in `taxonomy_snapshots`. The admin endpoint serves the
 * last N snapshots so the frontend can render trend charts and actionable
 * recommendations (when to run cloud-audit, cloud-teacher, etc.).
 */

import { api } from "encore.dev/api";
import { eq, sql, desc, and, count as drizzleCount } from "drizzle-orm";
import { dailyAtUtc, schedule } from "../lib/local-cron";
import db from "../db/database";
import {
  documents,
  documentCategories,
  documentCategorySuggestions,
  taxonomySnapshots,
} from "../db/schema";

// ─── Snapshot capture ────────────────────────────────────────────────────────

export interface TaxonomySnapshot {
  snapshot_date: string;
  total_documents: number;
  classified_documents: number;
  sonstiges_count: number;
  sonstiges_pct: number;
  avg_confidence: number | null;
  low_confidence_count: number;
  teacher_requested_count: number;
  open_suggestions_count: number;
  category_count: number;
}

async function captureSnapshot(): Promise<TaxonomySnapshot> {
  const today = new Date().toISOString().slice(0, 10);

  const [totals] = await db
    .select({
      total: sql<number>`count(*)::int`,
      classified: sql<number>`count(*) FILTER (WHERE ${documents.category_id} IS NOT NULL)::int`,
      avg_conf: sql<number>`avg(${documents.classification_confidence})::float`,
      low_conf: sql<number>`count(*) FILTER (WHERE ${documents.classification_confidence} < 0.5)::int`,
      teacher_requested: sql<number>`count(*) FILTER (WHERE ${documents.teacher_requested} = true)::int`,
    })
    .from(documents);

  const sonstigesRow = await db
    .select({ id: documentCategories.id })
    .from(documentCategories)
    .where(eq(documentCategories.slug, "sonstiges"))
    .limit(1);

  let sonstigesCount = 0;
  if (sonstigesRow.length > 0) {
    const [r] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(documents)
      .where(eq(documents.category_id, sonstigesRow[0]!.id));
    sonstigesCount = r?.n ?? 0;
  }

  const [suggestionsRow] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(documentCategorySuggestions)
    .where(eq(documentCategorySuggestions.status, "open"));

  const [catCountRow] = await db
    .select({ n: sql<number>`count(DISTINCT ${documents.category_id})::int` })
    .from(documents)
    .where(sql`${documents.category_id} IS NOT NULL`);

  const total = totals?.total ?? 0;
  const sonstigesPct = total > 0 ? (sonstigesCount / total) * 100 : 0;

  const snapshot: TaxonomySnapshot = {
    snapshot_date: today,
    total_documents: total,
    classified_documents: totals?.classified ?? 0,
    sonstiges_count: sonstigesCount,
    sonstiges_pct: Math.round(sonstigesPct * 10) / 10,
    avg_confidence: totals?.avg_conf != null ? Math.round(totals.avg_conf * 1000) / 1000 : null,
    low_confidence_count: totals?.low_conf ?? 0,
    teacher_requested_count: totals?.teacher_requested ?? 0,
    open_suggestions_count: suggestionsRow?.n ?? 0,
    category_count: catCountRow?.n ?? 0,
  };

  await db
    .insert(taxonomySnapshots)
    .values({
      snapshot_date: snapshot.snapshot_date,
      total_documents: snapshot.total_documents,
      classified_documents: snapshot.classified_documents,
      sonstiges_count: snapshot.sonstiges_count,
      sonstiges_pct: snapshot.sonstiges_pct,
      avg_confidence: snapshot.avg_confidence,
      low_confidence_count: snapshot.low_confidence_count,
      teacher_requested_count: snapshot.teacher_requested_count,
      open_suggestions_count: snapshot.open_suggestions_count,
      category_count: snapshot.category_count,
    })
    .onConflictDoUpdate({
      target: taxonomySnapshots.snapshot_date,
      set: {
        total_documents: snapshot.total_documents,
        classified_documents: snapshot.classified_documents,
        sonstiges_count: snapshot.sonstiges_count,
        sonstiges_pct: snapshot.sonstiges_pct,
        avg_confidence: snapshot.avg_confidence,
        low_confidence_count: snapshot.low_confidence_count,
        teacher_requested_count: snapshot.teacher_requested_count,
        open_suggestions_count: snapshot.open_suggestions_count,
        category_count: snapshot.category_count,
      },
    });

  return snapshot;
}

// ─── Cron endpoint ───────────────────────────────────────────────────────────

export const runTaxonomyCockpit = api(
  { expose: false, method: "POST", path: "/internal/documents/taxonomy-cockpit" },
  async (): Promise<TaxonomySnapshot> => {
    return await captureSnapshot();
  },
);

// 11:00 Berlin (CEST) / 09:00 UTC — part of the 10–13 Uhr batch window.
schedule({
  name: "documents-taxonomy-cockpit",
  description: "Capture daily taxonomy health snapshot for the KPI cockpit",
  service: "documents",
  scheduleLabel: "daily 09:00 UTC",
  nextFire: dailyAtUtc(9, 0),
  run: () => runTaxonomyCockpit(),
});

// ─── Admin API ───────────────────────────────────────────────────────────────

export interface CockpitResponse {
  snapshots: TaxonomySnapshot[];
  recommendations: Recommendation[];
}

export interface Recommendation {
  severity: "info" | "warning" | "critical";
  action: string;
  reason: string;
}

export const getTaxonomyCockpit = api(
  { expose: true, auth: true, method: "GET", path: "/admin/taxonomy-cockpit" },
  async (): Promise<CockpitResponse> => {
    const rows = await db
      .select()
      .from(taxonomySnapshots)
      .orderBy(desc(taxonomySnapshots.snapshot_date))
      .limit(90);

    const snapshots: TaxonomySnapshot[] = rows.map((r) => ({
      snapshot_date: r.snapshot_date,
      total_documents: r.total_documents,
      classified_documents: r.classified_documents,
      sonstiges_count: r.sonstiges_count,
      sonstiges_pct: r.sonstiges_pct,
      avg_confidence: r.avg_confidence,
      low_confidence_count: r.low_confidence_count,
      teacher_requested_count: r.teacher_requested_count,
      open_suggestions_count: r.open_suggestions_count,
      category_count: r.category_count,
    }));

    const recommendations = computeRecommendations(snapshots);
    return { snapshots, recommendations };
  },
);

export const triggerSnapshot = api(
  { expose: true, auth: true, method: "POST", path: "/admin/taxonomy-cockpit/snapshot" },
  async (): Promise<TaxonomySnapshot> => {
    return await captureSnapshot();
  },
);

// ─── Recommendation engine ───────────────────────────────────────────────────

function computeRecommendations(snapshots: TaxonomySnapshot[]): Recommendation[] {
  if (snapshots.length === 0) return [];
  const latest = snapshots[0]!;
  const recs: Recommendation[] = [];

  // Sonstiges quota
  if (latest.sonstiges_pct > 8) {
    recs.push({
      severity: "critical",
      action: "Cloud-Audit starten",
      reason: `Sonstiges-Quote bei ${latest.sonstiges_pct}% — deutet auf Taxonomie-Lücken hin. Ein Audit identifiziert fehlende Kategorien.`,
    });
  } else if (latest.sonstiges_pct > 5) {
    recs.push({
      severity: "warning",
      action: "Cloud-Audit empfohlen",
      reason: `Sonstiges-Quote bei ${latest.sonstiges_pct}% — leicht erhöht. Ein Audit kann potenzielle neue Kategorien aufdecken.`,
    });
  }

  // Teacher-requested backlog
  if (latest.teacher_requested_count > 10) {
    recs.push({
      severity: "warning",
      action: "Cloud-Teacher starten",
      reason: `${latest.teacher_requested_count} Dokumente sind für den Cloud-Teacher vorgemerkt.`,
    });
  } else if (latest.teacher_requested_count > 0) {
    recs.push({
      severity: "info",
      action: "Cloud-Teacher steht an",
      reason: `${latest.teacher_requested_count} vorgemerkte Dokumente warten auf den nächsten Teacher-Lauf.`,
    });
  }

  // Open suggestions
  if (latest.open_suggestions_count > 5) {
    recs.push({
      severity: "warning",
      action: "Kategorie-Vorschläge prüfen",
      reason: `${latest.open_suggestions_count} offene Vorschläge warten auf Bearbeitung.`,
    });
  } else if (latest.open_suggestions_count > 0) {
    recs.push({
      severity: "info",
      action: "Kategorie-Vorschläge vorhanden",
      reason: `${latest.open_suggestions_count} Vorschläge zur Prüfung bereit.`,
    });
  }

  // Low confidence
  if (latest.total_documents > 0) {
    const lowPct = (latest.low_confidence_count / latest.total_documents) * 100;
    if (lowPct > 15) {
      recs.push({
        severity: "warning",
        action: "Cloud-Teacher für Niedrig-Confidence",
        reason: `${latest.low_confidence_count} Dokumente (${lowPct.toFixed(1)}%) haben Confidence < 0.5 — ein Teacher-Lauf verbessert diese.`,
      });
    }
  }

  // Trend detection (sonstiges growing over last 7 days)
  if (snapshots.length >= 7) {
    const weekAgo = snapshots[6];
    if (weekAgo && latest.sonstiges_pct - weekAgo.sonstiges_pct > 1.5) {
      recs.push({
        severity: "warning",
        action: "Sonstiges wächst",
        reason: `Sonstiges-Quote stieg von ${weekAgo.sonstiges_pct}% auf ${latest.sonstiges_pct}% in 7 Tagen — Taxonomie prüfen.`,
      });
    }
  }

  // Confidence trend (dropping)
  if (snapshots.length >= 7) {
    const weekAgo = snapshots[6];
    if (weekAgo?.avg_confidence != null && latest.avg_confidence != null) {
      if (weekAgo.avg_confidence - latest.avg_confidence > 0.03) {
        recs.push({
          severity: "info",
          action: "Confidence sinkt",
          reason: `Durchschnittliche Confidence fiel von ${weekAgo.avg_confidence.toFixed(3)} auf ${latest.avg_confidence.toFixed(3)} in 7 Tagen.`,
        });
      }
    }
  }

  return recs;
}
