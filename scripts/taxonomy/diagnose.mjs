#!/usr/bin/env node
/**
 * Etappe A — Diagnose der Dokument-Taxonomie und Steuer-Einordnung.
 *
 * READ-ONLY. Das Skript führt ausschließlich SELECT-Abfragen aus (plus
 * eine HNSW-Nachbarschaftssuche über den vorhandenen pgvector-Index) und
 * schreibt einen Markdown-Report nach scripts/taxonomy/out/diagnose.md.
 * Es verändert KEINE produktiven Daten.
 *
 * Zweck (siehe docs/taxonomy-tax-quality-improvement.md, Etappe A):
 *   - Inventar der manuell bestätigten Daten (tax_reviewed, source='user'),
 *     damit klar ist, wie groß das Steuer-Gold-Set fürs spätere Eval-Gate ist.
 *   - Kategorie-Verteilung inkl. sonstiges-Quote und Niedrig-Confidence-Anteil.
 *   - Confidence-Histogramm.
 *   - Steuer-Sektionen: belegt / tot / überladen, mittlere Confidence.
 *   - Top-Absender je Kategorie und je Steuer-Sektion (Überlappungen sichtbar).
 *   - Embedding-Confusion-Heuristik: Dokumente, deren nächste Nachbarn
 *     überwiegend in einer ANDEREN Kategorie liegen → Fehlklassifikations-Kandidaten.
 *
 * Verbindung: identische Logik wie db/database.ts (POSTGRES_CONNECTION_STRING
 * oder POSTGRES_HOST/PORT/USER/PASSWORD/DATABASE). Standard-DB: fk_encore.
 *
 * Aufruf:
 *   node scripts/taxonomy/diagnose.mjs
 *   CONFUSION_SAMPLE=0 node scripts/taxonomy/diagnose.mjs   # Confusion überspringen
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const { Pool } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const OUT_DIR = path.join(__dirname, "out");
const OUT_FILE = path.join(OUT_DIR, "diagnose.md");

// Wie viele Dokumente für die (teurere) Confusion-Heuristik bemustert werden.
// 0 = überspringen. Nachbarn pro Dokument:
const CONFUSION_SAMPLE = Number(process.env.CONFUSION_SAMPLE ?? "800");
const CONFUSION_K = Number(process.env.CONFUSION_K ?? "10");

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

// ── Kanonische Slugs aus dem TS-Quelltext lesen (eine Quelle der Wahrheit) ──
// Vermeidet Duplizierung: tax-sections.ts / taxonomy.ts bleiben maßgeblich.
function extractSlugs(relPath) {
  const text = fs.readFileSync(path.join(REPO_ROOT, relPath), "utf8");
  const slugs = [];
  const re = /slug:\s*"([^"]+)"/g;
  let m;
  while ((m = re.exec(text)) !== null) slugs.push(m[1]);
  return slugs;
}
function extractTaxSectionMeta() {
  // slug + group + name, um den Report nach Gruppen zu ordnen.
  const text = fs.readFileSync(
    path.join(REPO_ROOT, "documents/tax-sections.ts"),
    "utf8",
  );
  const entries = [];
  // Blockweise: { slug: "...", group: "...", name: "...", hint: "..." }
  const re =
    /slug:\s*"([^"]+)",\s*group:\s*"([^"]+)",\s*name:\s*"([^"]+)"/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    entries.push({ slug: m[1], group: m[2], name: m[3] });
  }
  return entries;
}

// ── Markdown-Hilfen ────────────────────────────────────────────────────────
const lines = [];
const out = (s = "") => lines.push(s);
function table(headers, rows) {
  out(`| ${headers.join(" | ")} |`);
  out(`| ${headers.map(() => "---").join(" | ")} |`);
  for (const r of rows) out(`| ${r.map((c) => String(c ?? "")).join(" | ")} |`);
  out("");
}
function pct(n, total) {
  if (!total) return "0%";
  return `${((100 * n) / total).toFixed(1)}%`;
}

async function main() {
  const pool = new Pool({ connectionString: CONNECTION_STRING, max: 4 });
  const q = (text, params) => pool.query(text, params);

  // Sanity: existieren die Dokument-Tabellen überhaupt?
  const exists = await q(`SELECT to_regclass('public.documents') AS t`);
  if (!exists.rows[0].t) {
    throw new Error(
      `Tabelle "documents" nicht gefunden (DB: ${CONNECTION_STRING.replace(/:[^:@/]+@/, ":***@")}). ` +
        `Zeigt das Skript auf die richtige Datenbank? Setze POSTGRES_CONNECTION_STRING.`,
    );
  }

  out(`# Diagnose: Taxonomie & Steuer-Einordnung`);
  out(``);
  out(`_Erzeugt: ${new Date().toISOString()} — read-only Report (Etappe A)._`);
  out(``);

  // ── 1. Gesamtzahlen ──────────────────────────────────────────────────────
  const total = Number(
    (await q(`SELECT count(*)::int AS n FROM documents`)).rows[0].n,
  );
  const classified = Number(
    (await q(`SELECT count(*)::int AS n FROM documents WHERE category_id IS NOT NULL`))
      .rows[0].n,
  );
  const withText = Number(
    (
      await q(
        `SELECT count(*)::int AS n FROM documents WHERE extracted_text IS NOT NULL AND extracted_text <> ''`,
      )
    ).rows[0].n,
  );
  const withEmb = Number(
    (
      await q(
        `SELECT count(DISTINCT document_id)::int AS n FROM document_embeddings`,
      )
    ).rows[0].n,
  );
  out(`## 1. Überblick`);
  out(``);
  table(
    ["Kennzahl", "Wert"],
    [
      ["Dokumente gesamt", total],
      ["mit Kategorie klassifiziert", `${classified} (${pct(classified, total)})`],
      ["ohne Kategorie", `${total - classified} (${pct(total - classified, total)})`],
      ["mit extrahiertem Text", `${withText} (${pct(withText, total)})`],
      ["mit Embeddings", `${withEmb} (${pct(withEmb, total)})`],
    ],
  );

  // ── 2. Manuell bestätigte Daten (Gold-Set-Inventar) ──────────────────────
  // Das ist die zentrale Frage: wie groß ist das vom Menschen bestätigte Set?
  const taxReviewed = Number(
    (await q(`SELECT count(*)::int AS n FROM documents WHERE tax_reviewed = true`))
      .rows[0].n,
  );
  const taxRelevant = Number(
    (await q(`SELECT count(*)::int AS n FROM documents WHERE tax_relevant = true`))
      .rows[0].n,
  );
  const userSectionRows = Number(
    (
      await q(
        `SELECT count(*)::int AS n FROM document_tax_sections WHERE source = 'user'`,
      )
    ).rows[0].n,
  );
  const aiSectionRows = Number(
    (
      await q(
        `SELECT count(*)::int AS n FROM document_tax_sections WHERE source = 'ai'`,
      )
    ).rows[0].n,
  );
  const docsWithUserSection = Number(
    (
      await q(
        `SELECT count(DISTINCT document_id)::int AS n FROM document_tax_sections WHERE source = 'user'`,
      )
    ).rows[0].n,
  );
  out(`## 2. Manuell bestätigte Daten (Gold-Set-Inventar)`);
  out(``);
  out(
    `> Nur Steuerfelder tragen ein Manuell-Signal (\`tax_reviewed\`, ` +
      `\`document_tax_sections.source\`). **Kategorie und Tags haben kein** ` +
      `Manuell-Marker — dort ist eine Nutzerkorrektur nicht von AI-Output ` +
      `unterscheidbar. Das hier ist also das gesamte automatisch nutzbare Gold-Set.`,
  );
  out(``);
  table(
    ["Signal", "Wert"],
    [
      ["Dokumente mit `tax_reviewed = true`", `${taxReviewed} (${pct(taxReviewed, total)})`],
      ["Dokumente mit `tax_relevant = true`", `${taxRelevant} (${pct(taxRelevant, total)})`],
      ["Steuer-Sektionen `source='user'` (Zeilen)", userSectionRows],
      ["…davon betroffene Dokumente", docsWithUserSection],
      ["Steuer-Sektionen `source='ai'` (Zeilen)", aiSectionRows],
    ],
  );
  out(
    `**Einschätzung Gold-Set:** ${
      taxReviewed + docsWithUserSection < 30
        ? "klein — fürs Eval-Gate (Etappe F) vermutlich per Handprüfung aufzustocken."
        : "ausreichend groß für ein erstes Eval-Gate."
    }`,
  );
  out(``);

  // ── 3. Kategorie-Verteilung ──────────────────────────────────────────────
  const catRows = (
    await q(`
    SELECT c.slug,
           c.name,
           count(d.id)::int                                              AS n,
           avg(d.classification_confidence)::float                       AS avg_conf,
           count(*) FILTER (WHERE d.classification_confidence < 0.5)::int AS low_conf
    FROM document_categories c
    LEFT JOIN documents d ON d.category_id = c.id
    GROUP BY c.slug, c.name
    HAVING count(d.id) > 0
    ORDER BY n DESC
  `)
  ).rows;
  out(`## 3. Kategorie-Verteilung`);
  out(``);
  table(
    ["Kategorie", "Slug", "Dok.", "Anteil", "Ø Conf.", "< 0.5"],
    catRows.map((r) => [
      r.name,
      r.slug,
      r.n,
      pct(r.n, total),
      r.avg_conf == null ? "—" : r.avg_conf.toFixed(2),
      r.low_conf,
    ]),
  );
  const sonst = catRows.find((r) => r.slug === "sonstiges");
  if (sonst) {
    out(
      `**sonstiges-Quote:** ${sonst.n} (${pct(sonst.n, total)}) — hoher Wert ` +
        `deutet auf Taxonomie-Lücken hin.`,
    );
    out(``);
  }

  // ── 4. Confidence-Histogramm ─────────────────────────────────────────────
  const hist = (
    await q(`
    SELECT width_bucket(classification_confidence, 0, 1, 10) AS bucket,
           count(*)::int AS n
    FROM documents
    WHERE classification_confidence IS NOT NULL
    GROUP BY bucket
    ORDER BY bucket
  `)
  ).rows;
  out(`## 4. Confidence-Histogramm`);
  out(``);
  const maxN = Math.max(1, ...hist.map((h) => h.n));
  table(
    ["Bereich", "Dok.", ""],
    hist.map((h) => {
      const lo = ((h.bucket - 1) / 10).toFixed(1);
      const hi = (h.bucket / 10).toFixed(1);
      const bar = "█".repeat(Math.round((40 * h.n) / maxN));
      return [`${lo}–${hi}`, h.n, bar];
    }),
  );

  // ── 5. Steuer-Sektionen: belegt / tot / überladen ────────────────────────
  const sectionMeta = extractTaxSectionMeta();
  const sectionMetaBySlug = new Map(sectionMeta.map((s) => [s.slug, s]));
  const secRows = (
    await q(`
    SELECT tax_section,
           count(*)::int          AS n,
           avg(confidence)::float  AS avg_conf
    FROM document_tax_sections
    WHERE source = 'ai'
    GROUP BY tax_section
  `)
  ).rows;
  const secCount = new Map(secRows.map((r) => [r.tax_section, r]));
  out(`## 5. Steuer-Sektionen (source='ai')`);
  out(``);
  const taxDocs = Math.max(1, taxRelevant);
  const groupOrder = ["einkuenfte", "abzuege", "bescheid", "rahmen"];
  const ordered = [...sectionMeta].sort(
    (a, b) => groupOrder.indexOf(a.group) - groupOrder.indexOf(b.group),
  );
  table(
    ["Gruppe", "Sektion", "Slug", "Dok.", "Anteil*", "Ø Conf."],
    ordered.map((s) => {
      const r = secCount.get(s.slug);
      const n = r ? r.n : 0;
      return [
        s.group,
        s.name.replace(/\|/g, "/"),
        s.slug,
        n === 0 ? "**0 (tot)**" : n,
        pct(n, taxDocs),
        r && r.avg_conf != null ? r.avg_conf.toFixed(2) : "—",
      ];
    }),
  );
  out(`_*Anteil bezogen auf tax_relevant=true (${taxRelevant} Dok.)._`);
  out(``);
  // Sektionen in DB, die nicht (mehr) im kanonischen Set stehen → Drift.
  const unknown = secRows.filter((r) => !sectionMetaBySlug.has(r.tax_section));
  if (unknown.length) {
    out(
      `**Unbekannte Sektions-Slugs in der DB** (nicht in tax-sections.ts): ` +
        unknown.map((u) => `\`${u.tax_section}\` (${u.n})`).join(", "),
    );
    out(``);
  }
  const dead = ordered.filter((s) => !secCount.has(s.slug));
  if (dead.length) {
    out(
      `**Nie vergebene Sektionen (${dead.length}):** ` +
        dead.map((s) => `\`${s.slug}\``).join(", ") +
        ` — entweder im Korpus nicht vorhanden oder Hint zu schwach.`,
    );
    out(``);
  }

  // Steuerjahr-Verteilung
  const yearRows = (
    await q(`
    SELECT tax_year, count(*)::int AS n
    FROM documents
    WHERE tax_relevant = true AND tax_year IS NOT NULL
    GROUP BY tax_year ORDER BY tax_year
  `)
  ).rows;
  if (yearRows.length) {
    out(`### Steuerjahre (tax_relevant=true)`);
    out(``);
    table(["Jahr", "Dok."], yearRows.map((r) => [r.tax_year, r.n]));
  }

  // ── 6. Top-Absender je Kategorie / Sektion ───────────────────────────────
  const topSendersCat = (
    await q(`
    SELECT slug, name, sender, n FROM (
      SELECT c.slug, c.name, d.sender, count(*)::int AS n,
             row_number() OVER (PARTITION BY c.id ORDER BY count(*) DESC) AS rnk
      FROM documents d
      JOIN document_categories c ON c.id = d.category_id
      WHERE d.sender IS NOT NULL AND d.sender <> ''
      GROUP BY c.id, c.slug, c.name, d.sender
    ) s WHERE rnk <= 3 ORDER BY slug, n DESC
  `)
  ).rows;
  out(`## 6. Top-Absender je Kategorie (max. 3)`);
  out(``);
  table(
    ["Kategorie", "Absender", "Dok."],
    topSendersCat.map((r) => [r.name, r.sender, r.n]),
  );

  // ── 7. Embedding-Confusion-Heuristik ─────────────────────────────────────
  out(`## 7. Confusion-Kandidaten (Embedding-Nachbarschaft)`);
  out(``);
  if (CONFUSION_SAMPLE <= 0) {
    out(`_Übersprungen (CONFUSION_SAMPLE=0)._`);
    out(``);
  } else {
    out(
      `> Heuristik: für eine Stichprobe von Dokumenten werden die ${CONFUSION_K} ` +
        `nächsten Nachbarn (Cosine, HNSW) gesucht; liegt die Mehrheit in einer ` +
        `anderen Kategorie, ist das ein Fehlklassifikations-Kandidat. ` +
        `Pro Dokument wird der erste Chunk als Repräsentant genutzt.`,
    );
    out(``);
    // Stichprobe von Dokumenten mit Kategorie + Embedding.
    const sample = (
      await q(
        `
      SELECT d.id, d.category_id, c.slug AS cat_slug, c.name AS cat_name
      FROM documents d
      JOIN document_categories c ON c.id = d.category_id
      WHERE EXISTS (SELECT 1 FROM document_embeddings e WHERE e.document_id = d.id)
      ORDER BY random()
      LIMIT $1
    `,
        [CONFUSION_SAMPLE],
      )
    ).rows;

    const confusionPairs = new Map(); // "fromSlug→toSlug" → count
    let flagged = 0;
    const flaggedDocs = [];
    for (const doc of sample) {
      // Repräsentant-Embedding = erster Chunk des Dokuments.
      const neighbors = (
        await q(
          `
        WITH rep AS (
          SELECT embedding FROM document_embeddings
          WHERE document_id = $1 ORDER BY chunk_idx LIMIT 1
        )
        SELECT c.slug AS slug, c.name AS name, count(*)::int AS votes
        FROM (
          SELECT e.document_id,
                 e.embedding <=> (SELECT embedding FROM rep) AS dist
          FROM document_embeddings e
          WHERE e.document_id <> $1
          ORDER BY dist
          LIMIT $2
        ) nn
        JOIN documents nd ON nd.id = nn.document_id
        JOIN document_categories c ON c.id = nd.category_id
        GROUP BY c.slug, c.name
        ORDER BY votes DESC
      `,
          [doc.id, CONFUSION_K],
        )
      ).rows;
      if (!neighbors.length) continue;
      const top = neighbors[0];
      const totalVotes = neighbors.reduce((a, r) => a + r.votes, 0);
      // „Mehrheit in anderer Kategorie" + nicht nur knapp.
      if (top.slug !== doc.cat_slug && top.votes > totalVotes / 2) {
        flagged++;
        const key = `${doc.cat_slug} → ${top.slug}`;
        confusionPairs.set(key, (confusionPairs.get(key) ?? 0) + 1);
        if (flaggedDocs.length < 25) {
          flaggedDocs.push([doc.id, doc.cat_name, top.name, `${top.votes}/${totalVotes}`]);
        }
      }
    }
    out(
      `Stichprobe: ${sample.length} Dokumente — **${flagged} Kandidaten** ` +
        `(${pct(flagged, sample.length)}) mit Nachbar-Mehrheit in anderer Kategorie.`,
    );
    out(``);
    const pairRows = [...confusionPairs.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([k, v]) => [k, v]);
    if (pairRows.length) {
      out(`### Häufigste Verwechslungs-Richtungen`);
      out(``);
      table(["von → nach", "Fälle"], pairRows);
    }
    if (flaggedDocs.length) {
      out(`### Beispiel-Kandidaten (max. 25)`);
      out(``);
      table(["Dok-ID", "aktuelle Kategorie", "Nachbar-Mehrheit", "Stimmen"], flaggedDocs);
    }
  }

  out(`---`);
  out(``);
  out(
    `_Nächster Schritt laut Plan: bei hoher sonstiges-Quote / vielen Confusion-` +
      `Kandidaten → Etappe B/C (Clustering). Bei vielen toten/überladenen ` +
      `Sektionen → Etappe D (Hints)._`,
  );

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_FILE, lines.join("\n"), "utf8");
  await pool.end();

  // Konsolen-Kurzfassung.
  console.log(`[diagnose] Dokumente: ${total}, klassifiziert: ${classified}`);
  console.log(
    `[diagnose] Gold-Set: tax_reviewed=${taxReviewed}, user-Sektionen=${userSectionRows} (${docsWithUserSection} Dok.)`,
  );
  console.log(`[diagnose] Report geschrieben: ${path.relative(REPO_ROOT, OUT_FILE)}`);
}

main().catch((err) => {
  console.error("[diagnose] FEHLER:", err.message);
  process.exitCode = 1;
});
