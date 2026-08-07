#!/usr/bin/env node
/**
 * Etappe 0 aus docs/auto-pick-face-relevance.md.
 *
 * Frage: Welches Signal erzeugt eigentlich den Score-Abstand Δ zwischen
 * Top-Pick und bestem Nicht-Pick — jenen Abstand, der über
 * HIGH_CONFIDENCE_DELTA entscheidet, ob eine Gruppe als "high" gilt und vom
 * Bulk-Accept ungefragt angewendet wird?
 *
 * Anlass: die Messung in diagnose-autopick-faces.mjs zeigte, dass
 * `face_sharpness` den Δ rechnerisch gar nicht erzeugen KANN — σ innerhalb
 * einer Gruppe ~0.035, mit Gewicht 0.40 also ~0.014 Beitrag, während die
 * Schwelle bei 0.10 liegt. Gleichzeitig ist das 'high'-Bucket mit 75.9 %
 * Trefferquote deutlich schlechter als der Rest (97.3 %). Also: welcher Term
 * macht den Abstand, und unterscheidet er sich zwischen Gruppen, in denen
 * die KI richtig lag, und solchen, in denen der Nutzer widersprochen hat?
 *
 * READ-ONLY. Ausschließlich SELECT-Abfragen. Report nach
 * scripts/photos/out/<datum>-autopick-delta.md.
 *
 * Es wird NICHT neu gescort: die Zerlegung nutzt ausschließlich die zur
 * Pick-Zeit gespeicherten Signale aus photo_groups.ai_pick_details. Ob die
 * dabei angesetzten Gewichte die richtigen sind, prüft Abschnitt 1 —
 * stimmt die Rekonstruktion nicht, ist der Rest nicht belastbar.
 *
 * Verbindung wie diagnose-autopick-faces.mjs (POSTGRES_CONNECTION_STRING
 * oder POSTGRES_HOST/PORT/USER/PASSWORD/DATABASE, Standard-DB `encore`).
 *
 * Aufruf:
 *   POSTGRES_DATABASE=encore node scripts/photos/diagnose-autopick-delta.mjs
 *   USER_ID=1 ... node scripts/photos/diagnose-autopick-delta.mjs
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const { Pool } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const OUT_DIR = path.join(__dirname, "out");
const TODAY = new Date().toISOString().slice(0, 10);
const OUT_FILE = path.join(OUT_DIR, `${TODAY}-autopick-delta.md`);

const ONLY_USER = process.env.USER_ID ? Number(process.env.USER_ID) : null;

function buildConnectionString() {
  const host = process.env.POSTGRES_HOST || "localhost";
  const port = process.env.POSTGRES_PORT || "5432";
  const user = process.env.POSTGRES_USER || "postgres";
  const password = process.env.POSTGRES_PASSWORD || "postgres";
  const database = process.env.POSTGRES_DATABASE || "encore";
  return `postgres://${user}:${password}@${host}:${port}/${database}`;
}
const CONNECTION_STRING =
  process.env.POSTGRES_CONNECTION_STRING || buildConnectionString();

// ── Gewichte: eine Quelle der Wahrheit ────────────────────────────────────
// Die Defaults werden aus dem TS-Quelltext gelesen statt hier dupliziert, damit
// eine spätere Änderung an scorePhoto() nicht still an dieser Auswertung
// vorbeiläuft. Per-Nutzer-Gewichte kommen aus der DB und haben Vorrang.
function parseDefaultWeights() {
  const src = fs.readFileSync(
    path.join(REPO_ROOT, "photo/group-auto-pick.ts"),
    "utf8",
  );
  const block = src.match(
    /DEFAULT_SCORING_WEIGHTS[\s\S]*?face:\s*\[([^\]]+)\][\s\S]*?non_face:\s*\[([^\]]+)\]/,
  );
  if (!block) {
    throw new Error(
      "DEFAULT_SCORING_WEIGHTS konnte nicht aus photo/group-auto-pick.ts gelesen werden",
    );
  }
  const nums = (s) => s.split(",").map((v) => Number(v.trim())).filter((v) => !Number.isNaN(v));
  return { face: nums(block[1]), non_face: nums(block[2]) };
}

// Reihenfolge MUSS zu scorePhoto() passen (siehe ScoringWeights in
// group-auto-pick.ts). Wird in Abschnitt 1 gegen die gespeicherten Scores
// validiert — eine Verschiebung würde dort sofort auffallen.
const FACE_FEATURES = [
  "face_sharpness",
  "eyes_open",
  "face_coverage",
  "face_composition",
  "blur",
  "clip_aesthetics",
  "exposure_contrast",
];
const NON_FACE_FEATURES = [
  "blur",
  "clip_aesthetics",
  "clip_composition",
  "clip_technical",
  "exposure_contrast",
];

/** Mirror von clamp01() in group-auto-pick.ts: fehlende Signale → 0.5. */
function clamp01(v, fallback = 0.5) {
  if (v == null || Number.isNaN(v)) return fallback;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

/** Feature-Vektor eines Fotos aus den gespeicherten Signalen. */
function featureValue(signals, key) {
  if (key === "exposure_contrast") {
    return 0.5 * (clamp01(signals.exposure) + clamp01(signals.contrast));
  }
  return clamp01(signals[key]);
}

// ── Markdown-Hilfen ───────────────────────────────────────────────────────
const lines = [];
const out = (s = "") => lines.push(s);
function table(headers, rows) {
  out(`| ${headers.join(" | ")} |`);
  out(`| ${headers.map(() => "---").join(" | ")} |`);
  for (const r of rows) out(`| ${r.map((c) => String(c ?? "")).join(" | ")} |`);
  out();
}
const pct = (n, d) => (d > 0 ? `${((n / d) * 100).toFixed(1)} %` : "–");
const num = (v, digits = 4) =>
  typeof v === "number" && Number.isFinite(v) ? v.toFixed(digits) : "–";
function median(values) {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
const mean = (v) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : null);

async function main() {
  const pool = new Pool({ connectionString: CONNECTION_STRING });
  const defaults = parseDefaultWeights();

  out(`# Auto-Pick: Woher kommt der Δ?`);
  out();
  out(`Erzeugt: ${new Date().toISOString()}`);
  out(`Datenbank: \`${CONNECTION_STRING.replace(/:[^:@]*@/, ":***@")}\``);
  if (ONLY_USER != null) out(`Eingeschränkt auf user_id = ${ONLY_USER}`);
  out();
  out(
    `Etappe 0 aus \`docs/auto-pick-face-relevance.md\`. Zerlegt den ` +
      `Score-Abstand zwischen Top-Pick und bestem Nicht-Pick in die Beiträge ` +
      `der einzelnen Signale — und prüft, ob sich diese Zerlegung zwischen ` +
      `richtigen und falschen Vorschlägen unterscheidet.`,
  );
  out();

  // Per-Nutzer-Gewichte (haben Vorrang vor den Defaults).
  const wRows = await pool.query(
    `SELECT user_id, weights FROM ai_pick_user_weights
     ${ONLY_USER != null ? "WHERE user_id = $1" : ""}`,
    ONLY_USER != null ? [ONLY_USER] : [],
  );
  const userWeights = new Map();
  for (const r of wRows.rows) {
    if (r.weights?.face && r.weights?.non_face) userWeights.set(r.user_id, r.weights);
  }

  const groups = await pool.query(
    `
    SELECT pg.id, pg.user_id, pg.ai_picked_photo_ids, pg.ai_picked_confidence,
           pg.ai_pick_details,
           COALESCE(
             (SELECT array_agg(gm.photo_id)
                FROM photo_group_members gm WHERE gm.group_id = pg.id),
             ARRAY[]::int[]
           ) AS member_ids,
           COALESCE(
             (SELECT array_agg(pc.photo_id)
                FROM photo_curation pc
               WHERE pc.user_id = pg.user_id
                 AND pc.status = 'hidden'
                 AND pc.photo_id IN (
                   SELECT gm2.photo_id FROM photo_group_members gm2
                    WHERE gm2.group_id = pg.id)),
             ARRAY[]::int[]
           ) AS hidden_ids
      FROM photo_groups pg
     WHERE pg.reviewed_at IS NOT NULL
       AND pg.ai_pick_details IS NOT NULL
       AND pg.ai_picked_photo_ids IS NOT NULL
       AND array_length(pg.ai_picked_photo_ids, 1) > 0
       ${ONLY_USER != null ? "AND pg.user_id = $1" : ""}
    `,
    ONLY_USER != null ? [ONLY_USER] : [],
  );

  // ── Aufbereitung ────────────────────────────────────────────────────────
  let skippedNoScores = 0;
  let skippedMixedBranch = 0;
  let skippedNoHidden = 0;
  const analysed = [];
  const reconstruction = []; // |rekonstruierter Score − gespeicherter Score|
  const deltaCheck = [];     // |rekonstruierter Δ − gespeicherter runner_up_delta|

  for (const g of groups.rows) {
    const details = g.ai_pick_details;
    const scores = details?.scores;
    if (!Array.isArray(scores) || scores.length < 2) {
      skippedNoScores++;
      continue;
    }
    const hidden = new Set(g.hidden_ids ?? []);
    // Gruppen ohne jede Ausblendung sagen nichts über richtig/falsch aus.
    if (hidden.size === 0) {
      skippedNoHidden++;
      continue;
    }
    const picked = new Set(g.ai_picked_photo_ids ?? []);

    const sorted = [...scores].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    const top = sorted[0];
    const runnerUp = sorted.find((s) => !picked.has(s.photo_id));
    if (!top || !runnerUp) {
      skippedNoScores++;
      continue;
    }
    // Unterschiedliche Zweige => unterschiedliche Signalmengen, eine
    // termweise Differenz wäre bedeutungslos.
    if (top.has_face !== runnerUp.has_face) {
      skippedMixedBranch++;
      continue;
    }

    const weights = userWeights.get(g.user_id) ?? defaults;
    const featureKeys = top.has_face ? FACE_FEATURES : NON_FACE_FEATURES;
    const w = top.has_face ? weights.face : weights.non_face;

    // Rekonstruktion des gespeicherten Scores als Plausibilitätsprüfung.
    const recompute = (s) =>
      featureKeys.reduce(
        (acc, key, i) => acc + (w[i] ?? 0) * featureValue(s.signals ?? {}, key),
        0,
      );
    reconstruction.push(Math.abs(recompute(top) - (top.score ?? 0)));

    const contributions = {};
    for (let i = 0; i < featureKeys.length; i++) {
      const key = featureKeys[i];
      contributions[key] =
        (w[i] ?? 0) *
        (featureValue(top.signals ?? {}, key) - featureValue(runnerUp.signals ?? {}, key));
    }
    const delta = (top.score ?? 0) - (runnerUp.score ?? 0);
    if (typeof details.runner_up_delta === "number") {
      deltaCheck.push(Math.abs(delta - details.runner_up_delta));
    }

    analysed.push({
      group_id: g.id,
      confidence: g.ai_picked_confidence ?? "unbekannt",
      has_face: !!top.has_face,
      delta,
      contributions,
      featureKeys,
      // Treffer = mindestens ein vorgeschlagenes Foto wurde behalten.
      hit: (g.member_ids ?? []).some((id) => picked.has(id) && !hidden.has(id)),
    });
  }

  // ── 1. Validierung der Rekonstruktion ───────────────────────────────────
  out(`## 1. Validierung: stimmen die angesetzten Gewichte?`);
  out();
  out(
    `Der Score wird aus den gespeicherten Signalen und den angesetzten ` +
      `Gewichten nachgerechnet und gegen den gespeicherten Score gehalten. ` +
      `Weichen die Werte ab, wurden die Picks mit anderen Gewichten erzeugt ` +
      `als hier angesetzt — dann ist die Zerlegung darunter nicht belastbar.`,
  );
  out();
  const recoMedian = median(reconstruction);
  const recoOk = reconstruction.filter((d) => d < 0.005).length;
  table(
    ["Gruppen zerlegt", "Median |Δ Score|", "davon < 0.005", "Median |Δ runner_up_delta|"],
    [[
      analysed.length,
      num(recoMedian),
      `${recoOk} (${pct(recoOk, reconstruction.length)})`,
      num(median(deltaCheck)),
    ]],
  );
  out(
    `Verwendete Gewichte: ` +
      (userWeights.size > 0
        ? `kalibrierte Per-Nutzer-Gewichte für ${userWeights.size} Nutzer, sonst Defaults.`
        : `Defaults aus \`photo/group-auto-pick.ts\`.`),
  );
  out();
  table(
    ["Übersprungen: keine/zu wenige scores", "gemischte Zweige", "ohne Ausblendung"],
    [[skippedNoScores, skippedMixedBranch, skippedNoHidden]],
  );

  if (analysed.length === 0) {
    out(`_Keine auswertbaren Gruppen._`);
    await pool.end();
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(OUT_FILE, lines.join("\n"), "utf8");
    console.log(lines.join("\n"));
    return;
  }

  // ── 2. Beitrag je Signal, nach Konfidenz ────────────────────────────────
  out(`## 2. Beitrag je Signal zum Δ, nach Konfidenz`);
  out();
  out(
    `Positiver Beitrag = das Signal spricht für den Pick. Die Beiträge ` +
      `summieren sich zum Δ. "Dominant" zählt, wie oft ein Signal den ` +
      `größten positiven Beitrag der Gruppe stellt.`,
  );
  out();

  const CONF_ORDER = ["high", "medium", "low", "unbekannt"];
  for (const conf of CONF_ORDER) {
    const subset = analysed.filter((a) => a.confidence === conf);
    if (subset.length === 0) continue;
    out(`### Konfidenz: ${conf} (${subset.length} Gruppen)`);
    out();
    out(`Median Δ: ${num(median(subset.map((s) => s.delta)))}`);
    out();
    const keys = [...new Set(subset.flatMap((s) => s.featureKeys))];
    const dominantCount = new Map();
    for (const a of subset) {
      let best = null;
      for (const k of a.featureKeys) {
        const v = a.contributions[k] ?? 0;
        if (best === null || v > a.contributions[best]) best = k;
      }
      if (best) dominantCount.set(best, (dominantCount.get(best) ?? 0) + 1);
    }
    table(
      ["Signal", "Median Beitrag", "Mittel Beitrag", "Anteil am Median-Δ", "dominant in"],
      keys
        .map((k) => {
          const vals = subset
            .filter((a) => a.featureKeys.includes(k))
            .map((a) => a.contributions[k] ?? 0);
          const med = median(vals);
          const medDelta = median(subset.map((s) => s.delta));
          return {
            k,
            med,
            row: [
              k,
              num(med),
              num(mean(vals)),
              medDelta && medDelta !== 0 ? `${((med / medDelta) * 100).toFixed(0)} %` : "–",
              `${dominantCount.get(k) ?? 0} (${pct(dominantCount.get(k) ?? 0, subset.length)})`,
            ],
          };
        })
        .sort((a, b) => (b.med ?? 0) - (a.med ?? 0))
        .map((e) => e.row),
    );
  }

  // ── 3. Der eigentliche Befund: richtig vs. falsch ───────────────────────
  out(`## 3. Unterscheidet sich die Zerlegung bei falschen Vorschlägen?`);
  out();
  out(
    `Nur 'high'-Gruppen — dort wendet der Bulk-Accept ungefragt an. ` +
      `Wenn ein Signal bei den Fehlgriffen systematisch stärker beiträgt als ` +
      `bei den Treffern, ist es der Verursacher des invertierten Gates.`,
  );
  out();

  const high = analysed.filter((a) => a.confidence === "high");
  if (high.length === 0) {
    out(`_Keine 'high'-Gruppen im auswertbaren Bestand._`);
    out();
  } else {
    const hits = high.filter((a) => a.hit);
    const misses = high.filter((a) => !a.hit);
    out(`Treffer: ${hits.length} · Fehlgriffe: ${misses.length}`);
    out();
    if (misses.length === 0) {
      out(`_Keine Fehlgriffe — nichts zu vergleichen._`);
      out();
    } else {
      const keys = [...new Set(high.flatMap((a) => a.featureKeys))];
      table(
        ["Signal", "Median bei Treffer", "Median bei Fehlgriff", "Differenz"],
        keys
          .map((k) => {
            const h = median(
              hits.filter((a) => a.featureKeys.includes(k)).map((a) => a.contributions[k] ?? 0),
            );
            const m = median(
              misses.filter((a) => a.featureKeys.includes(k)).map((a) => a.contributions[k] ?? 0),
            );
            const diff = h != null && m != null ? m - h : null;
            return { k, diff, row: [k, num(h), num(m), num(diff)] };
          })
          .sort((a, b) => Math.abs(b.diff ?? 0) - Math.abs(a.diff ?? 0))
          .map((e) => e.row),
      );
      out(
        `Positive Differenz = das Signal treibt den Δ bei Fehlgriffen ` +
          `stärker als bei Treffern. Der größte positive Wert ist der ` +
          `Hauptverdächtige.`,
      );
      out();
    }
  }

  // ── 4. Wie oft entscheidet ein einzelnes Signal über die Schwelle? ──────
  out(`## 4. Wie oft trägt ein Signal die Gruppe allein über die Schwelle?`);
  out();
  out(
    `HIGH_CONFIDENCE_DELTA liegt bei 0.10. Gezählt werden 'high'-Gruppen, ` +
      `deren Δ ohne den Beitrag des jeweiligen Signals unter die Schwelle ` +
      `fiele — das Signal ist dort allein für die Einstufung als "sicher" ` +
      `verantwortlich.`,
  );
  out();
  const HIGH_DELTA = 0.10;
  if (high.length > 0) {
    // Nur Gruppen, deren rekonstruierter Δ die Schwelle überhaupt erreicht,
    // können hier etwas beitragen. Weicht diese Zahl stark von der Gesamtzahl
    // der 'high'-Gruppen ab, wurde die Einstufung seinerzeit mit anderen
    // Gewichten oder einer anderen Schwelle vorgenommen — dann ist die
    // Tabelle darunter nur eingeschränkt aussagekräftig.
    const overThreshold = high.filter((a) => a.delta >= HIGH_DELTA);
    table(
      ["'high'-Gruppen gesamt", "davon Δ ≥ 0.10 (hier auswertbar)"],
      [[high.length, `${overThreshold.length} (${pct(overThreshold.length, high.length)})`]],
    );
    if (overThreshold.length < high.length) {
      out(
        `⚠️ ${high.length - overThreshold.length} als 'high' gespeicherte ` +
          `Gruppen erreichen mit der hier nachgerechneten Formel die Schwelle ` +
          `nicht. Mögliche Ursachen: die Picks entstanden unter anderen ` +
          `Gewichten, oder die Schwelle wurde seither geändert. Abschnitt 1 ` +
          `zeigt, ob die Rekonstruktion generell stimmt.`,
      );
      out();
    }
    if (overThreshold.length > 0) {
      const keys = [...new Set(overThreshold.flatMap((a) => a.featureKeys))];
      table(
        ["Signal", "entscheidend in", "davon Fehlgriffe"],
        keys
          .map((k) => {
            const decisive = overThreshold.filter(
              (a) =>
                a.featureKeys.includes(k) &&
                a.delta - (a.contributions[k] ?? 0) < HIGH_DELTA,
            );
            return {
              k,
              n: decisive.length,
              row: [
                k,
                `${decisive.length} (${pct(decisive.length, overThreshold.length)})`,
                `${decisive.filter((a) => !a.hit).length}`,
              ],
            };
          })
          .sort((a, b) => b.n - a.n)
          .map((e) => e.row),
      );
    }
  }

  out(`## Wie daraus eine Entscheidung wird`);
  out();
  out(
    `Zeigt Abschnitt 3 ein Signal mit klar positiver Differenz und ` +
      `bestätigt Abschnitt 4, dass genau dieses Signal die Gruppen über die ` +
      `Schwelle trägt, ist die Ursache des invertierten Gates gefunden — ` +
      `dann ist der Fix eine gezielte Änderung an diesem einen Term, nicht ` +
      `der große Umbau. Verteilen sich die Beiträge dagegen gleichmäßig, ` +
      `ist nicht ein Signal schuld, sondern die Schwelle selbst zu niedrig ` +
      `angesetzt.`,
  );
  out();

  await pool.end();
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_FILE, lines.join("\n"), "utf8");
  console.log(`Report geschrieben: ${OUT_FILE}`);
  console.log();
  console.log(lines.join("\n"));
}

main().catch((err) => {
  console.error("Diagnose fehlgeschlagen:", err);
  process.exitCode = 1;
});
