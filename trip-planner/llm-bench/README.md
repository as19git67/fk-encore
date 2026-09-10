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
| `scoring` | was der Planer heute tut: gewichtete Summe über OSM-Tags (`candidates.ts`), oben abgeschnitten |
| `local` | dasselbe Prompt an das Modell im Haus |
| `claude` | dasselbe Prompt an die Claude API |

Aus einem Vorrat von 34 erfundenen Orten sollen 10 gewählt werden. Der Vorrat
ist um die vier Dinge gebaut, die eine Kuration falsch machen kann und die man
**zählen** kann:

| Fehlgriff | was er ist |
| --- | --- |
| **erfunden** | eine Referenz, die es im Vorrat nicht gibt (§10.4) |
| **Alltag** | Dinge, die es gibt, statt Dinge, zu denen man geht — zwei davon mit Wikipedia-Artikel, genau dort ist die Tag-Summe blind |
| **Einerlei** | mehr als zwei von sechs austauschbaren Dorfkirchen |
| **nichts fürs Kind** | die Anfrage nennt ein siebenjähriges Kind |

Daneben zwei **beschreibende** Zahlen, ausdrücklich keine Noten: wie viele der
offensichtlichen Ziele gefunden wurden und über wie viele Kategorien die Auswahl
streut. Eine Auswahl darf ein Ziel auslassen; sie darf nicht sechs Kirchen sein.

Das Prompt sagt bewusst **nicht**, worauf zu achten ist — kein „vermeide
mehrere ähnliche Kirchen". Die Frage ist ja gerade, ob ein Modell das von
selbst bemerkt; ein Prompt, das es vorsagt, misst Gehorsam.

**Ein Befund fällt schon ohne Modell an:** Bei zehn gesuchten Orten liegen
**18 Kandidaten punktgleich** auf 3,0 — die Punktzahl besteht aus einer
Handvoll Halbpunkt-Signale, und alles mit Wikidata-Eintrag und Artikel landet
auf derselben Zahl. Wo der Schnitt in so einen Gleichstand fällt, entscheidet
die **Reihenfolge, in der die Regionssuche geantwortet hat**. Der Lauf misst
das mit: Bei umgekehrter Vorratsreihenfolge bleiben 8 von 10 Orten dieselben,
und die Fehlgriffe steigen von 1 auf 3.

## Was diese Messung nicht beantwortet

- **Die übrigen zwei Aufgaben aus §11.1** — Dokumentenauswertung und
  Verhandlungs-Chat.
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
