#!/usr/bin/env node
/**
 * Diagnose: Wie gut trifft der Auto-Pick auf Fotos MIT Gesichtern —
 * und degradiert die Trefferquote, je mehr Gesichter im Bild sind?
 *
 * READ-ONLY. Ausschließlich SELECT-Abfragen, keine Schreibzugriffe.
 * Report nach scripts/photos/out/<datum>-autopick-faces.md.
 *
 * Hintergrund (Follow-up zu #873 / docs/similar-photo-groups.md):
 * `face_sharpness` und `eyes_open` werden im embedding_service als
 * `min()` über ALLE erkannten Gesichter gebildet — ohne Rücksicht darauf,
 * wie prominent ein Gesicht überhaupt ist (Filter: nur ≥10 px Kantenlänge
 * in der Quelle). Zusammen tragen die beiden 0.60 der Gewichte im
 * Face-Zweig von scorePhoto(). Die Vermutung: auf Fotos mit vielen
 * verschieden großen Gesichtern (Menschenmenge) misst das Minimum den
 * unschärfsten Statisten im Hintergrund statt des Motivs — verzerrt also
 * nicht nur, sondern rauscht auch, weil zwischen zwei Frames desselben
 * Bursts ein anderes Hintergrundgesicht das Minimum stellen kann.
 *
 * Das Skript prüft diese Vermutung an bereits gespeicherten Daten. Es
 * braucht KEINEN Re-Scan: der Auto-Pick liegt samt Signal-Aufschlüsselung
 * in photo_groups.ai_pick_details, die Nutzer-Entscheidung in
 * photo_curation.
 *
 * Wichtig zur Interpretation: gemessen wird nur, wo der Nutzer bereits
 * reviewt hat (reviewed_at IS NOT NULL) UND ein Pick gespeichert ist. Der
 * Pick wurde vor dem Review berechnet, ist also eine echte Vorhersage —
 * aber die reviewten Gruppen sind keine Zufallsstichprobe der Bibliothek.
 *
 * Verbindung: identische Logik wie db/database.ts (POSTGRES_CONNECTION_STRING
 * oder POSTGRES_HOST/PORT/USER/PASSWORD/DATABASE). Standard-DB: fk_encore.
 *
 * Aufruf:
 *   node scripts/photos/diagnose-autopick-faces.mjs
 *   USER_ID=3 node scripts/photos/diagnose-autopick-faces.mjs   # nur ein Nutzer
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const { Pool } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, "out");
const TODAY = new Date().toISOString().slice(0, 10);
const OUT_FILE = path.join(OUT_DIR, `${TODAY}-autopick-faces.md`);

const ONLY_USER = process.env.USER_ID ? Number(process.env.USER_ID) : null;

// ── Verbindung (Spiegel von db/database.ts, non-test-Zweig) ────────────────
function buildConnectionString() {
  const host = process.env.POSTGRES_HOST || "localhost";
  const port = process.env.POSTGRES_PORT || "5432";
  const user = process.env.POSTGRES_USER || "postgres";
  const password = process.env.POSTGRES_PASSWORD || "postgres";
  const database = process.env.POSTGRES_DATABASE || "fk_encore";
  return `postgres://${user}:${password}@${host}:${port}/${database}`;
}
const CONNECTION_STRING =
  process.env.POSTGRES_CONNECTION_STRING || buildConnectionString();

// ── Markdown-Hilfen ────────────────────────────────────────────────────────
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

/** Bucket-Label für die Anzahl Gesichter im Bild. */
function faceCountBucket(n) {
  if (n <= 0) return "0 (ohne Gesicht)";
  if (n === 1) return "1";
  if (n === 2) return "2";
  if (n <= 5) return "3–5";
  if (n <= 15) return "6–15";
  return "16+";
}
const BUCKET_ORDER = ["0 (ohne Gesicht)", "1", "2", "3–5", "6–15", "16+"];

function median(values) {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
function stddev(values) {
  if (values.length < 2) return null;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const varr =
    values.reduce((acc, v) => acc + (v - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(varr);
}

async function main() {
  const pool = new Pool({ connectionString: CONNECTION_STRING });

  out(`# Auto-Pick-Diagnose: Gesichter`);
  out();
  out(`Erzeugt: ${new Date().toISOString()}`);
  out(`Datenbank: \`${CONNECTION_STRING.replace(/:[^:@]*@/, ":***@")}\``);
  if (ONLY_USER != null) out(`Eingeschränkt auf user_id = ${ONLY_USER}`);
  out();
  out(
    `Read-only. Getestet wird, ob die \`min()\`-Aggregation von ` +
      `\`face_sharpness\` / \`eyes_open\` die Auto-Pick-Qualität auf Fotos ` +
      `mit vielen Gesichtern verschlechtert.`,
  );
  out();

  // ── 1. Gespeicherte Kalibrierungs-Metadaten ──────────────────────────────
  // Die vorhandene Selbstauskunft des Systems: Trainings-Genauigkeit je
  // Zweig. Nur ein grober Indikator (Train-Accuracy, kein Holdout), aber
  // der erste Blick.
  out(`## 1. Gespeicherte Kalibrierung (\`ai_pick_user_weights.metadata\`)`);
  out();
  const calib = await pool.query(
    `SELECT user_id, fitted_at, metadata
       FROM ai_pick_user_weights
      ${ONLY_USER != null ? "WHERE user_id = $1" : ""}
      ORDER BY user_id`,
    ONLY_USER != null ? [ONLY_USER] : [],
  );
  if (calib.rows.length === 0) {
    out(
      `_Keine kalibrierten Gewichte vorhanden — es laufen die Defaults. ` +
        `Die Zahlen unten sind trotzdem aussagekräftig, weil sie den ` +
        `tatsächlich gespeicherten Pick gegen die tatsächliche ` +
        `Nutzer-Entscheidung halten._`,
    );
    out();
  } else {
    table(
      [
        "user_id",
        "fitted_at",
        "Face-Acc",
        "Face-Baseline",
        "Non-Face-Acc",
        "Non-Face-Baseline",
        "Paare Face",
        "Paare Non-Face",
      ],
      calib.rows.map((r) => {
        const m = r.metadata ?? {};
        return [
          r.user_id,
          r.fitted_at ? String(r.fitted_at).slice(0, 10) : "–",
          num(m.top1_accuracy_face),
          num(m.top1_accuracy_face_baseline),
          num(m.top1_accuracy_non_face),
          num(m.top1_accuracy_non_face_baseline),
          m.pair_count_face ?? "–",
          m.pair_count_non_face ?? "–",
        ];
      }),
    );
  }

  // ── 2. Trefferquote des gespeicherten Picks, gebucketet nach Gesichtszahl ─
  // Kernmessung. Für jede reviewte Gruppe mit gespeichertem Pick: hat der
  // Nutzer das vom Pick vorgeschlagene Foto behalten?
  //
  // "Behalten" = keine 'hidden'-Kuratierung (gleiche Definition wie in
  // group-auto-pick.calibration.ts). face_count kommt aus der faces-Tabelle,
  // gezählt wie im Scoring: ALLE Zeilen, auch als "ignoriert" markierte.
  const groups = await pool.query(
    `
    WITH g AS (
      SELECT pg.id, pg.user_id, pg.ai_picked_photo_ids, pg.ai_picked_confidence,
             pg.ai_pick_details
        FROM photo_groups pg
       WHERE pg.reviewed_at IS NOT NULL
         AND pg.ai_picked_photo_ids IS NOT NULL
         AND array_length(pg.ai_picked_photo_ids, 1) > 0
         ${ONLY_USER != null ? "AND pg.user_id = $1" : ""}
    )
    SELECT g.id            AS group_id,
           g.user_id,
           g.ai_picked_photo_ids,
           g.ai_picked_confidence,
           g.ai_pick_details,
           gm.photo_id,
           COALESCE(fc.face_count, 0)                    AS face_count,
           COALESCE(fc.max_face_area, 0)                 AS max_face_area,
           COALESCE(fc.min_face_area, 0)                 AS min_face_area,
           (pc.status = 'hidden')                        AS user_hidden
      FROM g
      JOIN photo_group_members gm ON gm.group_id = g.id
      LEFT JOIN photo_curation pc
             ON pc.photo_id = gm.photo_id AND pc.user_id = g.user_id
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::int AS face_count,
               MAX(COALESCE((f.bbox::jsonb->>'width')::float, 0)
                 * COALESCE((f.bbox::jsonb->>'height')::float, 0)) AS max_face_area,
               MIN(COALESCE((f.bbox::jsonb->>'width')::float, 0)
                 * COALESCE((f.bbox::jsonb->>'height')::float, 0)) AS min_face_area
          FROM faces f
         WHERE f.photo_id = gm.photo_id
      ) fc ON TRUE
    `,
    ONLY_USER != null ? [ONLY_USER] : [],
  );

  // Gruppen rekonstruieren.
  const byGroup = new Map();
  for (const r of groups.rows) {
    let entry = byGroup.get(r.group_id);
    if (!entry) {
      entry = {
        group_id: r.group_id,
        user_id: r.user_id,
        picked: new Set(r.ai_picked_photo_ids ?? []),
        confidence: r.ai_picked_confidence,
        details: r.ai_pick_details,
        photos: [],
      };
      byGroup.set(r.group_id, entry);
    }
    entry.photos.push({
      photo_id: r.photo_id,
      face_count: Number(r.face_count) || 0,
      max_face_area: Number(r.max_face_area) || 0,
      min_face_area: Number(r.min_face_area) || 0,
      // NULL-Kuratierung = nicht ausgeblendet = behalten.
      kept: r.user_hidden !== true,
    });
  }

  out(`## 2. Trefferquote nach Anzahl Gesichter`);
  out();
  out(
    `Eine Gruppe zählt als **Treffer**, wenn mindestens ein vom Auto-Pick ` +
      `vorgeschlagenes Foto vom Nutzer behalten wurde. Gebucketet nach der ` +
      `maximalen Gesichtszahl in der Gruppe (das Foto mit den meisten ` +
      `Detektionen bestimmt den Bucket — es ist das, was die \`min()\`-` +
      `Aggregation am stärksten trifft).`,
  );
  out();

  const buckets = new Map();
  const ensureBucket = (key) => {
    let b = buckets.get(key);
    if (!b) {
      b = { groups: 0, hits: 0, highConf: 0, highConfHits: 0 };
      buckets.set(key, b);
    }
    return b;
  };

  let usableGroups = 0;
  for (const g of byGroup.values()) {
    // Gruppen ohne jede Nutzer-Ausblendung tragen nichts bei: wenn alles
    // behalten wurde, trifft jeder Pick trivial. Solche Gruppen würden die
    // Quote nach oben verzerren.
    const hiddenCount = g.photos.filter((p) => !p.kept).length;
    if (hiddenCount === 0) continue;
    if (g.photos.length < 2) continue;
    usableGroups++;

    const maxFaces = Math.max(...g.photos.map((p) => p.face_count));
    const bucket = ensureBucket(faceCountBucket(maxFaces));
    bucket.groups++;
    const hit = g.photos.some((p) => g.picked.has(p.photo_id) && p.kept);
    if (hit) bucket.hits++;
    if (g.confidence === "high") {
      bucket.highConf++;
      if (hit) bucket.highConfHits++;
    }
  }

  if (usableGroups === 0) {
    out(
      `_Keine auswertbaren Gruppen: es gibt keine reviewte Gruppe mit ` +
        `gespeichertem Pick, in der der Nutzer mindestens ein Foto ` +
        `ausgeblendet hat. Ohne solche Entscheidungen lässt sich die ` +
        `Trefferquote nicht messen._`,
    );
    out();
  } else {
    table(
      ["Gesichter im Bild", "Gruppen", "Treffer", "Trefferquote", "davon 'high'", "Treffer bei 'high'"],
      BUCKET_ORDER.filter((k) => buckets.has(k)).map((k) => {
        const b = buckets.get(k);
        return [
          k,
          b.groups,
          b.hits,
          pct(b.hits, b.groups),
          b.highConf,
          pct(b.highConfHits, b.highConf),
        ];
      }),
    );
    out(
      `**So liest du das:** fällt die Trefferquote von den 1–2-Gesicht-` +
        `Buckets zu den 6–15/16+-Buckets deutlich ab, ist die Vermutung ` +
        `bestätigt. Bleibt sie flach, ist die \`min()\`-Aggregation in der ` +
        `Praxis kein Problem und der Umbau nicht gerechtfertigt. Die ` +
        `'high'-Spalten sind der wichtigere Teil: dort blendet der ` +
        `Batch-Abgleich ungefragt aus.`,
    );
    out();
  }

  // ── 3. Prominenz-Spreizung ───────────────────────────────────────────────
  // Wie oft ist das kleinste Gesicht viel kleiner als das größte? Genau
  // dann misst min() etwas anderes als das Motiv.
  out(`## 3. Prominenz-Spreizung der Gesichter`);
  out();
  out(
    `Verhältnis kleinstes/größtes Gesicht pro Foto (Fläche). Nahe 1 = alle ` +
      `Gesichter gleich prominent (\`min()\` ist dort unbedenklich). Nahe 0 ` +
      `= ein winziges Hintergrundgesicht bestimmt \`face_sharpness\`.`,
  );
  out();

  const multiFace = [];
  for (const g of byGroup.values()) {
    for (const p of g.photos) {
      if (p.face_count >= 2 && p.max_face_area > 0) {
        multiFace.push({
          ratio: p.min_face_area / p.max_face_area,
          face_count: p.face_count,
          max_face_area: p.max_face_area,
        });
      }
    }
  }
  if (multiFace.length === 0) {
    out(`_Keine Fotos mit ≥2 Gesichtern in reviewten Gruppen gefunden._`);
    out();
  } else {
    const ratios = multiFace.map((m) => m.ratio);
    const below10 = ratios.filter((r) => r < 0.1).length;
    const below25 = ratios.filter((r) => r < 0.25).length;
    table(
      ["Fotos mit ≥2 Gesichtern", "Median-Verhältnis", "< 0.25", "< 0.10"],
      [[
        multiFace.length,
        num(median(ratios)),
        `${below25} (${pct(below25, multiFace.length)})`,
        `${below10} (${pct(below10, multiFace.length)})`,
      ]],
    );
    out(
      `Der Anteil "< 0.10" ist der direkte Prevalenz-Wert: so oft ist das ` +
        `kleinste erkannte Gesicht weniger als ein Zehntel der Fläche des ` +
        `größten — und liefert trotzdem allein den \`face_sharpness\`-Wert.`,
    );
    out();
  }

  // ── 4. Face-Zweig durch Mini-Detektionen ─────────────────────────────────
  // face_count > 0 schaltet auf den Face-Zweig (0.85 Gewicht auf
  // Gesichtssignalen). Fotos, deren GRÖSSTES Gesicht winzig ist, sind
  // faktisch Landschaftsfotos mit Statisten.
  out(`## 4. Fotos, die nur durch winzige Detektionen im Face-Zweig landen`);
  out();
  const faceBranch = [];
  for (const g of byGroup.values()) {
    for (const p of g.photos) {
      if (p.face_count > 0) faceBranch.push(p);
    }
  }
  const tinyOnly = faceBranch.filter((p) => p.max_face_area < 0.005);
  const verySmallOnly = faceBranch.filter((p) => p.max_face_area < 0.02);
  table(
    ["Fotos im Face-Zweig", "größtes Gesicht < 2 % der Fläche", "< 0.5 % der Fläche"],
    [[
      faceBranch.length,
      `${verySmallOnly.length} (${pct(verySmallOnly.length, faceBranch.length)})`,
      `${tinyOnly.length} (${pct(tinyOnly.length, faceBranch.length)})`,
    ]],
  );
  out(
    `Diese Fotos werden nach der Face-Formel bewertet (0.85 des Gewichts ` +
      `auf Gesichtssignalen), obwohl das Motiv offensichtlich kein Porträt ist.`,
  );
  out();

  // ── 5. Ignorierte Gesichter zählen weiter mit ────────────────────────────
  // Nebenbefund: das Scoring joint faces ohne user_face_assignments.
  out(`## 5. Als "ignoriert" markierte Gesichter im Scoring`);
  out();
  const ignored = await pool.query(`
    SELECT COUNT(*)::int                                    AS ignored_faces,
           COUNT(DISTINCT f.photo_id)::int                  AS affected_photos
      FROM user_face_assignments ufa
      JOIN faces f ON f.id = ufa.face_id
     WHERE ufa.ignored = TRUE
  `);
  const ig = ignored.rows[0] ?? { ignored_faces: 0, affected_photos: 0 };
  table(
    ["Ignorierte Gesichter", "betroffene Fotos"],
    [[ig.ignored_faces, ig.affected_photos]],
  );
  out(
    `\`loadSignalsForPhotos\` (group-auto-pick.service.ts) joint \`faces\` ` +
      `ohne \`user_face_assignments\` — diese Gesichter zählen weiterhin in ` +
      `\`face_count\` und \`face_coverage\` und können den Face-Zweig ` +
      `mitauslösen.`,
  );
  out();

  // ── 6. Instabilität von face_sharpness innerhalb einer Gruppe ────────────
  // Die Signatur des "springenden Minimums": innerhalb eines Bursts sollten
  // sich globale Schärfe (blur) und Gesichtsschärfe ähnlich verhalten. Streut
  // face_sharpness deutlich stärker als blur, deutet das auf ein Minimum hin,
  // das zwischen Frames das Gesicht wechselt statt die Schärfe zu messen.
  out(`## 6. Streuung innerhalb einer Gruppe: face_sharpness vs. blur`);
  out();
  out(
    `Je Gruppe die Standardabweichung beider Signale über die Mitglieder, ` +
      `dann das Verhältnis. Werte deutlich > 1 heißen: die Gesichtsschärfe ` +
      `springt zwischen fast identischen Aufnahmen viel stärker als die ` +
      `globale Schärfe — die Signatur eines instabilen Minimums.`,
  );
  out();

  const spreadByBucket = new Map();
  for (const g of byGroup.values()) {
    const scores = g.details?.scores;
    if (!Array.isArray(scores) || scores.length < 2) continue;
    const faceVals = [];
    const blurVals = [];
    for (const s of scores) {
      const fs_ = s?.signals?.face_sharpness;
      const bl = s?.signals?.blur;
      if (typeof fs_ === "number" && typeof bl === "number") {
        faceVals.push(fs_);
        blurVals.push(bl);
      }
    }
    if (faceVals.length < 2) continue;
    const sdFace = stddev(faceVals);
    const sdBlur = stddev(blurVals);
    if (sdFace == null || sdBlur == null) continue;
    const maxFaces = Math.max(...g.photos.map((p) => p.face_count));
    const key = faceCountBucket(maxFaces);
    let arr = spreadByBucket.get(key);
    if (!arr) {
      arr = [];
      spreadByBucket.set(key, arr);
    }
    // Kleiner Epsilon-Boden, damit eine praktisch konstante globale
    // Schärfe (auf dieser Bibliothek liegt blur nahe 1.0) das Verhältnis
    // nicht ins Unendliche treibt.
    arr.push({ sdFace, sdBlur, ratio: sdFace / Math.max(sdBlur, 0.01) });
  }

  if (spreadByBucket.size === 0) {
    out(`_Keine Gruppen mit auswertbaren \`ai_pick_details.scores\` gefunden._`);
    out();
  } else {
    table(
      [
        "Gesichter im Bild",
        "Gruppen",
        "Median σ(face_sharpness)",
        "Median σ(blur)",
        "Median Verhältnis",
        "davon σ(blur) < 0.01",
      ],
      BUCKET_ORDER.filter((k) => spreadByBucket.has(k)).map((k) => {
        const arr = spreadByBucket.get(k);
        const floored = arr.filter((a) => a.sdBlur < 0.01).length;
        return [
          k,
          arr.length,
          num(median(arr.map((a) => a.sdFace))),
          num(median(arr.map((a) => a.sdBlur))),
          num(median(arr.map((a) => a.ratio)), 2),
          `${floored} (${pct(floored, arr.length)})`,
        ];
      }),
    );
    out(
      `Die letzte Spalte ist eine Warnung vor Über-Interpretation: wo ` +
        `σ(blur) unter dem Epsilon-Boden (0.01) liegt, ist das Verhältnis ` +
        `vom Boden bestimmt und nicht vom echten Verhältnis der Streuungen. ` +
        `Aussagekräftig ist die Spalte "Median σ(face_sharpness)" im ` +
        `Vergleich über die Buckets — steigt sie mit der Gesichtszahl, ` +
        `springt das Minimum.`,
    );
    out();
  }

  // ── Fazit-Hilfe ──────────────────────────────────────────────────────────
  out(`## Wie daraus eine Entscheidung wird`);
  out();
  out(
    `Der Umbau (Prominenz-Gewichtung statt \`min()\` im embedding_service, ` +
      `plus Re-Scoring der Bibliothek) lohnt sich, wenn **beides** zutrifft:`,
  );
  out();
  out(
    `1. Abschnitt 2 zeigt einen klaren Abfall der Trefferquote zu den ` +
      `hohen Gesichtszahlen hin — besonders in der 'high'-Spalte, weil dort ` +
      `ungefragt ausgeblendet wird.`,
  );
  out(
    `2. Abschnitt 3 zeigt, dass die betroffene Konstellation (stark ` +
      `gespreizte Gesichtsgrößen) in der Bibliothek überhaupt häufig ist.`,
  );
  out();
  out(
    `Bleibt die Quote in Abschnitt 2 flach, ist die Hypothese widerlegt — ` +
      `dann sind die einfachen Nebenbefunde (Abschnitt 4 und 5) die ` +
      `lohnenderen Baustellen, weil sie ohne Re-Scan zu beheben sind.`,
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
