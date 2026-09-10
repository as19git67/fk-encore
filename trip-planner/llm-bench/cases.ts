/**
 * The sentences the two tracks are measured on (§11.0).
 *
 * Written rather than collected, and deliberately so: every one of them
 * has a *known* right answer, which is what makes the comparison a
 * measurement instead of a reading of tea leaves. They are also
 * completely synthetic — no real people, no real addresses, no real
 * trips (see the repository's PII rule).
 *
 * The cases are chosen along the axes where §11.1 expects the two
 * tracks to differ:
 *
 *   - **plain** — everything stated outright. Both tracks should manage
 *     these; a miss here is a broken prompt, not a weak model.
 *   - **indirect** — the sentence implies a field without naming it
 *     ("mit dem Kinderwagen" → withChildren; "meine Mutter kommt mit
 *     dem Rollator" → limitedMobility). This is where a small model
 *     historically fell over.
 *   - **restraint** — the sentence says *little*, and the right answer
 *     is to leave the rest empty. §13's rule: a missing field beats an
 *     invented one. A model that fills in "normal" pace because most
 *     trips are normal is wrong here, and it is the failure that costs
 *     a traveller a wrong trip rather than a correction.
 *   - **trap** — something that looks like a field and is not: a number
 *     that is not a day count, a place that is not the destination.
 */

import type { ExpectedConstraints } from "./score";

export type CaseKind = "plain" | "indirect" | "restraint" | "trap";

export interface BenchCase {
  id: string;
  kind: CaseKind;
  text: string;
  expected: ExpectedConstraints;
  /** Why this case exists, for the report. */
  note: string;
}

export const BENCH_CASES: readonly BenchCase[] = [
  {
    id: "plain-augsburg",
    kind: "plain",
    text: "Wir sind vier Tage in Augsburg, mit einem Kind, eher gemütlich.",
    expected: { placeHint: "Augsburg", days: 4, pace: "relaxed", withChildren: true },
    note: "Das Beispiel aus §13, Wort für Wort.",
  },
  {
    id: "plain-museums",
    kind: "plain",
    text: "Drei Tage Museen und Kirchen in Bamberg, straffes Programm.",
    expected: {
      placeHint: "Bamberg",
      days: 3,
      pace: "packed",
      categories: ["museum", "worship"],
    },
    note: "Zwei Kategorien wörtlich genannt.",
  },
  {
    id: "indirect-pram",
    kind: "indirect",
    text: "Zwei Tage Regensburg, wir sind mit dem Kinderwagen unterwegs.",
    expected: { placeHint: "Regensburg", days: 2, withChildren: true },
    note: "Kinderwagen sagt Kind, ohne das Wort zu benutzen.",
  },
  {
    id: "indirect-walker",
    kind: "indirect",
    text: "Eine Woche Lindau. Meine Mutter kommt mit und ist schlecht zu Fuß, mehr als zehn Minuten am Stück gehen wir nicht.",
    expected: {
      placeHint: "Lindau",
      days: 7,
      limitedMobility: true,
      maxWalkMinutes: 10,
    },
    note: "„Eine Woche\" ist sieben Tage, und die Gehstrecke steht als Zahl im Satz.",
  },
  {
    id: "restraint-bare",
    kind: "restraint",
    text: "Wir wollen nach Passau.",
    expected: { placeHint: "Passau" },
    note: "Der Satz sagt einen Ort und sonst nichts. Alles Weitere wäre erfunden.",
  },
  {
    id: "restraint-pace-only",
    kind: "restraint",
    text: "Bitte nichts hetzen, wir haben Urlaub.",
    expected: { pace: "relaxed" },
    note: "Kein Ort, keine Tage — nur ein Tempo.",
  },
  {
    id: "trap-year",
    kind: "trap",
    text: "Nürnberg, wir fahren wie schon 2019 wieder hin, diesmal fünf Tage.",
    expected: { placeHint: "Nürnberg", days: 5 },
    note: "Zwei Zahlen im Satz; nur eine ist eine Tageszahl.",
  },
  {
    id: "trap-origin",
    kind: "trap",
    text: "Von Kempten aus wollen wir drei Tage in Füssen verbringen.",
    expected: { placeHint: "Füssen", days: 3 },
    note: "Der erste Ort ist der Start, nicht das Ziel.",
  },
  {
    id: "trap-no-car",
    kind: "trap",
    text: "Sechs Tage Konstanz, ohne Auto, viel zu Fuß, aber keine Gewaltmärsche.",
    expected: { placeHint: "Konstanz", days: 6, pace: "relaxed" },
    note: "„Ohne Auto\" ist ein Verkehrsmittel — es gibt kein Constraint-Feld dafür, also darf nichts anderes daraus werden.",
  },
  {
    id: "indirect-radius",
    kind: "indirect",
    text: "Zwei Tage Ulm, wir bleiben im Umkreis von zwei Kilometern um die Altstadt.",
    expected: { placeHint: "Ulm", days: 2, radiusM: 2000 },
    note: "Kilometer im Satz, Meter im Feld.",
  },
];
