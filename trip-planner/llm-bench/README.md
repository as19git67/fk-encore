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

## Was diese Messung nicht beantwortet

- **Die anderen drei Aufgaben aus §11.1** — Kandidatenkuration,
  Dokumentenauswertung, Verhandlungs-Chat. Die Kuration ist laut §11.3 der
  größte erwartete Sprung und braucht einen eigenen Aufbau (ganzer Stadtvorrat
  in einer Anfrage).
- **Ob die Cloud-Spur gebaut werden sollte.** Das ist die Frage aus §11.5, und
  sie ist keine technische: Ein Kurationsaufruf schickt Vorlieben und
  Gruppenzusammensetzung außer Haus. Diese Messung sagt nur, wie groß der
  Qualitätsunterschied überhaupt ist, den man dafür eintauschen würde.
- **Was unterwegs passiert.** §11.1s harte Regel bleibt: Die Cloud darf nie auf
  dem kritischen Pfad des Umplanens liegen. `claude-client.ts` wird von keinem
  Endpunkt aufgerufen, und das ist kein Versehen.
