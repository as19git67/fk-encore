/**
 * The negotiation chat, as something that can be scored (§11.3, Weg 3).
 *
 * §11.3 puts it precisely: the model should *operate the planner* rather
 * than talk about it — *„Aus ‚zu viel Laufen' wird ein Werkzeugaufruf mit
 * sichtbarer Wirkung statt einer Umschreibung."* That makes the
 * measurable question narrow and fair: given the plan as it stands and
 * one sentence from a traveller, **which call follows?**
 *
 * The tools below mirror endpoints that exist (`plans.ts`,
 * `redistribute.ts`, `pool.ts`, `fixpoints.ts`); the names are the
 * German ones §11.3 uses, because that is the surface the model would
 * see. Three answers are deliberately not calls, and they are the
 * interesting part:
 *
 *   - **`rueckfrage`** — the sentence does not say enough to act on.
 *     A model that guesses which day "der ist zu voll" means has done
 *     the one thing a plan cannot recover from silently.
 *   - **`nichts`** — nothing to do: the sentence is conversation, or it
 *     asks about something the planner does not decide.
 *   - …and **no second call nobody asked for.** "Zu viel Laufen" is one
 *     setting, not a licence to also drop three spots.
 */

export interface ToolSpec {
  name: string;
  description: string;
  args: Record<string, string>;
}

export const CHAT_TOOLS: readonly ToolSpec[] = [
  {
    name: "constraint_setzen",
    description:
      "Eine Planungsvorgabe ändern: pace (relaxed|normal|packed), maxWalkMinutes "
      + "(Zahl), withChildren/limitedMobility (true|false). Plant die betroffenen "
      + "Tage selbst neu — neu_verteilen ist danach überflüssig.",
    args: { feld: "string", wert: "string | number | boolean" },
  },
  {
    name: "spot_entfernen",
    description: "Einen Spot aus dem Plan nehmen; er wandert zurück in den Vorrat.",
    args: { ref: "osmRef aus dem Plan" },
  },
  {
    name: "spot_verbergen",
    description:
      "Einen Spot dauerhaft ausblenden, damit er bei neuer Planung nicht wiederkommt. "
      + "Nimmt ihn zugleich aus dem Plan und rechnet den Tag neu — spot_entfernen "
      + "und neu_verteilen sind danach überflüssig.",
    args: { ref: "osmRef" },
  },
  {
    name: "anheften",
    description: "Einen Spot festnageln, damit das Umverteilen ihn liegen lässt.",
    args: { ref: "osmRef" },
  },
  {
    name: "neu_verteilen",
    description: "Einen Tag neu rechnen, nachdem sich etwas geändert hat.",
    args: { tag: "Tagesindex, 0-basiert" },
  },
  {
    name: "vorrat_durchsuchen",
    description: "Im Vorrat nach etwas suchen, das noch nicht im Plan steht.",
    args: { kategorie: "z. B. museum, cafe, outdoors" },
  },
  {
    name: "rueckfrage",
    description:
      "Nachfragen, statt zu raten — wenn der Satz nicht sagt, worauf er sich bezieht.",
    args: { frage: "die eine Frage" },
  },
  {
    name: "nichts",
    description: "Nichts tun: Der Satz verlangt keine Änderung am Plan.",
    args: {},
  },
];

/** The plan every case talks about, short enough to fit in one prompt. */
export const CHAT_PLAN = {
  title: "Oberfeld, drei Tage",
  pace: "normal",
  maxWalkMinutes: 40,
  days: [
    {
      index: 0,
      date: "2026-05-04",
      blocks: [
        { label: "Vormittag", stops: [
          { ref: "way:1", name: "Stiftskirche Sankt Kolomann", kategorie: "worship" },
          { ref: "way:2", name: "Stadtmuseum im Kornhaus", kategorie: "museum" },
        ] },
        { label: "Nachmittag", stops: [
          { ref: "way:3", name: "Burgruine Hohenwald", kategorie: "sight" },
        ] },
      ],
    },
    {
      index: 1,
      date: "2026-05-05",
      blocks: [
        { label: "Vormittag", stops: [
          { ref: "way:9", name: "Galerie im Torbogenhaus", kategorie: "museum" },
          { ref: "way:13", name: "Kunstverein Salzstadel", kategorie: "museum" },
          { ref: "way:18", name: "Uhrenmuseum Kleinberg", kategorie: "museum" },
        ] },
        { label: "Nachmittag", stops: [
          { ref: "way:4", name: "Aussichtsturm Lindenberg", kategorie: "viewpoint" },
          { ref: "way:16", name: "Stadtpark Rosenau", kategorie: "outdoors" },
        ] },
      ],
    },
    {
      index: 2,
      date: "2026-05-06",
      blocks: [
        { label: "Vormittag", stops: [
          { ref: "way:6", name: "Tierpark Auwiesen", kategorie: "zoo" },
        ] },
        { label: "Nachmittag", stops: [] },
      ],
    },
  ],
} as const;

export interface ExpectedCall {
  tool: string;
  /** Only the arguments that decide whether the call is the right one. */
  args?: Record<string, string | number | boolean>;
}

export interface ChatCase {
  id: string;
  utterance: string;
  /**
   * What should happen. Several entries mean several calls are right
   * *together*.
   */
  expected: ExpectedCall[];
  /**
   * A second answer that is just as defensible.
   *
   * The first run forced this: asked to drop two of three museums, the
   * sentence never says *which* two. Picking one is a fair reading and
   * so is asking — and a rule that rewarded only the first was
   * rewarding a guess.
   */
  orElse?: ExpectedCall[];
  /**
   * Calls that would be wrong here even though they look helpful. The
   * failure §7.1 cares about: doing more than was asked.
   */
  forbidden?: string[];
  note: string;
}

export const CHAT_CASES: readonly ChatCase[] = [
  {
    id: "zu-viel-laufen",
    utterance: "Das ist mir zu viel Laufen.",
    expected: [{ tool: "constraint_setzen", args: { feld: "maxWalkMinutes" } }],
    forbidden: ["spot_entfernen", "spot_verbergen"],
    note: "§11.3s eigenes Beispiel: eine Vorgabe, nicht drei gestrichene Spots.",
  },
  {
    id: "gemuetlicher",
    utterance: "Bitte insgesamt etwas gemütlicher.",
    expected: [{ tool: "constraint_setzen", args: { feld: "pace", wert: "relaxed" } }],
    forbidden: ["spot_entfernen"],
    note: "Tempo ist ein Feld mit drei Werten; „gemütlich\" ist einer davon.",
  },
  {
    id: "drei-museen",
    utterance: "Am zweiten Tag sind mir drei Museen am Vormittag zu viel — eins reicht.",
    expected: [{ tool: "spot_entfernen" }, { tool: "neu_verteilen", args: { tag: 1 } }],
    orElse: [{ tool: "rueckfrage" }],
    note: "Der Satz nennt den Tag und die Menge — aber nicht, welches Museum bleibt. "
      + "Eines wählen ist eine faire Lesart, nachfragen auch.",
  },
  {
    id: "zu-voll-welcher-tag",
    utterance: "Der Tag ist zu voll.",
    expected: [{ tool: "rueckfrage" }],
    forbidden: ["spot_entfernen", "neu_verteilen", "constraint_setzen"],
    note: "Drei Tage im Plan, einer gemeint — raten ist hier der teure Fehler.",
  },
  {
    id: "burg-bleibt",
    utterance: "Die Burgruine bleibt auf jeden Fall drin.",
    expected: [{ tool: "anheften", args: { ref: "way:3" } }],
    forbidden: ["spot_entfernen", "neu_verteilen"],
    note: "Ein Wunsch, der etwas schützt, statt etwas zu ändern.",
  },
  {
    id: "kunstverein-nie",
    utterance: "Den Kunstverein will ich nicht, auch nicht bei einer Neuplanung.",
    expected: [{ tool: "spot_verbergen", args: { ref: "way:13" } }],
    note: "„Auch nicht später\" ist der Unterschied zwischen entfernen und verbergen.",
  },
  {
    id: "cafe-gesucht",
    utterance: "Ist im Vorrat noch ein Café für den letzten Nachmittag?",
    expected: [{ tool: "vorrat_durchsuchen", args: { kategorie: "cafe" } }],
    forbidden: ["spot_entfernen", "constraint_setzen"],
    note: "Eine Frage an den Vorrat, keine Änderung am Plan.",
  },
  {
    id: "wetterfrage",
    utterance: "Wie wird denn das Wetter am Mittwoch?",
    expected: [{ tool: "nichts" }],
    forbidden: ["constraint_setzen", "neu_verteilen", "spot_entfernen"],
    note: "Beantwortet wird das woanders; der Plan ändert sich davon nicht.",
  },
  {
    id: "danke",
    utterance: "Super, danke — sieht gut aus.",
    expected: [{ tool: "nichts" }],
    forbidden: ["constraint_setzen", "neu_verteilen", "spot_entfernen", "anheften"],
    note: "Zustimmung ist kein Auftrag. Ein Modell, das hier etwas tut, ist gefährlich.",
  },
  {
    id: "oma-kommt-mit",
    utterance: "Meine Mutter kommt doch mit, sie ist schlecht zu Fuß.",
    expected: [
      { tool: "constraint_setzen", args: { feld: "limitedMobility", wert: true } },
    ],
    note: "Eine Gruppenangabe, aus der der Planer den Rest selbst zieht.",
  },
];
