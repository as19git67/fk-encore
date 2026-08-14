#!/usr/bin/env node
/**
 * Vorhersage V1 aus docs/auto-pick-face-relevance.md, Abschnitt 7.
 *
 * Frage: Hat eine prominenzgewichtete Aggregation der Gesichtsschärfe
 * innerhalb einer Ähnlichkeitsgruppe mehr Streuung als das heutige Minimum?
 *
 * Hintergrund: `face_sharpness` ist das Minimum über alle Detektionen eines
 * Fotos. Ist das unschärfste Gesicht in jedem Frame eines Bursts dasselbe
 * winzige Hintergrundgesicht, ist das Minimum über alle Frames identisch —
 * die Schärfeschwankung des Hauptmotivs wird von der Aggregation gelöscht,
 * bevor sie das Scoring erreicht. Genau das erklärt (Vermutung), warum zwei
 * Drittel aller Gruppen bei Δ≈0 landen.
 *
 * Diese Messung ist die BILLIGSTE und zugleich SCHÄRFSTE Prüfung des ganzen
 * Umbaus: trifft V1 nicht zu, ist die Kernannahme falsch und an der
 * Scoring-Formel darf nichts geändert werden. Sie läuft direkt nach dem
 * Backfill von `faces.sharpness` (Etappe 2) und VOR jeder Formeländerung.
 *
 * Voraussetzung: `faces.sharpness` ist befüllt — über den Button
 * "Gesichtsschärfe nachtragen" in der Datenverwaltung bzw.
 * `POST /photos/backfill-face-sharpness`. Abschnitt 1 des Reports weist die
 * Abdeckung aus; ist sie niedrig, ist der Rest nicht belastbar.
 *
 * READ-ONLY. Ausschließlich SELECT-Abfragen. Report nach
 * scripts/photos/out/<datum>-face-sharpness-variance.md.
 *
 * Verbindung wie die übrigen Diagnoseskripte
 * (POSTGRES_CONNECTION_STRING oder POSTGRES_HOST/PORT/USER/PASSWORD/DATABASE,
 * Standard-DB `encore`).
 *
 * Aufruf:
 *   POSTGRES_DATABASE=encore node scripts/photos/diagnose-face-sharpness-variance.mjs
 *   USER_ID=1 ... node scripts/photos/diagnose-face-sharpness-variance.mjs
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
const OUT_FILE = path.join(OUT_DIR, `${TODAY}-face-sharpness-variance.md`);

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

// ── Prominenz-Konstanten: eine Quelle der Wahrheit ────────────────────────
// Aus dem TS-Quelltext gelesen statt hier dupliziert, damit ein späteres
// Tuning der Schwellwerte nicht still an dieser Auswertung vorbeiläuft.
function parseProminenceConstants() {
  const src = fs.readFileSync(
    path.join(REPO_ROOT, "photo/group-auto-pick.ts"),
    "utf8",
  );
  const read = (name) => {
    const m = src.match(new RegExp(`export const ${name} = ([0-9.]+)`));
    if (!m) throw new Error(`${name} konnte nicht aus photo/group-auto-pick.ts gelesen werden`);
    return Number(m[1]);
  };
  return {
    floor: read("PROMINENCE_FLOOR"),
    saturation: read("PROMINENCE_SATURATION"),
    knownBonus: read("KNOWN_BONUS"),
  };
}

/** Messgrenze, ebenfalls aus dem TS-Quelltext statt hier dupliziert. */
function parseMinFacePixels() {
  const src = fs.readFileSync(
    path.join(REPO_ROOT, "photo/face-sharpness.ts"),
    "utf8",
  );
  const m = src.match(/export const MIN_FACE_PIXELS = ([0-9]+)/);
  if (!m) throw new Error("MIN_FACE_PIXELS konnte nicht aus photo/face-sharpness.ts gelesen werden");
  return Number(m[1]);
}
const MIN_FACE_PIXELS = parseMinFacePixels();

/** Mirror von computeFaceProminence() in photo/group-auto-pick.ts. */
function faceProminence(bboxArea, known, c) {
  if (bboxArea < c.floor) return 0;
  const normalized = Math.min(bboxArea, c.saturation) / c.saturation;
  return normalized * (1 + (known ? c.knownBonus : 0));
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
function stddev(values) {
  if (values.length < 2) return 0;
  const m = mean(values);
  return Math.sqrt(mean(values.map((v) => (v - m) ** 2)));
}
/** Streuung gilt als "praktisch null" — dieselbe Größenordnung, in der die
 *  Δ≈0-Gruppen des Kalibrierungs-Reports liegen. */
const FLAT = 0.001;

async function main() {
  const pool = new Pool({ connectionString: CONNECTION_STRING });
  const constants = parseProminenceConstants();

  out(`# Gesichtsschärfe je Gesicht: löscht \`min()\` die Varianz?`);
  out();
  out(`Erzeugt: ${new Date().toISOString()}`);
  out(`Datenbank: \`${CONNECTION_STRING.replace(/:[^:@]*@/, ":***@")}\``);
  if (ONLY_USER != null) out(`Eingeschränkt auf user_id = ${ONLY_USER}`);
  out();
  out(
    `Prüfung der Vorhersage **V1** aus \`docs/auto-pick-face-relevance.md\`: ` +
      `Eine prominenzgewichtete Aggregation von \`faces.sharpness\` hat ` +
      `innerhalb einer Ähnlichkeitsgruppe eine höhere Streuung als das heutige ` +
      `Minimum. Trifft V1 nicht zu, ist die Kernannahme aus Abschnitt 2 falsch ` +
      `und die Formel bleibt, wie sie ist.`,
  );
  out();
  out(
    `Prominenz-Konstanten (aus \`photo/group-auto-pick.ts\` gelesen): ` +
      `Untergrenze ${constants.floor}, Sättigung ${constants.saturation}, ` +
      `Bonus für bekannte Personen ${constants.knownBonus}.`,
  );
  out();

  // ── 1. Abdeckung des Backfills ──────────────────────────────────────────
  //
  // Die unvermessenen Gesichter werden aufgeteilt: unter der Messgrenze
  // (bbox-Kantenlänge < 10 px im Original — die bleiben dauerhaft NULL) gegen
  // schlicht noch nicht nachgetragen. Nur die zweite Zahl heißt „der Backfill
  // ist noch nicht durch", und nur sie entscheidet, ob der Rest des Reports
  // überhaupt etwas aussagt.
  const coverage = await pool.query(
    `
    SELECT COUNT(*)::int AS faces_total,
           COUNT(f.sharpness)::int AS faces_measured,
           COUNT(f.sharpness_variance)::int AS faces_with_variance,
           COUNT(*) FILTER (
             WHERE f.sharpness IS NULL
               AND p.width IS NOT NULL AND p.height IS NOT NULL
               AND (
                 COALESCE(((f.bbox)::jsonb->>'width')::float, 0) * p.width < ${MIN_FACE_PIXELS}
                 OR COALESCE(((f.bbox)::jsonb->>'height')::float, 0) * p.height < ${MIN_FACE_PIXELS}
               )
           )::int AS faces_too_small,
           COUNT(*) FILTER (
             WHERE f.sharpness IS NULL
               AND (p.width IS NULL OR p.height IS NULL)
           )::int AS faces_unknown_size
      FROM faces f
      JOIN photos p ON p.id = f.photo_id
     ${ONLY_USER != null ? "WHERE p.user_id = $1" : ""}
    `,
    ONLY_USER != null ? [ONLY_USER] : [],
  );
  const cov = coverage.rows[0];
  const pending =
    cov.faces_total - cov.faces_measured - cov.faces_too_small - cov.faces_unknown_size;
  const measurable = cov.faces_total - cov.faces_too_small;
  out(`## 1. Abdeckung`);
  out();
  table(
    ["Größe", "Wert"],
    [
      ["Gesichter gesamt", cov.faces_total],
      ["davon vermessen", `${cov.faces_measured} (${pct(cov.faces_measured, cov.faces_total)})`],
      ["unter der Messgrenze (bleiben NULL)", cov.faces_too_small],
      ["ohne bekannte Bildmaße (nicht einzuordnen)", cov.faces_unknown_size],
      ["**noch nachzutragen**", `**${pending}**`],
      [
        "vermessen von den messbaren",
        `${cov.faces_measured} / ${measurable} (${pct(cov.faces_measured, measurable)})`,
      ],
      ["davon mit Rohvarianz", cov.faces_with_variance],
    ],
  );
  out(
    `Nicht vermessene Gesichter sind entweder noch nicht nachgetragen oder ` +
      `unter der Messgrenze (Kantenlänge < ${MIN_FACE_PIXELS} px im Original) — beides ` +
      `\`NULL\`, beides absichtlich kein 0.0.`,
  );
  out();
  if (cov.faces_measured === 0) {
    out(
      `**Abbruch:** kein einziges Gesicht vermessen. Erst den Backfill ` +
        `laufen lassen (\`POST /photos/backfill-face-sharpness\`), dann diese ` +
        `Diagnose wiederholen.`,
    );
    await finish(pool);
    return;
  }

  // ── 1b. Verteilung der Messwerte ────────────────────────────────────────
  //
  // Vor jeder Aussage über Streuung *zwischen* Fotos gehört geprüft, ob die
  // Messung überhaupt noch unterscheidet. LAPLACIAN_FULL_SCALE ist am
  // Frontend kalibriert, das die *gerenderte* (herunterskalierte) Datei misst;
  // derselbe Ausschnitt aus dem Original trägt deutlich mehr Detail und kann
  // an die 1.0-Decke stoßen. Sitzt dort ein großer Teil der Werte, ist ein
  // σ von 0 keine Eigenschaft der Bilder, sondern der Skala.
  const dist = await pool.query(
    `
    SELECT COUNT(*)::int AS n,
           COUNT(*) FILTER (WHERE f.sharpness >= 0.999)::int AS at_ceiling,
           COUNT(*) FILTER (WHERE f.sharpness <= 0.001)::int AS at_floor,
           MIN(f.sharpness)::float AS s_min,
           percentile_cont(0.25) WITHIN GROUP (ORDER BY f.sharpness)::float AS s_p25,
           percentile_cont(0.50) WITHIN GROUP (ORDER BY f.sharpness)::float AS s_median,
           percentile_cont(0.75) WITHIN GROUP (ORDER BY f.sharpness)::float AS s_p75,
           MAX(f.sharpness)::float AS s_max,
           percentile_cont(0.05) WITHIN GROUP (ORDER BY f.sharpness_variance)::float AS v_p05,
           percentile_cont(0.50) WITHIN GROUP (ORDER BY f.sharpness_variance)::float AS v_median,
           percentile_cont(0.95) WITHIN GROUP (ORDER BY f.sharpness_variance)::float AS v_p95,
           MAX(f.sharpness_variance)::float AS v_max
      FROM faces f
      JOIN photos p ON p.id = f.photo_id
     WHERE f.sharpness IS NOT NULL
     ${ONLY_USER != null ? "AND p.user_id = $1" : ""}
    `,
    ONLY_USER != null ? [ONLY_USER] : [],
  );
  const d = dist.rows[0];
  const ceilingShare = d.n > 0 ? d.at_ceiling / d.n : 0;
  out(`## 1b. Verteilung der Messwerte`);
  out();
  table(
    ["Größe", "Wert"],
    [
      ["vermessene Gesichter", d.n],
      ["**an der Decke (≥ 0.999)**", `**${d.at_ceiling} (${pct(d.at_ceiling, d.n)})**`],
      ["am Boden (≤ 0.001)", `${d.at_floor} (${pct(d.at_floor, d.n)})`],
      ["Score min / p25 / Median / p75 / max",
        [d.s_min, d.s_p25, d.s_median, d.s_p75, d.s_max].map((v) => num(v, 3)).join(" / ")],
      ["Rohvarianz p05 / Median / p95 / max",
        [d.v_p05, d.v_median, d.v_p95, d.v_max].map((v) => num(v, 1)).join(" / ")],
    ],
  );
  if (ceilingShare >= 0.5) {
    out(
      `**Die Skala sättigt.** ${pct(d.at_ceiling, d.n)} der Gesichter liegen ` +
        `am Maximum — der Score unterscheidet sie nicht mehr, und ein σ von 0 ` +
        `innerhalb der Gruppe sagt in diesem Zustand nichts über die Bilder ` +
        `aus. Die Rohvarianz oben zeigt, wo der Vollausschlag stattdessen ` +
        `liegen müsste (Größenordnung des Medians); sie ist gespeichert, ` +
        `eine Neuskalierung ist also ein \`UPDATE\` und kein zweiter ` +
        `Messlauf. **V1 ist erst danach prüfbar.**`,
    );
    out();
  }

  // ── 2. Rohdaten je Gruppe ───────────────────────────────────────────────
  const rows = await pool.query(
    `
    SELECT pg.id AS group_id,
           pg.reviewed_at IS NOT NULL AS reviewed,
           gm.photo_id,
           f.id AS face_id,
           f.sharpness,
           f.bbox,
           (ufa.person_id IS NOT NULL) AS known_person
      FROM photo_groups pg
      JOIN photo_group_members gm ON gm.group_id = pg.id
      JOIN faces f ON f.photo_id = gm.photo_id
      LEFT JOIN user_face_assignments ufa
             ON ufa.face_id = f.id AND ufa.user_id = pg.user_id
     ${ONLY_USER != null ? "WHERE pg.user_id = $1" : ""}
    `,
    ONLY_USER != null ? [ONLY_USER] : [],
  );

  // group_id → photo_id → Gesichtsliste
  const groups = new Map();
  for (const r of rows.rows) {
    let g = groups.get(r.group_id);
    if (!g) {
      g = { id: r.group_id, reviewed: r.reviewed, photos: new Map() };
      groups.set(r.group_id, g);
    }
    let faces = g.photos.get(r.photo_id);
    if (!faces) {
      faces = [];
      g.photos.set(r.photo_id, faces);
    }
    let area = 0;
    try {
      const bbox = typeof r.bbox === "string" ? JSON.parse(r.bbox) : r.bbox;
      area = (Number(bbox.width) || 0) * (Number(bbox.height) || 0);
    } catch {
      area = 0;
    }
    faces.push({
      sharpness: r.sharpness == null ? null : Number(r.sharpness),
      area,
      known: r.known_person === true,
    });
  }

  // ── 3. Aggregation je Foto, Streuung je Gruppe ──────────────────────────
  const analysed = [];
  let skippedTooSmall = 0;   // Gruppe mit < 2 Fotos mit Gesichtern
  let skippedUnmeasured = 0; // Gruppe mit unvollständigem Backfill
  for (const g of groups.values()) {
    const perPhoto = [];
    let incomplete = false;
    for (const [photoId, faceList] of g.photos) {
      const measured = faceList.filter((f) => f.sharpness != null);
      if (measured.length === 0) {
        // Foto ganz ohne Messwert: entweder Backfill offen oder nur
        // Winzgesichter. Beides macht die Gruppe für diesen Vergleich
        // unbrauchbar, weil "heute" und "neu" dann auf verschiedenen
        // Datenbeständen rechnen würden.
        incomplete = true;
        continue;
      }
      const min = Math.min(...measured.map((f) => f.sharpness));
      let weightSum = 0;
      let weighted = 0;
      for (const f of measured) {
        const w = faceProminence(f.area, f.known, constants);
        if (w <= 0) continue;
        weightSum += w;
        weighted += w * f.sharpness;
      }
      perPhoto.push({
        photoId,
        min,
        // Kein prominentes Gesicht (nur Winzdetektionen): dann trägt die
        // gewichtete Variante nichts bei und fällt bewusst auf das Minimum
        // zurück — so wird der Vergleich nicht künstlich geschönt.
        weighted: weightSum > 0 ? weighted / weightSum : min,
        prominent: weightSum > 0,
      });
    }
    if (incomplete) {
      skippedUnmeasured++;
      continue;
    }
    if (perPhoto.length < 2) {
      skippedTooSmall++;
      continue;
    }
    const minValues = perPhoto.map((p) => p.min);
    const weightedValues = perPhoto.map((p) => p.weighted);
    // Alle Indizes an der Spitze — ein Gleichstand ist hier kein Randfall,
    // sondern der Normalfall: genau dort entscheidet das Minimum nicht.
    const topIndices = (values) => {
      const max = Math.max(...values);
      return values
        .map((v, i) => [v, i])
        .filter(([v]) => v >= max - 1e-9)
        .map(([, i]) => i);
    };
    const minTop = topIndices(minValues);
    const weightedTop = topIndices(weightedValues);
    analysed.push({
      id: g.id,
      reviewed: g.reviewed,
      members: perPhoto.length,
      sigmaMin: stddev(minValues),
      sigmaWeighted: stddev(weightedValues),
      spreadMin: Math.max(...minValues) - Math.min(...minValues),
      spreadWeighted: Math.max(...weightedValues) - Math.min(...weightedValues),
      // Das Minimum benennt heute einen eindeutigen Sieger …
      minDecides: minTop.length === 1,
      // … und die gewichtete Variante benennt einen anderen.
      winnerChanged:
        minTop.length === 1 && weightedTop.length === 1 && weightedTop[0] !== minTop[0],
      // Enthaltung heute, Entscheidung morgen: das eigentliche Ziel („das
      // Entscheidungsband verbreitern").
      tieBroken: minTop.length > 1 && weightedTop.length === 1,
      anyProminent: perPhoto.some((p) => p.prominent),
    });
  }

  out(`## 2. Auswertbare Gruppen`);
  out();
  table(
    ["Größe", "Wert"],
    [
      ["Gruppen mit Gesichtern", groups.size],
      ["auswertbar", analysed.length],
      ["übersprungen (Backfill unvollständig)", skippedUnmeasured],
      ["übersprungen (< 2 Fotos mit Gesichtern)", skippedTooSmall],
      [
        "davon mit mindestens einem prominenten Gesicht",
        `${analysed.filter((a) => a.anyProminent).length} (${pct(
          analysed.filter((a) => a.anyProminent).length,
          analysed.length,
        )})`,
      ],
    ],
  );

  if (analysed.length === 0) {
    out(
      `**Abbruch:** keine auswertbare Gruppe. Meist heißt das, dass der ` +
        `Backfill noch läuft.`,
    );
    await finish(pool);
    return;
  }

  // ── 4. Die eigentliche V1-Messung ───────────────────────────────────────
  const report = (label, subset) => {
    if (subset.length === 0) return [label, 0, "–", "–", "–", "–", "–"];
    const flatMin = subset.filter((a) => a.sigmaMin < FLAT).length;
    const flatWeighted = subset.filter((a) => a.sigmaWeighted < FLAT).length;
    const higher = subset.filter((a) => a.sigmaWeighted > a.sigmaMin).length;
    return [
      label,
      subset.length,
      num(median(subset.map((a) => a.sigmaMin))),
      num(median(subset.map((a) => a.sigmaWeighted))),
      `${flatMin} (${pct(flatMin, subset.length)})`,
      `${flatWeighted} (${pct(flatWeighted, subset.length)})`,
      `${higher} (${pct(higher, subset.length)})`,
    ];
  };

  out(`## 3. V1 — Streuung innerhalb der Gruppe`);
  out();
  table(
    [
      "Menge",
      "Gruppen",
      "σ Median (min)",
      "σ Median (prominenzgewichtet)",
      "σ ≈ 0 (min)",
      "σ ≈ 0 (gewichtet)",
      "gewichtet > min",
    ],
    [
      report("alle", analysed),
      report("reviewt (Testset)", analysed.filter((a) => a.reviewed)),
      report("offen", analysed.filter((a) => !a.reviewed)),
      report(
        "mit prominentem Gesicht",
        analysed.filter((a) => a.anyProminent),
      ),
    ],
  );
  out(
    `„σ ≈ 0" heißt: Streuung unter ${FLAT} — das Signal unterscheidet die ` +
      `Mitglieder der Gruppe praktisch nicht. Genau diese Spalte ist die ` +
      `Enthaltungsquote in Rohform: fällt sie von „min" zu „gewichtet" ` +
      `deutlich, ist die maskierte Varianz gefunden.`,
  );
  out();

  // ── 5. Bewegungsmaß ─────────────────────────────────────────────────────
  const decisive = analysed.filter((a) => a.minDecides);
  const changed = analysed.filter((a) => a.winnerChanged).length;
  const tieBroken = analysed.filter((a) => a.tieBroken).length;
  const undecidedToday = analysed.length - decisive.length;
  out(`## 4. Bewegungsmaß`);
  out();
  table(
    ["Größe", "Wert"],
    [
      [
        "Gruppen, in denen das Minimum heute gar keinen Sieger benennt",
        `${undecidedToday} (${pct(undecidedToday, analysed.length)})`,
      ],
      [
        "davon: gewichtet entsteht ein eindeutiger Sieger",
        `${tieBroken} (${pct(tieBroken, undecidedToday)})`,
      ],
      [
        "Gruppen mit heute eindeutigem Sieger, der sich ändert",
        `${changed} (${pct(changed, decisive.length)})`,
      ],
      [
        "Median-Spanne (max − min) je Gruppe, Minimum-Aggregation",
        num(median(analysed.map((a) => a.spreadMin))),
      ],
      [
        "Median-Spanne (max − min) je Gruppe, prominenzgewichtet",
        num(median(analysed.map((a) => a.spreadWeighted))),
      ],
    ],
  );
  out(
    `Das Bewegungsmaß ist kein Qualitätsurteil — es sagt nur, wie viele ` +
      `Vorschläge sich sichtbar ändern würden. Ob die Änderung besser ist, ` +
      `beantwortet erst der Replay gegen die tatsächlichen ` +
      `Nutzerentscheidungen (Abschnitt 7 des Konzepts).`,
  );
  out();

  // ── 6. Urteil ───────────────────────────────────────────────────────────
  const all = analysed;
  const medianMin = median(all.map((a) => a.sigmaMin));
  const medianWeighted = median(all.map((a) => a.sigmaWeighted));
  const flatMin = all.filter((a) => a.sigmaMin < FLAT).length;
  const flatWeighted = all.filter((a) => a.sigmaWeighted < FLAT).length;
  const v1Holds = medianWeighted > medianMin && flatWeighted < flatMin;

  // Ein Urteil setzt voraus, dass überhaupt gemessen wurde. Zwei
  // Abbruchgründe, beide aus eigener Erfahrung: ein unvollständiger Backfill
  // (dann ist die auswertbare Menge eine winzige, nicht zufällige Teilmenge)
  // und eine gesättigte Skala (dann ist σ = 0 eine Eigenschaft der
  // Normalisierung, nicht der Bilder). In beiden Fällen wäre „V1 widerlegt"
  // genau der Denkfehler, den Abschnitt 1 des Konzepts bereits einmal
  // festhält: der Schluss aus einer Kennzahl auf eine Bedingung, die sie
  // nicht trägt.
  const coverageOk = pending === 0 || cov.faces_measured / Math.max(measurable, 1) >= 0.9;
  const scaleOk = ceilingShare < 0.5;
  const enoughGroups = analysed.length >= 30;

  out(`## 5. Urteil zu V1`);
  out();
  if (!coverageOk || !scaleOk || !enoughGroups) {
    out(`**Kein Urteil möglich.** Offen ist:`);
    out();
    if (!coverageOk) {
      out(
        `- **Der Backfill ist nicht durch.** ${pending} messbare ` +
          `${pending === 1 ? "Gesicht ist" : "Gesichter sind"} noch nicht ` +
          `vermessen (${pct(cov.faces_measured, measurable)} ` +
          `erledigt). Auswertbar sind nur Gruppen, in denen *jedes* Foto ` +
          `mindestens einen Messwert hat — das ist derzeit eine kleine und ` +
          `keineswegs zufällige Teilmenge.`,
      );
    }
    if (!scaleOk) {
      out(
        `- **Die Skala sättigt** (${pct(d.at_ceiling, d.n)} der Werte an der ` +
          `1.0-Decke). Ein σ von 0 misst dann die Normalisierung, nicht die ` +
          `Bilder. Vollausschlag anhand der gespeicherten Rohvarianz neu ` +
          `setzen (Median ${num(d.v_median, 1)}), danach erneut messen.`,
      );
    }
    if (!enoughGroups) {
      out(
        `- **Zu wenige auswertbare Gruppen** (${analysed.length}). Unter 30 ` +
          `trägt der Vergleich nicht.`,
      );
    }
    out();
    out(
      `Die Zahlen oben bleiben stehen, sind aber Diagnose des Messaufbaus, ` +
        `nicht Befund über die Bilder. V1 gilt weder als bestätigt noch als ` +
        `widerlegt.`,
    );
    out();
    await finish(pool);
    return;
  }
  out(
    v1Holds
      ? `**V1 trifft zu.** Die prominenzgewichtete Aggregation streut ` +
          `innerhalb der Gruppe stärker (σ Median ${num(medianWeighted)} ` +
          `gegen ${num(medianMin)}), und der Anteil der Gruppen ohne jede ` +
          `Unterscheidung fällt von ${pct(flatMin, all.length)} auf ` +
          `${pct(flatWeighted, all.length)}. Die Varianz war in den Pixeln ` +
          `vorhanden und wurde vom Minimum maskiert. Damit ist der Weg zu ` +
          `Etappe 4 (gruppenrelative Normalisierung) und zur Formeländerung ` +
          `frei — die Schwellwerte werden weiterhin über den Replay bestimmt, ` +
          `nicht geraten.`
      : `**V1 trifft NICHT zu.** Die gewichtete Aggregation streut nicht ` +
          `stärker als das Minimum (σ Median ${num(medianWeighted)} gegen ` +
          `${num(medianMin)}; Gruppen ohne Unterscheidung: ` +
          `${pct(flatWeighted, all.length)} gegen ${pct(flatMin, all.length)}). ` +
          `Damit ist die Kernannahme aus Abschnitt 2 des Konzepts widerlegt: ` +
          `die fehlende Varianz liegt nicht an der Aggregation. An der ` +
          `Scoring-Formel darf auf dieser Grundlage nichts geändert werden — ` +
          `stattdessen gehört das Ergebnis ins Konzept, zu den beiden bereits ` +
          `widerlegten Hypothesen.`,
  );
  out();

  await finish(pool);
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
