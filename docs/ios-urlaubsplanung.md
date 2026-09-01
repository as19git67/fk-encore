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

## 2. Drei Leitentscheidungen

Diese drei prägen alles Weitere und stehen deshalb vorne:

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

### 3.3 Dokumente als Fixpunkte
Der documents-Service hat bereits OCR, Klassifikation und semantische Suche.
Hotelbestätigung, Bahnticket, Mietwagenvertrag, Museums-/Städtepass liegen also
**schon im Haus und sind maschinenlesbar**. Der Plan wird um reale Fixpunkte
gebaut: Hoteladresse als Tagesstart und -ende, Check-in-Zeit, Rückgabetermin
des Mietwagens, gebuchtes Zeitfenster für die Sagrada Família. Das kann Google
strukturell nicht, ohne dass man sein Postfach öffnet.

### 3.4 Mit wem gereist wird
Die Personenerkennung kennt die Reisegruppe. „Wir" ist nicht generisch: zwei
Kinder unter zehn → kürzere Blöcke, Pausen, keine drei Museen am Stück;
Großeltern dabei → Gehstrecke und Steigung als harte Nebenbedingung statt als
Sternchen-Hinweis. Das wirkt direkt auf das Zeitbudget eines Blocks.

### 3.5 Familienabstimmung mit vorhandener Mechanik
Das Album-Voting (Nutzer **und** KI stimmen über Fotos ab) ist eins zu eins auf
Spot-Kandidaten übertragbar: Jeder wischt vor der Reise durch die Vorschläge,
der Planer optimiert gegen die aggregierten Stimmen. Das zahlt sich vor allem
beim Umplanen aus — wenn etwas wegfallen muss, fällt zuerst weg, was der Gruppe
am wenigsten wichtig war. Google Maps hat Listen, aber keine Gruppenentscheidung,
die anschließend in eine Auswahl fließt.

### 3.6 Der Kreis schließt sich mit dem Trip Mode
`docs/ios-trip-mode.md` bringt Fotos des Tages automatisch ins Trip-Album. Ein
Plan plus dieses Album ergibt ohne Zusatzaufwand ein **Reisetagebuch**: geplante
Blöcke gegen tatsächlich Besuchtes, pro Stopp die dort entstandenen Fotos, und
am Ende ein Recap (`docs/recaps.md`), das bereits existiert.

### 3.7 Erklärbar, verhandelbar, werbefrei
Jeder Vorschlag trägt eine Begründung („20 Min. zu Fuß vom Hotel, passt in den
Vormittag, ihr mögt Aussichtspunkte"), jede Gewichtung ist verstellbar. Kein
bezahltes Ranking, keine gesponserten Einträge — bei einem selbst gehosteten
System keine Marketing-Aussage, sondern eine Eigenschaft der Architektur.

### 3.8 Offline und ohne Roaming
Die OSM-Regionsdatenbanken liegen ohnehin im Haus. Ein fertiger Plan lässt sich
komplett aufs iPhone laden und funktioniert im Ausland ohne Datenverbindung.
Weil grob geplant wird, ist auch der Offline-Plan vollwertig — es fehlen keine
Minutenangaben, die es ohnehin nie gab. Google Maps Offline-Karten können
navigieren, aber nicht planen.

### 3.9 Nachrang: die eigene Fotohistorie
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

- Der Nutzer tippt „wir sind hier, es ist jetzt" (oder die App merkt es selbst,
  wenn der Trip Mode ohnehin läuft).
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

## 6. Wie sich das in der iOS-App anfühlt

### 6.1 Einstieg
Im bestehenden **Trip**-Tab kommt neben „Aufnehmen" (Trip Mode) ein zweiter
Bereich **„Planen"** dazu. Beides sind Ansichten desselben Trips: erst planen,
dann unterwegs anpassen und fotografieren, danach der Rückblick.

### 6.2 Eingabe
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

### 6.3 Ergebnis
Pro Tag eine **Karte je Block** (Vormittag / Mittag / Nachmittag / Abend), darin
die Spots als kompakte Zeile mit Referenzbild, geschätzter Aufenthaltsdauer und
Wegsymbol dazwischen. Darunter eine Auslastungsanzeige: „ca. 3 h von 3,5 h".
Kartenansicht mit nummerierten Pins pro Tag. „Warum hier?" pro Spot
aufklappbar.

### 6.4 Verhandeln
- Spot wischen → **ersetzen** (Alternativen aus dem Vorrat, die ins selbe
  Zeitbudget passen) oder **in den Vorrat zurück**.
- Anheften (📌) → Fixpunkt.
- Zwischen Blöcken und Tagen ziehen → Budgets rechnen sich sofort neu, ein
  überfüllter Block wird rot.
- Chat für alles, was sich nicht ziehen lässt.

### 6.5 Modus „Heute"
Der unterwegs wichtigste Screen: aktueller Block, was noch drin ist, wie viel
Budget übrig ist. Ein großer Knopf **„umplanen"** (siehe §5) und pro Spot ein
Wisch für „erledigt" / „übersprungen". Navigation per Deep-Link an Apple Maps.

### 6.6 Danach
Geplant gegen tatsächlich besucht, Fotos je Spot aus dem Trip-Album, Übergabe an
den Recap.

## 7. Architektur-Skizze

```
iOS (SwiftUI, Feature „Trip/Planen")
        │  REST
┌───────▼──────────────────────────────────────────────┐
│ Encore-Service  trip-planner                          │
│  · NL → Constraints (llm-service, JSON-Schema)        │
│  · Kandidatensuche  → geo /pois/search                │
│  · Ranking          → Interessen, Votes, Prominenz    │
│  · Reisezeit: Heuristik, optional Matrix vom Router   │
│  · Block-Zuschnitt + Reihenfolge (Solver)             │
│  · Neuverteilung ab „jetzt/hier"                      │
│  · Persistenz: plans / days / blocks / stops / pool   │
└───┬──────────────┬──────────────────┬─────────────────┘
    │              │                  │
 geo (PostGIS)  llm-service      routing (NEU, Stufe 2)
 OSM-POIs,      Qwen2.5-7B       Valhalla: Fuß/Auto/Rad
 Adressen                        (GTFS optional, später)
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

**Das LLM plant nicht.** Es übersetzt Sprache in validierte Constraints und
schreibt Begründungen. So halluziniert es weder Öffnungszeiten noch Wege.

**Ranking-Signale** (gewichtete Summe, Gewichte im UI sichtbar):
Prominenz (Wikidata/Wikipedia vorhanden, Artikellänge) · Passung zu den
Interessen (Embedding-Ähnlichkeit gegen OSM-Tags/Beschreibung) ·
Gruppen-Votes · Nähe zu bereits gesetzten Spots des Blocks · Öffnung passt zum
Block · Kategorie-Vielfalt (keine drei Kirchen hintereinander) · optionaler
Historien-Bonus/-Malus.

**Datenmodell** (neu, Drizzle):
`trip_plans` (Trip, Zeitraum, Region, Constraints als JSONB) ·
`plan_days` · `plan_blocks` (Typ, Zeitbudget, Start-/Endpunkt) ·
`plan_stops` (POI-Referenz, Position im Block, geschätzte Dauer, Status
`geplant|erledigt|übersprungen`, gepinnt) ·
`plan_pool` (bewertete Kandidaten samt Score-Begründung) ·
`plan_votes` (Nutzer/KI pro Kandidat, analog zum Album-Voting).

## 8. Mögliche Etappen

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
6. **Kontextsignale** — Dokumenten-Fixpunkte, Reisegruppe, Gruppen-Voting.
7. **Verfeinerung, optional** — Valhalla für echte Reisezeiten, GTFS pro
   Region, Offline-Bundle, Verknüpfung mit Trip-Album und Recap.

Etappen 1–3 sind der ehrliche Test: Liefert die Maschine für *einen* Tag in
*einer* Stadt eine Blockeinteilung, die man tatsächlich so ablaufen würde — und
hält sie stand, wenn der Tag anders läuft? Alles danach ist Ausbau.

## 9. Bekannte Schwachstellen

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
- **Keine Echtzeit.** Verkehr, Streiks, spontane Schließungen sieht das System
  nicht — bewusste Übergabe an Apple/Google Maps für die Navigation.
- **Speicherbedarf** eines späteren Routers (Valhalla-Kacheln zusätzlich zu den
  PostGIS-Region-DBs) muss in Etappe 7 gemessen und in die Regionsverwaltung
  integriert werden (Region löschen = auch Kacheln löschen).
- **Offline-Karten.** Vektorkacheln aus den PBFs (planetiler + MapLibre) wären
  ein eigener großer Baustein. Zunächst MapKit online; offline gibt es
  Blockliste, Spots und Wegbeschreibung, aber keine Kartendarstellung.

## 10. Offene Fragen an den Nutzer

1. **Blockschema:** Sind Vormittag / Mittag / Nachmittag / Abend die richtige
   Einteilung, oder lieber frei definierbare Blöcke pro Tag?
2. **Regionsumfang:** Soll für einen geplanten Urlaub automatisch die passende
   Geofabrik-Region importiert werden (Speicher!), oder bleibt das eine
   bewusste Admin-Entscheidung wie heute?
3. **Standort unterwegs:** Darf die App für „wir sind hier, es ist jetzt" den
   Standort automatisch ziehen, oder soll das Umplanen immer eine bewusste
   Nutzeraktion bleiben?
4. **Wetter:** externe Wetter-API (verlässt das Haus, aber nur mit Koordinate
   und Datum) oder bewusst nicht? Für „es regnet — was Drinnen" wäre sie der
   naheliegende Auslöser.
5. **Web-Frontend:** nur iOS, oder Planung auch in der Vue-App? Planen am großen
   Bildschirm, Umplanen am Telefon wäre eine naheliegende Arbeitsteilung.
