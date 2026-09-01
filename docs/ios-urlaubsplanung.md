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

## 4. Planungsgranularität: Etappe, Tag, Block

### 4.1 Der Zeitblock

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

### 4.2 Etappen: die Ebene über den Tagen

Eine Reise ist selten ein Ort. „20 Tage Tokio, Osaka und Hakata" braucht
zwischen Reise und Tag eine dritte Ebene, die **Etappe**:

- eigener Zeitraum (Tokio 3.–11.9., Osaka 11.–18.9., Hakata 18.–22.9.),
- eigener **Anker** — das Hotel dieser Etappe, Start- und Endpunkt jedes Tages,
- eigene **Regionsdatenbank** (Kanto, Kansai, Kyushu) und damit ein eigener
  Kandidatenvorrat,
- **Transfertage:** Die Fahrt zwischen zwei Etappen ist ein Fixpunkt, der einen
  halben Tag frisst. Ein Anreisetag hat keinen vollen Vormittagsblock, und der
  erste Block danach beginnt am neuen Anker.

Liegen Hotelbuchungen als Dokumente vor, ergeben sich die Etappengrenzen daraus
von selbst; sonst schlägt der Planer eine Aufteilung vor, die der Nutzer
verschiebt. Umverteilt wird immer nur **innerhalb** einer Etappe — was in Tokio
ausfällt, rutscht nicht nach Osaka.

### 4.3 Zwei Auflösungen: grob für die Reise, fein für morgen

Zwanzig Tage sind rund sechzig Blöcke. Die will niemand vorab durchsehen, und
es wäre auch verschwendete Mühe: Das Wetter ist unbekannt, und nach drei Tagen
weiß man ohnehin besser, was einem liegt. Deshalb plant das System in zwei
Auflösungen:

- **Reiseauflösung** (die ganze Zeit, sofort): pro Etappe ein bewerteter Vorrat
  („Tokio: 34 Kandidaten, davon 12 klare Favoriten") plus alles, was terminlich
  gebunden ist — gebuchte Zeitfenster, Tagesausflüge, Transfertage. Das ist
  das, worüber die Familie vorab abstimmt.
- **Tagesauflösung** (ein bis zwei Tage im Voraus): konkrete Blöcke mit
  Reihenfolge, Wegen und Lichtfenstern, üblicherweise am Vorabend.

Der Vorrat aus §5 ist damit nicht nur Reserve fürs Umplanen, sondern von Anfang
an **das eigentliche Planungsergebnis** — die Tagesblöcke sind nur seine
jeweils nächste Konkretisierung. Für einen Wochenendtrip fallen beide
Auflösungen zusammen, für drei Wochen nicht.

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

**Hitze zählt genauso wie Regen.** 33 °C bei hoher Luftfeuchte verkürzt eine
Tagesgehstrecke so wirksam wie ein Regenguss. Temperatur und Luftfeuchte gehen
deshalb ebenfalls ins Blockbudget ein und schieben Outdoor-Spots in die
Randzeiten des Tages — was sich zwanglos mit dem Lichtfenster aus §6.3 deckt.

**Jenseits des Prognosehorizonts zählt Klima, nicht Vorhersage.** Vorhersagen
reichen etwa zwei Wochen; für eine Reise, die in acht Monaten beginnt, gibt es
keine. In der Reiseauflösung (§4.3) arbeitet der Planer deshalb mit
**Klimanormalen** für Region und Monat — „September in Japan: heiß, schwül,
Taifunsaison". Daraus folgen keine Tagespläne, sondern Vorkehrungen: genug
Indoor-Kandidaten im Vorrat und ein nicht verplanter Puffertag je Etappe. Erst
in den letzten zwei Wochen schaltet sich die echte Vorhersage tageweise zu.

**Quelle:** [Open-Meteo](https://open-meteo.com) — stündliche Werte für
`precipitation`, `cloud_cover` und `sunshine_duration`, ohne API-Schlüssel und
ohne Registrierung, weltweit — dieselbe Schnittstelle liefert auch die
Klimanormalen. Für Deutschland alternativ Bright Sky (DWD).
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
  **Achtung, das geht heute noch nicht:** Der Import reduziert flächige POIs auf
  ihren Zentroid (`geo/src/osm2pgsql.lua`, `as_polygon():centroid()`), das
  Polygon ist danach verloren. Das Fassadenazimut muss deshalb **beim Import
  einmal berechnet** und als Spalte an `osm_pois` mitgeführt werden — billiger,
  als die Polygone dauerhaft zu speichern, und ohnehin nur einmal pro Objekt
  nötig.
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

**Zwei kleine Änderungen am OSM-Import** sind Voraussetzung und gehören in den
ersten Umsetzungsschritt, weil sie einen Neuimport der Regionen erfordern:
`name:en` in die Tag-Allowlist (`geo/src/osm2pgsql.lua` kennt heute nur `name`
und `name:de` — in Japan steht in `name` Kanji), und das beim Import berechnete
Fassadenazimut als eigene Spalte (§6.3). Beides ist im Lua-Filter je eine
Handvoll Zeilen.

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
`trip_plans` (Trip, Zeitraum, Constraints als JSONB) ·
`plan_legs` (Etappe: Zeitraum, Region/Datenbank, Anker-Adresse, Transfer) ·
`plan_days` · `plan_blocks` (Typ, Zeitbudget, Start-/Endpunkt) ·
`plan_stops` (POI-Referenz, Position im Block, geschätzte Dauer, Status
`geplant|erledigt|übersprungen`, gepinnt) ·
`plan_pool` (bewertete Kandidaten je Etappe samt Score-Begründung,
Indoor/Outdoor, Fassadenazimut) ·
`weather_forecasts` (gerundete Koordinate + Tag → stündliche Werte, Cache) ·
`plan_votes` (Nutzer/KI pro Kandidat, analog zum Album-Voting).

## 9. Mögliche Umsetzungsschritte

> „Etappe" meint in diesem Dokument durchgehend einen **Reiseabschnitt**
> (§4.2); die Umsetzung ist in **Schritte** gegliedert.

1. **`geo /pois/search` + Importänderungen** — Flächen-/Umkreissuche mit
   Kategorie- und grobem Öffnungsfilter. Der Lua-Filter muss dafür mehr Tags
   mitnehmen (`opening_hours`, `cuisine`, `wheelchair`, `fee`, `website`,
   **`name:en`**) und das **Fassadenazimut** beim Import berechnen. Alles, was
   einen Neuimport erzwingt, gehört in diesen einen Schritt.
2. **`trip-planner`, ein Tag, Fußwege per Heuristik** — Constraints per API,
   kein LLM, kein Frontend. Liefert Blöcke mit Spots. Deterministisch testbar.
3. **Neuverteilung** — „ab hier, ab jetzt", Vorrat, Verschieben auf Folgetage.
   Bewusst **vor** dem hübschen UI, weil es die Kernmechanik ist.
4. **NL-Eingabe** über llm-service (JSON-Schema, strikte Validierung) +
   Mehrtagesplanung.
5. **Etappen und zwei Auflösungen** (§4.2/§4.3) — Reisen über mehrere Orte,
   Transfertage, Vorrat je Etappe, Detaillierung erst am Vorabend.
6. **iOS-Oberfläche** — Blockkarten, Karte, Wischgesten, „Heute"-Modus.
7. **Standort** — Geofences um die nächsten Stopps, Erledigt-Erkennung,
   angebotene Neuverteilung, „was ist in der Nähe".
8. **Wetter & Licht** — Open-Meteo-Anbindung mit Cache, Indoor/Outdoor-Ableitung,
   Sonnenstandsmodul, Lichthinweise und Abendblock-Vorschlag.
9. **Weitere Kontextsignale** — Dokumenten-Fixpunkte, Reisegruppe, Gruppen-Voting.
10. **Verfeinerung, optional** — Valhalla für echte Reisezeiten, GTFS pro
   Region, Offline-Bundle, Verknüpfung mit Trip-Album und Recap.

Schritte 1–3 sind der ehrliche Test: Liefert die Maschine für *einen* Tag in
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
  Blockbudget, ehrliche Kennzeichnung als Schätzung, und Schritt 10 für die
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
- **Nicht-lateinische Schriften.** Ohne `name:en` im Import stehen in Japan,
  Griechenland oder Thailand unlesbare Namen im Plan. Auch mit dem Tag bleibt
  eine Lücke, wo OSM keinen englischen Namen führt — dann hilft nur die
  Originalschreibweise plus Wikidata-Label als Fallback.
- **Keine Echtzeit.** Verkehr, Streiks, spontane Schließungen sieht das System
  nicht — bewusste Übergabe an Apple/Google Maps für die Navigation.
- **Speicherbedarf** eines späteren Routers (Valhalla-Kacheln zusätzlich zu den
  PostGIS-Region-DBs) muss in Schritt 10 gemessen und in die Regionsverwaltung
  integriert werden (Region löschen = auch Kacheln löschen).
- **Offline-Karten.** Vektorkacheln aus den PBFs (planetiler + MapLibre) wären
  ein eigener großer Baustein. Zunächst MapKit online; offline gibt es
  Blockliste, Spots und Wegbeschreibung, aber keine Kartendarstellung.

## 11. Offene Fragen an den Nutzer

1. **Blockschema:** Sind Vormittag / Mittag / Nachmittag / Abend die richtige
   Einteilung, oder lieber frei definierbare Blöcke pro Tag?
2. **Regionsumfang:** Eine Japanreise braucht drei Regionsdatenbanken (Kanto,
   Kansai, Kyushu), die vor der Planung importiert sein müssen — das ist heute
   eine bewusste Admin-Entscheidung und dauert. Soll der Planer bei einem
   unbekannten Ziel den Import selbst anbieten („für Tokio habe ich keine
   Daten — jetzt importieren?"), oder bleibt es getrennt? Und wie lange darf
   eine Etappenregion nach der Reise liegen bleiben?
3. **Automatik-Schwelle:** Soll die App bei Rückstand oder Wetterumschwung nur
   einen Hinweis zeigen, oder den neuen Vorschlag gleich fertig danebenlegen?
4. **Lichthinweise für alle?** Sichtbar für jeden, oder ein Schalter für die,
   die tatsächlich fotografieren wollen — und darf Licht auch einen Abendblock
   vorschlagen, den es sonst nicht gäbe?
5. **Web-Frontend:** nur iOS, oder Planung auch in der Vue-App? Planen am großen
   Bildschirm, Umplanen am Telefon wäre eine naheliegende Arbeitsteilung.

---

## 12. Durchgespielt: 20 Tage Japan

Ein Beispiel, an dem sich die Mechanik prüfen lässt — **3.9. bis 22.9.2027,
Tokio, Osaka und Hakata, zu zweit**. Bewusst ein harter Fall: lang, mehrere
Orte, weit in der Zukunft, nicht-lateinische Schrift, andere Zeitzone.

### 12.1 Vorbereitung: die Regionen

Vor jeder Planung müssen die OSM-Daten im Haus sein: drei Geofabrik-Sub-Regionen
Japans — **Kanto** (Tokio), **Kansai** (Osaka), **Kyushu** (Hakata/Fukuoka).
Das ist heute ein Admin-Vorgang, dauert, und passiert Wochen vorher, nicht beim
Planen (siehe offene Frage 2 in §11).

### 12.2 Eingabe

```
3.9. bis 22.9.2027, Tokio, Osaka und Hakata,
zu zweit, viel zu Fuß und mit der Bahn,
wir mögen Tempel, Aussicht und Märkte
```

→ Chips: `20 Tage` · `3 Etappen` · `Modi: Fuß, ÖPNV` · `Interessen: Tempel,
Aussicht, Märkte`. Findet der documents-Service Flug- und Hotelbestätigungen für
den Zeitraum, werden sie als Fixpunkte vorgeschlagen — Ankunft Haneda, drei
Hotels, und damit implizit die Etappengrenzen.

### 12.3 Etappen und Transfers

Tokio 3.–11.9., Osaka 11.–18.9., Hakata 18.–22.9. (§4.2). Die Shinkansen-Fahrten
dazwischen sind Fixpunkte, die je einen halben Tag kosten; jede Etappe bekommt
ihr Hotel als Tagesanker und ihre eigene Regionsdatenbank.

### 12.4 Grob planen, nicht alles planen

In der Reiseauflösung (§4.3) entsteht pro Etappe ein bewerteter Vorrat — „Tokio:
34 Kandidaten, 12 klare Favoriten" — plus die terminlich gebundenen Punkte
(Zeitfenster-Tickets, ein Tagesausflug). Darüber stimmt ihr zu zweit ab, die KI
stimmt mit. Ergebnis ist keine Route, sondern eine Rangfolge: Sie entscheidet
später, was zuerst wegfällt. Konkrete Blöcke entstehen erst ein bis zwei Tage
vorher.

### 12.5 Wetter acht Monate im Voraus

Gibt es nicht. In der Reiseauflösung zählen deshalb die Klimanormalen (§6.2):
September in Japan ist heiß, schwül und **Taifunsaison**. Praktische Folge im
Plan — genug Indoor-Kandidaten im Vorrat und ein nicht verplanter Puffertag je
Etappe. Ab etwa zwei Wochen vorher detailliert die echte Vorhersage tageweise.

### 12.6 Ein Tag in Tokio

Am Vorabend entsteht der Plan für Asakusa und Umgebung:

| Block | Inhalt |
|---|---|
| Vormittag (ca. 3,5 h) | Sensō-ji → Nakamise → Sumida-Ufer |
| Mittag | offen, in der Gegend |
| Nachmittag (ca. 3 h) | eine Fahrt nach Ueno → Museum → Park |
| Abend (vorgeschlagen) | Aussichtspunkt ab ca. 17:00 |

Der Abendblock kommt vom Lichtmodul — und hier zahlt es konkret: **Tokio liegt
am östlichen Rand seiner Zeitzone**, die Sonne geht Anfang September gegen 18 Uhr
unter. Die goldene Stunde ist dort später Nachmittag, nicht Abend; wer nach
europäischem Gefühl um 19:30 zur Aussicht aufbricht, steht im Dunkeln. In
Hakata, gut neun Längengrade weiter westlich, liegt derselbe Moment rund
35 Minuten später. Kein Reiseführer sagt einem das, und berechnen lässt es sich
offline in Millisekunden (§6.3).

### 12.7 Unterwegs

Um 14 Uhr steht ihr noch beim Sensō-ji. Der Geofence merkt es, die App bietet an:
*„Der Nachmittag wird knapp — Museum raus, rutscht auf Freitag Vormittag. Der
Aussichtspunkt um 17 Uhr bleibt."* Ein Tipp genügt; das Museum ist nicht
gelöscht, es liegt wieder im Vorrat.

Zieht ein Taifunausläufer durch, greift dieselbe Mechanik eine Ebene höher: Der
Regentag tauscht mit einem trockenen Tag **derselben Etappe**, Outdoor wandert
in den Vorrat, Indoor rückt nach.

### 12.8 Etappenwechsel und danach

Am 11.9. ist der Vormittag durch den Shinkansen belegt; ab Osaka gelten neue
Regionsdatenbank und neuer Anker, der Vorrat für Osaka ist längst bewertet.
Parallel sammelt der Trip Mode die Fotos ein — am Ende steht das Reisetagebuch
mit geplanten gegen tatsächlich besuchte Blöcke und der Recap.

### 12.9 Was dieses Beispiel am Konzept geändert hat

Der Durchgang hat fünf Lücken aufgedeckt, die jetzt eingearbeitet sind:
Etappen als Ebene über den Tagen (§4.2), zwei Planungsauflösungen (§4.3),
Klimanormale statt Vorhersage jenseits des Prognosehorizonts und Hitze als
Budgetfaktor (§6.2), das Fassadenazimut, das wegen der Zentroid-Reduktion beim
Import berechnet werden muss (§6.3), und `name:en` in der Tag-Allowlist, ohne
das im Plan 浅草寺 statt „Sensō-ji" stünde (§8).
