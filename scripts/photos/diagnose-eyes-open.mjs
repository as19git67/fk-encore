#!/usr/bin/env node
/**
 * Augen offen: trifft die Messung aus den Gesichtslandmarken die
 * Entscheidungen des Nutzers besser als der CLIP-Wert?
 * (Etappe 5 aus documentation/auto-pick-face-relevance.md)
 *
 * Heute: `eyes_open` in `photos.ai_quality_details` — CLIP-Zero-Shot auf
 * jedem Gesichtsausschnitt, Minimum über alle Gesichter.
 * Neu: `faces.eye_aspect` (106-Punkte-Modell) und `faces.eye_aspect_68`
 * (68-Punkte-Modell), je Foto prominenzgewichtet gemittelt wie die
 * Gesichtsschärfe in diagnose-face-sharpness-variance.mjs.
 * Dazu der Mund (Migration 0273): `mouth_lift` / `mouth_width` je Modell als
 * Ersatz für ein Lächeln. Dafür gibt es kein heutiges Signal; Maßstab ist
 * der Zufall (Abschnitt 3b).
 *
 * Gemessen wird paarweise in geprüften Gruppen: ein behaltenes gegen ein
 * ausgeblendetes Foto. Ein Signal „entscheidet" ein Paar, wenn sich seine
 * Werte um mehr als EPS unterscheiden, und „trifft", wenn das behaltene Foto
 * den höheren Wert hat. Verglichen wird auf denselben Paaren, sonst rechnen
 * die Signale auf verschieden schweren Mengen.
 *
 * Die Augen sind nur ein Grund unter vielen, ein Foto auszublenden. Eine
 * Trefferquote um 50 % heißt deshalb nicht „Signal wertlos", sondern „in
 * diesen Paaren nicht ausschlaggebend". Aussagekräftig ist der Unterschied
 * zwischen den Signalen und die Quote bei großen Unterschieden.
 *
 * Voraussetzung: der Backfill „Gesichtslandmarken nachtragen" (Fotos ›
 * Einstellungen › Wartung, `POST /photos/backfill-face-landmarks`) ist durch.
 *
 * READ-ONLY. Ausschließlich SELECT-Abfragen. Report nach
 * scripts/photos/out/<datum>-eyes-open.md.
 *
 * Aufruf:
 *   POSTGRES_DATABASE=encore node scripts/photos/diagnose-eyes-open.mjs
 *   USER_ID=1 ... node scripts/photos/diagnose-eyes-open.mjs
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
const OUT_FILE = path.join(OUT_DIR, `${TODAY}-eyes-open.md`);

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

// Konstanten aus dem TS-Quelltext statt hier dupliziert.
function readConst(file, name) {
  const src = fs.readFileSync(path.join(REPO_ROOT, file), "utf8");
  const m = src.match(new RegExp(`export const ${name} = ([0-9.]+)`));
  if (!m) throw new Error(`${name} konnte nicht aus ${file} gelesen werden`);
  return Number(m[1]);
}
const PROM = {
  floor: readConst("photo/group-auto-pick.ts", "PROMINENCE_FLOOR"),
  saturation: readConst("photo/group-auto-pick.ts", "PROMINENCE_SATURATION"),
  knownBonus: readConst("photo/group-auto-pick.ts", "KNOWN_BONUS"),
};
const MIN_EYE_FACE_PIXELS = readConst("photo/face-eyes.ts", "MIN_EYE_FACE_PIXELS");

/** Mirror von computeFaceProminence() in photo/group-auto-pick.ts. */
function faceProminence(area, known) {
  if (area < PROM.floor) return 0;
  return (Math.min(area, PROM.saturation) / PROM.saturation) * (1 + (known ? PROM.knownBonus : 0));
}

/** Unterschied, ab dem ein Signal ein Paar „entscheidet". */
const EPS = 0.01;

const SIGNALS = [
  { key: "clip", label: "CLIP `eyes_open` (heute, Minimum)" },
  { key: "g106", label: "Landmarken 106 (`eye_aspect`, gewichtet)" },
  { key: "g68", label: "Landmarken 68 (`eye_aspect_68`, gewichtet)" },
];

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
const num = (v, digits = 3) =>
  typeof v === "number" && Number.isFinite(v) ? v.toFixed(digits) : "–";
function median(values) {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

async function main() {
  const pool = new Pool({ connectionString: CONNECTION_STRING });
  const userFilter = ONLY_USER != null ? [ONLY_USER] : [];

  out(`# Augen offen und Lächeln: Landmarken an den Nutzerentscheidungen`);
  out();
  out(`Erzeugt: ${new Date().toISOString()}`);
  out(`Datenbank: \`${CONNECTION_STRING.replace(/:[^:@]*@/, ":***@")}\``);
  if (ONLY_USER != null) out(`Eingeschränkt auf user_id = ${ONLY_USER}`);
  out();

  // ── 1. Abdeckung ────────────────────────────────────────────────────────
  const cov = (
    await pool.query(
      `
      SELECT COUNT(*)::int AS total,
             COUNT(f.landmarks)::int AS with_landmarks,
             COUNT(f.eye_aspect)::int AS with_106,
             COUNT(f.eye_aspect_68)::int AS with_68,
             COUNT(*) FILTER (
               WHERE p.width IS NOT NULL
                 AND COALESCE(((f.bbox)::jsonb->>'width')::float, 0) * p.width >= ${MIN_EYE_FACE_PIXELS}
             )::int AS large_enough
        FROM faces f
        JOIN photos p ON p.id = f.photo_id
       ${ONLY_USER != null ? "WHERE p.user_id = $1" : ""}
      `,
      userFilter,
    )
  ).rows[0];
  out(`## 1. Abdeckung`);
  out();
  table(
    ["Größe", "Wert"],
    [
      ["Gesichter gesamt", cov.total],
      ["mit Landmarken", `${cov.with_landmarks} (${pct(cov.with_landmarks, cov.total)})`],
      [`groß genug (≥ ${MIN_EYE_FACE_PIXELS} px breit)`, cov.large_enough],
      ["mit Wert 106 / 68", `${cov.with_106} / ${cov.with_68}`],
    ],
  );
  if (cov.with_landmarks === 0) {
    out(`**Abbruch:** kein Gesicht mit Landmarken. Erst den Backfill laufen lassen.`);
    return finish(pool);
  }

  // ── 2. Verteilung ───────────────────────────────────────────────────────
  const dist = (
    await pool.query(
      `
      SELECT percentile_cont(ARRAY[0.05,0.25,0.5,0.75,0.95]) WITHIN GROUP (ORDER BY f.eye_aspect) AS p106,
             percentile_cont(ARRAY[0.05,0.25,0.5,0.75,0.95]) WITHIN GROUP (ORDER BY f.eye_aspect_68) AS p68,
             corr(f.eye_aspect, f.eye_aspect_68)::float AS r
        FROM faces f
        JOIN photos p ON p.id = f.photo_id
       WHERE f.eye_aspect IS NOT NULL OR f.eye_aspect_68 IS NOT NULL
       ${ONLY_USER != null ? "AND p.user_id = $1" : ""}
      `,
      userFilter,
    )
  ).rows[0];
  out(`## 2. Verteilung je Gesicht`);
  out();
  table(
    ["Signal", "p05 / p25 / Median / p75 / p95"],
    [
      ["`eye_aspect` (106)", (dist.p106 ?? []).map((v) => num(v)).join(" / ")],
      ["`eye_aspect_68`", (dist.p68 ?? []).map((v) => num(v)).join(" / ")],
    ],
  );
  out(
    `Korrelation der beiden Modelle: ${num(dist.r)}. Geschlossene Augen ` +
      `sollten als eigener linker Ausläufer sichtbar sein (p05 deutlich unter ` +
      `p25). Fehlt er bei einem Modell, folgt es dem Lid nicht.`,
  );
  out();

  // ── 3. Paare aus geprüften Gruppen ──────────────────────────────────────
  const res = await pool.query(
    `
    SELECT pg.id AS group_id, gm.photo_id,
           (p.ai_quality_details->>'eyes_open')::float AS clip,
           EXISTS (SELECT 1 FROM photo_curation pc
                    WHERE pc.photo_id = gm.photo_id AND pc.user_id = pg.user_id
                      AND pc.status = 'hidden') AS hidden,
           f.bbox, f.eye_aspect, f.eye_aspect_68,
           f.mouth_width, f.mouth_lift, f.mouth_width_68, f.mouth_lift_68,
           (ufa.person_id IS NOT NULL) AS known
      FROM photo_groups pg
      JOIN photo_group_members gm ON gm.group_id = pg.id
      JOIN photos p ON p.id = gm.photo_id
      LEFT JOIN faces f ON f.photo_id = gm.photo_id
      LEFT JOIN user_face_assignments ufa ON ufa.face_id = f.id AND ufa.user_id = pg.user_id
     WHERE pg.reviewed_at IS NOT NULL
       ${ONLY_USER != null ? "AND pg.user_id = $1" : ""}
    `,
    userFilter,
  );

  const groups = new Map();
  for (const r of res.rows) {
    let g = groups.get(r.group_id);
    if (!g) groups.set(r.group_id, (g = new Map()));
    let ph = g.get(r.photo_id);
    if (!ph) g.set(r.photo_id, (ph = { clip: r.clip, hidden: r.hidden, faces: [] }));
    if (r.bbox == null) continue;
    let area = 0;
    try {
      const b = typeof r.bbox === "string" ? JSON.parse(r.bbox) : r.bbox;
      area = (Number(b.width) || 0) * (Number(b.height) || 0);
    } catch {
      area = 0;
    }
    ph.faces.push({
      area,
      known: r.known === true,
      a106: r.eye_aspect,
      a68: r.eye_aspect_68,
      mw106: r.mouth_width,
      ml106: r.mouth_lift,
      mw68: r.mouth_width_68,
      ml68: r.mouth_lift_68,
    });
  }

  const weighted = (faces, key) => {
    let ws = 0;
    let acc = 0;
    for (const f of faces) {
      if (f[key] == null) continue;
      const w = faceProminence(f.area, f.known);
      if (w <= 0) continue;
      ws += w;
      acc += w * f[key];
    }
    return ws > 0 ? acc / ws : null;
  };

  const pairs = [];
  for (const g of groups.values()) {
    const photos = [...g.values()].map((p) => ({
      hidden: p.hidden,
      clip: p.clip,
      g106: weighted(p.faces, "a106"),
      g68: weighted(p.faces, "a68"),
      mw106: weighted(p.faces, "mw106"),
      ml106: weighted(p.faces, "ml106"),
      mw68: weighted(p.faces, "mw68"),
      ml68: weighted(p.faces, "ml68"),
    }));
    const kept = photos.filter((p) => !p.hidden);
    const hidden = photos.filter((p) => p.hidden);
    for (const k of kept) for (const h of hidden) pairs.push({ k, h });
  }

  out(`## 3. Paare (behalten gegen ausgeblendet)`);
  out();
  out(
    `${groups.size} geprüfte Gruppen, ${pairs.length} Paare. Verglichen wird ` +
      `je Signal gegen CLIP auf genau den Paaren, in denen beide einen Wert ` +
      `haben. EPS = ${EPS}.`,
  );
  out();

  const evaluate = (subset, key) => {
    const decided = subset.filter((p) => Math.abs(p.k[key] - p.h[key]) > EPS);
    const hits = decided.filter((p) => p.k[key] > p.h[key]).length;
    const diffs = decided.map((p) => Math.abs(p.k[key] - p.h[key]));
    const cut = median(diffs);
    const strong = decided.filter((p) => Math.abs(p.k[key] - p.h[key]) >= cut);
    const strongHits = strong.filter((p) => p.k[key] > p.h[key]).length;
    return { n: subset.length, decided: decided.length, hits, strong: strong.length, strongHits };
  };

  const rows = [];
  const verdicts = [];
  for (const sig of SIGNALS.slice(1)) {
    const common = pairs.filter(
      (p) => p.k.clip != null && p.h.clip != null && p.k[sig.key] != null && p.h[sig.key] != null,
    );
    const geo = evaluate(common, sig.key);
    const clip = evaluate(common, "clip");
    for (const [label, e] of [[SIGNALS[0].label, clip], [sig.label, geo]]) {
      rows.push([
        label,
        `${sig.key} ∩ clip`,
        e.n,
        `${e.decided} (${pct(e.decided, e.n)})`,
        pct(e.hits, e.decided),
        pct(e.strongHits, e.strong),
      ]);
    }
    verdicts.push({ sig, geo, clip });
  }
  table(
    ["Signal", "Paarmenge", "Paare", "entschieden", "Treffer", "Treffer bei großem Unterschied"],
    rows,
  );
  out(
    `„Großer Unterschied": die obere Hälfte der entschiedenen Paare nach ` +
      `Betrag des Unterschieds.`,
  );
  out();

  // ── 3b. Lächeln ─────────────────────────────────────────────────────────
  //
  // Für den Mund gibt es kein heutiges Signal, gegen das verglichen werden
  // könnte. Maßstab ist deshalb der Zufall (50 %): ein Signal, das ein Paar
  // nur in Richtung des Nutzers entscheidet, wenn es zufällig passt, trägt
  // nichts.
  const MOUTH_SIGNALS = [
    { key: "ml106", label: "Mundwinkel-Hebung 106 (`mouth_lift`)" },
    { key: "mw106", label: "Mundbreite 106 (`mouth_width`)" },
    { key: "ml68", label: "Mundwinkel-Hebung 68 (`mouth_lift_68`)" },
    { key: "mw68", label: "Mundbreite 68 (`mouth_width_68`)" },
  ];
  const mouthResults = MOUTH_SIGNALS.map((sig) => {
    const subset = pairs.filter((p) => p.k[sig.key] != null && p.h[sig.key] != null);
    return { sig, e: evaluate(subset, sig.key) };
  });
  out(`## 3b. Lächeln (behalten gegen ausgeblendet)`);
  out();
  table(
    ["Signal", "Paare", "entschieden", "Treffer", "Treffer bei großem Unterschied"],
    mouthResults.map(({ sig, e }) => [
      sig.label,
      e.n,
      `${e.decided} (${pct(e.decided, e.n)})`,
      pct(e.hits, e.decided),
      pct(e.strongHits, e.strong),
    ]),
  );
  out(
    `Ohne Vergleichssignal ist der Maßstab 50 %. Ein Lächeln ist seltener ` +
      `der Grund für die Wahl als offene Augen; schon wenige Prozentpunkte ` +
      `darüber bei großem Unterschied wären ein Befund.`,
  );
  out();

  // ── 4. Urteil ───────────────────────────────────────────────────────────
  out(`## 4. Urteil`);
  out();
  const coverageOk = cov.with_landmarks / Math.max(cov.total, 1) >= 0.9;
  if (!coverageOk) {
    out(
      `**Kein Urteil.** Erst ${pct(cov.with_landmarks, cov.total)} der Gesichter ` +
        `haben Landmarken — die auswertbaren Paare sind eine kleine, nicht ` +
        `zufällige Teilmenge. Backfill zu Ende laufen lassen.`,
    );
    out();
    return finish(pool);
  }
  for (const { sig, geo, clip } of verdicts) {
    if (geo.decided < 30) {
      out(`- ${sig.label}: **kein Urteil**, nur ${geo.decided} entschiedene Paare.`);
      continue;
    }
    const rGeo = geo.hits / geo.decided;
    const rClip = clip.decided > 0 ? clip.hits / clip.decided : 0;
    out(
      `- ${sig.label}: entscheidet ${pct(geo.decided, geo.n)} der Paare ` +
        `(CLIP ${pct(clip.decided, clip.n)}), trifft ${pct(geo.hits, geo.decided)} ` +
        `(CLIP ${pct(clip.hits, clip.decided)}). ` +
        (rGeo > rClip && geo.decided >= clip.decided * 0.5
          ? `**Besser als CLIP** — Kandidat für den Replay mit neuen Gewichten.`
          : `**Nicht besser als CLIP** — bleibt außerhalb der Formel.`),
    );
  }
  for (const { sig, e } of mouthResults) {
    if (e.decided < 30) {
      out(`- ${sig.label}: **kein Urteil**, nur ${e.decided} entschiedene Paare.`);
      continue;
    }
    const strongRate = e.strong > 0 ? e.strongHits / e.strong : 0;
    out(
      `- ${sig.label}: trifft ${pct(e.hits, e.decided)}, bei großem ` +
        `Unterschied ${pct(e.strongHits, e.strong)}. ` +
        (strongRate >= 0.55
          ? `**Über dem Zufall** — Kandidat für den Replay.`
          : `**Nicht über dem Zufall** — bleibt außerhalb der Formel.`),
    );
  }
  out();
  out(
    `Eine Übernahme in \`scorePhoto()\` geschieht nicht auf Grund dieser ` +
      `Tabelle allein, sondern erst nach dem Replay mit neu gelernten ` +
      `Gewichten (Abschnitt 7 des Konzepts).`,
  );
  out();
  return finish(pool);
}

async function finish(pool) {
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
