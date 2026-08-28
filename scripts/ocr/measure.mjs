#!/usr/bin/env node
/**
 * OCR-Messkorpus: misst Tesseract, PaddleOCR und den VLM-Resolver gegen
 * dieselben synthetischen Crops und meldet die Zeichenfehlerrate (CER).
 *
 * Zweck: die eine Frage zu beantworten, die vor jedem Umbau der Pipeline steht
 * — welche Engine liest die Fälle besser, an denen die aktuelle scheitert?
 * Ohne diese Zahl ist ein Primärtausch (Tesseract → PaddleOCR) eine Wette, und
 * die Entscheidung, ob der VLM-Pfad seinen Preis wert ist, unbelegbar.
 *
 * ## Warum synthetisch
 *
 * Echte Dokumente dürfen nicht ins Repo (siehe die PII-Regel in CLAUDE.md).
 * Der Korpus wird deshalb bei jedem Lauf aus SVG gerendert: reproduzierbar,
 * ohne Binärdateien in git, und mit bekanntem Soll-Text — was ihn überhaupt
 * erst messbar macht. Die Degradationen (Rauschen, Weichzeichnen, Grauschleier,
 * niedrige Auflösung) bilden die Fehlerklassen nach, an denen die Pipeline in
 * Produktion scheitert.
 *
 * Der Korpus ersetzt keine Messung an echten Scans. Er beantwortet, welche
 * Engine auf *diesen* Fehlerklassen besser liest — was für eine Rangfolge
 * genügt und ohne echte Daten auskommt.
 *
 * ## Aufruf
 *
 *     node scripts/ocr/measure.mjs                 # nur Tesseract
 *     node scripts/ocr/measure.mjs --paddle        # zusätzlich PaddleOCR
 *     node scripts/ocr/measure.mjs --paddle --vlm  # zusätzlich das VLM
 *     node scripts/ocr/measure.mjs --keep out/     # gerenderte Crops behalten
 *
 * Braucht `tesseract` im PATH. --paddle braucht RECEIPT_OCR_SERVICE_URL,
 * --vlm braucht LLM_SERVICE_URL mit geladenem mmproj.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";

const RECEIPT_OCR_SERVICE_URL = (
  process.env.RECEIPT_OCR_SERVICE_URL || "http://localhost:8003"
).replace(/\/$/, "");
const LLM_SERVICE_URL = (process.env.LLM_SERVICE_URL || "http://localhost:8002").replace(/\/$/, "");

/**
 * Der Korpus. Jeder Eintrag ist eine Zeile, wie sie auf einem deutschen
 * Geschäftsdokument steht, plus die Beeinträchtigung, unter der sie gelesen
 * werden muss. Alle Werte sind frei erfunden.
 */
const CORPUS = [
  // Die auslösende Fehlerklasse: gesperrt gedrucktes Datum in Versalien.
  { id: "date-spaced", text: "23 AUG 02", context: "Rechnungsdatum", degrade: "blur" },
  { id: "date-spaced-noisy", text: "14 SEP 09", context: "Rechnungsdatum", degrade: "noise" },
  { id: "date-numeric", text: "23.08.2002", context: "Datum", degrade: "blur" },
  { id: "date-small", text: "01.12.2024", context: "Buchungstag", degrade: "small" },

  // Beträge — hier ist eine falsche „Korrektur" am teuersten.
  { id: "amount", text: "7.500,00", context: "Betrag EUR", degrade: "blur" },
  { id: "amount-noisy", text: "1.234,56", context: "Summe", degrade: "noise" },
  { id: "amount-gray", text: "20,11", context: "Gesamt", degrade: "gray" },

  // Struktur mit langen Ziffernfolgen: kein Sprachmodell hilft, nur Optik.
  { id: "iban", text: "DE00 0000 0000 0000 0000 00", context: "IBAN", degrade: "small" },
  { id: "iban-gray", text: "DE00 1111 2222 3333 4444 55", context: "IBAN", degrade: "gray" },
  { id: "docnumber", text: "#100234", context: "Beleg", degrade: "noise" },
  { id: "contract", text: "R-00000000-00", context: "Versicherungsnummer", degrade: "blur" },

  // Fließtext als Kontrolle: hier ist Tesseract stark, und ein VLM, das hier
  // etwas „verbessert", ist ein Warnsignal.
  { id: "prose", text: "Sehr geehrte Damen und Herren", context: "", degrade: "blur" },
  { id: "prose-gray", text: "Wir bestaetigen den Eingang Ihrer Zahlung", context: "", degrade: "gray" },
  { id: "address", text: "Beispielstrasse 1", context: "Anschrift", degrade: "small" },
  { id: "city", text: "12345 Musterstadt", context: "", degrade: "noise" },
];

/** Ein Lesen, das gar nicht zustande kam — zählt nicht als schlechte Lesung. */
function failed(reading) {
  return typeof reading === "string" && reading.startsWith("<error:");
}

/**
 * Zeichenfehlerrate: Levenshtein-Distanz normiert auf die Soll-Länge.
 * `null` für einen Aufruf, der fehlgeschlagen ist — eine nicht erreichbare
 * Engine als „1200 % Fehlerrate" auszuweisen würde die Tabelle unlesbar machen
 * und einen Ausfall wie ein Qualitätsproblem aussehen lassen.
 */
function cer(expected, actual) {
  if (failed(actual)) return null;
  const a = expected.trim();
  const b = (actual ?? "").trim();
  if (a.length === 0) return b.length === 0 ? 0 : 1;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[b.length] / a.length;
}

function escapeXml(value) {
  return value.replace(/[<>&"']/g, (c) =>
    ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c],
  );
}

/**
 * Eine Zeile rendern — mit Beschriftung darüber, denn genau dieser Kontext ist
 * das, was der Crop-Rand dem VLM mitgibt. Ohne ihn misst man eine andere
 * Aufgabe als die, die in der Pipeline gestellt wird.
 */
async function render(entry) {
  const width = 900;
  const height = 200;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <rect width="100%" height="100%" fill="white"/>
    ${entry.context ? `<text x="60" y="70" font-family="DejaVu Sans, sans-serif" font-size="26" fill="#333">${escapeXml(entry.context)}</text>` : ""}
    <text x="60" y="130" font-family="DejaVu Sans, sans-serif" font-size="34" fill="black" letter-spacing="2">${escapeXml(entry.text)}</text>
  </svg>`;

  // Die Stärken sind empirisch eingestellt: schwächer, und Tesseract löst
  // alles fehlerfrei — dann misst der Korpus nichts. Stärker, und keine Engine
  // liest mehr etwas, was ebenso wenig aussagt. Gesucht ist das Regime
  // dazwischen, in dem Tesseract in genau der Weise scheitert, wie es bei
  // echten Scans tut: einzelne Zeichen falsch, nicht die Zeile verloren.
  let image = sharp(Buffer.from(svg)).greyscale();
  switch (entry.degrade) {
    case "blur":
      // Weiche Kanten wie bei einem leicht unscharfen Einzug.
      image = image.resize({ width: Math.round(width * 0.34) }).blur(1.1);
      break;
    case "noise": {
      // Körniges Papier: Rauschen, das die dünnen Striche zerlegt.
      //
      // In zwei Durchgängen, weil sharp innerhalb einer Pipeline erst skaliert
      // und dann kompositiert — die Rauschkachel wäre sonst größer als das
      // Bild, auf das sie gelegt wird.
      const noisy = await image
        .composite([{ input: await noiseTile(width, height), blend: "overlay" }])
        .png()
        .toBuffer();
      image = sharp(noisy).resize({ width: Math.round(width * 0.36) }).blur(0.8);
      break;
    }
    case "gray":
      // Grauschleier wie bei getöntem Papier — der Fall, für den
      // ocr-preprocess.ts seine Normalisierung hat.
      image = image.linear(0.32, 130).resize({ width: Math.round(width * 0.38) }).blur(0.9);
      break;
    case "small":
      // Kleingedrucktes bei 200 dpi: die Klasse, in der eine Zeile nur noch
      // wenige Pixel hoch ist und ein VLM den größten Vorsprung hat.
      image = image.resize({ width: Math.round(width * 0.26) }).blur(0.6);
      break;
    default:
      break;
  }
  return image.png().toBuffer();
}

async function noiseTile(width, height) {
  const pixels = Buffer.alloc(width * height);
  for (let i = 0; i < pixels.length; i++) {
    pixels[i] = 128 + Math.round((Math.random() - 0.5) * 90);
  }
  return sharp(pixels, { raw: { width, height, channels: 1 } }).png().toBuffer();
}

function runTesseract(imagePath, outBase) {
  return new Promise((resolve, reject) => {
    const lang = process.env.DOCUMENTS_OCR_LANG ?? "deu+eng";
    const proc = spawn("tesseract", [imagePath, outBase, "-l", lang, "--psm", "6", "txt"], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("error", reject);
    proc.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`tesseract exited ${code}: ${stderr}`)),
    );
  });
}

/**
 * Nur die Zeile aus der Tesseract-Ausgabe, die dem Soll am nächsten kommt.
 * Das Bild enthält absichtlich auch die Beschriftung; gemessen wird der Wert.
 */
function bestLine(text, expected) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return "";
  return lines.reduce((best, line) => (cer(expected, line) < cer(expected, best) ? line : best));
}

async function paddleRead(imageBuffer, expected) {
  const form = new FormData();
  form.append("file", new Blob([imageBuffer], { type: "image/png" }), "crop.png");
  const res = await fetch(`${RECEIPT_OCR_SERVICE_URL}/ocr/page`, { method: "POST", body: form });
  if (!res.ok) throw new Error(`paddle ${res.status}`);
  const body = await res.json();
  return bestLine(body.full_text ?? "", expected);
}

async function vlmRead(imageBuffer, hint, expectedType) {
  const res = await fetch(`${LLM_SERVICE_URL}/vision/transcribe`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      image_b64: imageBuffer.toString("base64"),
      image_mime: "image/png",
      ...(hint ? { hint } : {}),
      ...(expectedType ? { expected_type: expectedType } : {}),
    }),
  });
  if (!res.ok) throw new Error(`vlm ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()).text ?? "";
}

function mean(values) {
  const usable = values.filter((v) => v !== null);
  return usable.length === 0 ? null : usable.reduce((a, b) => a + b, 0) / usable.length;
}

function pct(value) {
  return value === null ? "n/a" : `${(value * 100).toFixed(1)}%`;
}

async function main() {
  const args = process.argv.slice(2);
  const withPaddle = args.includes("--paddle");
  const withVlm = args.includes("--vlm");
  const keepIndex = args.indexOf("--keep");
  const keepDir = keepIndex >= 0 ? args[keepIndex + 1] : null;

  const tmpDir = keepDir ?? (await fs.promises.mkdtemp(path.join(os.tmpdir(), "fk-ocr-corpus-")));
  await fs.promises.mkdir(tmpDir, { recursive: true });

  const rows = [];
  for (const entry of CORPUS) {
    const png = await render(entry);
    const imagePath = path.join(tmpDir, `${entry.id}.png`);
    await fs.promises.writeFile(imagePath, png);

    const row = { id: entry.id, expected: entry.text, degrade: entry.degrade };

    const outBase = path.join(tmpDir, `${entry.id}-tess`);
    try {
      await runTesseract(imagePath, outBase);
      const txt = await fs.promises.readFile(`${outBase}.txt`, "utf8");
      row.tesseract = bestLine(txt, entry.text);
    } catch (err) {
      row.tesseract = `<error: ${err.message}>`;
    }

    if (withPaddle) {
      try {
        row.paddleocr = await paddleRead(png, entry.text);
      } catch (err) {
        row.paddleocr = `<error: ${err.message}>`;
      }
    }
    if (withVlm) {
      try {
        // Mit dem Tesseract-Lesen als Hinweis — genau so ruft der Resolver an.
        row.vlm = await vlmRead(png, row.tesseract, null);
      } catch (err) {
        row.vlm = `<error: ${err.message}>`;
      }
    }
    rows.push(row);
  }

  const engines = ["tesseract", ...(withPaddle ? ["paddleocr"] : []), ...(withVlm ? ["vlm"] : [])];

  console.log(`\nOCR-Korpus: ${CORPUS.length} Zeilen, Crops in ${tmpDir}\n`);
  const width = Math.max(...rows.map((r) => r.id.length));
  console.log(
    `${"id".padEnd(width)}  ${engines.map((e) => e.padEnd(10)).join(" ")}  erwartet`,
  );
  for (const row of rows) {
    const cells = engines.map((e) => pct(cer(row.expected, row[e])).padEnd(10));
    console.log(`${row.id.padEnd(width)}  ${cells.join(" ")}  ${row.expected}`);
  }

  console.log("\nMittlere Zeichenfehlerrate:");
  for (const engine of engines) {
    const scores = rows.map((r) => cer(r.expected, r[engine]));
    const measured = scores.filter((s) => s !== null).length;
    const perfect = scores.filter((s) => s === 0).length;
    console.log(
      `  ${engine.padEnd(10)} CER ${pct(mean(scores))}   fehlerfrei ${perfect}/${measured}` +
        (measured < rows.length ? `   (${rows.length - measured} Aufruf(e) fehlgeschlagen)` : ""),
    );
  }

  console.log("\nLesungen im Detail:");
  for (const row of rows) {
    const wrong = engines.filter((e) => {
      const score = cer(row.expected, row[e]);
      return score === null || score > 0;
    });
    if (wrong.length === 0) continue;
    console.log(`  ${row.id} (${row.degrade}) erwartet ${JSON.stringify(row.expected)}`);
    for (const engine of wrong) {
      console.log(`    ${engine.padEnd(10)} ${JSON.stringify(row[engine])}`);
    }
  }

  if (!keepDir) {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
