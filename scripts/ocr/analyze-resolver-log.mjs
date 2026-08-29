/**
 * Tesseract vs. PaddleOCR an echten Dokumenten auswerten.
 *
 * Der synthetische Korpus (measure.mjs) misst Erkennungsqualität an bekannten
 * Sollwerten — dafür braucht er ein Node-Environment und gerenderte Crops.
 * Dieses Skript wertet stattdessen aus, was der Resolver in Produktion ohnehin
 * protokolliert: für jeden unsicheren Span beide Lesungen nebeneinander.
 *
 * Ohne Sollwert lässt sich nicht sagen, wer recht hat. Messbar sind aber die
 * Fehlerklassen selbst — und genau die entscheiden über einen Primärtausch:
 *
 *   - Abdeckung:   wie oft liefert Paddle überhaupt eine Lesung?
 *   - Kürzung:     wie oft ist Paddles Lesung ein Präfix der längeren?
 *   - Dezimaltrenner: wie oft wird aus `1.234,56` ein `1.234.56`?
 *   - Diakritika:  wer erkennt Umlaute und ß, wer verliert sie?
 *   - Konfidenz:   sind die beiden Skalen überhaupt vergleichbar?
 *
 * Aufruf (Logzeilen als JSONL auf stdin oder als Dateiargument):
 *
 *     docker compose logs --no-color app | grep -o '{"bbox".*}' > spans.jsonl
 *     node scripts/ocr/analyze-resolver-log.mjs spans.jsonl
 *
 * Braucht nur Node-Builtins, läuft also auch in jedem beliebigen Container.
 */

import fs from "node:fs";

/** Eine Zahl mit deutschem Dezimalkomma, wie sie auf Belegen steht. */
const GERMAN_AMOUNT = /\d{1,3}(?:\.\d{3})*,\d{2}/;
/** Dieselbe Zahl, nachdem das Komma zum Punkt geworden ist. */
const DECIMAL_AS_DOT = /\d{1,3}(?:\.\d{3})+\.\d{2}/;
const DIACRITIC = /[äöüÄÖÜßéèêáàâ]/;

function read(source) {
  const raw = source ? fs.readFileSync(source, "utf8") : fs.readFileSync(0, "utf8");
  const spans = [];
  for (const line of raw.split("\n")) {
    const start = line.indexOf('{"bbox"');
    if (start < 0) continue;
    try {
      spans.push(JSON.parse(line.slice(start)));
    } catch {
      // Eine abgeschnittene Zeile (Log-Rotation, Terminal-Umbruch) ist kein
      // Grund, den ganzen Lauf aufzugeben.
    }
  }
  return spans;
}

/**
 * Dieselbe Schwelle wie `tooSmallToRead` in documents/ocr-uncertainty.ts.
 *
 * Bewusst als zwei Kantenlängen statt als Fläche: ein 1x27px breiter
 * Tabellenstrich hat 27px² und ist genauso entartet wie ein Punkt, während ein
 * schmales `1` mit 5x15px nur 75px² hat und echter Text ist. Eine Flächen-
 * schwelle verwirft das eine oder behält das andere — beides falsch.
 *
 * Weicht dieses Skript von der Pipeline ab, meldet es einen Rest, der keiner
 * ist. Bei einer Änderung dort also hier mitziehen.
 */
const MIN_SPAN_WIDTH = 4;
const MIN_SPAN_HEIGHT = 8;

const tooSmallToRead = (b) =>
  b.right - b.left < MIN_SPAN_WIDTH || b.bottom - b.top < MIN_SPAN_HEIGHT;

function main() {
  const spans = read(process.argv[2]);
  if (spans.length === 0) {
    console.error("Keine resolver-span-Zeilen gefunden. DOCUMENTS_OCR_RESOLVER_DEBUG=1 gesetzt?");
    process.exit(1);
  }

  const pairs = [];
  let tessOnly = 0;
  let degenerate = 0;
  const conf = { tesseract: [], paddleocr: [] };

  for (const span of spans) {
    // Ein Span von wenigen Pixeln deckt sich per Flächenanteil mit jeder
    // Zeile, die ihn enthält — solche Treffer sagen nichts über die Engine.
    // Seit dem Filter in findUncertainSpans muss das 0 sein; steht hier etwas
    // anderes, läuft ein Container mit älterem Code.
    if (tooSmallToRead(span.bbox)) degenerate++;
    const t = span.candidates.find((c) => c.source === "tesseract");
    const p = span.candidates.find((c) => c.source === "paddleocr");
    if (t) conf.tesseract.push(t.confidence);
    if (p) conf.paddleocr.push(p.confidence);
    if (!p) { tessOnly++; continue; }
    if (t) pairs.push({ span, t, p });
  }

  const differ = pairs.filter(({ span }) => span.decision !== "ocr_agreement");
  const paddleWonByConfidence = differ.filter(({ span, p }) => span.final_text === p.text);

  const truncated = differ.filter(
    ({ t, p }) => t.text.length > p.text.length + 3 && t.text.startsWith(p.text.slice(0, 12)),
  );
  const commaLost = differ.filter(
    ({ t, p }) => GERMAN_AMOUNT.test(t.text) && DECIMAL_AS_DOT.test(p.text),
  );
  const diacriticGained = differ.filter(
    ({ t, p }) => !DIACRITIC.test(t.text) && DIACRITIC.test(p.text),
  );
  const diacriticLost = differ.filter(
    ({ t, p }) => DIACRITIC.test(t.text) && !DIACRITIC.test(p.text),
  );

  const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const pct = (n) => `${((n / spans.length) * 100).toFixed(1)} %`;

  console.log(`Spans gesamt                    ${spans.length}`);
  console.log(`  davon entartet (Speck)        ${degenerate}  ${pct(degenerate)}`);
  console.log(`  ohne Paddle-Lesung            ${tessOnly}  ${pct(tessOnly)}`);
  console.log(`  mit beiden Lesungen           ${pairs.length}  ${pct(pairs.length)}`);
  console.log(`    davon uneinig               ${differ.length}`);
  console.log(`    davon Paddle übernommen     ${paddleWonByConfidence.length}`);
  console.log("");
  console.log(`Mittlere Konfidenz  Tesseract   ${mean(conf.tesseract).toFixed(3)}`);
  console.log(`                    PaddleOCR   ${mean(conf.paddleocr).toFixed(3)}`);
  console.log("");
  console.log("Fehlerklassen unter den Uneinigen (ohne Sollwert messbar):");
  console.log(`  Paddle kürzt die Zeile        ${truncated.length}`);
  console.log(`  Dezimalkomma → Punkt          ${commaLost.length}`);
  console.log(`  Paddle gewinnt Diakritikum    ${diacriticGained.length}`);
  console.log(`  Paddle verliert Diakritikum   ${diacriticLost.length}`);

  if (process.argv.includes("--pairs")) {
    console.log("\n--- Paare zur Beurteilung ---");
    for (const { span, t, p } of differ) {
      console.log(`T(${t.confidence.toFixed(2)}) ${JSON.stringify(t.text)}`);
      console.log(`P(${p.confidence.toFixed(2)}) ${JSON.stringify(p.text)}`);
      console.log(`      → ${JSON.stringify(span.final_text)}\n`);
    }
  }
}

main();
