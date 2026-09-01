# Urlaubsplanung („Spots & Blöcke") – Konzept

Stand: 2026-09-01 · Status: Ideensammlung / Vorentwurf (Leitentscheidungen in
§2 gesetzt, sonst offen)

## 1. Die Idee in einem Satz

Der Nutzer sagt in natürlicher Sprache, was er vorhat — *„ich bin vier Tage in
Lissabon"*, *„wir fahren von München nach Bozen und haben zwei Tage Zeit"* —
und bekommt daraufhin pro Tag **grobe Zeitblöcke mit je zwei bis vier Spots**
(Sehenswürdigkeit, Museum, Café, Aussichtspunkt) in sinnvoller Reihenfolge:
*„Vormittag: A → B → C, Nachmittag: D → E"*. Läuft der Tag anders als gedacht,
wird der Rest in Sekunden neu verteilt.

## 2. Vier Leitentscheidungen

Diese vier prägen alles Weitere und stehen deshalb vorne:

1. **Grobe Zeitblöcke statt Uhrzeiten.** Der Plan sagt „Vormittag: A, B, C",
   nicht „9:47 ab Haltestelle X". Alles Weitere folgt daraus — insbesondere
   entfällt der Zwang zu exakten Fahrplandaten.
2. **Umplanen ist der Normalfall, nicht die Ausnahme.** Ein Plan ist kein
   Drehbuch, das man abarbeitet, sondern ein Vorrat mit Reihenfolge. Das
   System muss jederzeit „wir sind noch bei B und es ist schon 14 Uhr"
   verarbeiten können, ohne dass der Nutzer neu plant.
3. **Die eigene Fotohistorie ist ein nettes Extra, keine Säule.** Am selben Ort
   schon einmal gewesen zu sein, ist der Ausnahmefall. Wo es zufällig zutrifft,
   ist es eine hübsche Notiz („hier wart ihr 2019") — es darf aber weder das
   Ranking tragen noch Voraussetzung für einen brauchbaren Plan sein. Für den
   Erstbesuch, also den Regelfall, muss das System ohne jede Historie
   vollständig funktionieren.
4. **Standort, Wetter und Licht sind erstklassige Eingaben.** Die App kennt den
   Standort und nutzt ihn aktiv. Niederschlag steuert, *was* geplant wird;
   Sonnenstand und Bewölkung steuern, *wann* — denn fk-encore plant nicht nur
   Besuche, sondern gute Fotos (§6).

## 3. Warum das kein Google-Maps-Klon wird

Google Maps ist bei **Live-Daten** (Verkehr, Echtzeit-ÖPNV, aktuelle
Öffnungszeiten, Bewertungen, Innenraumfotos) uneinholbar. Ein Nachbau dieser
Ebene wäre sinnlos. Der Unterschied liegt woanders: **Google Maps optimiert
eine Route, die man schon gewählt hat. Es beantwortet nicht die Frage, was
überhaupt in einen Nachmittag passt — und schon gar nicht, was davon
wegfällt, wenn man in Verzug gerät.** Genau das ist die Lücke.

### 3.1 Der Kern: Was passt in einen halben Tag?
Die eigentliche Planungsfrage ist nicht „wie komme ich von A nach B", sondern
„ich habe zwölf Kandidaten und einen Nachmittag — welche vier davon gehen sich
aus, ohne dass es Stress wird?". Google Maps kann das nicht beantworten; es
kann nur eine bereits getroffene Auswahl in eine Route legen. Dieses
Zuschneiden auf ein Zeitbudget ist der Kern des Features.

### 3.2 Umplanen ohne Neuplanen
Der Museumsbesuch dauert doppelt so lange, es regnet, das Kind ist müde, das
Restaurant hat zu. Ein Knopf **„wir sind hier, es ist jetzt"** rechnet den Rest
des Tages neu: Was nicht mehr passt, wandert nicht in den Papierkorb, sondern
in den Vorrat für morgen. Google Maps hat dafür kein Konzept — dort löscht man
Wegpunkte von Hand.

### 3.3 Der richtige Spot zur richtigen Tageszeit
Weil fk-encore eine Foto-App ist, plant der Trip Planer nicht nur Besuche,
sondern gute Fotos: Sonnenstand, Fassadenausrichtung und Bewölkung ergeben pro
Spot ein Lichtfenster, das die Reihenfolge im Block bestimmt und einen
Abendtermin vorschlagen kann (§6.3). Google Maps kennt Öffnungszeiten — aber
nicht, dass die Aussichtsterrasse erst ab halb acht lohnt.

### 3.4 Dokumente als Fixpunkte
Der documents-Service hat bereits OCR, Klassifikation und semantische Suche.
Hotelbestätigung, Bahnticket, Mietwagenvertrag, Museums-/Städtepass liegen also
**schon im Haus und sind maschinenlesbar**. Der Plan wird um reale Fixpunkte
gebaut: Hoteladresse als Tagesstart und -ende, Check-in-Zeit, Rückgabetermin
des Mietwagens, gebuchtes Zeitfenster für die Sagrada Família. Das kann Google
strukturell nicht, ohne dass man sein Postfach öffnet.

### 3.5 Mit wem gereist wird
Die Personenerkennung kennt die Reisegruppe. „Wir" ist nicht generisch: zwei
Kinder unter zehn → kürzere Blöcke, Pausen, keine drei Museen am Stück;
Großeltern dabei → Gehstrecke und Steigung als harte Nebenbedingung statt als
Sternchen-Hinweis. Das wirkt direkt auf das Zeitbudget eines Blocks.

### 3.6 Familienabstimmung mit vorhandener Mechanik
Das Album-Voting (Nutzer **und** KI stimmen über Fotos ab) ist eins zu eins auf
Spot-Kandidaten übertragbar: Jeder wischt vor der Reise durch die Vorschläge,
der Planer optimiert gegen die aggregierten Stimmen. Das zahlt sich vor allem
beim Umplanen aus — wenn etwas wegfallen muss, fällt zuerst weg, was der Gruppe
am wenigsten wichtig war. Google Maps hat Listen, aber keine Gruppenentscheidung,
die anschließend in eine Auswahl fließt.

### 3.7 Der Kreis schließt sich mit dem Trip Mode
`docs/ios-trip-mode.md` bringt Fotos des Tages automatisch ins Trip-Album. Ein
Plan plus dieses Album ergibt ohne Zusatzaufwand ein **Reisetagebuch**: geplante
Blöcke gegen tatsächlich Besuchtes, pro Stopp die dort entstandenen Fotos, und
am Ende ein Recap (`docs/recaps.md`), das bereits existiert.

### 3.8 Erklärbar, verhandelbar, werbefrei
Jeder Vorschlag trägt eine Begründung („20 Min. zu Fuß vom Hotel, passt in den
Vormittag, ihr mögt Aussichtspunkte"), jede Gewichtung ist verstellbar. Kein
bezahltes Ranking, keine gesponserten Einträge — bei einem selbst gehosteten
System keine Marketing-Aussage, sondern eine Eigenschaft der Architektur.

### 3.9 Offline und ohne Roaming
Die OSM-Regionsdatenbanken liegen ohnehin im Haus. Ein fertiger Plan lässt sich
komplett aufs iPhone laden und funktioniert im Ausland ohne Datenverbindung.
Weil grob geplant wird, ist auch der Offline-Plan vollwertig — es fehlen keine
Minutenangaben, die es ohnehin nie gab. Google Maps Offline-Karten können
navigieren, aber nicht planen.

### 3.10 Nachrang: die eigene Fotohistorie
Wo die Familie zufällig schon war, weiß der POI-Matcher (`poi-matcher.ts`,
DINOv2 + OSM + Wikidata) bereits. Das ergibt eine nette Anzeige beim
Wiederbesuch und einen kleinen Ranking-Bonus oder -Malus, den der Nutzer selbst
setzt („schon Gesehenes lieber wieder / lieber nicht"). Mehr nicht — siehe
Leitentscheidung 3.

**Fazit:** Nicht „besser als Google Maps", sondern **eine andere Ebene**: Google
navigiert, fk-encore teilt den Tag ein. Für Turn-by-turn wird bewusst per
Deep-Link an Apple/Google Maps übergeben.

## 4. Planungsgranularität: der Zeitblock

Ein Tag besteht aus **Blöcken**, nicht aus einem Zeitstrahl:

| Block | Default-Budget | typische Füllung |
|---|---|---|
| Vormittag | ca. 3,5 h | 2–3 Spots |
| Mittag | ca. 1,5 h | Essen (freie Wahl vor Ort) |
| Nachmittag | ca. 3,5 h | 2–3 Spots |
| Abend | optional | 1 Spot / Essen |

Die Budgets skalieren mit dem Tempo („entspannt" schrumpft sie, „viel sehen"
dehnt sie) und mit der Reisegruppe. Innerhalb eines Blocks gibt es eine
**Reihenfolge, aber keine Uhrzeiten**: „Vormittag: Kathedrale → Markthalle →
Aussichtsterrasse, zusammen ca. 3 h inkl. Wege".

**Reisezeiten werden nur klassifiziert, nicht berechnet:** „kurzer Fußweg"
(< 10 Min.), „längerer Fußweg" (10–25), „eine Fahrt" (ÖPNV/Auto, grob
geschätzt). Für den Block zählt nur die Summe gegen das Budget.

**Damit fällt der Zwang zu Fahrplandaten weg.** Eine ÖPNV-Fahrt wird zunächst
heuristisch geschätzt (Luftlinie ÷ typische Netzgeschwindigkeit + Zuschlag für
Warten und Umsteigen), im Innenstadtbereich ist das für eine Blockeinteilung
genau genug. Liegt für eine Region ein GTFS-Fahrplan vor, verfeinert er die
Schätzung — er ist aber **keine Voraussetzung** mehr, sondern Kür. Damit ist
das Feature auch außerhalb Deutschlands sofort brauchbar, wo GTFS-Feeds mühsam
zu beschaffen sind.

**Öffnungszeiten ebenfalls grob:** relevant ist nur, ob ein Spot „vormittags
offen" bzw. „montags zu" ist — das ist aus OSM verlässlicher zu holen als eine
minutengenaue Angabe und passt exakt zur Blockeinteilung.

Die Untergrenze der Genauigkeit ist bewusst gewählt: **lieber eine Aussage, die
stimmt, als eine Uhrzeit, die nicht hält.**

## 5. Umplanen als Kernmechanik

Ein Plan besteht aus drei Schichten:

- **Fixpunkte** — aus Dokumenten oder vom Nutzer angeheftet (Hotel-Check-in,
  gebuchtes Zeitfenster, Zugabfahrt). Werden nie automatisch verschoben.
- **Eingeplante Spots** — pro Block, mit Reihenfolge.
- **Vorrat** — bewertete Kandidaten der Region, die (noch) nicht eingeplant
  sind. Der Vorrat ist der Grund, warum Umplanen schnell geht: die Kandidaten
  sind bereits gesucht, bewertet und mit groben Reisezeiten versehen.

**Auslöser für eine Neuverteilung:**

- Der Nutzer tippt „wir sind hier, es ist jetzt".
- **Die App merkt es selbst** am Standort: die Gruppe hängt hinter dem Block
  zurück (§6.1). Sie *bietet* die Neuverteilung an, führt sie nicht ungefragt aus.
- **Die Wettervorhersage ändert sich** — aus dem trockenen Nachmittag wird ein
  nasser (§6.2).
- Ein Spot wird als erledigt, übersprungen oder als „hat länger gedauert"
  markiert.
- Eine Bedingung ändert sich per Chat: *„es regnet — was Drinnen"*, *„zu viel
  Laufen"*, *„wir haben keine Lust mehr auf Museen"*.

**Was dann passiert:** Nur der **Rest ab jetzt** wird neu verteilt, Vergangenes
bleibt unangetastet (es ist der Anfang des Reisetagebuchs). Was nicht mehr
passt, wird nicht gelöscht, sondern wandert in den Vorrat zurück — mit erhöhter
Priorität für die Folgetage, sofern noch welche da sind. Ausgeworfen wird
zuerst, was die niedrigsten Gruppenstimmen hat.

**Für den Nutzer sichtbar** ist immer nur die Konsequenz, nicht die Rechnung:
*„Der Nachmittag wird knapp — E fällt raus und rutscht auf morgen Vormittag."*
Mit Rückgängig-Knopf.

## 6. Standort, Wetter und Licht

Drei Umgebungssignale, die den Plan prägen. Alle drei sind grob genug, um zur
Blockeinteilung zu passen, und keins davon erzwingt eine Uhrzeit.

### 6.1 Standort

Die App kennt den Standort und nutzt ihn für vier Dinge:

- **Umplanen ohne Tippen.** Statt „wir sind hier, es ist jetzt" von Hand zu
  drücken, merkt die App selbst, dass die Gruppe noch beim zweiten von vier
  Spots steht, während der Block halb vorbei ist, und **bietet** eine
  Neuverteilung an. Angeboten, nicht durchgeführt — ungefragt umzuräumen wäre
  übergriffig.
- **Erledigt-Erkennung.** Wer länger als ein paar Minuten am Spot war, hat ihn
  gesehen; der Status setzt sich selbst und speist das Reisetagebuch.
- **„Was ist hier in der Nähe?"** — spontan, ohne Plan, aus demselben Vorrat.
- **Wegschätzung ab dem echten Standort** statt ab dem geplanten Punkt.

**Technisch batterieschonend:** kein Dauer-GPS, sondern Region Monitoring
(Geofences um die nächsten ein bis zwei Stopps) plus *significant location
change*. iOS weckt die App bei Bedarf; dazwischen kostet es praktisch nichts.
Der Trip Mode holt sich ohnehin schon eine `CLLocation` beim Start.

**Datenschutz:** Der Standort bleibt für die Planung auf dem Gerät — der Vorrat
liegt lokal, die Neuverteilung rechnet lokal (§8). Zum eigenen Server geht er
nur, wenn geteilt geplant wird; nach außen (Wetter) nur gerundet (§6.2).

### 6.2 Wetter, vor allem Niederschlag

Pro Tag und Block: erwartete **Niederschlagsmenge** (mm), Bewölkungsgrad,
Temperatur. Für die Planung reichen drei Klassen — trocken / etwas Regen /
nass — und die wirken so:

- Jeder Spot bekommt ein **Indoor/Outdoor-Attribut**, größtenteils direkt aus
  den OSM-Tags ableitbar (`tourism=museum|gallery`, `building=church` → drinnen;
  `tourism=viewpoint`, `leisure=park`, `natural=*` → draußen; Markt, Burgruine,
  Kreuzgang → teils).
- Ein Regenblock zieht Indoor-Spots nach vorn und schiebt Outdoor-Spots in den
  Vorrat — exakt die Mechanik aus §5, nur automatisch ausgelöst.
- Das **Blockbudget schrumpft** bei Nässe: mit Regenschirm und nassen Kindern
  ist man langsamer.
- Ein Regentag verschiebt sich als Ganzes: was heute nass wäre, wird auf einen
  trockenen Folgetag getauscht, solange noch Tage übrig sind.

**Quelle:** [Open-Meteo](https://open-meteo.com) — stündliche Werte für
`precipitation`, `cloud_cover` und `sunshine_duration`, ohne API-Schlüssel und
ohne Registrierung, weltweit. Für Deutschland alternativ Bright Sky (DWD).
`open-meteo.com` muss in die Netzwerk-Policy der Umgebung.

**Was das Haus verlässt:** ausschließlich eine auf ca. 5 km **gerundete**
Koordinate plus ein Datum. Das genügt für eine Stadtvorhersage und taugt nicht
als Bewegungsprofil. Die Antwort wird pro Ort und Tag zwischengespeichert, ein
Abruf pro Tag reicht.

### 6.3 Licht: wann die Fotos gut werden

Der Teil, den nur eine Foto-App bauen würde — und der Grund, warum ein
Abendblock überhaupt im Plan auftaucht.

**Der Sonnenstand ist reine Rechnung, keine API.** Aus Koordinate und Zeitpunkt
ergeben sich Höhe und Azimut der Sonne (Standardformeln, wie sie z. B. SunCalc
implementiert; auf Bruchteile eines Grades genau). Das läuft deterministisch
auf dem Server **und** offline auf dem Gerät. Daraus:

- **Goldene Stunde** — Sonnenhöhe etwa −4° bis +6°: warmes, flaches Licht.
- **Blaue Stunde** — etwa −6° bis −4°: beleuchtete Gebäude gegen blauen Himmel.
- **Harte Mittagssonne** — hoher Stand: steile Schatten, für Fassaden meist der
  schlechteste Moment, für Innenhöfe und Wasser dagegen gut.

**Verknüpft mit dem konkreten Spot** wird daraus eine Aussage statt einer
Allgemeinheit:

- Für Gebäude liefert die OSM-Geometrie die **Ausrichtung der Hauptfassade**
  (Normale der längsten Kante des Polygons). Steht die Sonne in diesem Halbraum,
  ist die Fassade frontbeleuchtet — eine Westfassade also abends.
- Für Aussichtspunkte trägt OSM häufig `direction=*`; sonst hilft die
  **Blickrichtung aus den eigenen Fotos**: der POI-Matcher verarbeitet den
  EXIF-Kompasskurs (`GPSImgDirection`) bereits (`osm-admin/poi-matcher.ts`).
  Wer nach Westen schaut, hat abends Gegenlicht — je nach Geschmack Sonnenuntergang
  oder Blendung.
- **Die Bewölkung aus §6.2 moduliert das Ganze:** bei geschlossener Decke ist
  die goldene Stunde wertlos, dafür ist das diffuse Licht ideal für Innenhöfe,
  Wald, Details und Fassaden ohne Schattenkanten. Bei klarem Himmel gilt das
  Umgekehrte.

**Wie es in den Plan einfließt — bewusst zurückhaltend:**

1. **Reihenfolge im Block.** Der Aussichtspunkt rutscht ans Ende des
   Nachmittags, die schattige Gasse in die Mittagszeit. Kostet nichts, ändert
   die Auswahl nicht.
2. **Ein kleiner Ranking-Bonus**, wenn ein Spot ohnehin im Vorrat konkurriert.
3. **Ein Vorschlag für einen Abendblock**: *„Die Aussichtsterrasse liegt heute
   von ca. 19:30 bis 20:10 im besten Licht — als Abendtermin einplanen?"*
4. **Ein Hinweis auf der Spot-Karte**, sonst nichts.

Dass das Lichtfenster minutengenau ist, während der Plan grob bleibt, ist kein
Widerspruch zu Leitentscheidung 1: Es ist ein **Hinweis, kein Termin**. Eine
Uhrzeit, die man verpassen kann, entsteht erst, wenn der Nutzer Vorschlag 3
annimmt — und dann hat er sie selbst gewollt. Abschaltbar in einem Schalter, denn
nicht jede Reise soll sich nach dem Sonnenstand richten.

## 7. Wie sich das in der iOS-App anfühlt

### 7.1 Einstieg
Im bestehenden **Trip**-Tab kommt neben „Aufnehmen" (Trip Mode) ein zweiter
Bereich **„Planen"** dazu. Beides sind Ansichten desselben Trips: erst planen,
dann unterwegs anpassen und fotografieren, danach der Rückblick.

### 7.2 Eingabe
Ein Textfeld plus Chips für das, was das LLM nicht raten soll:

```
„4 Tage Lissabon, mit Oma, wir mögen Aussicht und gutes Essen,
 kein Auto, entspanntes Tempo"
```

→ vom LLM in ein **striktes JSON-Constraint-Objekt** übersetzt und als
editierbare Chips gezeigt: `Ort: Lissabon` · `4 Tage` · `Modi: Fuß, ÖPNV` ·
`Tempo: entspannt` · `max. 4 km Gehstrecke/Tag` · `Interessen: Aussicht, Essen`.
Nichts wird stillschweigend angenommen. Erkannte Dokumente werden vorgeschlagen:
*„Ich habe eine Hotelbuchung für diesen Zeitraum gefunden — als Basis nehmen?"*

### 7.3 Ergebnis
Pro Tag eine **Karte je Block** (Vormittag / Mittag / Nachmittag / Abend), darin
die Spots als kompakte Zeile mit Referenzbild, geschätzter Aufenthaltsdauer und
Wegsymbol dazwischen. Darunter eine Auslastungsanzeige: „ca. 3 h von 3,5 h".
Kartenansicht mit nummerierten Pins pro Tag. „Warum hier?" pro Spot
aufklappbar.

### 7.4 Verhandeln
- Spot wischen → **ersetzen** (Alternativen aus dem Vorrat, die ins selbe
  Zeitbudget passen) oder **in den Vorrat zurück**.
- Anheften (📌) → Fixpunkt.
- Zwischen Blöcken und Tagen ziehen → Budgets rechnen sich sofort neu, ein
  überfüllter Block wird rot.
- Chat für alles, was sich nicht ziehen lässt.

### 7.5 Modus „Heute"
Der unterwegs wichtigste Screen: aktueller Block, was noch drin ist, wie viel
Budget übrig ist. Ein großer Knopf **„umplanen"** (siehe §5) und pro Spot ein
Wisch für „erledigt" / „übersprungen" — Letzteres setzt sich am Standort oft
schon selbst. Über dem Block ein schmales Band mit Regenrisiko und, wenn heute
etwas im guten Licht liegt, dem Lichthinweis. Navigation per Deep-Link an Apple
Maps.

### 7.6 Danach
Geplant gegen tatsächlich besucht, Fotos je Spot aus dem Trip-Album, Übergabe an
den Recap.

## 8. Architektur-Skizze

```
iOS (SwiftUI, Feature „Trip/Planen")
        │  REST
┌───────▼──────────────────────────────────────────────┐
│ Encore-Service  trip-planner                          │
│  · NL → Constraints (llm-service, JSON-Schema)        │
│  · Kandidatensuche  → geo /pois/search                │
│  · Ranking          → Interessen, Votes, Prominenz    │
│  · Reisezeit: Heuristik, optional Matrix vom Router   │
│  · Wetter (Cache) + Sonnenstand/Licht je Spot         │
│  · Block-Zuschnitt + Reihenfolge (Solver)             │
│  · Neuverteilung ab „jetzt/hier"                      │
│  · Persistenz: plans / days / blocks / stops / pool   │
└───┬──────────────┬────────────┬──────────┬────────────┘
    │              │            │          │
 geo (PostGIS)  llm-service  Open-Meteo  routing (NEU,
 OSM-POIs,      Qwen2.5-7B   (extern,     Stufe 2)
 Adressen,                    gerundete   Valhalla,
 Gebäude-                     Koordinate) GTFS optional
 geometrie
```

**Das Routing rückt nach hinten.** Weil Blöcke nur Summen brauchen, reicht für
den ersten Wurf eine Heuristik auf Luftlinie mit Umwegfaktor (Fußweg ≈ Luftlinie
× 1,3 bei 4,5 km/h). Ein echter Router (Valhalla — ein Container für Fuß, Rad
und Auto, mit Matrix-API, auf denselben Geofabrik-PBFs, die `osm-admin` schon
lädt) verbessert das später messbar, ist aber nicht mehr der Blocker, den er im
ersten Entwurf noch darstellte. GTFS wird von der Voraussetzung zur optionalen
Verfeinerung.

**Der Solver wird durch die Blöcke deutlich einfacher.** Statt eines
*Orienteering Problem with Time Windows* mit harten Uhrzeiten ist es jetzt
**Rucksackproblem pro Block** (welche Spots passen ins Zeitbudget, maximiere
den Wert) plus **kurze Rundreise innerhalb des Blocks** (bei 2–4 Stopps
erschöpfend lösbar). Beides in TypeScript in Millisekunden — wichtig, weil die
Neuverteilung unterwegs sofort reagieren muss und im Zweifel offline läuft.

**Die Lichtberechnung braucht keine externe Quelle.** Sonnenhöhe und -azimut
sind aus Koordinate und Zeitpunkt berechenbar (~100 Zeilen, keine Abhängigkeit,
kein Netz) — bewusst doppelt implementiert in TypeScript für den Server und in
Swift fürs Gerät, damit der Lichthinweis auch offline stimmt. Die
Fassadenausrichtung wird beim Kandidatenaufbau einmal aus der OSM-Geometrie
abgeleitet und am Spot gespeichert. Extern ist nur die Wettervorhersage.

**Das LLM plant nicht.** Es übersetzt Sprache in validierte Constraints und
schreibt Begründungen. So halluziniert es weder Öffnungszeiten noch Wege.

**Ranking-Signale** (gewichtete Summe, Gewichte im UI sichtbar):
Prominenz (Wikidata/Wikipedia vorhanden, Artikellänge) · Passung zu den
Interessen (Embedding-Ähnlichkeit gegen OSM-Tags/Beschreibung) ·
Gruppen-Votes · Nähe zu bereits gesetzten Spots des Blocks · Öffnung passt zum
Block · **Indoor/Outdoor gegen den Niederschlag des Blocks** (das stärkste
Wettersignal) · **Lichtfenster liegt im Block** (kleiner Bonus) ·
Kategorie-Vielfalt (keine drei Kirchen hintereinander) · optionaler
Historien-Bonus/-Malus.

**Datenmodell** (neu, Drizzle):
`trip_plans` (Trip, Zeitraum, Region, Constraints als JSONB) ·
`plan_days` · `plan_blocks` (Typ, Zeitbudget, Start-/Endpunkt) ·
`plan_stops` (POI-Referenz, Position im Block, geschätzte Dauer, Status
`geplant|erledigt|übersprungen`, gepinnt) ·
`plan_pool` (bewertete Kandidaten samt Score-Begründung, Indoor/Outdoor,
Fassadenazimut) ·
`weather_forecasts` (gerundete Koordinate + Tag → stündliche Werte, Cache) ·
`plan_votes` (Nutzer/KI pro Kandidat, analog zum Album-Voting).

## 9. Mögliche Etappen

1. **`geo /pois/search`** — Flächen-/Umkreissuche mit Kategorie- und grobem
   Öffnungsfilter. Die Lua-Importregel muss dafür mehr Tags mitnehmen
   (`opening_hours`, `cuisine`, `wheelchair`, `fee`, `website`).
2. **`trip-planner`, ein Tag, Fußwege per Heuristik** — Constraints per API,
   kein LLM, kein Frontend. Liefert Blöcke mit Spots. Deterministisch testbar.
3. **Neuverteilung** — „ab hier, ab jetzt", Vorrat, Verschieben auf Folgetage.
   Bewusst **vor** dem hübschen UI, weil es die Kernmechanik ist.
4. **NL-Eingabe** über llm-service (JSON-Schema, strikte Validierung) +
   Mehrtagesplanung.
5. **iOS-Oberfläche** — Blockkarten, Karte, Wischgesten, „Heute"-Modus.
6. **Standort** — Geofences um die nächsten Stopps, Erledigt-Erkennung,
   angebotene Neuverteilung, „was ist in der Nähe".
7. **Wetter & Licht** — Open-Meteo-Anbindung mit Cache, Indoor/Outdoor-Ableitung,
   Sonnenstandsmodul, Lichthinweise und Abendblock-Vorschlag.
8. **Weitere Kontextsignale** — Dokumenten-Fixpunkte, Reisegruppe, Gruppen-Voting.
9. **Verfeinerung, optional** — Valhalla für echte Reisezeiten, GTFS pro
   Region, Offline-Bundle, Verknüpfung mit Trip-Album und Recap.

Etappen 1–3 sind der ehrliche Test: Liefert die Maschine für *einen* Tag in
*einer* Stadt eine Blockeinteilung, die man tatsächlich so ablaufen würde — und
hält sie stand, wenn der Tag anders läuft? Alles danach ist Ausbau.

## 10. Bekannte Schwachstellen

- **OSM-Datenqualität.** `opening_hours` ist lückenhaft, Restaurantqualität
  steht dort gar nicht. Gegenmittel: die grobe Auflösung (§4) verzeiht
  Ungenauigkeit, fehlende Angaben werden als „ungeprüft" gekennzeichnet.
  Restaurants plant das System bewusst nur als Zeitfenster („Mittag, irgendwo
  in der Gegend von B"), nicht als konkrete Empfehlung — dafür fehlen die
  Daten, und eine erfundene Empfehlung wäre schlechter als keine.
- **Geschätzte Reisezeiten.** Die Heuristik kann bei Flüssen, Bergen oder
  schlechter ÖPNV-Anbindung deutlich danebenliegen. Gegenmittel: Puffer im
  Blockbudget, ehrliche Kennzeichnung als Schätzung, und Etappe 7 für die
  Regionen, wo es sich lohnt.
- **Wettervorhersagen sind unsicher.** Drei Tage im Voraus ist die
  Niederschlagsmenge eine grobe Tendenz. Gegenmittel: nur die drei Klassen
  verwenden, den Plan bei jeder Aktualisierung nachziehen (§5) und im UI die
  Unsicherheit zeigen, statt eine Millimeterzahl vorzutäuschen.
- **Fassadenausrichtung ist eine Näherung.** Aus der längsten Polygonkante
  abgeleitet, funktioniert sie bei einfachen Baukörpern gut, bei runden,
  verschachtelten oder freistehenden Objekten kaum. Und die goldene Stunde
  dauert je nach Breite und Jahreszeit zwanzig Minuten oder drei Stunden.
  Deshalb bleibt Licht ein Hinweis mit kleinem Gewicht und wird nie zur harten
  Nebenbedingung.
- **Standort kostet Batterie und Vertrauen.** Gegenmittel: Region Monitoring
  statt Dauer-GPS, alles Planungsrelevante on-device, nach außen nur die
  gerundete Wetter-Koordinate — und ein Schalter, der die ganze Automatik
  abstellt.
- **Keine Echtzeit.** Verkehr, Streiks, spontane Schließungen sieht das System
  nicht — bewusste Übergabe an Apple/Google Maps für die Navigation.
- **Speicherbedarf** eines späteren Routers (Valhalla-Kacheln zusätzlich zu den
  PostGIS-Region-DBs) muss in Etappe 7 gemessen und in die Regionsverwaltung
  integriert werden (Region löschen = auch Kacheln löschen).
- **Offline-Karten.** Vektorkacheln aus den PBFs (planetiler + MapLibre) wären
  ein eigener großer Baustein. Zunächst MapKit online; offline gibt es
  Blockliste, Spots und Wegbeschreibung, aber keine Kartendarstellung.

## 11. Offene Fragen an den Nutzer

1. **Blockschema:** Sind Vormittag / Mittag / Nachmittag / Abend die richtige
   Einteilung, oder lieber frei definierbare Blöcke pro Tag?
2. **Regionsumfang:** Soll für einen geplanten Urlaub automatisch die passende
   Geofabrik-Region importiert werden (Speicher!), oder bleibt das eine
   bewusste Admin-Entscheidung wie heute?
3. **Automatik-Schwelle:** Soll die App bei Rückstand oder Wetterumschwung nur
   einen Hinweis zeigen, oder den neuen Vorschlag gleich fertig danebenlegen?
4. **Lichthinweise für alle?** Sichtbar für jeden, oder ein Schalter für die,
   die tatsächlich fotografieren wollen — und darf Licht auch einen Abendblock
   vorschlagen, den es sonst nicht gäbe?
5. **Web-Frontend:** nur iOS, oder Planung auch in der Vue-App? Planen am großen
   Bildschirm, Umplanen am Telefon wäre eine naheliegende Arbeitsteilung.
