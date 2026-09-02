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
   Besuche, sondern gute Fotos (§7).

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
Abendtermin vorschlagen kann (§7.3). Google Maps kennt Öffnungszeiten — aber
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
der Planer optimiert gegen die aggregierten Stimmen — wobei „aggregiert" gerade
nicht Mittelwert heißt (§6.1). Das zahlt sich vor allem
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
- eigener **Anker** — das Hotel dieser Etappe, Start- und Endpunkt jedes Tages.
  Ist noch nichts gebucht, genügt eine **Ankerzone** statt einer Adresse
  („höchstens fünf Metro-Stationen vom Wenzelsplatz"): Der Planer rechnet mit
  ihrem Schwerpunkt und kann sie zugleich als Suchhilfe für die Hotelwahl
  ausgeben,
- eigener **Fortbewegungsmodus.** Der Modus gehört zur Etappe, nicht zur Reise:
  Mit dem Auto anzureisen heißt nicht, in der Innenstadt Auto zu fahren. Wechselt
  der Modus am Etappenanfang, wird das Umsteigen selbst zum Fixpunkt — Park & Ride
  am Stadtrand, Mietwagenrückgabe, Gepäck ins Hotel,
- eigene **Regionsdatenbank** (Kanto, Kansai, Kyushu) und damit ein eigener
  Kandidatenvorrat,
- **Transfertage:** Die Fahrt zwischen zwei Etappen ist ein Fixpunkt, der einen
  halben Tag frisst. Ein Anreisetag hat keinen vollen Vormittagsblock, und der
  erste Block danach beginnt am neuen Anker.

Liegen Hotelbuchungen als Dokumente vor, ergeben sich die Etappengrenzen daraus
von selbst; sonst schlägt der Planer eine Aufteilung vor, die der Nutzer
verschiebt. Umverteilt wird immer nur **innerhalb** einer Etappe — was in Tokio
ausfällt, rutscht nicht nach Osaka.

**Der Transfer selbst kann ein Planungsobjekt sein.** „Auf dem Weg noch etwas
anschauen, ohne groß umzuwegen" ist keine Umkreissuche mehr, sondern eine
**Korridorsuche mit Umwegbudget**: gesucht sind Spots, die die Fahrt um höchstens
*n* Minuten verlängern. Billig lösbar auch ohne Router — die Punkte, für die
`Entfernung(Start, P) + Entfernung(P, Ziel) ≤ Entfernung(Start, Ziel) + Budget`
gilt, bilden eine **Ellipse mit Start und Ziel als Brennpunkten**. Das ist eine
einzige Bedingung in PostGIS, filtert aus einem ganzen Land ein schmales Band
heraus, und erst die paar Überlebenden bekommen (später, mit Router) eine echte
Umwegrechnung. Wie viel Zeit dabei überhaupt zur Verfügung steht, ergibt sich aus
den Fixpunkten der Etappe — eine Anreise mit Check-in erst ab 15 Uhr *schafft*
den Zwischenstopp, statt ihn zu verhindern.

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

### 4.4 Harte Uhrzeiten: der Rahmen, nicht der Inhalt

Leitentscheidung 1 vermeidet Uhrzeiten — aber manche sind unausweichlich: der
letzte Zug zurück, das gebuchte Zeitfenster, der Check-in ab 15 Uhr, die
Fährabfahrt. Die Auflösung ist eine Arbeitsteilung:

- **Fixpunkte sind absolut** und tragen eine echte Uhrzeit. Sie spannen den
  Rahmen eines Tages auf.
- **Blöcke sind relativ** und füllen den Raum dazwischen. Sie behalten ihre
  grobe Natur.

Ein Fixpunkt am Tagesende wird **rückwärts** gerechnet: Vom letzten Zug gehen
der Weg zum Bahnhof und ein Sicherheitspuffer ab, der Rest ist das Budget des
letzten Blocks. Je näher der Tag an diesen Rand kommt, desto härter greift das
Budget — und desto eher schlägt die Neuverteilung (§5) vor, etwas zu streichen.
Der Puffer ist verhandelbar, aber nie null: Einen Zug zu verpassen ist teurer
als ein ausgelassener Spot.

## 5. Umplanen als Kernmechanik

Ein Plan besteht aus drei Schichten:

- **Fixpunkte** — aus Dokumenten oder vom Nutzer angeheftet (Hotel-Check-in,
  gebuchtes Zeitfenster, Zugabfahrt, Moduswechsel). Werden nie automatisch
  verschoben und sind die einzigen Elemente mit echter Uhrzeit (§4.4).
- **Eingeplante Spots** — pro Block, mit Reihenfolge.
- **Vorrat** — bewertete Kandidaten der Region, die (noch) nicht eingeplant
  sind. Der Vorrat ist der Grund, warum Umplanen schnell geht: die Kandidaten
  sind bereits gesucht, bewertet und mit groben Reisezeiten versehen.

**Auslöser für eine Neuverteilung:**

- Der Nutzer tippt „wir sind hier, es ist jetzt".
- **Die App merkt es selbst** am Standort: die Gruppe hängt hinter dem Block
  zurück (§7.1). Sie *bietet* die Neuverteilung an, führt sie nicht ungefragt aus.
- **Die Wettervorhersage ändert sich** — aus dem trockenen Nachmittag wird ein
  nasser (§7.2).
- Ein Spot wird als erledigt, übersprungen oder als „hat länger gedauert"
  markiert.
- Eine Bedingung ändert sich per Chat: *„es regnet — was Drinnen"*, *„zu viel
  Laufen"*, *„wir haben keine Lust mehr auf Museen"*.

**Was dann passiert:** Nur der **Rest ab jetzt** wird neu verteilt, Vergangenes
bleibt unangetastet (es ist der Anfang des Reisetagebuchs). Was nicht mehr
passt, wird nicht gelöscht, sondern wandert in den Vorrat zurück — mit erhöhter
Priorität für die Folgetage, sofern noch welche da sind. Ausgeworfen wird
zuerst, was die niedrigsten Gruppenstimmen hat — Herzenswünsche und das
Fairness-Konto (§6.1) schützen dabei einzelne Setzungen davor, als Erstes zu
fallen.

**Für den Nutzer sichtbar** ist immer nur die Konsequenz, nicht die Rechnung:
*„Der Nachmittag wird knapp — E fällt raus und rutscht auf morgen Vormittag."*
Mit Rückgängig-Knopf.

## 6. Zu mehreren unterwegs: Beiträge, Rollen, Splits

Bis hierher liest sich das Konzept, als plante eine Person. Tatsächlich benutzen
mehrere Familienmitglieder die App, tragen Spots bei, gewichten sie
unterschiedlich und laufen unterwegs zeitweise auseinander. Das ist keine
Randbedingung, sondern prägt Datenmodell und Mechanik.

### 6.1 Der Vorrat ist gemeinsam, die Bewertung ist persönlich

Alle Teilnehmer speisen **denselben Vorrat** (§5): über die Kandidatensuche,
über geteilte Orte aus anderen Apps (§9.2) oder von Hand. Sichtbar bleibt, wer
was beigetragen hat — das kostet nichts und ist sozial wichtig.

Bewertet wird dagegen **pro Person**: durchwischen mit *will ich* / *egal* /
*lieber nicht*. Wer kein eigenes Konto hat (kleine Kinder), bekommt eine
stellvertretend geführte Stimme.

**Der Mittelwert ist dabei die falsche Aggregation** — und das ist der wichtigste
Punkt dieses Kapitels. Ein Durchschnitt wählt aus, was alle *mittelmäßig*
finden, und streicht, was einer Person *sehr viel* und den übrigen nichts
bedeutet. Das Ergebnis ist ein Plan, den niemand geliebt hat. Deshalb zwei
Korrektive:

- **Herzenswünsche mit Kontingent.** Jede Person hat pro Etappe eine kleine
  feste Zahl an Setzungen (etwa zwei je drei Tage). Ein so markierter Spot kommt
  in den Plan, solange er physisch möglich ist — unabhängig von der Mehrheit.
  Das schützt genau die Vorlieben, die ein Durchschnitt zermahlt.
- **Ein Fairness-Konto.** Für alles Übrige zählt die Stimmensumme, aber der
  Planer merkt sich, wessen Wünsche schon erfüllt wurden, und bevorzugt bei
  Gleichstand die Person, die zuletzt zurückstecken musste. Ein Zähler, kein
  Verfahren — und erklärbar: *„heute ist mal wieder X dran."*

Ein *lieber nicht* ist ein starkes Minus, aber kein Veto. Echte Ausschlüsse
(„keine Höhenwege") sind keine Stimmen, sondern Nebenbedingungen der Person
(§3.5) und wirken auf den Solver, nicht auf das Ranking.

### 6.2 Braucht es einen Trip Leader?

**Ja — aber als Organisator, nicht als Chef, und nur für die Vorbereitung.**

Ohne eine verantwortliche Person gibt es bei Konflikten keinen definierten
Zustand. Eine starke Leitungsrolle wäre aber sozial falsch: Urlaub ist keine
Hierarchie, und eine App, die das erzwingt, wird lästig. Der Organisator bekommt
deshalb genau drei Sonderrechte:

1. **Das Gerüst ändern** — Zeitraum, Etappen, Anker (§4.2).
2. **Teilnehmer einladen und entfernen.**
3. **Stichentscheid**, wenn das Fairness-Konto unentschieden bleibt.

Alles andere darf jeder: Spots beitragen, bewerten, Alternativen vorschlagen,
Splits eröffnen, unterwegs umplanen. Organisator ist zunächst, wer den Trip
angelegt hat; die Rolle ist übertragbar. Technisch fügt sich das in die
vorhandene Freigabemechanik (`albumShares`), an der das Trip-Album ohnehin
hängt.

**Unterwegs gibt es keinen Leader.** Wer vor Ort ist, darf umplanen — eine
Verspätung ist ein Fakt, keine Entscheidung. Müsste die Gruppe warten, bis der
Organisator sein Telefon zückt, wäre die Mechanik aus §5 wertlos.

### 6.3 Gleichzeitige Änderungen

Mehrere Geräte, teils offline, ändern denselben Plan — das ist der teuerste
Teil des Mehrbenutzerbetriebs und verdient eine klare Entscheidung: **Der Plan
wird nie als Ganzes überschrieben.** Geschrieben werden feingranulare Vorgänge
(*Stopp streichen*, *Stopp verschieben*, *Constraint ändern*, *Spot beitragen*),
die der Server zusammenführt; offline entstandene Vorgänge werden gepuffert und
beim Verbinden angewandt. Wer den ganzen Plan als Dokument speichert, verliert
regelmäßig die Änderungen der anderen.

Sichtbar bleibt, wer was geändert hat, mit Rückgängig-Möglichkeit. Push für die
Gruppe gibt es bereits (`push`, `sharedalbum`) — sinnvoll ist er sparsam: bei
Streichungen, Splits und verschobenen Treffpunkten, nicht bei jeder Umsortierung.

### 6.4 Automatisch erkennen, dass ein Spot erledigt ist

Drei Signale, von denen zwei ohne Zusatzaufwand anfallen:

1. **Aufenthalt.** Geofence um den Spot, Radius nach Objektgröße (Aussichtspunkt
   ~50 m, Park ~300 m), und entscheidend ist die **Verweildauer**, nicht der
   Eintritt: an einem Museum vorbeizulaufen ist kein Besuch. Schwelle etwa zehn
   Minuten oder ein Viertel der geplanten Dauer; für Spots, die zwischen zwei
   anderen auf dem Weg liegen, höher.
2. **Fotos.** Der Trip Mode sammelt ohnehin Aufnahmen mit Ort und Zeit ein, und
   der POI-Matcher ordnet sie konkreten Sehenswürdigkeiten zu
   (`osm-admin/poi-matcher.ts`). Trifft ein Foto den geplanten Spot, ist das der
   beste denkbare Beleg — und er kostet nichts, weil die Maschinerie existiert.
3. **Zahlung.** Ein Beleg oder eine Kartenzahlung im Zeitfenster (§10.6), vor
   allem bei Eintritt und Gastronomie.

**Ein Signal ergibt einen Vorschlag** („wart ihr hier? ✓ / ✗"), **zwei Signale
setzen den Status stumm** — Fehler sind mit einer Wischgeste billig korrigierbar,
Fehlalarme dagegen nerven.

Wertvoller als das Abhaken ist die Umkehrung: **auch ungeplante Aufenthalte
erkennen.** *„13:40–14:20 wart ihr hier — als Stopp übernehmen?"* Damit zeichnet
die App den tatsächlichen Tag auf, statt nur den geplanten abzuhaken, und das
Reisetagebuch (§3.6) schreibt sich von selbst.

Erledigt ist dabei **pro Person**, nicht pro Gruppe — sonst zerfällt die
Zuordnung beim Split (§6.5), und die Historie wüsste später nicht, wer den Tempel
gesehen hat. Geteilt wird ausschließlich das Ereignis „X war an Spot Y", nie ein
laufender Standort; auch das abschaltbar. Eine Live-Karte mit den Punkten der
Familie ist ein anderes Produkt.

### 6.5 Splits: getrennt unterwegs, gemeinsam geplant

Der Fall ist häufiger als gedacht: Einer ins Technikmuseum, die anderen auf den
Markt; ein Elternteil bleibt beim schlafenden Kind im Hotel; unterschiedliche
Rückfahrten.

**Ein Split ist ein Blockattribut, kein zweiter Trip.** Ein Block bekommt statt
einer Stoppfolge zwei oder mehr **Zweige**, jeder mit eigener Teilnehmermenge,
eigener Folge und eigenem Budget. Alle Zweige beginnen am Trennpunkt und enden
am **Treffpunkt** — und der ist ein echter Fixpunkt mit Uhrzeit im Sinne von
§4.4. Vom Treffpunkt rückwärts ergibt sich das Budget jedes Zweigs, und der
vorhandene Solver läuft einfach *n*-mal. Mehr Mechanik braucht es nicht.

**Der Planer sollte Splits aktiv vorschlagen.** Gehen die Stimmen zu zwei Spots
weit auseinander, ist der übliche Kompromiss — beides halb, oder das eine
gestrichen — schlechter als die Trennung:

> *„Diese beiden Spots spalten die Gruppe. Ihr könntet euch vormittags trennen
> und um 13 Uhr am Markt wieder treffen."*

Das ist der Punkt, an dem die Stimmdaten aus §6.1 ihren eigentlichen Nutzen
entfalten: **Der Split ist Konfliktlösung statt Kompromiss** — die billigste Art,
allen ihren Wunsch zu erfüllen. Er verbraucht deshalb auch keine
Herzenswunsch-Kontingente. Wer in welchen Zweig gehört, schlägt der Planer
anhand der Stimmen vor; entschieden wird es von Hand.

Weiteres:

- **Umplanen** geschieht je Zweig. Verzögert sich einer, verschiebt sich der
  Treffpunkt für alle — genau hier ist ein Push sinnvoll („Zweig B braucht
  20 Minuten länger").
- **Erledigt** gilt nur im eigenen Zweig (§6.4).
- **Grenze:** Splits laufen innerhalb eines Blocks, höchstens über einen Tag.
  Wer sich für drei Tage trennt, plant zwei Trips — dafür braucht es keine
  Sonderlogik.

### 6.6 Was das am Datenmodell ändert

Ergänzend zu §12: `trip_members` (Person, Rolle, ob stellvertretend geführt) ·
`plan_votes` (Person, Kandidat, Wertung, Herzenswunsch-Flag) ·
`member_fairness` (erfüllte und zurückgestellte Wünsche je Person und Etappe) ·
`plan_branches` (Block, Teilnehmermenge, Treffpunkt und -zeit) ·
`plan_stops.branch_id` · `stop_visits` (Person, Spot, von–bis, Quelle:
Geofence / Foto / Zahlung / manuell) — Letzteres ist zugleich die Grundlage des
Reisetagebuchs.

## 7. Standort, Wetter und Licht

Drei Umgebungssignale, die den Plan prägen. Alle drei sind grob genug, um zur
Blockeinteilung zu passen, und keins davon erzwingt eine Uhrzeit.

### 7.1 Standort

Die App kennt den Standort und nutzt ihn für vier Dinge:

- **Umplanen ohne Tippen.** Statt „wir sind hier, es ist jetzt" von Hand zu
  drücken, merkt die App selbst, dass die Gruppe noch beim zweiten von vier
  Spots steht, während der Block halb vorbei ist, und **bietet** eine
  Neuverteilung an. Angeboten, nicht durchgeführt — ungefragt umzuräumen wäre
  übergriffig.
- **Erledigt-Erkennung.** Verweildauer am Spot setzt den Status selbst und
  speist das Reisetagebuch — die Signale, Schwellen und Fallstricke stehen in
  §6.4.
- **„Was ist hier in der Nähe?"** — spontan, ohne Plan, aus demselben Vorrat.
- **Wegschätzung ab dem echten Standort** statt ab dem geplanten Punkt.

**Technisch batterieschonend:** kein Dauer-GPS, sondern Region Monitoring
(Geofences um die nächsten ein bis zwei Stopps) plus *significant location
change*. iOS weckt die App bei Bedarf; dazwischen kostet es praktisch nichts.
Der Trip Mode holt sich ohnehin schon eine `CLLocation` beim Start.

**Datenschutz:** Der Standort bleibt für die Planung auf dem Gerät — der Vorrat
liegt lokal, die Neuverteilung rechnet lokal (§12). Zum eigenen Server geht er
nur, wenn geteilt geplant wird; nach außen (Wetter) nur gerundet (§7.2).

### 7.2 Wetter, vor allem Niederschlag

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
Randzeiten des Tages — was sich zwanglos mit dem Lichtfenster aus §7.3 deckt.

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

### 7.3 Licht: wann die Fotos gut werden

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
- **Die Bewölkung aus §7.2 moduliert das Ganze:** bei geschlossener Decke ist
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

## 8. Wie sich das in der iOS-App anfühlt

### 8.1 Einstieg
Im bestehenden **Trip**-Tab kommt neben „Aufnehmen" (Trip Mode) ein zweiter
Bereich **„Planen"** dazu. Beides sind Ansichten desselben Trips: erst planen,
dann unterwegs anpassen und fotografieren, danach der Rückblick.

### 8.2 Eingabe
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

### 8.3 Ergebnis
Pro Tag eine **Karte je Block** (Vormittag / Mittag / Nachmittag / Abend), darin
die Spots als kompakte Zeile mit Referenzbild, geschätzter Aufenthaltsdauer und
Wegsymbol dazwischen. Darunter eine Auslastungsanzeige: „ca. 3 h von 3,5 h".
Kartenansicht mit nummerierten Pins pro Tag. „Warum hier?" pro Spot
aufklappbar.

### 8.4 Verhandeln
- Spot wischen → **ersetzen** (Alternativen aus dem Vorrat, die ins selbe
  Zeitbudget passen) oder **in den Vorrat zurück**.
- Anheften (📌) → Fixpunkt.
- Zwischen Blöcken und Tagen ziehen → Budgets rechnen sich sofort neu, ein
  überfüllter Block wird rot.
- Chat für alles, was sich nicht ziehen lässt.

### 8.5 Modus „Heute"
Der unterwegs wichtigste Screen: aktueller Block, was noch drin ist, wie viel
Budget übrig ist. Ein großer Knopf **„umplanen"** (siehe §5) und pro Spot ein
Wisch für „erledigt" / „übersprungen" — Letzteres setzt sich am Standort oft
schon selbst. Über dem Block ein schmales Band mit Regenrisiko und, wenn heute
etwas im guten Licht liegt, dem Lichthinweis. Navigation per Deep-Link an Apple
Maps.

### 8.6 Danach
Geplant gegen tatsächlich besucht, Fotos je Spot aus dem Trip-Album, Übergabe an
den Recap.

## 9. Übergänge zu Karten-Apps

Die Arbeitsteilung aus §3 wird hier konkret: **fk-encore plant, Apple und Google
navigieren und bewerten.** Das ist kein Notbehelf, sondern Absicht — Echtzeit
und Publikumsmeinung sind nicht nachbaubar (§10), Tagesplanung dafür schon.

### 9.1 Hinaus: was die App abgibt

- **Navigation zum nächsten Stopp** im Modus des Blocks (Fuß, ÖPNV, Auto),
  **wahlweise mit Apple Karten oder Google Maps** — siehe die Zielapp-Wahl
  unten.
- **Ein ganzer Block als Sequenz.** Apples `openMaps` nimmt ein Array von
  Zielen, die Google-Maps-URL kennt Wegpunkte — damit wandert nicht nur der
  nächste Punkt, sondern der ganze Vormittag am Stück hinüber.
- **ÖPNV-Verbindung nachschlagen** — genau dort, wo unsere Schätzung am
  schwächsten ist (§4.1). Die Karten-App hat den Echtzeitfahrplan, wir nicht.
- **Spot in Karten nachschlagen** — Bewertungen, Innenraumfotos, aktuelle
  Öffnungszeiten. Der bewusste Ausgleich für das, was offene Daten nicht
  hergeben (§10).
- **Parken / Park & Ride** beim Moduswechsel einer Auto-Etappe (§4.2).
- Verwandt, ohne Karten-App: `tel:` und `website` stehen als OSM-Tags bereit
  (Tisch reservieren, Öffnungszeit erfragen), und die Fixpunkte eines Tages
  lassen sich per EventKit in den Kalender exportieren.

**Die Zielapp ist eine Nutzerwahl, keine Vorgabe.** Viele navigieren
gewohnheitsmäßig mit Google Maps — gerade im Ausland, wo dessen ÖPNV-Daten oft
besser sind. Deshalb:

- Eine Einstellung **„Navigation öffnen mit"** mit den Werten *Apple Karten*,
  *Google Maps* und *jedes Mal fragen*; Standard ist Apple Karten, weil sie
  immer vorhanden sind.
- Google Maps erscheint als Option nur, wenn es installiert ist — geprüft über
  `canOpenURL` auf `comgooglemaps://`, was einen Eintrag in
  `LSApplicationQueriesSchemes` der `Info.plist` voraussetzt. Fehlt der Eintrag,
  meldet die Prüfung stillschweigend „nicht vorhanden", und die Option
  verschwindet grundlos — ein klassischer Stolperstein.
- Als Rückfallebene taugt die universelle `https://www.google.com/maps/dir/`-URL:
  Sie öffnet die App, wenn sie da ist, sonst den Browser. Damit funktioniert die
  Auswahl auch dann, wenn die Schema-Prüfung scheitert.
- **Der Modus muss mitgehen.** Was intern „zu Fuß / ÖPNV / Auto" heißt, wird pro
  Zielapp übersetzt (Apple: `MKLaunchOptionsDirectionsModeKey`; Google:
  `directionsmode` bzw. `travelmode`). Ein Block, der zu Fuß geplant ist, darf
  nicht als Autoroute aufgehen — sonst stimmt die Ankunftszeit nicht, mit der
  der Plan rechnet.
- Die Wahl gilt für **alle** Übergaben dieses Kapitels, nicht nur für die
  Navigation: Nachschlagen, ÖPNV-Verbindung und Parksuche folgen derselben
  Einstellung.

### 9.2 Herein: der unterschätzte Weg

**Teilen aus einer Karten-App in den Trip-Vorrat.** Wer in Google Maps, einem
Blog oder einer Nachricht auf einen Ort stößt, schickt ihn über das Teilen-Sheet
in den Vorrat der laufenden Etappe — und beim nächsten Umplanen ist er ein
Kandidat wie jeder andere. Damit ist Recherche in fremden Apps kein Bruch mehr,
sondern eine Zulieferung.

Die **Share-Extension existiert bereits** (`ios/App/ShareExtension`), nimmt
heute aber nur Bilder entgegen (`NSExtensionActivationSupportsImageWithMaxCount`).
Sie müsste um URLs und Ortsangaben erweitert werden. Ehrlich dazu: Aus einem
geteilten Karten-Link die Koordinate zu ziehen, ist fragil — die Formate ändern
sich ohne Ankündigung. Der Fallback ist deshalb kein Fehlerdialog, sondern eine
Karte mit der Bitte, den Ort zu bestätigen; danach wird per Umkreissuche und
Reverse-Geocoding (`geo/src/reverse.ts`) ein OSM-POI zugeordnet oder der Punkt
frei übernommen.

### 9.3 Die Karte in der App

Die eingebettete Karte ist MapKit, also **Apples Kartenmaterial** — die
Sachdaten (Kandidaten, Kategorien, Öffnung) kommen dagegen aus den eigenen
OSM-Regionen. Zwei Ebenen mit klarer Trennung: Apple zeichnet, fk-encore weiß.

Nützlich und wenig bekannt: **Look Around** lässt sich seit iOS 16 über
`MKLookAroundViewController` direkt in der App einbetten. „Lohnt dieser
Aussichtspunkt überhaupt?" beantwortet sich damit ohne App-Wechsel — dort, wo
Apple Daten hat; sonst entfällt der Knopf stillschweigend.

### 9.4 Die Grenze

Kein Deep-Link gibt etwas zurück. Die App erfährt nie, ob ihr wirklich
losgefahren seid oder was ihr in Google gelesen habt. Alles, was nach der
Übergabe passiert, kommt ausschließlich über den Standort zurück (§7.1) — was
die Rückkehr in die App bewusst billig machen muss: eine Wischgeste für
„erledigt", kein Formular.

## 10. Essen, Café und andere Alltagsspots

Die Frage nach der Datenbasis ist hier am unbequemsten, deshalb ein eigenes
Kapitel.

### 10.1 Der Befund: offene Daten kennen Existenz, nicht Meinung

OSM führt Gastronomie zuverlässig als **Existenz mit Eigenschaften**:
`amenity=restaurant|cafe|fast_food|bar|pub|ice_cream|bakery`, dazu `cuisine`,
`diet:vegetarian` / `diet:vegan`, `outdoor_seating`, `wheelchair`, `takeaway`,
`opening_hours`, `phone`, `website`, Adresse.

Was fehlt, ist alles Wertende: **Qualität, Beliebtheit, Preisniveau** — und die
Aktualität. Gastronomie hat die höchste Fluktuation aller POI-Klassen; ein
Eintrag von vorletztem Jahr kann längst geschlossen sein. Auch die neueren
offenen Datensätze (Overture Places, Foursquare Open Source Places) ändern daran
nichts: Sie liefern mehr Existenz und bessere Kategorien, aber keine
Bewertungen. Publikumsmeinung ist faktisch nirgends als offene Daten verfügbar.

**Daraus folgt die Arbeitsteilung mit §9** — nicht als Ausrede, sondern als
einzige ehrliche Lösung: Wir liefern Struktur, Nähe und Zeit, Google liefert die
Meinung, ein Fingertipp verbindet beides.

### 10.2 Der Import kennt heute keine Gastronomie

Konkret fehlt die Datenbasis noch ganz. Der Lua-Filter nimmt aus `amenity` nur
`place_of_worship` und `theatre` mit (`geo/src/osm2pgsql.lua`) — er wurde für
das **Foto-POI-Matching** gebaut, nicht fürs Planen. In `osm_pois` steht kein
einziges Café.

Die Erweiterung ist die dritte und größte der Importänderungen aus §12 und
verdient zwei Anmerkungen:

- **Sie vergrößert die Regionsdatenbanken spürbar.** Gastronomie und
  Alltagsinfrastruktur sind um Größenordnungen zahlreicher als
  Sehenswürdigkeiten. Vor dem Neuimport messen.
- **Sie gefährdet das Foto-Matching nicht.** Die Tag-Filter stehen in der
  `WHERE`-Klausel von `findPoiCandidates` und wirken damit **vor** dem `LIMIT`
  (`geo/src/pois.ts`) — der Matcher schickt seine engen Defaults mit und sieht
  Cafés nie, auch wenn sie in der Tabelle stehen. Diese Reihenfolge ist der
  Grund, warum keine zweite Tabelle nötig ist; sie darf beim Umbau nicht
  verlorengehen.

### 10.3 Drei Stufen, was der Planer damit tut

1. **In der Planung nur der Rahmen.** Der Mittagsblock ist Zeit plus Gegend
   („Mittag irgendwo um B"), kein Lokal. Das ist die einzige Aussage, die
   sicher stimmt — und die nützlichste, weil sie den Nachmittag zusammenhält.
2. **Vor Ort eine gefilterte Liste, keine Rangliste.** Umkreis um den aktuellen
   Standort, gefiltert nach dem, was OSM verlässlich weiß (Küche, vegetarisch,
   Außenplätze, barrierefrei, grob geöffnet), **sortiert nach Entfernung** — nicht
   nach einer Qualität, die wir nicht kennen. Jeder Eintrag mit einem Knopf „in
   Karten ansehen" (§9.1) und, wo getaggt, `tel:`.
3. **Eigene Signale, wo vorhanden.** Gruppen-Votes; Fotos, die ihr dort gemacht
   habt; auf Wunsch Belege und Kartenzahlungen (§10.6). Stark bei Wiederholung,
   im Regelfall leer — Leitentscheidung 3 gilt auch hier.

### 10.4 Die harte Regel für das LLM

**Das Modell darf ausschließlich aus dem Kandidatenvorrat formulieren, niemals
aus seinem Weltwissen empfehlen.** Ein lokales Modell nennt sonst bereitwillig
Lokale, die es nie gab oder die seit Jahren zu sind — flüssig, überzeugend und
ohne Quelle. Ein einziges erfundenes Restaurant beschädigt das Vertrauen in den
gesamten Planer, auch dort, wo er richtig liegt. Praktisch heißt das: Jeder Name
im erzeugten Text wird gegen den Vorrat validiert; was dort nicht steht, fliegt
raus.

### 10.5 Wo dieselbe Datenbasis glänzt

Apotheke, Supermarkt, Bäckerei, öffentliche Toilette, Trinkbrunnen, Spielplatz,
Bank, Gepäckaufbewahrung: Hier genügt **Existenz**, niemand braucht
Bewertungen — und genau das kann OSM hervorragend. Für Reisen mit Kindern oder
mit eingeschränkter Gehfähigkeit (§3.5) ist das unmittelbar nützlich und ohne
jeden Vorbehalt nutzbar.

Die Datenbasis ist also genau dort stark, wo **Funktion** zählt, und genau dort
schwach, wo **Geschmack** zählt. Der Planer sollte sich entsprechend verhalten:
selbstbewusst beim Finden einer Apotheke, zurückhaltend beim Abendessen.

### 10.6 Belege und Zahlungen: was realistisch geht

Kassenbelege und Kartenzahlungen als Signal sind **dünn gesät** — und die naive
Umsetzung („Airline-Buchung → Flug → Trip → Ort") ist zu Recht abschreckend.
Sie ist aber auch nicht nötig: Der Weg zerfällt in zwei viel einfachere Fragen,
und die schwierige Richtung ist die falsche.

**Flüge: das Dokument ist die Quelle, nicht die Transaktion.** Eine
Banktransaktion einer Fluggesellschaft nennt Händler und Betrag — mehr nicht.
Kein Ziel, keine Flugzeiten, und ihr Datum ist das **Buchungsdatum**, das
Monate vor dem Flug liegt. Daraus einen Trip abzuleiten, ist aussichtslos. Die
Buchungsbestätigung als PDF dagegen liegt bereits OCR-verarbeitet und
klassifiziert im documents-Service und enthält alles: Flugnummer, Datum,
Uhrzeiten, Flughäfen. Sie ist der Fixpunktlieferant (§3.4), die Transaktion ist
es nicht.

**Umgekehrt ist die Verknüpfung leicht.** Steht das Dokument mit Betrag, Datum
und Airline fest, findet sich die passende Transaktion mit hoher Sicherheit —
und das Datenmodell sieht die Verbindung bereits vor (`receipt_document_id` in
`finance/transactions.ts`). Dokument → Transaktion, nie Transaktion → Reise.

**Für Essensvorschläge braucht es überhaupt keine Trip-Zuordnung.** Gefragt ist
nur „haben wir hier schon einmal bezahlt?" — dafür genügen Händlername und
Datum. Der schwierige Teil ist ein anderer: **Händlername → POI**. Was auf dem
Kontoauszug steht, ist abgekürzt, groß geschrieben, oft der Zahlungsdienstleister
statt des Lokals und manchmal die Firmierung statt des Aushängeschilds. Ein
automatischer Treffer ist die Ausnahme.

Deshalb in zwei Stufen, und die erste kommt ohne Zuordnung aus:

1. **Im Reisetagebuch** (§3.6) erscheinen Belege und Zahlungen schlicht am
   jeweiligen Reisetag. Das braucht nur den Zeitraum, den der Trip ohnehin
   kennt, ist sofort nützlich und kann nichts falsch zuordnen. Daraus ergibt
   sich zugleich die **Kostenübersicht des Trips** — beschlossen: Der Trip weist
   seine Kosten selbst aus, statt sie nur im finance-Bereich sichtbar zu machen.
   Er braucht dafür keine eigene Buchhaltung, nur die Summe über seinen
   Zeitraum, aufgeschlüsselt nach den Tagen und, wo bestätigt (Stufe 2), nach
   Orten.
2. **Als Planungssignal erst nach Bestätigung.** Tippt der Nutzer im Tagebuch
   „das war das Café am Markt", wird die Zuordnung gespeichert und gilt künftig
   automatisch. Das ist dasselbe Muster wie beim Benennen von Gesichtern und
   beim Duplikat-Review: Vorschlag, Bestätigung, gelernte Regel. Ohne
   Bestätigung wird nichts zugeordnet.

Damit bleibt der Aufwand klein und proportional zum Nutzen — der ohnehin erst
bei Wiederholungsbesuchen entsteht. Ein sinnvoller später Schritt, kein
Baustein für den Anfang.

### 10.7 Geprüft und verworfen: Bewertungen per API

Naheliegende Frage, deshalb hier die Prüfung samt Ergebnis — damit sie nicht
später erneut aufgerollt wird.

**Technisch gibt es das.** Die **Google Places API (New)** liefert zu einem Ort
`rating`, `userRatingCount`, einige Rezensionstexte, Preisniveau, aktuelle
Öffnungszeiten und Fotos; Suche per Text, Umkreis oder Place-ID. Sie braucht
einen API-Schlüssel und ein Abrechnungskonto, hat ein monatliches Freikontingent
und kostet darüber hinaus pro Abfrage. Für ein Familiensystem wäre das Volumen
kein Kostenproblem.

**Drei Gründe sprechen trotzdem dagegen:**

1. **Die Nutzungsbedingungen verbieten genau das, was wir bräuchten.** Inhalte
   der Places API dürfen (mit Ausnahme der Place-IDs) nicht dauerhaft
   gespeichert werden, und die Darstellung zusammen mit einer **Nicht-Google-Karte**
   ist untersagt. Unser Planer lebt aber von einem **vorab bewerteten Vorrat**
   (§4.3) und zeichnet auf einer MapKit-Karte (§9.3). Beides zusammen geht
   nicht. Ein Ranking, das bei jedem Öffnen neu eingekauft werden muss und
   offline nicht existiert, ist kein Vorrat.
2. **Es widerspricht dem Kern des Produkts.** Jede Abfrage sendet Ort, Zeitpunkt
   und Absicht an Google — genau das, was §3 als Unterschied zu Google Maps
   ausweist. Ein Planer, der im Hintergrund Google fragt, ist ein
   Google-Frontend mit Extraschritten.
3. **Es macht das System von einem fremden Schlüssel abhängig.** Preismodell,
   Kontingente und Bedingungen ändern sich; ein selbst gehostetes System sollte
   nicht ausfallen, weil ein Abrechnungskonto abläuft.

**Die Alternativen sind nicht besser.** Apples MapKit-Suche liefert Orte, aber
**keine Bewertungen**. Yelp hat eine brauchbare API, außerhalb Nordamerikas aber
dünne Abdeckung — für Prag oder Osaka wenig hilfreich. Die TripAdvisor-Content-API
deckt Touristisches ordentlich ab, verlangt aber Logo und Verlinkung an jeder
Anzeigestelle und beschränkt das Speichern ebenfalls. Foursquare hat Bewertungen
nur im kommerziellen Dienst, nicht im offenen Datensatz (§10.1).

**Ergebnis: kein Rating-Backend, sondern der Fingertipp.** Die Übergabe aus §9.1
liefert dasselbe Ergebnis ohne Schlüssel, ohne Kosten, ohne
Speicherbeschränkung und ohne dass fk-encore selbst zum Datenlieferanten an
Google wird: Du tippst auf „in Karten ansehen", siehst dort Bewertungen, Fotos
und aktuelle Öffnungszeiten, und kommst zurück. Diese Frage bestätigt die
Arbeitsteilung aus §9, statt einen neuen Weg zu eröffnen.

*Sollte sich das ändern* — etwa weil eine Quelle mit freundlicheren Bedingungen
auftaucht —, wäre die verträglichste Form eine **einzelne, vom Nutzer ausgelöste
Abfrage** für einen Spot („Bewertung laden"), nur zur Anzeige, ohne Speicherung
und ohne Einfluss auf das Ranking. Als Massenanreicherung des Vorrats jedoch
nie.

## 11. Wenn ein Frontier-Modell zur Verfügung steht

Alle bisherigen Entscheidungen sind unter einer Randbedingung gefallen: Das
einzige verfügbare Sprachmodell ist ein lokales Qwen2.5-7B. Stünde stattdessen
die Claude API mit **Opus 5** (`claude-opus-5`, 1M Kontext, $5 / $25 je Mio.
Ein-/Ausgabe-Token) bereit, änderte sich einiges — aber weniger, als man
zunächst vermutet, und an anderer Stelle als erwartet.

### 11.1 Die Trennlinie liegt schon im Konzept

Der Planer zerfällt ohnehin in zwei Welten (§4.3): die **Reiseauflösung**
entsteht vorher, zu Hause, am Netz und ohne Zeitdruck — die **Tagesauflösung
und alles unterwegs** muss offline, sofort und verlässlich funktionieren.
Genau entlang dieser Naht verläuft die sinnvolle Aufteilung zwischen den
Modellen:

| | lokal (Qwen) | Opus 5 (online, opt-in) |
|---|---|---|
| Kandidaten kuratieren | Gewichtete Summe | **deutlich besser** |
| Anfrage verstehen | brüchig | **deutlich besser** |
| Dokumente auswerten | ordentlich | **deutlich besser** |
| Verhandlungs-Chat vorab | knapp ausreichend | **deutlich besser** |
| Tagebuch-/Recap-Texte | ordentlich | besser |
| Umplanen unterwegs | **zwingend lokal** | ungeeignet |
| Solver | **keins von beiden** | keins von beiden |

**Die harte Regel: Opus 5 darf nie auf dem kritischen Pfad des Umplanens
liegen.** „Wir hängen hinterher" muss im Funkloch in Hakata funktionieren. Ein
Netzaufruf ist dort keine Verbesserung, sondern ein Ausfall.

### 11.2 Was sich nicht ändert

- **Der Solver bleibt Arithmetik.** Rucksack pro Block plus Kurzrundreise über
  zwei bis vier Stopps ist exakt, in Millisekunden lösbar, deterministisch und
  offline. Kein Modell der Welt macht das besser; es macht es langsamer, teurer
  und nicht reproduzierbar. Was Opus 5 beisteuern kann, ist die **Auswahl**, die
  in den Solver geht — nicht die Rechnung.
- **Die Halluzinationsregel aus §10.4 bleibt.** Opus 5 erfindet drastisch
  seltener, aber „seltener" ist nicht „nie", und der Fehler ist unsichtbar. Jeder
  Ortsname wird weiter gegen den Vorrat validiert. Technisch billig, deshalb
  keine Ausnahme.
- **Die Ellipsen-Vorfilterung, die Lichtrechnung, die Blocklogik** — alles
  Rechenverfahren, alles unberührt.

### 11.3 Was deutlich besser würde

1. **Kandidatenkuration statt Tag-Ranking.** Heute entscheidet eine gewichtete
   Summe aus OSM-Tags und Wikipedia-Artikellänge, was ein Favorit ist — grob.
   In 1M Kontext passt der komplette Vorrat einer Stadt samt Wikipedia-Auszügen
   in **eine** Anfrage, und heraus kommt eine begründete, thematisch
   ausgewogene Auswahl: „diese 12 von 34, und warum". Das ist der größte
   Qualitätssprung — und ausgerechnet der billigste, weil er vorab und
   stapelweise läuft (Batch-API: halber Preis).
2. **Anfrageverständnis.** „Mit Oma, entspannt, kein Auto" zuverlässig in
   Constraints zu übersetzen, ist für ein 7B-Modell brüchig. Mit **Structured
   Outputs** (`output_config.format`) bzw. `strict: true` an den Tools kommt ein
   schemavalides Objekt zurück — genau das, was §8.2 als Chips anzeigt.
3. **Der Verhandlungs-Chat vor der Reise.** Opus 5 könnte per Tool-Use die
   Planer-API selbst bedienen (`vorrat_durchsuchen`, `constraint_setzen`,
   `anheften`, `neu_verteilen`), statt nur Constraints auszuwerfen. Aus „zu viel
   Laufen" wird ein Werkzeugaufruf mit sichtbarer Wirkung statt einer Umschreibung.
4. **Dokumentenauswertung.** Fixpunkte aus OCR-Text zu ziehen — Flugzeiten,
   Check-in-Regeln im Kleingedruckten, fremdsprachige Bestätigungen — ist genau
   die Disziplin, in der ein Frontier-Modell ein 7B klar schlägt. Pro Dokument
   einmal, cachebar, nicht zeitkritisch.
5. **Texte im Reisetagebuch.** Geringes Risiko, sichtbarer Gewinn.

### 11.4 Kosten sind nicht das Hindernis

Grob geschätzt: Die Kuration einer Stadt liegt im Bereich einiger
zehntausend Eingabe-Token — also **deutlich unter einem Euro**, halbiert über
die Batch-API. Ein Chat-Verlauf mit Prompt-Caching kostet Cent-Beträge, weil
zwischengespeicherte Token nur etwa ein Zehntel kosten. Für ein Familiensystem
ist das irrelevant.

Zwei Caching-Details, die dabei zählen: Die Reihenfolge ist
`tools` → `system` → `messages`, Stabiles nach vorn, Veränderliches ans Ende —
also Vorrat und Systemprompt zuerst, die aktuelle Frage zuletzt. Und Opus 5
erlaubt **Systemnachrichten mitten im Verlauf** (`role: "system"` innerhalb von
`messages`, ohne Beta-Header), was den zwischengespeicherten Präfix erhält,
wenn sich während der Verhandlung eine Regel ändert.

### 11.5 Der eigentliche Preis: Privatsphäre

Das ist die einzige ernsthafte Frage, und sie ist keine technische. „Alles bleibt
im Haus" ist die Rückgratzusage des Produkts (§3). Ein Kurationsaufruf schickt
Kandidatenlisten, Interessen, Reisezeitraum und Gruppenzusammensetzung an einen
Dienst.

Abschwächen lässt sich das erheblich, weil die Aufgabe die Identitäten gar nicht
braucht:

- **Öffentliches nach draußen, Privates nicht.** Der Vorrat besteht aus
  OSM- und Wikipedia-Daten — öffentlich. Was ihn privat macht, sind die
  Präferenzen, und die lassen sich abstrakt fassen: „zwei Erwachsene, ein Kind
  (7), eine Person mit begrenzter Gehstrecke" statt Namen und Gesichtern.
- **Keine Anker-Adressen.** Die Ankerzone genügt als Koordinatenschwerpunkt;
  die Hoteladresse muss nicht mit.
- **Nichts aus Dokumenten, Fotos oder Finanzen** verlässt das Haus für die
  Kuration — die Dokumentenauswertung (10.3.4) wäre ein getrennter,
  eigenständig zuschaltbarer Fall.
- **Pro Funktion zuschaltbar, nicht global.** Ein einzelner „KI besser machen"-Schalter
  wäre die falsche Granularität.

Ausdrücklich nicht empfohlen ist die dritte Möglichkeit: das
**Websuche-Werkzeug** (`web_search_20260209`) als Lückenfüller für
Öffnungszeiten, Schließungen und Veranstaltungen. Es würde die
Echtzeitschwäche aus §14 tatsächlich schließen — aber mit demselben Handel,
der in §10.7 schon gegen die Google-API entschieden wurde, nur an anderer Stelle.
Wenn diese Lücke geschlossen werden soll, dann als bewusste, eigene
Entscheidung, nicht als Nebenwirkung eines Modellwechsels.

### 11.6 Fazit

Opus 5 würde den Planer **klüger in der Vorbereitung** machen und am Verhalten
unterwegs nichts ändern — was gut ist, denn unterwegs zählt Verlässlichkeit,
nicht Klugheit. Die Architektur bliebe dieselbe, mit einem zusätzlichen,
optionalen Kurationsschritt zwischen Kandidatensuche und Solver. Das ist
bemerkenswert wenig Umbau für spürbar bessere Vorschläge — und ein Hinweis
darauf, dass die Aufteilung „Modell versteht und formuliert, Rechenverfahren
plant" unabhängig davon richtig ist, wie gut das Modell wird.

## 12. Architektur-Skizze

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

**Drei Änderungen am OSM-Import** sind Voraussetzung und gehören in den ersten
Umsetzungsschritt, weil jede einen Neuimport der Regionen erfordert:
`name:en` in die Tag-Allowlist (`geo/src/osm2pgsql.lua` kennt heute nur `name`
und `name:de` — in Japan steht in `name` Kanji), das beim Import berechnete
Fassadenazimut als eigene Spalte (§7.3), und die **Aufnahme von Gastronomie und
Alltagsinfrastruktur** in den Filter (§10.2), die heute vollständig fehlt. Die
ersten beiden sind je eine Handvoll Zeilen, die dritte vergrößert die
Regionsdatenbanken spürbar und will vorher gemessen werden.

**Die Lichtberechnung braucht keine externe Quelle.** Sonnenhöhe und -azimut
sind aus Koordinate und Zeitpunkt berechenbar (~100 Zeilen, keine Abhängigkeit,
kein Netz) — bewusst doppelt implementiert in TypeScript für den Server und in
Swift fürs Gerät, damit der Lichthinweis auch offline stimmt. Die
Fassadenausrichtung wird beim Kandidatenaufbau einmal aus der OSM-Geometrie
abgeleitet und am Spot gespeichert. Extern ist nur die Wettervorhersage.

**Das LLM plant nicht.** Es übersetzt Sprache in validierte Constraints und
schreibt Begründungen. So halluziniert es weder Öffnungszeiten noch Wege. Diese
Rollenteilung gilt unabhängig davon, wie gut das Modell ist — §11 spielt durch,
was sich mit einem Frontier-Modell änderte (Kuration ja, Solver nein).

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
`plan_votes` (Nutzer/KI pro Kandidat, analog zum Album-Voting) — die
Mehrbenutzer-Tabellen (Rollen, Fairness, Zweige, Besuche) stehen in §6.6.

## 13. Mögliche Umsetzungsschritte

> „Etappe" meint in diesem Dokument durchgehend einen **Reiseabschnitt**
> (§4.2); die Umsetzung ist in **Schritte** gegliedert.

### 13.0 Vorarbeiten, bevor Schritt 1 sinnvoll beginnt

Vier Dinge, die keine Feature-Arbeit sind, aber sonst später teuer werden:

- **Testbarkeit der Kandidatensuche entscheiden.** Die geo-Tests arbeiten heute
  mit skriptgesteuerten Query-Attrappen (`geo/src/replication.test.ts`) und
  laufen außerhalb des Haupt-Testlaufs (`geo/**` ist in `vitest.config.ts`
  ausgeschlossen). Für eine räumliche Tag-Query liegt das Risiko aber gerade in
  der SQL-Semantik, nicht im Zusammenbau des Strings. Empfehlung: **PostGIS in
  die Testumgebung aufnehmen** und `osm_pois` für Tests von Hand befüllen —
  ohne osm2pgsql, nur ein paar Dutzend Zeilen Saatdaten.
- **Die dreifache Tag-Liste zusammenführen.** Dieselbe Tag-Kenntnis steht in
  `geo/src/osm2pgsql.lua` (Importfilter), `geo/src/pois.ts` (Query-Defaults) und
  `osm-admin/poi.config.ts` (Aufruferfilter) — mit zwei „must stay in
  sync"-Kommentaren als einziger Absicherung. Die Planung erweitert alle drei.
  Vorher: Lua-Tabellen aus der TS-Konfiguration erzeugen, oder wenigstens ein
  Test, der die Lua-Datei liest und die Mengen vergleicht.
- **Eine kleine Entwicklungsregion festlegen.** Jede Filteränderung erzwingt
  einen Neuimport, und der dauert für ein Bundesland 10–30 Minuten
  (`osm-admin/importer.ts`). Für die Entwicklung genügt eine Stadt.
- **Den Zuwachs messen**, bevor Gastronomie und Alltagsinfrastruktur zugesagt
  werden (§10.2) — auf dem echten Host, mit einer echten Region.

### 13.1 Die Schritte

1. **`geo /pois/search` gegen den heutigen Datenbestand** — Flächen- und
   Umkreissuche mit Kategoriefilter. **Ohne Neuimport:** Sehenswürdigkeiten
   liegen bereits in `osm_pois`, und für den ersten Planer genügen sie, weil
   der Mittagsblock ohnehin nur ein Zeitfenster ist (§10.3). Damit ist der
   langsame Teil (Import) vom schnellen (Query, Solver) entkoppelt.
2. **`trip-planner`, ein Tag, Fußwege per Heuristik** — Constraints per API,
   kein LLM, kein Frontend. Liefert Blöcke mit Spots. Deterministisch testbar.
3. **Neuverteilung** — „ab hier, ab jetzt", Vorrat, Verschieben auf Folgetage.
   Bewusst **vor** dem hübschen UI, weil es die Kernmechanik ist.
4. **Importerweiterung** — jetzt, wo der Planer läuft und zeigt, welche Tags er
   wirklich braucht: `opening_hours`, `cuisine`, `wheelchair`, `fee`,
   `website`, **`name:en`**, `diet:*`, `outdoor_seating`, dazu **Gastronomie
   und Alltagsinfrastruktur** (§10.2) und das **Fassadenazimut** (§7.3). Alles,
   was einen Neuimport erzwingt, in einem Zug.
5. **NL-Eingabe** über llm-service (JSON-Schema, strikte Validierung) +
   Mehrtagesplanung.
6. **Etappen, Fixpunkte, zwei Auflösungen** (§4.2–§4.4) — Reisen über mehrere
   Orte, Modus je Etappe, Ankerzonen, Transfertage, harte Uhrzeiten mit
   Rückwärtsrechnung, Vorrat je Etappe, Detaillierung erst am Vorabend.
   Enthält die **Korridorsuche** für geplante Anreisen (Ellipsenfilter, noch
   ohne Router).
7. **iOS-Oberfläche** — Blockkarten, Karte, Wischgesten, „Heute"-Modus,
   **Übergaben an Karten-Apps** (§9.1) und die Essensliste vor Ort (§10.3).
8. **Standort** — Geofences um die nächsten Stopps, Erledigt-Erkennung,
   angebotene Neuverteilung, „was ist in der Nähe".
9. **Wetter & Licht** — Open-Meteo-Anbindung mit Cache, Indoor/Outdoor-Ableitung,
   Sonnenstandsmodul, Lichthinweise und Abendblock-Vorschlag.
10. **Weitere Kontextsignale** — Dokumenten-Fixpunkte, Reisegruppe.
11. **Mehrbenutzerbetrieb** (§6) — Beiträge und Stimmen je Person,
    Herzenswünsche und Fairness-Konto, Organisatorrolle, feingranulare
    Zusammenführung gleichzeitiger Änderungen, automatische Erledigt-Erkennung,
    Splits mit Treffpunkt. Bewusst spät: Ein Trip, den eine Person plant, muss
    vorher vollständig funktionieren.
12. **Verfeinerung, optional** — Valhalla für echte Reisezeiten, GTFS pro
   Region, Offline-Bundle, Verknüpfung mit Trip-Album und Recap.

Schritte 1–3 sind der ehrliche Test — und sie kommen **ohne einen einzigen
Neuimport** aus: Liefert die Maschine für *einen* Tag in
*einer* Stadt eine Blockeinteilung, die man tatsächlich so ablaufen würde — und
hält sie stand, wenn der Tag anders läuft? Alles danach ist Ausbau.

## 14. Bekannte Schwachstellen

- **OSM-Datenqualität.** `opening_hours` ist lückenhaft, Restaurantqualität
  steht dort gar nicht. Gegenmittel: die grobe Auflösung (§4) verzeiht
  Ungenauigkeit, fehlende Angaben werden als „ungeprüft" gekennzeichnet. Für
  Gastronomie gilt das doppelt — §10 behandelt Datenlage und Konsequenz
  ausführlich.
- **Geschätzte Reisezeiten.** Die Heuristik kann bei Flüssen, Bergen oder
  schlechter ÖPNV-Anbindung deutlich danebenliegen. Gegenmittel: Puffer im
  Blockbudget, ehrliche Kennzeichnung als Schätzung, und Schritt 12 für die
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
- **Der Korridorfilter ist eine Näherung.** Die Ellipse rechnet mit Luftlinien;
  Berge, Flüsse und Grenzübergänge sieht sie nicht. Ein Spot mit „+10 Min." laut
  Ellipse kann real eine halbe Stunde kosten. Solange kein Router mitrechnet,
  gehört die Umwegangabe deshalb als Schätzung gekennzeichnet, und das Budget
  wird großzügig angesetzt, damit die Vorauswahl nichts Gutes verwirft.
- **Übergaben sind Einbahnstraßen.** Was nach dem Deep-Link passiert, sieht die
  App nicht (§9.4). Der Rückweg in den Plan muss deshalb so billig sein, dass
  ihn niemand vergisst — eine Wischgeste, kein Formular.
- **Gleichzeitige Änderungen sind aufwendig.** Mehrere Geräte, teils offline,
  am selben Plan (§6.3) sind der teuerste Teil des Mehrbenutzerbetriebs — und
  ohne feingranulare Zusammenführung gehen still Änderungen verloren. Ebenso
  ist die automatische Erledigt-Erkennung (§6.4) in dichten Innenstädten und
  Innenräumen ungenau; deshalb Verweildauer statt Eintritt, zwei Signale für
  stummes Setzen und eine Wischgeste zum Korrigieren.
- **Keine Echtzeit.** Verkehr, Streiks, spontane Schließungen sieht das System
  nicht — bewusste Übergabe an Apple/Google Maps für die Navigation.
- **Speicherbedarf** eines späteren Routers (Valhalla-Kacheln zusätzlich zu den
  PostGIS-Region-DBs) muss in Schritt 12 gemessen und in die Regionsverwaltung
  integriert werden (Region löschen = auch Kacheln löschen).
- **Offline-Karten.** Vektorkacheln aus den PBFs (planetiler + MapLibre) wären
  ein eigener großer Baustein. Zunächst MapKit online; offline gibt es
  Blockliste, Spots und Wegbeschreibung, aber keine Kartendarstellung.

## 15. Offene Fragen an den Nutzer

Sortiert danach, wann eine Antwort gebraucht wird. **Nichts davon blockiert den
Anfang** — die Schritte 1–3 lassen sich mit den hier vorgeschlagenen
Vorgabewerten bauen.

### 15.1 Vor Schritt 1 zu entscheiden

1. **Testumgebung:** PostGIS in die Testumgebung aufnehmen und `osm_pois` für
   Tests von Hand befüllen (§13.0), oder bei den Query-Attrappen bleiben und
   nur den SQL-Zusammenbau prüfen? Empfehlung: PostGIS — die Query *ist*
   Schritt 1.
2. **Entwicklungsregion:** Welche kleine Region dient als Spielwiese, damit ein
   Neuimport Minuten und nicht Stunden dauert?

### 15.2 Vor Schritt 2 zu entscheiden

3. **Blockschema:** Sind Vormittag / Mittag / Nachmittag / Abend die richtige
   Einteilung, oder lieber frei definierbare Blöcke pro Tag? Vorgabewert für
   den Anfang: die feste Vierteilung.
4. **Web-Frontend:** nur iOS, oder Planung auch in der Vue-App? Beeinflusst den
   Schnitt der API. Empfehlung unabhängig davon: die Endpunkte
   frontend-neutral halten — das kostet jetzt nichts und hält die Tür offen.

### 15.3 Später, aber gut früh zu wissen

5. **Regionsumfang:** Eine Japanreise braucht drei Regionsdatenbanken (Kanto,
   Kansai, Kyushu), die vor der Planung importiert sein müssen — heute eine
   bewusste Admin-Entscheidung, die dauert. Soll der Planer bei einem
   unbekannten Ziel den Import selbst anbieten, oder bleibt es getrennt? Und wie
   lange darf eine Etappenregion nach der Reise liegen bleiben?
6. **Claude API überhaupt eine Option?** §11 beschreibt, was ein
   Frontier-Modell brächte. Ob es ein Konto, ein Budget und die Bereitschaft
   gibt, kuratierte Daten das Haus verlassen zu lassen, entscheidet, ob Schritt
   5 einspurig lokal oder gleich zweispurig gebaut wird.
7. **Automatik-Schwelle:** Soll die App bei Rückstand oder Wetterumschwung nur
   einen Hinweis zeigen, oder den fertigen Vorschlag gleich danebenlegen?
8. **Lichthinweise für alle?** Sichtbar für jeden, oder ein Schalter für die,
   die tatsächlich fotografieren wollen — und darf Licht einen Abendblock
   vorschlagen, den es sonst nicht gäbe?
9. **Hotelwahl:** Soll der Planer aus einer Ankerzone (§4.2) aktiv Viertel
   vorschlagen, oder bleibt die Unterkunft außerhalb seines Auftrags?

### 15.4 Aus dem Mehrbenutzerbetrieb (§6), erst für Schritt 11

10. **Kontingent der Herzenswünsche:** zwei je drei Tage — zu knapp, zu
    großzügig, oder pro Trip statt pro Etappe?
11. **Splits proaktiv?** Soll der Planer eine Trennung von sich aus vorschlagen,
    wenn die Stimmen auseinandergehen (§6.5), oder nur auf Anforderung? Ein
    ungefragter Vorschlag, sich zu trennen, kann als Einmischung gelesen werden.
12. **Sichtbarkeit in der Familie:** Sollen Besuchsereignisse anderer Personen
    („X war am Tempel") für alle sichtbar sein, nur für den Organisator, oder
    gar nicht?

---

## 16. Durchgespielt: 20 Tage Japan

Drei durchgespielte Fälle prüfen die Mechanik an ihren Rändern: eine lange
Mehrstädtereise (§16), ein Kurztrip mit dem Auto und geplanter Anreise (§17) und
ein einzelner Tagesausflug (§18). Jeder hat das Konzept verändert.

Zuerst der lange Fall — **3.9. bis 22.9.2027,
Tokio, Osaka und Hakata, zu zweit**. Bewusst ein harter Fall: lang, mehrere
Orte, weit in der Zukunft, nicht-lateinische Schrift, andere Zeitzone.

### 16.1 Vorbereitung: die Regionen

Vor jeder Planung müssen die OSM-Daten im Haus sein: drei Geofabrik-Sub-Regionen
Japans — **Kanto** (Tokio), **Kansai** (Osaka), **Kyushu** (Hakata/Fukuoka).
Das ist heute ein Admin-Vorgang, dauert, und passiert Wochen vorher, nicht beim
Planen (siehe offene Frage 2 in §15).

### 16.2 Eingabe

```
3.9. bis 22.9.2027, Tokio, Osaka und Hakata,
zu zweit, viel zu Fuß und mit der Bahn,
wir mögen Tempel, Aussicht und Märkte
```

→ Chips: `20 Tage` · `3 Etappen` · `Modi: Fuß, ÖPNV` · `Interessen: Tempel,
Aussicht, Märkte`. Findet der documents-Service Flug- und Hotelbestätigungen für
den Zeitraum, werden sie als Fixpunkte vorgeschlagen — Ankunft Haneda, drei
Hotels, und damit implizit die Etappengrenzen.

### 16.3 Etappen und Transfers

Tokio 3.–11.9., Osaka 11.–18.9., Hakata 18.–22.9. (§4.2). Die Shinkansen-Fahrten
dazwischen sind Fixpunkte, die je einen halben Tag kosten; jede Etappe bekommt
ihr Hotel als Tagesanker und ihre eigene Regionsdatenbank.

### 16.4 Grob planen, nicht alles planen

In der Reiseauflösung (§4.3) entsteht pro Etappe ein bewerteter Vorrat — „Tokio:
34 Kandidaten, 12 klare Favoriten" — plus die terminlich gebundenen Punkte
(Zeitfenster-Tickets, ein Tagesausflug). Darüber stimmt ihr zu zweit ab, die KI
stimmt mit. Ergebnis ist keine Route, sondern eine Rangfolge: Sie entscheidet
später, was zuerst wegfällt. Konkrete Blöcke entstehen erst ein bis zwei Tage
vorher.

### 16.5 Wetter acht Monate im Voraus

Gibt es nicht. In der Reiseauflösung zählen deshalb die Klimanormalen (§7.2):
September in Japan ist heiß, schwül und **Taifunsaison**. Praktische Folge im
Plan — genug Indoor-Kandidaten im Vorrat und ein nicht verplanter Puffertag je
Etappe. Ab etwa zwei Wochen vorher detailliert die echte Vorhersage tageweise.

### 16.6 Ein Tag in Tokio

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
offline in Millisekunden (§7.3).

### 16.7 Unterwegs

Um 14 Uhr steht ihr noch beim Sensō-ji. Der Geofence merkt es, die App bietet an:
*„Der Nachmittag wird knapp — Museum raus, rutscht auf Freitag Vormittag. Der
Aussichtspunkt um 17 Uhr bleibt."* Ein Tipp genügt; das Museum ist nicht
gelöscht, es liegt wieder im Vorrat.

Zieht ein Taifunausläufer durch, greift dieselbe Mechanik eine Ebene höher: Der
Regentag tauscht mit einem trockenen Tag **derselben Etappe**, Outdoor wandert
in den Vorrat, Indoor rückt nach.

### 16.8 Etappenwechsel und danach

Am 11.9. ist der Vormittag durch den Shinkansen belegt; ab Osaka gelten neue
Regionsdatenbank und neuer Anker, der Vorrat für Osaka ist längst bewertet.
Parallel sammelt der Trip Mode die Fotos ein — am Ende steht das Reisetagebuch
mit geplanten gegen tatsächlich besuchte Blöcke und der Recap.

### 16.9 Was dieses Beispiel am Konzept geändert hat

Der Durchgang hat fünf Lücken aufgedeckt, die jetzt eingearbeitet sind:
Etappen als Ebene über den Tagen (§4.2), zwei Planungsauflösungen (§4.3),
Klimanormale statt Vorhersage jenseits des Prognosehorizonts und Hitze als
Budgetfaktor (§7.2), das Fassadenazimut, das wegen der Zentroid-Reduktion beim
Import berechnet werden muss (§7.3), und `name:en` in der Tag-Allowlist, ohne
das im Plan 浅草寺 statt „Sensō-ji" stünde (§12).

---

## 17. Durchgespielt: vier Tage Prag mit dem Auto

**30.8. bis 2.9.2027, Augsburg → Prag und zurück, mit dem Auto.** Der
Gegenentwurf zu Japan: kurz, ein Ziel, aber mit einer Anreise, die selbst
geplant werden will, und einem Moduswechsel unterwegs.

### 17.1 Eingabe und Rahmen

```
30.8. bis 2.9.2027 Prag, mit dem Auto ab Augsburg.
Hotel etwa 5 Metro-Stationen vom Wenzelsplatz.
Check-in ab 15 Uhr. Auf dem Weg gern was anschauen,
wenn es nicht groß umwegt.
```

Daraus wird **eine** Etappe (Prag) mit zwei Transfers, dazu:

- **Ankerzone statt Anker** (§4.2): Das Hotel ist noch nicht gebucht. Der Planer
  rechnet mit dem Schwerpunkt der Zone rund um Muzeum/Můstek und gibt sie als
  Suchhilfe aus — welche Viertel innerhalb von etwa fünfzehn Minuten Metrofahrt
  liegen, weiß er aus den OSM-Daten besser als ein Buchungsportal.
- **Modus je Etappe** (§4.2): Auto für Hin- und Rückweg, in Prag **Fuß und
  Metro**. In die Innenstadt fährt man nicht — der Wechsel ist ein Fixpunkt:
  Park & Ride an einer Metro-Endstation oder das Hotelparkhaus, dann Gepäck ab,
  dann zu Fuß weiter.
- **Nur eine Auflösung** (§4.3): Vier Tage sind kurz genug, dass Reise- und
  Tagesauflösung zusammenfallen.

### 17.2 Der Anreisetag — die interessanteste Rechnung

Die Fahrt Augsburg–Prag liegt bei gut vier Stunden reiner Fahrzeit. Der
Check-in **ab** 15 Uhr ist kein Hindernis, sondern die Quelle des freien
Zeitfensters: Bei Abfahrt um acht wäre man um kurz nach zwölf da und stünde drei
Stunden vor einer verschlossenen Rezeption. Der Planer dreht das um und sucht im
**Korridor** (§4.2) nach einem Zwischenstopp mit rund zwei Stunden Aufenthalt und
kleinem Umwegbudget.

Die Ellipsenbedingung zieht dabei ein schmales Band entlang der Strecke aus der
Regionsdatenbank — Kandidaten mit nahezu null Umweg liegen ohnehin auf dem Weg,
weiter entfernte müssen ihr Budget rechtfertigen. Ergebnis ist ein kleiner
Vorrat statt einer einzelnen Empfehlung, mit der Umwegzeit als sichtbarer
Kennzahl („+5 Min.", „+25 Min."), über den ihr entscheidet.

Der Tag sieht danach so aus:

| Zeit | Element |
|---|---|
| ~8:00 | Abfahrt (Fixpunkt, selbst gesetzt) |
| Vormittag | Fahrt, ein Teilstück |
| Mittagsblock | Zwischenstopp im Korridor, ca. 2 h |
| Nachmittag | Rest der Fahrt, P+R, Gepäck ins Hotel |
| ab 15:00 | Check-in (Fixpunkt) |
| Restnachmittag | erster kurzer Block zu Fuß rund um den Anker |

### 17.3 Die beiden vollen Tage und die Abreise

31.8. und 1.9. sind normale Blocktage, ab dem Anker, zu Fuß und mit der Metro —
also genau der Fall aus §4.1 Der 2.9. ist wieder ein halber: Check-out am
Vormittag, Rückfahrt. Ob der Rückweg noch einen Korridorstopp verträgt, hängt
davon ab, wann ihr zu Hause sein wollt — dieselbe Rechnung wie bei der Anreise,
nur mit dem Fixpunkt am anderen Ende (§4.4).

### 17.4 Was dieses Beispiel beigetragen hat

Drei Mechaniken, die jetzt im Konzept stehen: die **Ankerzone** für noch nicht
gebuchte Unterkünfte, der **Modus je Etappe** samt Moduswechsel als Fixpunkt,
und die **Korridorsuche mit Umwegbudget** samt der Ellipsen-Vorfilterung, die
ohne Router auskommt.

---

## 18. Durchgespielt: ein Tag Nürnberg mit dem Zug

Der kleinstmögliche Trip — **Augsburg → Nürnberg und zurück, an einem Tag, mit
der Bahn**. Wertvoll als Testfall, weil hier jede Vereinfachung des Konzepts
an ihre Grenze kommt.

### 18.1 Was hier alles wegfällt

Ein Tagesausflug ist eine Etappe mit einem Tag, ohne Hotel und ohne
Reiseauflösung. Der **Anker ist der Hauptbahnhof** — Start- und Endpunkt
zugleich, und in Nürnberg praktischerweise direkt an der Altstadt, sodass der
ganze Tag zu Fuß funktioniert. Der Vorrat ist klein, die Abstimmung entfällt,
und Klimanormale braucht niemand: Für morgen gibt es eine echte Vorhersage.

Das System muss also **nach unten sauber abbauen** — kein leerer
Etappen-Assistent, keine Aufforderung, ein Hotel zu wählen, kein
Vier-Wochen-Vorrat.

### 18.2 Der Tag hängt zwischen zwei Zügen

Hier zeigt §4.4 seinen Nutzen. Beide Enden sind harte Uhrzeiten:

| | |
|---|---|
| Hinfahrt | Fixpunkt — je nach Zug rund eine bis zwei Stunden |
| Vormittag | Altstadt und Burgberg, ab Hauptbahnhof zu Fuß |
| Mittag | offen |
| Nachmittag | Museum oder ein zweiter Stadtteil |
| **Rückfahrt** | **Fixpunkt, rückwärts gerechnet** |

Vom letzten sinnvollen Zug gehen der Fußweg zum Bahnhof und ein Sicherheitspuffer
ab; was bleibt, ist das Budget des Nachmittagsblocks. Fällt ihr um drei Uhr
zurück, greift die Neuverteilung (§5) härter als in Prag oder Tokio — es gibt
kein „dann eben morgen", der Vorrat hat keinen Folgetag mehr. Genau deshalb
zählt hier die Rangfolge aus der Abstimmung am meisten: Was zuerst wegfällt,
sollte nicht das sein, wofür man gefahren ist.

### 18.3 Das Ticket als Randbedingung

Liegt ein Ticket als Dokument vor, wird seine Einschränkung zum Fixpunkt: Ein
Sparpreis mit Zugbindung legt beide Enden fest, ein Bayern-Ticket ist werktags
erst ab 9 Uhr gültig und verschiebt damit den Beginn des Vormittagsblocks. Das
ist derselbe Mechanismus wie die Hotelbuchung in §16 — nur enger, weil ein Tag
keine Reserve hat.

### 18.4 Was dieses Beispiel beigetragen hat

Es hat die Formulierung von §4.4 erzwungen: Fixpunkte sind absolut und tragen
eine Uhrzeit, Blöcke bleiben relativ. Ohne diese Trennung wäre die grobe Planung
ausgerechnet dort gescheitert, wo Pünktlichkeit zählt. Dazu die Erkenntnis, dass
das System **nach unten abbauen** können muss: Ein Tagesausflug darf sich nicht
anfühlen wie eine amputierte Weltreise.
