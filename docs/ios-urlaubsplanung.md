# Urlaubsplanung („Spots & Routen") – Konzept

Stand: 2026-09-01 · Status: Ideensammlung / Vorentwurf (noch keine gesperrten
Entscheidungen)

## 1. Die Idee in einem Satz

Der Nutzer sagt in natürlicher Sprache, was er vorhat — *„ich bin vier Tage in
Lissabon"*, *„wir fahren von München nach Bozen und haben zwei Tage Zeit"* —
und bekommt daraufhin **Tagespläne mit konkreten Spots** (Sehenswürdigkeit,
Museum, Café, Restaurant, Aussichtspunkt) in einer **sinnvollen Reihenfolge**,
inklusive der Wege dazwischen zu Fuß, mit ÖPNV oder mit dem Auto.

## 2. Warum das kein Google-Maps-Klon wird

Google Maps ist bei **Live-Daten** (Verkehr, Echtzeit-ÖPNV, aktuelle
Öffnungszeiten, Bewertungen, Innenraumfotos) uneinholbar. Ein Nachbau dieser
Ebene wäre sinnlos. Der Mehrwert von fk-encore liegt an einer anderen Stelle:
**Google kennt die Welt, aber nicht die Familie.** fk-encore kennt die Familie
— und zwar in einer Tiefe, die kein Cloud-Anbieter je bekommt, weil die Daten
das Haus nie verlassen.

Sieben konkrete Hebel:

### 2.1 Eigene Fotohistorie als Ranking-Signal
Die POI-Erkennung (`osm-admin/poi-matcher.ts`, DINOv2 + OSM-PostGIS +
Wikidata) weiß bereits **an welchen konkreten Sehenswürdigkeiten die Familie
schon war**. Daraus folgt direkt:
- *„Den Torre de Belém habt ihr 2019 schon gesehen — dafür diesmal lieber …"*
- *„Ihr fotografiert auffällig viele Klöster und Aussichtspunkte, aber kaum
  Museen"* → das Ranking wird an echtem, beobachtetem Verhalten kalibriert,
  nicht an einem Interessen-Fragebogen.
- Beim Wiederbesuch: *„2019 stand ihr hier"* mit dem eigenen Foto daneben.

Google kann das prinzipiell auch — mit Google Photos und Standortverlauf. Hier
passiert es lokal, ohne dass jemand die Bewegungsprofile bekommt.

### 2.2 Dokumente als Fixpunkte des Plans
Der documents-Service hat bereits OCR, Klassifikation und semantische Suche.
Hotelbestätigung, Bahnticket, Mietwagenvertrag, Museums-/Städtepass, Fährticket
liegen also **schon im Haus und sind maschinenlesbar**. Der Plan wird damit
nicht um eine leere Karte herum gebaut, sondern um reale Fixpunkte:
Check-in-Zeit, Hoteladresse als Start-/Endpunkt jedes Tages, Rückgabetermin des
Mietwagens, gebuchtes Zeitfenster für die Sagrada Família. Genau das kann
Google Maps strukturell nicht — es sei denn, man legt sein Postfach offen.

### 2.3 Mit wem gereist wird
Die Personenerkennung kennt die Reisegruppe. „Wir" ist nicht generisch: zwei
Kinder unter zehn → kürzere Etappen, Spielplatz-/Eis-Pausen, keine drei Museen
am Stück; Großeltern dabei → Steigung, Gehstrecke und Sitzgelegenheiten als
harte Nebenbedingung statt als Sternchen-Hinweis.

### 2.4 Familienabstimmung mit vorhandener Mechanik
Das Album-Voting (Nutzer **und** KI stimmen über Fotos ab) ist eins zu eins auf
Spot-Kandidaten übertragbar: Jeder in der Gruppe wischt vor der Reise durch die
Vorschläge, der Planer optimiert gegen die aggregierten Stimmen. Google Maps
hat Listen — aber keine Gruppenentscheidung, die anschließend automatisch in
eine Route fließt.

### 2.5 Der Kreis schließt sich mit dem Trip Mode
`docs/ios-trip-mode.md` bringt Fotos des Tages automatisch ins Trip-Album. Ein
Plan plus dieses Album ergibt ohne Zusatzaufwand ein **Reisetagebuch**: geplante
Route vs. tatsächlich gelaufene, pro Stopp die dort entstandenen Fotos, und am
Ende ein Recap (`docs/recaps.md`), das bereits existiert. Danach fließt das
Ergebnis wieder als Historie ins Ranking (2.1) zurück.

### 2.6 Erklärbar und verhandelbar statt Blackbox
Jeder Vorschlag trägt eine Begründung („2,3 km vom Hotel, ab 10 Uhr geöffnet,
passt zwischen die beiden gebuchten Termine, ihr mögt Aussichtspunkte"), und
jede Gewichtung ist verstellbar. Es gibt kein bezahltes Ranking, keine
Werbeplätze, keine gesponserten Restaurants — das ist bei einem selbst
gehosteten System kein Marketing-Versprechen, sondern eine Eigenschaft der
Architektur.

### 2.7 Offline und ohne Roaming
Die OSM-Regionsdatenbanken liegen ohnehin im Haus. Ein fertiger Plan lässt sich
komplett aufs iPhone laden (Spots, Texte, Referenzbilder, vorberechnete
Routen-Polylines) und funktioniert im Ausland ohne Datenverbindung. Google Maps
Offline-Karten können navigieren, aber nicht planen.

**Fazit:** Nicht „besser als Google Maps", sondern **eine andere Ebene**: Google
navigiert, fk-encore plant. Für Turn-by-turn wird bewusst per Deep-Link an
Apple/Google Maps übergeben.

## 3. Was schon da ist (Wiederverwendung)

| Baustein | Status |
|---|---|
| OSM-POIs mit Namen, Wikidata, Wikipedia, Geometrie (PostGIS pro Region) | vorhanden (`geo/src/pois.ts`, `osm2pgsql.lua`) |
| Reverse-Geocoding / Adressauflösung | vorhanden (`geo/src/reverse.ts`) |
| Regionsverwaltung, Geofabrik-Import, stündliche Aktualisierung | vorhanden (`osm-admin/`) |
| Besuchte POIs aus eigenen Fotos | vorhanden (`poi-matcher.ts`, `poi-detection.ts`) |
| Referenzbilder (Wikimedia Commons) + Wikipedia-Link je POI | vorhanden (`poi-reference-cache.ts`) |
| Lokales LLM (Qwen2.5-7B) für NL-Verstehen und Textbausteine | vorhanden (`llm-service/`) |
| Semantische Suche / Embeddings (multilingual-e5) | vorhanden (`embedding_service/`) |
| Reisegruppe (Personen), Gruppen/Sharing, Push | vorhanden |
| Dokumente mit OCR + Klassifikation (Tickets, Buchungen) | vorhanden (`documents/`) |
| Trip-Klammer auf iOS, Trip-Album, Recap | vorhanden / geplant (`docs/ios-trip-mode.md`) |
| **Routing (Fuß/Auto/Rad) mit Reisezeit-Matrix** | **NEU** |
| **ÖPNV-Routing (GTFS)** | **NEU** |
| **Spot-Kandidatensuche über Fläche + Kategorie + Öffnungszeiten** | **NEU (Erweiterung von `/pois`)** |
| **Tagesplan-Optimierer** | **NEU** |
| **Plan-Datenmodell + API + iOS-Oberfläche** | **NEU** |

Der teuerste neue Baustein ist das Routing — alles Übrige ist im Kern
Orchestrierung über bereits vorhandenen Diensten.

## 4. Wie sich das in der iOS-App anfühlt

### 4.1 Einstieg
Im bestehenden **Trip**-Tab kommt neben „Aufnehmen" (Trip Mode) ein zweiter
Bereich **„Planen"** dazu. Beides sind Ansichten desselben Trips: erst planen,
dann unterwegs fotografieren, danach der Rückblick.

### 4.2 Eingabe
Ein Textfeld mit Beispielen plus Chips für das, was das LLM nicht raten soll:

```
„4 Tage Lissabon, mit Oma, wir mögen Aussicht und gutes Essen,
 kein Auto, entspanntes Tempo"
```

→ vom LLM in ein **striktes JSON-Constraint-Objekt** übersetzt und dem Nutzer
als editierbare Chips gezeigt: `Ort: Lissabon` · `4 Tage` · `Modi: Fuß, ÖPNV` ·
`Tempo: entspannt (≈3 Stopps/Tag)` · `max. 4 km Gehstrecke/Tag` ·
`Interessen: Aussicht, Essen`. **Nichts wird stillschweigend angenommen** —
falsch Verstandenes korrigiert man mit einem Tipp, nicht mit einem neuen Satz.

Erkannte Dokumente werden als Vorschlag eingeblendet: *„Ich habe eine
Hotelbuchung für diesen Zeitraum gefunden — als Basis verwenden?"*

### 4.3 Ergebnis
- **Tages-Timeline** (vertikal, wie eine Foto-Timeline): Karte pro Stopp mit
  Uhrzeit, Aufenthaltsdauer, Referenzbild, dazwischen ein schmales Wege-Segment
  („12 Min. zu Fuß" / „Tram 28, 9 Min.").
- **Kartenansicht** des Tages mit nummerierten Pins und Route.
- **„Warum hier?"** aufklappbar pro Stopp — inklusive der eigenen Fotos, falls
  die Familie schon einmal dort war.

### 4.4 Verhandeln statt neu suchen
- Stopp nach links wischen → **ersetzen** (Alternativen an derselben Stelle im
  Zeitfenster, gleiche Reisezeit-Klasse).
- Stopp anheften (📌) → Fixpunkt, alles andere wird darum herum neu optimiert.
- Ziehen zum Umsortieren → Zeiten und Wege rechnen sich sofort neu.
- Chat-Eingabe: *„Nachmittags soll es regnen — mach etwas Drinnen daraus"*, *„zu
  viel Laufen"*, *„ein Tag mehr Auto"*. Das LLM ändert dabei **nur die
  Constraints**, die eigentliche Route rechnet der Optimierer.

### 4.5 Modus „Heute"
Unterwegs: aktueller Stopp, nächster Weg, Restpuffer. Ein Knopf **„wir hängen
hinterher"** kürzt den Rest des Tages (Stopps mit den niedrigsten Stimmen
fallen zuerst). Navigation per Deep-Link an Apple Maps.

### 4.6 Danach
Der Plan wird zum Reisetagebuch: geplant vs. tatsächlich, Fotos pro Stopp aus
dem Trip-Album, besuchte Spots wandern in die Historie.

## 5. Architektur-Skizze

```
iOS (SwiftUI, Feature „Trip/Planen")
        │  REST
┌───────▼──────────────────────────────────────────────┐
│ Encore-Service  trip-planner                          │
│  · NL → Constraints (llm-service, JSON-Schema)        │
│  · Kandidatensuche  → geo /pois/search                │
│  · Ranking          → Fotohistorie, Personen, Votes   │
│  · Reisezeit-Matrix → routing-Container               │
│  · Optimierer (Auswahl + Reihenfolge + Zeitfenster)   │
│  · Persistenz: plans / days / stops / candidates      │
└───┬──────────────┬──────────────────┬─────────────────┘
    │              │                  │
 geo (PostGIS)  llm-service      routing (NEU)
 OSM-POIs,      Qwen2.5-7B       Valhalla: Fuß/Auto/Rad
 Adressen                        + GTFS-Feed für ÖPNV
```

**Routing-Empfehlung: Valhalla.** Ein Container bedient Fuß, Rad und Auto
*und* liefert eine Matrix-API (`sources_to_targets`) — genau das, was der
Optimierer braucht. Er frisst dieselben Geofabrik-PBFs, die `osm-admin`
ohnehin schon herunterlädt, und kann mit einem GTFS-Feed (für Deutschland
z. B. der DELFI-Gesamtdatensatz) auch multimodal mit ÖPNV rechnen. OSRM wäre
schneller, braucht aber pro Modus eine eigene Instanz; ein separater
OpenTripPlanner nur für ÖPNV wäre der zweite Container, den man sich sparen
kann.

**Der Optimierer ist kein LLM-Job.** Fachlich ist das ein *Team Orienteering
Problem with Time Windows*: aus vielen Kandidaten die wertvollsten auswählen
**und** so anordnen, dass Öffnungszeiten, Fixtermine, Gehbudget und Tageslänge
eingehalten werden. Praktisch reicht dafür Greedy-Einfügen nach
Wert/Zeit-Verhältnis plus lokale Suche (2-opt / or-opt) in TypeScript —
bei ~50 Kandidaten und 3 Tagen liegt das im Sekundenbereich. Das LLM macht
ausschließlich das, was es gut kann: Sprache verstehen und Begründungen
formulieren. Damit halluziniert es keine Öffnungszeiten und keine Wege.

**Ranking-Signale** (gewichtete Summe, jedes Gewicht in den Einstellungen
sichtbar):
Prominenz (Wikidata/Wikipedia vorhanden, Artikellänge) · Passung zu den
Interessen (Embedding-Ähnlichkeit gegen die OSM-Tags/Beschreibung) ·
Fotohistorie der Familie · Gruppen-Votes · Nähe zu bereits gesetzten Stopps ·
Öffnungszeit passt ins Fenster · Kategorie-Vielfalt am Tag (keine drei Kirchen
hintereinander).

**Datenmodell** (neu, Drizzle):
`trip_plans` (Trip, Zeitraum, Region, Constraints als JSONB) ·
`plan_days` (Datum, Start-/Endpunkt, Modi) ·
`plan_stops` (POI-Referenz, Ankunft, Dauer, Wegsegment zum nächsten, gepinnt) ·
`plan_candidates` (verworfene/alternative Kandidaten samt Score-Begründung) ·
`plan_votes` (Nutzer/KI pro Kandidat, analog zum Album-Voting).

## 6. Mögliche Etappen

0. **Machbarkeit Routing** — Valhalla-Container gegen eine bestehende
   Region-PBF, Matrix-Abfrage, Speicher-/Laufzeitmessung. Entscheidet, ob das
   Feature auf der vorhandenen Hardware überhaupt trägt.
1. **`geo /pois/search`** — Flächen-/Umkreissuche mit Kategorie- und
   `opening_hours`-Filter (die Lua-Importregel muss dafür mehr Tags mitnehmen:
   `opening_hours`, `cuisine`, `wheelchair`, `fee`, `website`).
2. **`trip-planner`-Service, ein Tag, nur zu Fuß** — feste Constraints per
   API, kein LLM, kein Frontend. Testbar, deterministisch.
3. **NL-Eingabe** über llm-service (JSON-Schema, strikte Validierung) +
   Mehrtagesplanung + Auto/ÖPNV.
4. **iOS-Oberfläche** — Timeline, Karte, Ersetzen/Pinnen/Umsortieren.
5. **Kontextsignale** — Fotohistorie, Personen, Gruppen-Voting,
   Dokumenten-Fixpunkte.
6. **Unterwegs & danach** — „Heute"-Modus, Offline-Bundle, Verknüpfung mit
   Trip-Album und Recap.

Etappen 0–2 sind der ehrliche Test: liefert die Maschine für *einen* Tag in
*einer* Stadt einen Plan, den man tatsächlich ablaufen würde? Alles danach ist
Ausbau.

## 7. Bekannte Schwachstellen

- **OSM-Datenqualität.** `opening_hours` ist lückenhaft, Restaurantqualität
  steht dort überhaupt nicht. Gegenmittel: Öffnungszeiten als weiches Signal
  behandeln und im UI ehrlich als „laut OSM, ungeprüft" kennzeichnen;
  Bewertungen bewusst weglassen, statt schlechte zu erfinden. Für Essen ist
  ehrliche Kommunikation besser als ein Halbergebnis: fk-encore plant den
  *Rahmen*, die Restaurantwahl bleibt beim Nutzer (oder kommt aus der eigenen
  Historie: „hier wart ihr, hier gibt es Fotos vom Essen").
- **Speicherbedarf.** Valhalla-Kacheln kommen zusätzlich zu den PostGIS-Region-
  DBs. Muss in Etappe 0 gemessen und in die Regionsverwaltung integriert
  werden (Region löschen = auch Routing-Kacheln löschen).
- **ÖPNV-Abdeckung.** GTFS ist pro Land/Region zu beschaffen und zu pflegen;
  außerhalb Deutschlands wird das schnell mühsam. Fallback: Fuß + Auto, ÖPNV
  als optionaler Zusatz pro Region.
- **Keine Echtzeit.** Verkehr, Streiks, spontane Schließungen sieht das System
  nicht. Deshalb großzügige Puffer und die bewusste Übergabe an Apple/Google
  Maps für die eigentliche Navigation.
- **Offline-Karten.** Vektorkacheln aus den PBFs (planetiler + MapLibre) wären
  ein eigener großer Baustein. Zunächst MapKit online; offline gibt es Liste,
  Zeiten und Wegbeschreibung, aber keine Kartendarstellung.

## 8. Offene Fragen an den Nutzer

1. **Regionsumfang:** Soll für einen geplanten Urlaub automatisch die passende
   Geofabrik-Region importiert werden (Speicher!), oder bleibt das eine
   bewusste Admin-Entscheidung wie heute?
2. **Restaurants/Cafés:** ohne Bewertungsdaten mitplanen (nur Kategorie + Lage
   + eigene Historie) oder außen vor lassen?
3. **ÖPNV:** von Anfang an, oder erst Fuß + Auto und ÖPNV als spätere Etappe?
4. **Wetter:** externe Wetter-API (verlässt das Haus, aber nur mit Koordinate
   und Datum) oder bewusst nicht?
5. **Web-Frontend:** nur iOS, oder Planung auch in der Vue-App (Planen am
   großen Bildschirm, Ausführen am Telefon wäre naheliegend)?
