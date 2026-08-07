#!/usr/bin/env node
/**
 * Etappe 0b aus docs/auto-pick-face-relevance.md.
 *
 * Frage: Sagt die GRÖSSE des Score-Abstands Δ überhaupt etwas über die
 * Trefferwahrscheinlichkeit aus?
 *
 * Anlass: Etappe 0 (diagnose-autopick-delta.mjs) hat gezeigt, dass kein
 * einzelnes Signal die Fehlgriffe im 'high'-Bucket erklärt — die größte
 * Differenz zwischen Treffern und Fehlgriffen lag bei 0.0092 gegenüber einem
 * Median-Δ von 0.1661. Damit rückt die Schwelle selbst in den Verdacht: nicht
 * "ein Term ist kaputt", sondern "Δ misst nicht, was es zu messen vorgibt".
 *
 * Kernmessung ist der LIFT über einer Zufallsbasislinie, nicht die nackte
 * Trefferquote. Grund: eine Gruppe aus 2 Fotos, von denen der Nutzer eines
 * behält, trifft man zu 50 % durch Raten; eine Gruppe aus 5 Fotos, von denen
 * er 4 behält, zu 80 %. Ohne diese Korrektur vergleicht man Bins, die
 * unterschiedlich leicht sind, und liest Struktur, wo keine ist.
 *
 *   Basislinie (Hypergeometrisch) = 1 - C(hidden, picks) / C(members, picks)
 *   = Wahrscheinlichkeit, dass ein zufälliger Pick derselben Größe
 *     mindestens ein behaltenes Foto erwischt.
 *
 * Verwendet wird der GESPEICHERTE Δ (`ai_pick_details.runner_up_delta`), denn
 * das ist die Größe, die seinerzeit tatsächlich über die Einstufung
 * entschieden hat — nicht eine Nachrechnung mit heutigen Gewichten.
 * Abschnitt 3 wiederholt die Messung auf der Teilmenge, deren Score sich mit
 * den heutigen Gewichten exakt reproduzieren lässt (in Etappe 0 waren das nur
 * 58,2 %), als Robustheitsprüfung.
 *
 * READ-ONLY. Report nach scripts/photos/out/<datum>-autopick-calibration.md.
 *
 * Aufruf:
 *   POSTGRES_DATABASE=encore node scripts/photos/diagnose-autopick-calibration.mjs
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
const OUT_FILE = path.join(OUT_DIR, `${TODAY}-autopick-calibration.md`);

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

// ── Gewichte (nur für die Validierungs-Teilmenge in Abschnitt 3) ──────────
function parseDefaultWeights() {
  const src = fs.readFileSync(path.join(REPO_ROOT, "photo/group-auto-pick.ts"), "utf8");
  const block = src.match(
    /DEFAULT_SCORING_WEIGHTS[\s\S]*?face:\s*\[([^\]]+)\][\s\S]*?non_face:\s*\[([^\]]+)\]/,
  );
  if (!block) throw new Error("DEFAULT_SCORING_WEIGHTS nicht lesbar");
  const nums = (s) => s.split(",").map((v) => Number(v.trim())).filter((v) => !Number.isNaN(v));
  return { face: nums(block[1]), non_face: nums(block[2]) };
}
const FACE_FEATURES = ["face_sharpness","eyes_open","face_coverage","face_composition","blur","clip_aesthetics","exposure_contrast"];
const NON_FACE_FEATURES = ["blur","clip_aesthetics","clip_composition","clip_technical","exposure_contrast"];
const clamp01 = (v, f = 0.5) => (v == null || Number.isNaN(v) ? f : v < 0 ? 0 : v > 1 ? 1 : v);
const featureValue = (sig, key) =>
  key === "exposure_contrast"
    ? 0.5 * (clamp01(sig.exposure) + clamp01(sig.contrast))
    : clamp01(sig[key]);

// ── Kombinatorik für die Zufallsbasislinie ────────────────────────────────
function binomial(n, k) {
  if (k < 0 || k > n) return 0;
  let r = 1;
  for (let i = 0; i < k; i++) r = (r * (n - i)) / (i + 1);
  return r;
}
/**
 * Wahrscheinlichkeit, dass ein zufälliger Pick von `picks` aus `members`
 * Fotos mindestens ein vom Nutzer behaltenes Foto trifft.
 */
function randomBaseline(members, hidden, picks) {
  if (members <= 0 || picks <= 0) return null;
  const p = Math.min(picks, members);
  if (hidden < p) return 1; // zu wenige ausgeblendete Fotos für einen Fehlgriff
  const denom = binomial(members, p);
  if (denom === 0) return null;
  return 1 - binomial(hidden, p) / denom;
}

// ── Markdown ──────────────────────────────────────────────────────────────
const lines = [];
const out = (s = "") => lines.push(s);
function table(headers, rows) {
  out(`| ${headers.join(" | ")} |`);
  out(`| ${headers.map(() => "---").join(" | ")} |`);
  for (const r of rows) out(`| ${r.map((c) => String(c ?? "")).join(" | ")} |`);
  out();
}
const num = (v, d = 3) => (typeof v === "number" && Number.isFinite(v) ? v.toFixed(d) : "–");
const pctOf = (v) => (typeof v === "number" && Number.isFinite(v) ? `${(v * 100).toFixed(1)} %` : "–");
const mean = (v) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : null);

// Bins um die 0.10-Schwelle herum verfeinert.
const BINS = [
  { label: "0.00 – 0.02", lo: 0, hi: 0.02 },
  { label: "0.02 – 0.04", lo: 0.02, hi: 0.04 },
  { label: "0.04 – 0.06", lo: 0.04, hi: 0.06 },
  { label: "0.06 – 0.10", lo: 0.06, hi: 0.10 },
  { label: "0.10 – 0.15  ← ab hier 'high'", lo: 0.10, hi: 0.15 },
  { label: "0.15 – 0.25", lo: 0.15, hi: 0.25 },
  { label: "0.25 +", lo: 0.25, hi: Infinity },
];

function binFor(delta) {
  return BINS.find((b) => delta >= b.lo && delta < b.hi) ?? null;
}

/** Auswertung einer Gruppenmenge zu einer Bin-Tabelle. */
function buildBinTable(groups) {
  return BINS.map((bin) => {
    const subset = groups.filter((g) => binFor(g.delta) === bin);
    if (subset.length === 0) {
      return [bin.label, 0, "–", "–", "–", "–"];
    }
    const hits = subset.filter((g) => g.hit).length;
    const rate = hits / subset.length;
    const baselines = subset.map((g) => g.baseline).filter((b) => b != null);
    const base = mean(baselines);
    const lift = base != null ? rate - base : null;
    return [
      bin.label,
      subset.length,
      pctOf(rate),
      pctOf(base),
      lift != null ? `${lift >= 0 ? "+" : ""}${(lift * 100).toFixed(1)} pp` : "–",
      num(mean(subset.map((g) => g.delta))),
    ];
  });
}

async function main() {
  const pool = new Pool({ connectionString: CONNECTION_STRING });
  const defaults = parseDefaultWeights();

  out(`# Auto-Pick: Sagt die Größe des Δ die Trefferquote voraus?`);
  out();
  out(`Erzeugt: ${new Date().toISOString()}`);
  out(`Datenbank: \`${CONNECTION_STRING.replace(/:[^:@]*@/, ":***@")}\``);
  if (ONLY_USER != null) out(`Eingeschränkt auf user_id = ${ONLY_USER}`);
  out();
  out(
    `Etappe 0b. Etappe 0 fand keinen einzelnen Term, der die Fehlgriffe im ` +
      `'high'-Bucket erklärt. Damit steht die Schwelle selbst zur Prüfung: ` +
      `steigt die Trefferwahrscheinlichkeit überhaupt mit dem Δ?`,
  );
  out();
  out(
    `**Gemessen wird der Lift über einer Zufallsbasislinie**, nicht die nackte ` +
      `Trefferquote. Eine Gruppe aus 2 Fotos mit einem behaltenen trifft man ` +
      `zu 50 % durch Raten, eine aus 5 Fotos mit 4 behaltenen zu 80 % — ohne ` +
      `diese Korrektur vergleicht man unterschiedlich schwere Bins.`,
  );
  out();

  const wRows = await pool.query(
    `SELECT user_id, weights FROM ai_pick_user_weights ${ONLY_USER != null ? "WHERE user_id = $1" : ""}`,
    ONLY_USER != null ? [ONLY_USER] : [],
  );
  const userWeights = new Map();
  for (const r of wRows.rows) if (r.weights?.face) userWeights.set(r.user_id, r.weights);

  const res = await pool.query(
    `
    SELECT pg.id, pg.user_id, pg.ai_picked_photo_ids, pg.ai_picked_confidence,
           pg.ai_pick_details,
           (SELECT COUNT(*)::int FROM photo_group_members gm WHERE gm.group_id = pg.id) AS members,
           (SELECT COUNT(*)::int FROM photo_group_members gm
              JOIN photo_curation pc ON pc.photo_id = gm.photo_id AND pc.user_id = pg.user_id
             WHERE gm.group_id = pg.id AND pc.status = 'hidden') AS hidden,
           (SELECT COUNT(*)::int FROM photo_group_members gm
             WHERE gm.group_id = pg.id
               AND gm.photo_id = ANY(pg.ai_picked_photo_ids)
               AND NOT EXISTS (
                 SELECT 1 FROM photo_curation pc
                  WHERE pc.photo_id = gm.photo_id AND pc.user_id = pg.user_id
                    AND pc.status = 'hidden')) AS picked_kept
      FROM photo_groups pg
     WHERE pg.reviewed_at IS NOT NULL
       AND pg.ai_pick_details IS NOT NULL
       AND pg.ai_picked_photo_ids IS NOT NULL
       AND array_length(pg.ai_picked_photo_ids, 1) > 0
       ${ONLY_USER != null ? "AND pg.user_id = $1" : ""}
    `,
    ONLY_USER != null ? [ONLY_USER] : [],
  );

  const groups = [];
  let skippedNoDelta = 0;
  let skippedNoHidden = 0;

  for (const r of res.rows) {
    const details = r.ai_pick_details;
    // Der gespeicherte Δ ist die operative Größe — er hat die Einstufung
    // erzeugt. Nur wenn er fehlt, aus den gespeicherten Scores ableiten.
    let delta = typeof details?.runner_up_delta === "number" ? details.runner_up_delta : null;
    const scores = Array.isArray(details?.scores) ? details.scores : [];
    if (delta == null && scores.length >= 2) {
      const picked = new Set(r.ai_picked_photo_ids ?? []);
      const sorted = [...scores].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
      const runnerUp = sorted.find((s) => !picked.has(s.photo_id));
      if (sorted[0] && runnerUp) delta = (sorted[0].score ?? 0) - (runnerUp.score ?? 0);
    }
    if (delta == null || !Number.isFinite(delta) || delta < 0) {
      skippedNoDelta++;
      continue;
    }
    // Ohne Ausblendung ist jeder Pick trivial ein Treffer.
    if ((r.hidden ?? 0) === 0) {
      skippedNoHidden++;
      continue;
    }

    const picks = (r.ai_picked_photo_ids ?? []).length;
    const baseline = randomBaseline(r.members, r.hidden, picks);

    // Reproduzierbarkeit mit heutigen Gewichten (für Abschnitt 3).
    let reproducible = false;
    if (scores.length >= 2) {
      const weights = userWeights.get(r.user_id) ?? defaults;
      const top = [...scores].sort((a, b) => (b.score ?? 0) - (a.score ?? 0))[0];
      const keys = top.has_face ? FACE_FEATURES : NON_FACE_FEATURES;
      const w = top.has_face ? weights.face : weights.non_face;
      const recomputed = keys.reduce(
        (acc, k, i) => acc + (w[i] ?? 0) * featureValue(top.signals ?? {}, k),
        0,
      );
      reproducible = Math.abs(recomputed - (top.score ?? 0)) < 0.005;
    }

    groups.push({
      delta,
      hit: (r.picked_kept ?? 0) > 0,
      baseline,
      confidence: r.ai_picked_confidence ?? "unbekannt",
      members: r.members,
      hidden: r.hidden,
      picks,
      reproducible,
    });
  }

  out(`## 1. Umfang`);
  out();
  table(
    ["auswertbare Gruppen", "übersprungen: kein Δ", "übersprungen: nichts ausgeblendet"],
    [[groups.length, skippedNoDelta, skippedNoHidden]],
  );

  if (groups.length === 0) {
    out(`_Keine auswertbaren Gruppen._`);
    await pool.end();
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(OUT_FILE, lines.join("\n"), "utf8");
    console.log(lines.join("\n"));
    return;
  }

  const overallRate = groups.filter((g) => g.hit).length / groups.length;
  const overallBase = mean(groups.map((g) => g.baseline).filter((b) => b != null));
  table(
    ["Trefferquote gesamt", "Zufallsbasislinie", "Lift"],
    [[
      pctOf(overallRate),
      pctOf(overallBase),
      overallBase != null
        ? `${overallRate - overallBase >= 0 ? "+" : ""}${((overallRate - overallBase) * 100).toFixed(1)} pp`
        : "–",
    ]],
  );
  out(
    `Der Lift gesamt ist der Maßstab: so viel besser als Raten ist das ` +
      `Modell überhaupt. Alles Weitere fragt, ob sich dieser Vorsprung mit ` +
      `steigendem Δ vergrößert.`,
  );
  out();

  // ── 2. Kernmessung ──────────────────────────────────────────────────────
  out(`## 2. Trefferquote nach Δ-Größe (Kernmessung)`);
  out();
  table(
    ["Δ-Bereich", "Gruppen", "Trefferquote", "Zufallsbasislinie", "Lift", "Median Δ"],
    buildBinTable(groups),
  );
  out(
    `**Lesart:** steigt der Lift mit dem Δ, ist die Schwelle als Mechanismus ` +
      `in Ordnung und nur die Höhe zu diskutieren. Bleibt er flach oder fällt ` +
      `er, misst der Δ keine Trefferwahrscheinlichkeit — dann hilft es nicht, ` +
      `die Schwelle zu verschieben, weil oberhalb wie unterhalb dasselbe ` +
      `Rauschen liegt.`,
  );
  out();

  // ── 3. Robustheitsprüfung ───────────────────────────────────────────────
  out(`## 3. Robustheit: nur exakt reproduzierbare Gruppen`);
  out();
  const repro = groups.filter((g) => g.reproducible);
  out(
    `In Etappe 0 ließen sich nur 58,2 % der gespeicherten Scores mit den ` +
      `heutigen Gewichten exakt nachrechnen — ältere Gruppen tragen die ` +
      `Scores einer früheren Formelversion. Hier dieselbe Messung nur auf ` +
      `den reproduzierbaren Gruppen (${repro.length} von ${groups.length}). ` +
      `Zeigt sich dasselbe Bild, ist der Befund unabhängig davon.`,
  );
  out();
  if (repro.length === 0) {
    out(`_Keine reproduzierbaren Gruppen._`);
    out();
  } else {
    table(
      ["Δ-Bereich", "Gruppen", "Trefferquote", "Zufallsbasislinie", "Lift", "Median Δ"],
      buildBinTable(repro),
    );
  }

  // ── 4. Gruppenzusammensetzung je Bin ────────────────────────────────────
  out(`## 4. Sind die Bins überhaupt vergleichbar?`);
  out();
  out(
    `Falls große Δ vorwiegend in kleinen Gruppen auftreten (oder umgekehrt), ` +
      `vergleicht Abschnitt 2 unterschiedliche Situationen. Die Basislinie ` +
      `korrigiert das rechnerisch, aber sichtbar sollte es trotzdem sein.`,
  );
  out();
  table(
    ["Δ-Bereich", "Gruppen", "Ø Mitglieder", "Ø ausgeblendet", "Ø Picks"],
    BINS.map((bin) => {
      const s = groups.filter((g) => binFor(g.delta) === bin);
      if (s.length === 0) return [bin.label, 0, "–", "–", "–"];
      return [
        bin.label,
        s.length,
        num(mean(s.map((g) => g.members)), 1),
        num(mean(s.map((g) => g.hidden)), 1),
        num(mean(s.map((g) => g.picks)), 2),
      ];
    }),
  );

  // ── 5. Konfidenz-Buckets zur Gegenprobe ─────────────────────────────────
  out(`## 5. Gegenprobe: dieselbe Rechnung nach Konfidenz-Bucket`);
  out();
  table(
    ["Konfidenz", "Gruppen", "Trefferquote", "Zufallsbasislinie", "Lift"],
    ["high", "medium", "low", "unbekannt"]
      .map((conf) => {
        const s = groups.filter((g) => g.confidence === conf);
        if (s.length === 0) return null;
        const rate = s.filter((g) => g.hit).length / s.length;
        const base = mean(s.map((g) => g.baseline).filter((b) => b != null));
        return [
          conf,
          s.length,
          pctOf(rate),
          pctOf(base),
          base != null ? `${rate - base >= 0 ? "+" : ""}${((rate - base) * 100).toFixed(1)} pp` : "–",
        ];
      })
      .filter(Boolean),
  );
  out(
    `Die zuvor gemessene Inversion (high 75,9 % gegen 97,3 % sonst) könnte ` +
      `auch daher rühren, dass 'high'-Gruppen schlicht schwerer sind — etwa ` +
      `weil dort mehr ausgeblendet wird. Erst der Lift trennt "schwerer" von ` +
      `"schlechter vorhergesagt".`,
  );
  out();

  out(`## Wie daraus eine Entscheidung wird`);
  out();
  out(
    `1. **Lift steigt mit Δ** → der Mechanismus taugt, nur die Schwelle sitzt ` +
      `zu niedrig. Fix: HIGH_CONFIDENCE_DELTA anheben, fertig.`,
  );
  out(
    `2. **Lift flach oder fallend** → Δ trägt keine Information über ` +
      `Trefferwahrscheinlichkeit. Eine höhere Schwelle würde nur weniger ` +
      `Gruppen auto-akzeptieren, ohne dass die verbleibenden zuverlässiger ` +
      `wären. Dann muss der Auto-Accept vom Δ entkoppelt werden, und die ` +
      `Verbesserung muss aus besseren Signalen kommen (Etappe 2).`,
  );
  out(
    `3. **Lift gesamt nahe null** → das Modell ist insgesamt kaum besser als ` +
      `Raten, und keine Schwelle rettet das.`,
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
