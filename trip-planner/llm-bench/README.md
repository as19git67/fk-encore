# Lokales Modell gegen Claude API — die Messung aus §11.0

`docs/ios-urlaubsplanung.md` §11 überlegt, was sich änderte, wenn statt des
lokalen Modells die Claude API zur Verfügung stünde. §11.0 macht daraus eine
Auflage:

> Vor jeder Entscheidung für die kostenpflichtige Spur gehört deshalb **erst
> die lokale gemessen** — sonst kauft man Qualität ein, die man schon hat.

Das hier ist diese Messung. Sie beantwortet **eine** der vier Aufgaben aus
§11.1, nämlich das **Anfrageverständnis**: Ein Satz geht hinein, Planungsvorgaben
kommen heraus (`POST /trip-planner/interpret`).

## Ausführen

```bash
# beide Spuren
npx tsx trip-planner/llm-bench/run.ts

# nur eine
npx tsx trip-planner/llm-bench/run.ts --track=local
npx tsx trip-planner/llm-bench/run.ts --track=claude

# Rohdaten mitschreiben
npx tsx trip-planner/llm-bench/run.ts --json=out.json
```

Voraussetzungen — eine fehlende Spur wird übersprungen, nicht zum Abbruch:

| Spur | braucht |
| --- | --- |
| `local` | erreichbaren `llm-service` (`LLM_SERVICE_URL`) **und** `INTERNAL_SERVICE_SECRET` |
| `claude` | `ANTHROPIC_API_KEY` in der Umgebung |
| beide | die Kategorienliste — aus dem geo-Dienst, oder `--categories=<datei.json>` |

### Vom Entwicklungsrechner aus, wenn der Stack in Docker läuft

`llm_service` veröffentlicht **keinen** Host-Port; im Compose-Netz hört er auf
`llm_service:8000`. Von außen erreichbar wird er über eine
`docker-compose.override.yml`:

```yaml
services:
  llm_service:
    ports:
      - "127.0.0.1:8002:8000"
```

Danach `docker compose up -d llm_service`, und:

```bash
export LLM_SERVICE_URL=http://localhost:8002
export INTERNAL_SERVICE_SECRET=…   # derselbe Wert wie in der .env des Stacks
```

Der Dienst weist jede Anfrage ohne `Authorization: Bearer
$INTERNAL_SERVICE_SECRET` mit 401 ab (`llm-service/service_auth.py`). Der
Header wird angehängt, indem `lib/internal-service-auth.ts` beim Import
`fetch` überschreibt — die Encore-Dienste holen ihn sich über ihre
`encore.service.ts`, der Bench importiert ihn selbst.

Die Kategorienliste ohne laufenden geo-Dienst:

```bash
npx tsx -e "import {POI_CATEGORIES} from './geo/src/poi-categories.ts'; \
  console.log(JSON.stringify(POI_CATEGORIES.map(c=>({id:c.id,description:c.description}))))" \
  > /tmp/cats.json
```

Kosten der Cloud-Spur: zehn Sätze, je ein paar tausend Token Eingabe. Das ist
ein Bruchteil eines Cent — die Messung ist billiger als die Entscheidung, sie
nicht zu machen.

## Warum das Ergebnis etwas bedeutet

Drei Dinge sind mit Absicht so gebaut:

- **Beide Spuren bekommen denselben Prompt** (`buildInterpretPrompt`, der aus
  der Produktion). Ein Vergleich, in dem jede Seite ihren eigenen Prompt
  bekommt, misst Prompt-Engineering.
- **Beide Antworten laufen durch `normalizeConstraints`.** Ein rohes Modell
  gegen ein validiertes zu stellen, schmeichelt dem validierten.
- **Die Kategorienliste kommt aus dem geo-Dienst**, nicht aus einer Kopie in
  diesem Verzeichnis. Eine zweite Wahrheit driftet.

## Was gezählt wird — und was nicht addiert wird

| Spalte | Bedeutung |
| --- | --- |
| **richtig** | Der Satz hat es gesagt, das Modell hat es gelesen. |
| **verpasst** | Der Satz hat es gesagt, das Modell hat es weggelassen. |
| **falsch** | Der Satz hat es gesagt, das Modell hat etwas anderes gelesen. |
| **erfunden** | Der Satz hat es **nicht** gesagt, das Modell liefert es trotzdem. |
| **ohne Antwort** | Die Spur konnte nicht antworten (Dienst weg, Schlüssel fehlt, kein JSON). |

„erfunden" bekommt bewusst eine eigene Spalte und geht in keine Gesamtnote
ein. §13s Regel lautet *„ein fehlendes Feld ist besser als ein erfundenes"* —
eine Spur, die mehr liest **und** mehr erfindet, hat nicht offensichtlich
gewonnen. Ein Modell, das „normal" als Tempo einträgt, weil die meisten Reisen
normal sind, hat nicht geraten, sondern dem Reisenden etwas in den Mund gelegt.

`interests` und `title` werden gezeigt, aber nicht bewertet: Beides ist
freier Text, und „barock" gegen „Barockarchitektur" zu punkten misst
Rechtschreibung.

## Der erste Lauf (2026-09-10)

`gemma-4-26B-A4B-it-qat` gegen `claude-opus-5` (niedriger Effort):

| | richtig | erfunden | Median |
| --- | --- | --- | --- |
| lokal | **96 %** (26/27) | **0** | **1005 ms** |
| Claude API | 93 % (25/27) | 1 | 2173 ms |

Die Spur, die nichts kostet, hat gewonnen. Ein Feld Unterschied bei 27
bewerteten Feldern ist Rauschen — die Aussage ist nicht „lokal ist besser",
sondern **„es gibt keinen Rückstand einzukaufen"**. Details und Folgerungen in
§11.0 des Konzepts.

## Die Fälle

Zehn Sätze, alle frei erfunden (keine echten Personen, Adressen oder Reisen),
entlang der Achsen, an denen §11.1 einen Unterschied erwartet:

- **plain** — alles steht da. Ein Fehler hier ist ein kaputter Prompt, kein
  schwaches Modell.
- **indirect** — der Satz meint ein Feld, ohne es zu nennen („mit dem
  Kinderwagen", „schlecht zu Fuß"). Hier fiel das kleine Modell historisch um.
- **restraint** — der Satz sagt **wenig**, und richtig ist, den Rest leer zu
  lassen.
- **trap** — etwas sieht aus wie ein Feld und ist keines: eine Jahreszahl, die
  keine Tageszahl ist; ein Startort, der nicht das Ziel ist.

## Die zweite Messung: die Kuration (§11.3)

```bash
npx tsx trip-planner/llm-bench/run-curation.ts
```

Dieselben Voraussetzungen, **drei** Spuren statt zwei — denn hier ist der
Amtsinhaber kein Modell:

| Spur | was sie ist |
| --- | --- |
| `scoring` | was der Planer heute tut: gewichtete Summe über OSM-Tags (`candidates.ts`), oben abgeschnitten — **mit** den Interessen des Falls, sonst wäre es eine Strohpuppe |
| `local` | dasselbe Prompt an das Modell im Haus |
| `claude` | dasselbe Prompt an die Claude API |

**Drei Anfragen über einen Vorrat** von 34 erfundenen Orten — 10, 8 und 5
sollen gewählt werden. Ein Vorrat und drei Sätze statt drei Vorräte ist das
Experiment, nicht die Abkürzung: Die Achse, an der sich die Modelle im ersten
Lauf schieden, war nicht, welche Orte sie kennen, sondern **ob sie den Satz
hören**. Dieselben 34 Orte haben drei verschiedene richtige Antworten — was
beim Kind falsch ist (Weinberg, Theater), ist beim Kunst-Wochenende richtig. Der Vorrat
ist um die vier Dinge gebaut, die eine Kuration falsch machen kann und die man
**zählen** kann:

| Fehlgriff | was er ist |
| --- | --- |
| **erfunden** | eine Referenz, die es im Vorrat nicht gibt (§10.4) |
| **Alltag** | Dinge, die es gibt, statt Dinge, zu denen man geht — zwei davon mit Wikipedia-Artikel, genau dort ist die Tag-Summe blind |
| **Einerlei** | mehr als zwei von sechs austauschbaren Dorfkirchen |
| **nichts fürs Kind** | die Anfrage nennt ein siebenjähriges Kind |
| **überhört** | ein Thema, das der Satz verlangt, bekommt **gar keinen** Ort |

„Überhört" ist die eine geschmacksfreie Regel in diesem Bereich: „zu wenig
Geschichte" ist ein Argument, „der Satz sagte Geschichte und die Auswahl hat
keine" ist ein Versehen. Genau daran schieden sich die Spuren im ersten Lauf,
ohne dass eine Zahl es bemerkte.

Die Themenabdeckung je Wunsch wird daneben **berichtet** (`geschichte 5 ·
draussen 5 · kinder 3`) und nicht bewertet — dünn ist ein Argument, nicht ein
Fehler.

Daneben zwei **beschreibende** Zahlen, ausdrücklich keine Noten: wie viele der
offensichtlichen Ziele gefunden wurden und über wie viele Kategorien die Auswahl
streut. Eine Auswahl darf ein Ziel auslassen; sie darf nicht sechs Kirchen sein.

Das Prompt sagt bewusst **nicht**, worauf zu achten ist — kein „vermeide
mehrere ähnliche Kirchen". Die Frage ist ja gerade, ob ein Modell das von
selbst bemerkt; ein Prompt, das es vorsagt, misst Gehorsam.

**Ergebnis (2026-09-11, drei Anfragen):** gewichtete Summe **2** Fehlgriffe
(13/24 Ziele, Median 1 ms) · lokal **0** (7/24, 5,3 s) · Claude **0** (10/24,
7,4 s). Beide Modelle über alle drei Anfragen sauber; sie unterscheiden sich
darin, wie viel vom Ort sie stehen lassen — die lokale Spur wählt das Passende
und lässt das Bedeutende liegen. Deutung in §11.0 des Konzepts.

**Und ein Fehler in dieser Messung, den der zweite Lauf fand:** „nichts fürs
Kind" galt unbedingt — auch im Fall „zu zweit, ohne Kinder", wo Weinberg und
Theater richtig sind. Die Regel greift jetzt nur, wenn ein Kind mitfährt. Vorher
stand die lokale Spur mit 3 Fehlgriffen da, die sie nicht gemacht hatte.

**Ein Befund fällt schon ohne Modell an:** Bei zehn gesuchten Orten liegen
**18 Kandidaten punktgleich** auf 3,0 — die Punktzahl besteht aus einer
Handvoll Halbpunkt-Signale, und alles mit Wikidata-Eintrag und Artikel landet
auf derselben Zahl. Wo der Schnitt in so einen Gleichstand fällt, entscheidet
die **Reihenfolge, in der die Regionssuche geantwortet hat**. Der Lauf misst
das mit: Bei umgekehrter Vorratsreihenfolge bleiben 8 von 10 Orten dieselben,
und die Fehlgriffe steigen von 1 auf 3.

## Die dritte Messung: der Verhandlungs-Chat (§11.3, Weg 3)

```bash
npx tsx trip-planner/llm-bench/run-chat.ts
```

§11.3 formuliert die Aufgabe selbst: *„Aus ‚zu viel Laufen' wird ein
Werkzeugaufruf mit sichtbarer Wirkung statt einer Umschreibung."* Gemessen wird
genau das — Plan plus ein Satz hinein, **welcher Aufruf folgt** heraus.

Acht Werkzeuge, die vorhandenen Endpunkten entsprechen (`constraint_setzen`,
`spot_entfernen`, `spot_verbergen`, `anheften`, `neu_verteilen`,
`vorrat_durchsuchen`) — und zwei, die keine Aktion sind und den interessanten
Teil ausmachen: **`rueckfrage`** (der Satz sagt nicht, worauf er sich bezieht)
und **`nichts`** (der Satz verlangt keine Änderung).

Zehn Sätze, darunter drei, bei denen Handeln falsch ist: „Der Tag ist zu voll"
(drei Tage im Plan — raten ist der teure Fehler), „Wie wird das Wetter am
Mittwoch?" und „Super, danke". Gezählt wird:

| | |
| --- | --- |
| **getroffen** | der erwartete Aufruf, mit dem Argument, das ihn identifiziert |
| **verfehlt** | fehlt oder falsches Subjekt — ein `ref` ist eine Identität, kein Formulierungsdetail |
| **übergriffig** | ein Aufruf, den der Fall ausschließt |

„Übergriffig" wird **getrennt** gezählt und nie durch einen Treffer aufgewogen:
Ein Modell, das „das ist mir zu viel Laufen" beantwortet, indem es zusätzlich
drei Spots löscht, hat hinter jemandes Rücken die Reise geändert (§7.1). Das
kostet Vertrauen, nicht Zeit.

**Hier gibt es keinen Amtsinhaber.** Einen Chat hat der Planer nicht;
`interpretRequest` deckt vielleicht ein Drittel der Fälle ab und kann weder
anheften noch neu verteilen. Die Frage ist deshalb nicht „besser als bisher",
sondern **„gut genug, um an einen Plan gelassen zu werden"**.

Eine Grenze dieses Laufs: Beide Spuren bekommen JSON-im-Prompt statt einer
echten Tool-Use-Schnittstelle — der lokale Dienst hat keine, und einer Seite
die bessere Schnittstelle zu geben hieße, Schnittstellen zu messen. Claudes
natives Tool-Use ist robuster als JSON in Prosa.

## Was diese Messung nicht beantwortet

- **Die Dokumentenauswertung** — und die bleibt auch ungemessen: §11.3 hat sie
  entschieden, und zwar dagegen. Dokumente verlassen das Haus nicht.
- **Ob eine Kuration *gut* ist.** Der Lauf zählt Fehlgriffe, nicht Geschmack.
  Zwei Auswahlen ohne Fehlgriff können unterschiedlich klug sein, und das
  entscheidet ein Mensch, der die Liste liest.
- **Ob die Cloud-Spur gebaut werden sollte.** Das ist die Frage aus §11.5, und
  sie ist keine technische: Ein Kurationsaufruf schickt Vorlieben und
  Gruppenzusammensetzung außer Haus. Diese Messung sagt nur, wie groß der
  Qualitätsunterschied überhaupt ist, den man dafür eintauschen würde.
- **Was unterwegs passiert.** §11.1s harte Regel bleibt: Die Cloud darf nie auf
  dem kritischen Pfad des Umplanens liegen. `claude-client.ts` wird von keinem
  Endpunkt aufgerufen, und das ist kein Versehen.
