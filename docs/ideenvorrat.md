# Ideenvorrat — die Sammlung ohne Reise

Stand: 2026-09-11 · Status: Backend vollständig, iOS-Oberfläche gebaut
(zwei Wege hinein und die Veranstaltungen ausgenommen — §6)

Ausführliche Begründung und Entwurf: `docs/ios-urlaubsplanung.md` §20.
Dieses Dokument beschreibt, **was gebaut ist** — Endpunkte, Datenmodell,
Regeln — damit man es benutzen kann, ohne 3 600 Zeilen Konzept zu lesen.

## 1. Was es ist

Alles Übrige im Urlaubsplaner braucht eine Reise: anlegen, Ort nennen, Tage
bekommen. Das ist die Hälfte, die man *plant*, und die seltenere. Die
häufigere ist die, die man *sammelt* — der Biergarten, den jemand erwähnt
hat, die Ausstellung im Nachbarort, der Weg, der zweimal aufkam. Dinge ohne
Datum, ohne Stadt, ohne Rahmen.

Der Baustein dafür gab es längst: Der Etappenvorrat (§5) ist eine bewertete
Liste von Möglichkeiten, die zufällig an einer Etappe hängt. Der Ideenvorrat
ist dieselbe Liste ohne sie.

Zwei Eigenschaften unterscheiden ihn von einer Merkliste:

- **Er ist geteilt** — eine Liste, in die die Familie schreibt, keine Kopie je
  Person. Jeder Eintrag trägt, wer ihn hineingelegt hat, denn „Papa wollte da
  hin" ist die halbe Information.
- **Er ist ortsbezogen, nicht listenförmig.** Eine Sammlung, die nur eine Liste
  ist, wird gelesen, bis sie zu lang ist, und danach nie wieder. Der Nutzen
  entsteht, wenn sie sich **von selbst meldet** — und daraus einen Nachmittag
  vorschlägt.

## 2. Status auf einen Blick

| Teil | Stand |
| --- | --- |
| Sammeln, Auflisten, Entfernen, Teilen | gebaut (`trip-planner/ideas.ts`) |
| Nähe-Meldung mit Ruhezeit, „nicht jetzt" | gebaut (`trip-planner/outing.ts`) |
| Ausflugsvorschlag aus mehreren Ideen | gebaut (`trip-planner/outing.ts`) |
| Die drei Wege zwischen Vorrat und Reise | gebaut (`trip-planner/ideas-trip.ts`) |
| Veranstaltungen mit Gültigkeitsfenster | Spalten da, Quelle fehlt — §20.4, vorerst nicht gebaut |
| Bildschirm: Liste, Merken, Entfernen, Teilen | gebaut (`TripIdeasView`) |
| Wege hinein: eigener Standort, geteilter Kartenlink | gebaut (`TripMapLink`) |
| Bildschirm „In der Nähe" samt „nicht jetzt" | gebaut (`TripIdeasNearbyView`) |
| Ausflugsvorschlag samt Übernahme als Reise | gebaut (`TripIdeasOutingView`) |
| Angebot in der Reise + „für später merken" | gebaut (`TripPlanIdeasView`, Vorrat-Wischgeste) |
| Die Meldung **von selbst** (Standortschleife) | gebaut (`TripIdeaNoticeMonitor`), **standardmäßig aus** |
| Wege hinein: Artikel, Suche | **nicht gebaut** — brauchen eine Reise (§9.3), siehe §6 |

Der Einstieg steht: In der Urlaubsplanung führt „Ideen" auf eine Liste je
Sammlung — mit Notiz, mit „wer hat's gemerkt", mit Hinweis auf Einträge, die
die Karte nicht kennt. Hinein kommen **der Ort, an dem man gerade steht**, und
ein **geteilter Kartenlink** (Apple Maps, auch als Kurzlink — der wird
aufgelöst); Artikel und Suche aus §9.2 fehlen und werden hier bewusst nicht
gebaut (§6).

Die drei Wege zwischen Vorrat und Reise stehen alle: der angenommene
**Ausflugsvorschlag** als eintägige Reise, das **Angebot in der Reise**
(„Aus dem Vorrat" im Menü der Tageskarte) und **„für später merken"** als
Wischgeste im Etappenvorrat. „In der Nähe" gibt es als **Frage** (ein
Bildschirm, den man öffnet, und der deshalb keine Ruhezeit verbraucht) und als
**Meldung von selbst** — letztere ist ein Schalter im Menü und standardmäßig
**aus**.

## 3. Datenmodell

Migration `0179_idea_pool.sql`, zwei Tabellen.

**`idea_pool`** spiegelt `trip_plan_pool` absichtlich Spalte für Spalte, minus
`leg_id` und plus drei Dinge, die eine stehende Sammlung braucht:

- `owner_id`, `created_by` — wem die Sammlung gehört, wer diesen Eintrag
  hineingelegt hat.
- `valid_from`, `valid_to` — für etwas, das endet (eine Ausstellung bis
  Sonntag). Beide `null` für den Normalfall: einen Ort, den es einfach gibt.
- `last_suggested_at`, `dismissed_count` — die Buchführung, die „einmal
  gemeldet" haltbar macht.

Ein eindeutiger Index auf `(owner_id, osm_ref)`: derselbe Biergarten, zweimal
erwähnt, ist **eine** Idee.

**`idea_pool_shares`** hat dieselbe Form wie die Teilnehmerliste einer Reise
(§6.2) — Personen, kein Rechte-Raster. Ein Haushalt ist eine Liste von
Menschen.

## 4. Endpunkte

Alle unter `/trip-planner`, alle mit `auth: true` und der Berechtigung
`photos.view`. `ownerId` ist überall optional und meint standardmäßig die
eigene Sammlung.

### 4.1 Die Sammlung selbst (`ideas.ts`)

| Aufruf | Was er tut |
| --- | --- |
| `POST /ideas` | Idee hinzufügen |
| `GET /ideas` | Einträge plus die Sammlungen, auf die man Zugriff hat |
| `POST /ideas/remove` | Eintrag löschen |
| `POST /ideas/share` | jemanden per E-Mail-Adresse hineinlassen |
| `POST /ideas/unshare` | jemanden wieder hinausnehmen |

Der Weg hinein ist **derselbe wie bei einem Fund** (§9.2), nicht ein zweiter:
Koordinate, optional Name, Notiz, Herkunft. Im Umkreis von **80 m** wird der
passende OSM-Eintrag gesucht; findet sich keiner, wird die eine erlaubte Frage
gestellt (`dwellMinutes` — wie lange?), statt eine Dauer zu erfinden. Der
Eintrag ist dann als `unmatched` markiert, und die Antwort nennt unter
`unknown` in Klartext, was nicht bekannt ist (§15.3).

Eine zweite Erwähnung desselben Orts wird **zusammengeführt** und ergänzt nur,
was sie mitbringt — was beim ersten Mal jemand geschrieben hat, überschreibt
sie nie (`merged: true` in der Antwort).

Wer in einer Sammlung ist, darf auch etwas herausnehmen: §6.2 gibt dem
Organisator drei Rechte, und das ist keines davon.

Eine Sammlung, in die niemand hineingelassen wurde, existiert für Fremde
**nicht** — `not_found`, nicht `permission_denied`. Was einem nicht gehört,
ist auch nicht zu wissen, dass es das gibt.

### 4.2 Der Vorrat meldet sich (`outing.ts`)

| Aufruf | Was er tut |
| --- | --- |
| `POST /ideas/nearby` | „Ist etwas von uns hier in der Nähe?" |
| `POST /ideas/dismiss` | „Nicht jetzt." |
| `POST /ideas/outing` | „Soll ich daraus einen Nachmittag machen?" |

**Nähe.** Nach Entfernung sortiert, mit `addedBy` — „der Biergarten, den Anna
gemerkt hat" ist die Form, die §20 verlangt. Standardradius 5 km, maximal
100 km.

> **Zurückgegeben zu werden ist gemeldet worden.** Der Zeitstempel wird beim
> Ausliefern gesetzt, nicht wenn eine App zurückmeldet, sie habe es angezeigt —
> eine App, die das vergisst, machte die Regel still wirkungslos. Danach ist
> **eine Woche Ruhe** (`QUIET_DAYS = 7`). Wer nur die Liste nach Entfernung
> sehen will, schickt `markSuggested: false`; ein Bildschirm ist nicht dasselbe
> wie eine Meldung.

Was im Radius liegt, aber bewusst nicht angeboten wurde, wird als `quiet`
**gezählt statt aufgelistet** — die Zahl ist ehrlich, die Liste wäre Lärm.

**Weggewischt.** `dismiss` zählt hoch und lässt den Eintrag stehen. Nach drei
„nicht jetzt" (`DISMISSALS_UNTIL_QUIET = 3`) schweigt er — aber er ist weiter
im Vorrat, denn „raus damit" hat niemand gesagt (§7.1 merkt sich ein Nein,
statt es zu löschen).

**Der Ausflug.** Der Punkt, an dem aus einer Merkliste ein Planer wird: Liegen
mehrere Einträge dicht genug beieinander, ist die Frage nicht „willst du zu
diesem?", sondern „soll ich daraus einen Nachmittag machen?". Die Antwort ist
ein Aufruf von `solveDay` mit dem Standort als Anker, **einem** Block über das
Zeitbudget und dem Vorrat als Kandidaten (Standardradius 25 km — ein
Tagesausflugsradius —, Standardbudget 240 Minuten, Standardverkehrsmittel
Auto). Ein Ausflug ist ein Block, keine
Vierteilung — die gehört zum Urlaub, nicht zum Samstagnachmittag.

Vier Entscheidungen, die dabei getroffen wurden:

- **Gesammeltes zuerst.** Ideen gehen mit Startbonus (`score: 10`) in die
  Auswahl und stehen damit vor dem, was die Regionssuche auffüllt. Beides ist
  im Ergebnis als `fromIdeas` markiert, damit „von uns" und „gefunden"
  unterscheidbar bleiben.
- **Auffüllen ist erlaubt, aber abschaltbar** (`fillFromRegion: false`).
- **Das Beinlimit ist ein Fuß-Budget.** Die 40 Minuten des Planers sind
  innerhalb einer Stadt die richtige Absage und für einen Ausflug die falsche:
  Eine halbe Stunde im Auto ist der Weg zum See, kein Umweg. Für Auto und ÖPNV
  gelten deshalb 90 Minuten je Etappe, zu Fuß und mit dem Rad bleibt es bei 40.
- **Abgelaufene Termine werden gar nicht erst betrachtet.** Eine Ausstellung,
  die am Sonntag zu Ende war, ist keine Idee mehr.

Die Antwort sagt auch, wenn nichts geht (`offered: false`, `reason:
no-ideas | nothing-fits`) und wie viel wegfiel (`leftOut`). Ein Ausflug, der
passt, ist kürzer als der, den jemand wollte.

### 4.3 Zwischen Vorrat und Reise (`ideas-trip.ts`)

Kein zweiter Mechanismus, sondern eine Quelle mehr — drei Richtungen, alle
über vorhandene Wege:

| Aufruf | Richtung |
| --- | --- |
| `POST /ideas/outing/accept` | Vorschlag → **neue eintägige Reise** |
| `GET /plans/:planId/ideas` | „Ihr habt vier Ideen für Lissabon gesammelt" |
| `POST /plans/:planId/ideas/take` | Idee → **Etappenvorrat** dieser Reise |
| `POST /plans/:planId/pool/to-ideas` | Übriggebliebenes → **zurück** in die Sammlung |

**Angenommener Ausflug.** Eine ganz normale eintägige Reise mit einer Etappe
und einem Block. Der Tag wird bewusst erst ausgeplant, **nachdem** die
angenommenen Ideen im Vorrat liegen — sonst plante er sich aus der
Regionssuche und die Ideen kämen hinterher. Die Antwort nennt getrennt, was
auf dem Tag landete (`planned`) und was im Vorrat blieb (`inPool`).

**Beim Anlegen einer Reise** wird angeboten, was in einer ihrer Etappen liegt —
sortiert nach Etappe und Entfernung, mit „wer hat's gemerkt". **Übernommen
wird nichts von selbst:** Eine Idee vom letzten Jahr ist nicht automatisch der
Wunsch dieser Reise. Was schon in der Reise ist, wird markiert
(`alreadyInTrip`) statt versteckt — dass es da ist, ist die Antwort auf
dieselbe Frage.

**Zurück in den Vorrat** schiebt, was auf der Reise niemand gesehen hat.
„Beim nächsten Mal" ist die ehrlichste Ablage für einen Spot, der es nicht in
den Plan geschafft hat. Schon Gesammeltes ist dabei kein Fehler, sondern wird
gezählt und gemeldet (`alreadyThere`).

**In allen drei Richtungen bleibt die Idee stehen** — sie ist nicht
verbraucht, nur benutzt.

## 5. Ein Detail, das Ärger macht, wenn man es übersieht

Ein Ort, den die Karte nicht kennt, bekommt als Fund eine **neue**
`manual:`-Referenz. Die eigene Referenz der Idee taugt danach nicht mehr zum
Wiedererkennen. „Schon in der Reise" wird deshalb über dieselben **80 Meter**
entschieden, mit denen `finds.ts` zwei Einträge denselben Ort nennt — eine
andere Zahl hier ließe denselben Biergarten gleichzeitig „schon dabei" und
„Dublette" sein.

## 6. Was fehlt

- **Zwei Wege hinein**: Artikel und Suche. Beide brauchen die Regionssuche
  bzw. das Sprachmodell und hängen deshalb an einer Reise (§9.3) — im Vorrat
  ohne Reise wären sie ein Versprechen auf eine Lesart, die hier niemand
  leisten kann. Alles Übrige aus §20 steht.
- **Veranstaltungen** (§20.4) — vorerst nicht gebaut, weil es keine Quelle
  gibt, die den Anspruch aushält. Die Spalten (`valid_from`, `valid_to`) und
  die Filterung abgelaufener Einträge stehen; ein Termin ist dann ein
  gewöhnlicher Eintrag mit Gültigkeitsfenster, und Nähe, Ausflug und Übernahme
  gelten unverändert.

## 7. Wo der Code liegt

| Datei | Inhalt |
| --- | --- |
| `trip-planner/ideas.ts` | Sammlung: anlegen, lesen, entfernen, teilen |
| `trip-planner/outing.ts` | Nähe, „nicht jetzt", Ausflugsvorschlag |
| `trip-planner/ideas-trip.ts` | die drei Wege zwischen Vorrat und Reise |
| `db/migrations/postgres/0179_idea_pool.sql` | `idea_pool`, `idea_pool_shares` |
| `trip-planner/ideas.test.ts`, `outing.test.ts`, `ideas-trip.test.ts` | Tests |
| `ios/Sources/FKPhotos/Features/TripPlanner/TripIdea*.swift` | Liste, Modelle, ViewModel |
