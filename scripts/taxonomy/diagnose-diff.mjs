#!/usr/bin/env node
/**
 * Diff zweier diagnose.mjs-Reports (Etappe A) — Vorher/Nachher-Vergleich, z.B.
 * rund um eine Reclassify-Runde (Few-Shot, neue Sender-Rules, Taxonomie-Hints).
 *
 * READ-ONLY. Liest ausschließlich die beiden übergebenen Markdown-Dateien,
 * fasst nichts in der DB an. Kein pg-Import nötig.
 *
 * Was verglichen wird:
 *   - Gesamtzahl Dokumente (Wachstum des Korpus einordnen)
 *   - Kategorie-Verteilung: Δ Dokumentenzahl + Δ Anteil je Kategorie
 *   - sonstiges-Quote (Taxonomie-Lücken-Indikator)
 *   - Confusion-Kandidaten-Rate + Verwechslungs-Richtungen (neu/verschwunden/verändert)
 *
 * Aufruf:
 *   node scripts/taxonomy/diagnose-diff.mjs <alt.md> <neu.md>
 *   npm run diagnose:diff -- scripts/taxonomy/out/2026-07-15-diagnose.md scripts/taxonomy/out/2026-07-18-diagnose.md
 *
 * Beide Argumente müssen von diagnose.mjs erzeugte (oder strukturell gleiche)
 * Markdown-Reports sein. Fehlende Abschnitte (z.B. Confusion übersprungen via
 * CONFUSION_SAMPLE=0) werden im Diff einfach ausgelassen.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, "out");
const TODAY = new Date().toISOString().slice(0, 10);
const OUT_FILE = path.join(OUT_DIR, `${TODAY}-diagnose-diff.md`);

const [, , oldPath, newPath] = process.argv;
if (!oldPath || !newPath) {
  console.error(
    "Nutzung: node scripts/taxonomy/diagnose-diff.mjs <alter-report.md> <neuer-report.md>",
  );
  process.exitCode = 1;
  process.exit();
}

function readReport(p) {
  const text = fs.readFileSync(p, "utf8");
  return text.split("\n");
}

/** Erzeugt-Zeitstempel aus dem Report-Kopf, für die Diff-Überschrift. */
function extractTimestamp(lines) {
  const m = lines.find((l) => l.startsWith("_Erzeugt:"));
  return m ? m.match(/_Erzeugt:\s*([^\s—]+)/)?.[1] ?? "?" : "?";
}

/**
 * Findet eine Markdown-Tabelle direkt nach einer Überschriftzeile, die
 * `headingMatch` erfüllt. Gibt {headers, rows} zurück oder null, wenn die
 * Überschrift (z.B. bei übersprungener Confusion-Sektion) fehlt.
 */
function findTable(lines, headingMatch) {
  const headingIdx = lines.findIndex((l) => headingMatch.test(l));
  if (headingIdx === -1) return null;
  let i = headingIdx + 1;
  while (i < lines.length && !lines[i].startsWith("|")) {
    // Eine einleitende Blockquote-Zeile (`> Heuristik: …`) überspringen, aber
    // nicht endlos weiterlaufen, falls die Sektion (z.B. Confusion) leer ist.
    if (lines[i].startsWith("##") && i > headingIdx + 1) return null;
    i++;
    if (i - headingIdx > 10) return null;
  }
  if (i >= lines.length) return null;
  const headerLine = lines[i];
  const sepLine = lines[i + 1];
  if (!sepLine || !/^\|[\s-]*\|/.test(sepLine)) return null;
  const headers = splitRow(headerLine);
  const rows = [];
  let j = i + 2;
  while (j < lines.length && lines[j].startsWith("|")) {
    rows.push(splitRow(lines[j]));
    j++;
  }
  return { headers, rows, endIdx: j };
}

function splitRow(line) {
  return line
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());
}

function parseCount(cell) {
  // "434" oder "**0 (tot)**" o.ä. — nur die führende Zahl interessiert.
  const m = String(cell).match(/-?\d+/);
  return m ? Number(m[0]) : 0;
}

function parseTotal(lines) {
  const t = findTable(lines, /^##\s*\d+\.\s*Überblick/);
  if (!t) return null;
  const row = t.rows.find((r) => r[0].includes("Dokumente gesamt"));
  return row ? parseCount(row[1]) : null;
}

function parseCategories(lines) {
  const t = findTable(lines, /^##\s*\d+\.\s*Kategorie-Verteilung/);
  if (!t) return new Map();
  // Spalten: Kategorie, Slug, Dok., Anteil, Ø Conf., < 0.5
  const map = new Map();
  for (const r of t.rows) {
    const [name, slug, n] = r;
    map.set(slug, { name, n: parseCount(n) });
  }
  return map;
}

function parseConfusionSummary(lines) {
  const line = lines.find((l) => l.startsWith("Stichprobe:"));
  if (!line) return null;
  const m = line.match(
    /Stichprobe:\s*(\d+)\s*Dokumente\s*—\s*\*\*(\d+)\s*Kandidaten\*\*\s*\(([\d.]+)%\)/,
  );
  if (!m) return null;
  return { sample: Number(m[1]), flagged: Number(m[2]), pct: Number(m[3]) };
}

function parseConfusionPairs(lines) {
  const t = findTable(lines, /^###\s*Häufigste Verwechslungs-Richtungen/);
  if (!t) return new Map();
  const map = new Map();
  for (const [pair, n] of t.rows) map.set(pair, parseCount(n));
  return map;
}

// ── Reports laden ────────────────────────────────────────────────────────
const oldLines = readReport(oldPath);
const newLines = readReport(newPath);

const oldTs = extractTimestamp(oldLines);
const newTs = extractTimestamp(newLines);
const oldTotal = parseTotal(oldLines);
const newTotal = parseTotal(newLines);
const oldCats = parseCategories(oldLines);
const newCats = parseCategories(newLines);
const oldConfusion = parseConfusionSummary(oldLines);
const newConfusion = parseConfusionSummary(newLines);
const oldPairs = parseConfusionPairs(oldLines);
const newPairs = parseConfusionPairs(newLines);

if (oldTotal == null || newTotal == null) {
  console.error(
    "Konnte die Gesamtdokumentenzahl (Abschnitt 'Überblick') in einem der beiden Reports nicht finden — " +
      "sind das wirklich diagnose.mjs-Markdown-Reports?",
  );
  process.exitCode = 1;
  process.exit();
}

// ── Diff aufbauen ────────────────────────────────────────────────────────
const lines = [];
const out = (s = "") => lines.push(s);
function table(headers, rows) {
  out(`| ${headers.join(" | ")} |`);
  out(`| ${headers.map(() => "---").join(" | ")} |`);
  for (const r of rows) out(`| ${r.map((c) => String(c ?? "")).join(" | ")} |`);
  out("");
}
function signed(n) {
  return n > 0 ? `+${n}` : String(n);
}
function pct(n, total) {
  if (!total) return "0%";
  return `${((100 * n) / total).toFixed(1)}%`;
}

out(`# Diagnose-Diff: ${oldTs} → ${newTs}`);
out();
out(`_Erzeugt: ${new Date().toISOString()}._`);
out();
out(`Alter Report: \`${path.basename(oldPath)}\` — Neuer Report: \`${path.basename(newPath)}\``);
out();

out(`## 1. Korpusgröße`);
out();
table(
  ["Kennzahl", "Alt", "Neu", "Δ"],
  [["Dokumente gesamt", oldTotal, newTotal, signed(newTotal - oldTotal)]],
);

out(`## 2. Kategorie-Verteilung — Δ`);
out();
out(
  `Sortiert nach absolutem Rückgang zuerst — der Long-Tail-Effekt von Few-Shot/` +
    `Sender-Rules zeigt sich als **Abnahme** in generischen Kategorien ` +
    `(\`finanzen-rechnungen\`, \`sonstiges\`) und **Zunahme** in spezifischeren.`,
);
out();
const allSlugs = new Set([...oldCats.keys(), ...newCats.keys()]);
const catDiffRows = [...allSlugs]
  .map((slug) => {
    const o = oldCats.get(slug);
    const n = newCats.get(slug);
    const oldN = o?.n ?? 0;
    const newN = n?.n ?? 0;
    return {
      slug,
      name: n?.name ?? o?.name ?? slug,
      oldN,
      newN,
      delta: newN - oldN,
      oldPct: pct(oldN, oldTotal),
      newPct: pct(newN, newTotal),
    };
  })
  .sort((a, b) => a.delta - b.delta);
table(
  ["Kategorie", "Slug", "Alt (Anteil)", "Neu (Anteil)", "Δ"],
  catDiffRows
    .filter((r) => r.delta !== 0)
    .map((r) => [
      r.name,
      r.slug,
      `${r.oldN} (${r.oldPct})`,
      `${r.newN} (${r.newPct})`,
      signed(r.delta),
    ]),
);
const unchanged = catDiffRows.filter((r) => r.delta === 0 && (r.oldN > 0 || r.newN > 0)).length;
if (unchanged > 0) {
  out(`_${unchanged} weitere Kategorien unverändert._`);
  out();
}

const sonstOld = oldCats.get("sonstiges");
const sonstNew = newCats.get("sonstiges");
if (sonstOld || sonstNew) {
  const oldN = sonstOld?.n ?? 0;
  const newN = sonstNew?.n ?? 0;
  out(
    `**sonstiges-Quote:** ${oldN} (${pct(oldN, oldTotal)}) → ${newN} (${pct(newN, newTotal)}) ` +
      `(${signed(newN - oldN)})`,
  );
  out();
}

const rechnOld = oldCats.get("finanzen-rechnungen");
const rechnNew = newCats.get("finanzen-rechnungen");
if (rechnOld || rechnNew) {
  const oldN = rechnOld?.n ?? 0;
  const newN = rechnNew?.n ?? 0;
  out(
    `**finanzen-rechnungen (Catch-all):** ${oldN} (${pct(oldN, oldTotal)}) → ${newN} (${pct(newN, newTotal)}) ` +
      `(${signed(newN - oldN)})`,
  );
  out();
}

if (oldConfusion || newConfusion) {
  out(`## 3. Confusion-Kandidaten (Embedding-Nachbarschaft)`);
  out();
  if (!oldConfusion || !newConfusion) {
    out(
      `_Nur in einem der beiden Reports vorhanden (CONFUSION_SAMPLE=0 im anderen?) — kein Vergleich möglich._`,
    );
    out();
  } else {
    table(
      ["Kennzahl", "Alt", "Neu", "Δ"],
      [
        ["Stichprobe", oldConfusion.sample, newConfusion.sample, signed(newConfusion.sample - oldConfusion.sample)],
        [
          "Kandidaten (Nachbar-Mehrheit in anderer Kategorie)",
          `${oldConfusion.flagged} (${oldConfusion.pct}%)`,
          `${newConfusion.flagged} (${newConfusion.pct}%)`,
          signed(newConfusion.flagged - oldConfusion.flagged),
        ],
      ],
    );

    const allPairs = new Set([...oldPairs.keys(), ...newPairs.keys()]);
    const pairRows = [...allPairs]
      .map((k) => {
        const o = oldPairs.get(k) ?? 0;
        const n = newPairs.get(k) ?? 0;
        return [k, o, n, signed(n - o)];
      })
      .sort((a, b) => a[3].localeCompare(b[3], "en", { numeric: true }));
    if (pairRows.length) {
      out(`### Verwechslungs-Richtungen — Δ`);
      out();
      out(
        `_Neu aufgetauchte Richtungen haben "Alt"=0, verschwundene haben "Neu"=0. ` +
          `Da beide Reports mit unabhängigen Zufalls-Stichproben arbeiten, sind kleine ` +
          `Schwankungen (±1-2) normal — erst durchgehende Trends sind aussagekräftig._`,
      );
      out();
      table(["von → nach", "Alt", "Neu", "Δ"], pairRows);
    }
  }
}

out(`---`);
out();
out(
  `_Diff-Tool: \`scripts/taxonomy/diagnose-diff.mjs\`. Rein textbasiert (kein DB-Zugriff) — ` +
    `funktioniert mit jedem Paar strukturell gleicher \`diagnose.mjs\`-Reports._`,
);

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(OUT_FILE, lines.join("\n"), "utf8");

console.log(`[diagnose-diff] Dokumente: ${oldTotal} → ${newTotal} (${signed(newTotal - oldTotal)})`);
if (sonstOld || sonstNew) {
  console.log(
    `[diagnose-diff] sonstiges: ${sonstOld?.n ?? 0} → ${sonstNew?.n ?? 0} (${signed((sonstNew?.n ?? 0) - (sonstOld?.n ?? 0))})`,
  );
}
if (rechnOld || rechnNew) {
  console.log(
    `[diagnose-diff] finanzen-rechnungen: ${rechnOld?.n ?? 0} → ${rechnNew?.n ?? 0} ` +
      `(${signed((rechnNew?.n ?? 0) - (rechnOld?.n ?? 0))})`,
  );
}
console.log(`[diagnose-diff] Report geschrieben: ${path.relative(path.join(__dirname, "..", ".."), OUT_FILE)}`);
