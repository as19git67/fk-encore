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

Wie sich das zu den KI-Reiseplanern am Markt verhält — die es inzwischen
zahlreich gibt —, steht in §19.

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

**Diese Vierteilung ist die Vorgabe, kein Zwang** (entschieden, §15.2): Jeder Tag
entsteht mit diesen vier Blöcken, aber jeder einzelne lässt sich umbenennen,
teilen, zusammenlegen oder streichen. Der Regelfall bleibt damit vorhersehbar
und ohne Konfiguration, während Anreisetage, Zugbindungen (§4.4) und Splits
(§6.5) die Struktur bekommen, die sie brauchen. Für das Datenmodell heißt das:
Der Blocktyp ist ein **Etikett samt Standardbudget**, keine feste Aufzählung —
ein Tag hält eine geordnete Liste von Blöcken, nicht vier Felder.

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

Alle Teilnehmer speisen **denselben Vorrat** (§5): über die automatische
Kandidatensuche, über eigene Funde aus Karten-Apps, Artikeln und Screenshots
(§9.2) oder über die Suche in der App. Sichtbar bleibt, wer
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
gesehen hat. Sichtbar sind die Besuche **für alle Trip-Teilnehmer** (entschieden, §15.4):
Nach einem Split muss klar sein, was der andere Zweig gesehen hat, und das
gemeinsame Tagebuch soll stimmen. Geteilt wird dabei ausschließlich das
Ereignis „X war an Spot Y", nie ein laufender Standort; pro Person abschaltbar
(dann erscheint der Stopp für die anderen nur als erledigt, ohne Namen); und
die Sichtbarkeit endet mit dem Trip. Eine Live-Karte mit den Punkten der
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
- **Das Gelände schneidet das Fenster ab.** Die Rechnung oben unterstellt einen
  freien Horizont — in einem Tal, hinter einem Hügelzug oder in einer Stadt mit
  Steilhang ist die Sonne lange vor dem astronomischen Sonnenuntergang weg. Ohne
  Korrektur verspricht der Planer goldenes Licht um 19:30, während der
  Aussichtspunkt seit 19:00 im Schatten liegt — ein Fehler in genau die
  unangenehme Richtung. Abhilfe ist eine **Vorberechnung wie beim
  Fassadenazimut**: einmal je Spot aus einem freien Höhenmodell (SRTM,
  Copernicus) das **Horizontprofil** bestimmen — welche Geländehöhe in welcher
  Himmelsrichtung ansteht — und das Lichtfenster dort abschneiden, wo die
  Sonnenhöhe darunter fällt. Zur Laufzeit kostet das nichts, es ist ein
  Vergleich zweier Winkel.
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

Dazu ein **Zeit-Regler über den Tag**: Beim Schieben wandert die Sonne mit — und
zugleich die Markierung, **wo ihr zu dieser Stunde laut Plan wärt**. Damit wird
aus dem Lichthinweis („beste Zeit ca. 19:30") etwas Nachprüfbares statt einer
Behauptung, und der Tagesplan bekommt nebenbei eine räumliche Vorschau. Beides
ist ohnehin gerechnet — Sonnenstand (§7.3) und Blockzeiten (§4.1) —, der Regler
macht es nur sichtbar und verbindet zwei Kapitel, die sonst nebeneinanderher
laufen.

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

### 8.6 Der Vorabend: Reisebereitschaft und Packliste

Zwischen „Plan steht" und „erster Reisetag" liegt ein Moment, in dem sich die
Fehler entscheiden, die den ganzen Planer entwerten würden — und für den
fk-encore die Teile schon hat. Eine **Reisebereitschafts-Prüfung** geht sie am
Vorabend durch:

- Liegen die **Tickets und Buchungen** als Dokumente vor (§3.4)? Fehlt eines,
  ist jetzt die Zeit, es zu suchen, nicht am Bahnsteig.
- Ist die **Regionsdatenbank** der ersten Etappe fertig importiert (§15.3)?
  Ohne sie gibt es vor Ort keinen Vorrat — der schlimmste denkbare Ausfall.
- Ist das **Offline-Bündel** geladen (§14)?
- Haben alle Teilnehmer **abgestimmt** (§6.1), oder plant ihr an jemandem vorbei?

Nichts davon ist neue Maschinerie; es ist eine Liste über vorhandene Zustände.
Gerade deshalb lohnt sie: Die beiden Fehler, die eine Reise wirklich verderben —
kein Kartenmaterial im Ausland, kein Ticket zur Hand — sind beide am Vorabend
noch billig zu beheben.

**Die Packliste** fällt aus demselben Wissen fast nebenbei ab, und zwar als
einzige, die nicht generisch ist: Outdoor-Blöcke plus Regenprognose →
Regenjacke; Hitze → Sonnenhut und Wasserflasche; eine Kirche mit Kleiderordnung
im Plan → lange Hose; ein Lichtfenster am Abend → Stativ; ein Kind im
Fairness-Konto → Wechselsachen. Kein „zehn Dinge für Japan", sondern abgeleitet
aus **diesem** Plan, diesem Wetter und dieser Gruppe. Ausbau, nicht Kern — aber
billig, weil alle Eingaben schon dastehen.

### 8.7 Danach
Geplant gegen tatsächlich besucht, Fotos je Spot aus dem Trip-Album, Übergabe an
den Recap.

## 9. Übergänge nach außen und von außen

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

### 9.2 Herein: eigene Funde in den Vorrat bringen

Der Planer schlägt Kandidaten selbst vor (§5) — aber die eigene Recherche im
Netz ist die zweite, mindestens ebenso wichtige Quelle. Sie darf kein Bruch
sein: Was man findet, gehört mit **einer** Geste in den Vorrat, wo es als
Kandidat mit allen anderen konkurriert.

**Vier Wege herein**, in der Reihenfolge ihrer Verlässlichkeit:

1. **Ein Ort aus einer Karten-App.** Der klarste Fall — es gibt eine Koordinate.
2. **Ein Artikel oder Blogbeitrag.** Der häufigste Fall bei echter Recherche
   („die zehn schönsten Cafés in Lissabon") — und der schwierigste, weil eine
   Seite *keine* Koordinate liefert, dafür aber oft gleich mehrere Orte nennt.
   Hier liest das Sprachmodell die Seite und zieht die **Ortsnamen** heraus —
   der Ablauf dazu in §9.3.
3. **Ein Screenshot.** Aus einer App, die nicht teilt, oder von einer Karte im
   Reiseführer. Fast geschenkt, weil die Share-Extension Bilder ohnehin annimmt
   und der documents-Service bereits OCR mitbringt (Tesseract) — der Text
   daraus geht denselben Weg wie Fall 2.
4. **Suche in der App.** Ohne Umweg über andere Apps: nach Name suchen und
   direkt in den Vorrat legen. Der einfachste Weg, und er muss unabhängig von
   allem anderen existieren.

**Die Share-Extension existiert bereits** (`ios/App/ShareExtension`), nimmt aber
laut `Info.plist` nur Bilder entgegen
(`NSExtensionActivationSupportsImageWithMaxCount`). Für die Fälle 1 und 2 muss
sie um URLs und Textauswahl erweitert werden. Ehrlich dazu: Aus einem geteilten
Karten-Link die Koordinate zu ziehen, ist fragil — die Formate ändern sich ohne
Ankündigung. Der Fallback ist deshalb kein Fehlerdialog, sondern eine Karte mit
der Bitte, den Ort zu bestätigen; danach ordnet eine Umkreissuche mit
Reverse-Geocoding (`geo/src/reverse.ts`) einen OSM-POI zu, oder der Punkt wird
frei übernommen.

**Was mit einem Fund dann geschieht** — fünf Regeln, die verhindern, dass der
Vorrat verwahrlost:

- **Er landet in der richtigen Etappe**, automatisch nach Lage: Ein Café in
  Osaka geht in die Osaka-Etappe, auch wenn du gerade in Tokio bist. Liegt es
  in keiner, wird nachgefragt.
- **Er ist ein Vorschlag, kein Termin.** Der Fund konkurriert im Vorrat wie
  jeder andere Kandidat. Wer sicher hin will, macht ihn zum Herzenswunsch
  (§6.1) — das ist genau der Zweck dieses Kontingents.
- **Dubletten werden zusammengeführt.** Schlägt jemand etwas vor, das schon im
  Vorrat liegt, entsteht kein zweiter Eintrag: Notiz, Quelle und Stimme wandern
  an den vorhandenen.
- **Herkunft und Link bleiben erhalten.** *Warum* ein Spot gespeichert wurde
  („beste Pastéis laut Blog"), ist beim Planen wichtiger als der Name — und wer
  ihn beigesteuert hat, gehört sichtbar dazu (§6.1).
- **Fehlende Daten werden benannt, nicht geraten.** Konnte kein OSM-Eintrag
  zugeordnet werden, fehlen Öffnungszeiten, Kategorie und Aufenthaltsdauer. Der
  Planer fragt dann einmal nach der geschätzten Dauer und markiert die
  Öffnungszeit als unbekannt, statt mit erfundenen Werten zu rechnen.

### 9.3 Eine Webseite auslesen

Der Weg von einem Reiseblog zu Kandidaten im Vorrat, in vier Stufen. Er ist der
aufwendigste der vier Wege und verdient deshalb eine eigene Beschreibung.

**Stufe 1: An den Text kommen — vom Gerät, nicht vom Server.** Naheliegend wäre,
nur die URL zu teilen und den Server die Seite laden zu lassen. Der bessere Weg
läuft aber über das Gerät: Eine Share-Extension kann per
`NSExtensionJavaScriptPreprocessingFile` ein kleines Skript **in der bereits
geöffneten Seite** ausführen und deren sichtbaren Text mitgeben. Damit sind vier
Probleme auf einen Schlag erledigt, an denen ein Server-Abruf scheitert:
JavaScript-gerenderte Seiten, Cookie-Banner, Anmeldung oder Bezahlschranke, und
Bot-Sperren gegen Rechenzentrums-IPs. Der Browser des Nutzers hat den schweren
Teil schon gelöst.

Der Server-Abruf bleibt als Rückfallebene für Fälle, in denen nur eine URL
ankommt (aus einer Nachricht etwa). Dann gelten die üblichen Vorsichtsmaßnahmen,
die hier ausdrücklich genannt seien, weil ein Dienst, der **beliebige vom Nutzer
gelieferte URLs** abruft, eine neue Angriffsfläche ist: nur `https`, keine
privaten oder link-lokalen Adressbereiche (auch nicht nach einer Weiterleitung —
sonst zeigt jemand auf den geo-Container oder einen Metadatendienst), Zeit- und
Größenbegrenzung. Das Muster dafür steht schon im Repo
(`osm-admin/wikidata-client.ts` mit `AbortController` und Timeout).

**Stufe 2: Den Artikel freilegen.** Navigation, Werbung, Kommentare und
Related-Blöcke blähen den Text auf und verwirren die Extraktion. Also den
Artikelkörper isolieren (Readability-Verfahren) und die Länge deckeln. Für den
lokalen Modell ist das keine Kosmetik: Kontext ist die knappste Ressource, und
Nebengeräusch verdrängt den Inhalt.

**Stufe 3: Extrahieren, mit Beleg.** Das Modell bekommt genau eine Aufgabe und
ein striktes Schema: eine Liste aus *Name*, optionaler *Ortsangabe*, optionaler
*Kategorie* und einem **wörtlichen Zitat** aus der Seite. Das Zitat ist der
Trick: Es lässt sich mechanisch gegen den Quelltext prüfen. Steht es dort nicht
buchstäblich, fliegt der Eintrag raus — eine erfundene Empfehlung überlebt diese
Prüfung nicht. Extrahieren ist ohnehin die freundlichere Aufgabe als Empfehlen:
Die Antwort steht im vorgelegten Text, weshalb hier auch ein kleines lokales
Modell brauchbar ist.

**Stufe 4: Namen auflösen.** Jeder extrahierte Name wird gegen die
Regionsdatenbank der Etappe aufgelöst — normalisierter Namensvergleich im
passenden Gebiet, mit der Ortsangabe aus dem Artikel als Eingrenzung. Drei
Ausgänge: **eindeutig** → Kandidat mit allen OSM-Daten; **mehrdeutig** →
Rückfrage mit Karte; **kein Treffer** → Notiz mit Link und Zitat, die im Vorrat
liegen bleibt, bis jemand sie von Hand auflöst. Erfunden wird nichts (§10.4).

Diese Auflösung ist **dieselbe Aufgabe wie Händlername → POI** aus §10.6. Beide
sollten einen Baustein teilen: *Name plus grober Ort → POI in dieser Region*,
mit den Ausgängen eindeutig / mehrdeutig / keiner. Das ist der einzige Ort im
Konzept, an dem zwei entfernte Funktionen exakt dasselbe Problem haben.

**Nebenbei zur Modellwahl:** Ein Artikel ist öffentlicher Text. Damit ist diese
Aufgabe der **unbedenklichste Kandidat für die API-Spur** aus §11 — anders als
die Kuration, die Vorlieben und Gruppenzusammensetzung mitschickt. Gespeichert
wird ohnehin nur das Ergebnis samt kurzem Zitat und Link, nie die ganze Seite.

### 9.4 Die Karte in der App

Die eingebettete Karte ist MapKit, also **Apples Kartenmaterial** — die
Sachdaten (Kandidaten, Kategorien, Öffnung) kommen dagegen aus den eigenen
OSM-Regionen. Zwei Ebenen mit klarer Trennung: Apple zeichnet, fk-encore weiß.

Nützlich und wenig bekannt: **Look Around** lässt sich seit iOS 16 über
`MKLookAroundViewController` direkt in der App einbetten. „Lohnt dieser
Aussichtspunkt überhaupt?" beantwortet sich damit ohne App-Wechsel — dort, wo
Apple Daten hat; sonst entfällt der Knopf stillschweigend.

### 9.5 Die Grenze

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

**Daraus folgt eine Trennung, die anfangs fehlte** (gemeldet: Apotheken,
Discounter, Sparkassen und unbedeutende Kirchen im vorgeschlagenen Plan). Jede
Kategorie hat einen `purpose`: `visit` — man geht hin, weil man es sehen will —
oder `service` — die Reise läuft darauf, bewundert es aber nicht. Eine Suche
ohne Kategorieangabe liefert nur noch `visit`; wer eine Apotheke sucht, nennt
`essentials` ausdrücklich. Vorher hieß „keine Kategorie" schlicht *alle*, und
damit lagen Geldautomat und Supermarkt im Kandidatenvorrat eines Vormittags.

Zweitens: **ein Name ist kein Zeichen von Bedeutung.** Jede Sparkasse hat einen.
Solange „hat einen Namen" in die Prominenz einging, punktete eine gewöhnliche
Dorfkirche genau wie eine Bankfiliale, und beide rückten nach, sobald die
lohnenden Spots verplant waren. Als Prominenz zählen jetzt nur Wikidata,
Wikipedia und die ausdrückliche Erfassung als Sehenswürdigkeit (`tourism=*`) —
Letzteres ist das Urteil eines Menschen, der davorstand. Wer keines davon hat,
kommt gar nicht erst in den Vorrat, aus dem ein Tag gebaut wird: **ein kürzerer
Vormittag ist die bessere Antwort als ein gefüllter, den niemand wollte.** Für
„was ist hier in der Nähe" gilt das nicht — dort ist das Gewöhnliche die
richtige Antwort.

Drittens war `sight` zu weit gefasst: `historic` ohne Werteliste trifft jedes
Wegkreuz, jeden Grenzstein und jede Gedenktafel, in einer deutschen Stadt
Tausende. Jetzt steht dort eine Liste.

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
   (§4.3) und zeichnet auf einer MapKit-Karte (§9.4). Beides zusammen geht
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
einzige verfügbare Sprachmodell läuft lokal (§11.0). Stünde stattdessen
die Claude API mit **Opus 5** (`claude-opus-5`, 1M Kontext, $5 / $25 je Mio.
Ein-/Ausgabe-Token) bereit, änderte sich einiges — aber weniger, als man
zunächst vermutet, und an anderer Stelle als erwartet.

### 11.0 Welches lokale Modell

Der llm-service ist **modellagnostisch**: Das aktive Modell wird zur Laufzeit
gewählt und persistiert (`load_active` / `save_active` in `llm-service/main.py`),
nicht im Code festgelegt. Die lokale Spur ist damit schon heute austauschbar —
was die Entscheidung aus §15.3 (zweispurig bauen) billiger macht, als sie
klingt.

**Aktuell geladen ist `gemma-4-26B-A4B-it-qat-UD-Q4_K_XL`** (Stand 2026-09-02) —
ein instruction-tuntes Modell mit 26 Mrd. Parametern gesamt und rund 4 Mrd.
aktiven je Token, quantisierungsbewusst trainiert und in einer dynamischen
4-Bit-Quantisierung ausgeliefert. Es hat das früher hier dokumentierte
Qwen2.5-7B abgelöst.

**Was das für dieses Kapitel bedeutet:** Die Einschätzungen weiter unten — „für
ein lokales Modell brüchig", „Frontier-Modell klar überlegen" — stammen aus der
7B-Zeit und sind **nicht nachgemessen**. Ein Modell dieser Größenordnung dürfte
beim Anfrageverständnis, bei der strukturierten Ausgabe und beim Auslesen von
Webseiten (§9.3) deutlich näher an der API-Spur liegen, als die Tabelle in §11.1
unterstellt. Vor jeder Entscheidung für die kostenpflichtige Spur gehört deshalb
**erst die lokale gemessen** — sonst kauft man Qualität ein, die man schon hat.
Zwei Größen sind dafür konkret zu prüfen: das nutzbare Kontextfenster (es
entscheidet, ob ein ganzer Etappenvorrat für die Kuration hineinpasst) und die
Antwortzeit auf der vorhandenen Hardware (sie entscheidet, ob das Modell im
Verhandlungs-Chat überhaupt erträglich ist).

### 11.1 Die Trennlinie liegt schon im Konzept

Der Planer zerfällt ohnehin in zwei Welten (§4.3): die **Reiseauflösung**
entsteht vorher, zu Hause, am Netz und ohne Zeitdruck — die **Tagesauflösung
und alles unterwegs** muss offline, sofort und verlässlich funktionieren.
Genau entlang dieser Naht verläuft die sinnvolle Aufteilung zwischen den
Modellen:

| | lokal | Opus 5 (online, opt-in) |
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
   Constraints zu übersetzen, ist für ein lokales Modell brüchig. Mit **Structured
   Outputs** (`output_config.format`) bzw. `strict: true` an den Tools kommt ein
   schemavalides Objekt zurück — genau das, was §8.2 als Chips anzeigt.
3. **Der Verhandlungs-Chat vor der Reise.** Opus 5 könnte per Tool-Use die
   Planer-API selbst bedienen (`vorrat_durchsuchen`, `constraint_setzen`,
   `anheften`, `neu_verteilen`), statt nur Constraints auszuwerfen. Aus „zu viel
   Laufen" wird ein Werkzeugaufruf mit sichtbarer Wirkung statt einer Umschreibung.
4. **Dokumentenauswertung.** Fixpunkte aus OCR-Text zu ziehen — Flugzeiten,
   Check-in-Regeln im Kleingedruckten, fremdsprachige Bestätigungen — ist genau
   die Disziplin, in der ein Frontier-Modell ein lokales Modell klar schlägt.
   Pro Dokument
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
 OSM-POIs,      lokales LLM  (extern,     Stufe 2)
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

- **PostGIS in die Testumgebung aufnehmen** (entschieden, §15.1). Die geo-Tests
  arbeiten heute mit skriptgesteuerten Query-Attrappen
  (`geo/src/replication.test.ts`) und laufen außerhalb des Haupt-Testlaufs
  (`geo/**` ist in `vitest.config.ts` ausgeschlossen). Für eine räumliche
  Tag-Query liegt das Risiko aber in der SQL-Semantik. Zu tun: PostGIS-Extension
  in Sandbox und CI verfügbar machen, einen Testhelfer schreiben, der eine
  `osm_pois`-Tabelle anlegt und mit einigen Dutzend Zeilen befüllt, und
  entscheiden, ob die neuen Tests im Haupt-Testlauf mitlaufen oder im eigenen
  geo-Lauf bleiben.

  **Umgesetzt (Schritt 1):** Die Suchtests bleiben im geo-eigenen Lauf
  (`geo/src/poi-search.test.ts`, `node:test`), weil geo ein eigenständiges Paket
  mit eigenem Container und eigener Datenbank ist; der geo-Workflow bekommt dafür
  einen PostGIS-Service. Ohne erreichbare Datenbank **überspringen** sie sich mit
  klarer Begründung, statt rot zu werden — eine rote Suite, die nur „hier ist
  keine Datenbank" bedeutet, erzieht dazu, rote Suiten zu ignorieren. Die
  Verbindung zum Haupt-Testlauf hält stattdessen
  `osm-admin/poi-tag-sync.test.ts`: Er liest die geo-Dateien von der Platte und
  schlägt fehl, sobald die Tag-Listen auseinanderlaufen.
- **Die dreifache Tag-Liste zusammenführen** (umgesetzt in Schritt 1 als
  Drift-Test, siehe unten). Dieselbe Tag-Kenntnis steht in
  `geo/src/osm2pgsql.lua` (Importfilter), `geo/src/pois.ts` (Query-Defaults) und
  `osm-admin/poi.config.ts` (Aufruferfilter) — mit zwei „must stay in
  sync"-Kommentaren als einziger Absicherung. Die Planung erweitert alle drei.
  Vorher: Lua-Tabellen aus der TS-Konfiguration erzeugen, oder wenigstens ein
  Test, der die Lua-Datei liest und die Mengen vergleicht.
- **Entwicklungsregionen sind Schwaben und Oberbayern** (entschieden, §15.1) —
  Regierungsbezirke, keine Bundesländer. Schwaben trägt die Fixtures rund um
  Augsburg, Oberbayern kommt für Etappen-, Transfer- und Korridortests dazu.
  Weil jede Filteränderung einen Neuimport erzwingt, bleibt die Regel:
  **Filteränderungen bündeln** statt einzeln durchzuziehen — der Grund, warum
  Schritt 4 alles Import-Relevante zusammenfasst.
- **Den Zuwachs messen**, bevor Gastronomie und Alltagsinfrastruktur produktiv
  gehen (§10.2) — auf dem echten Host. Schwaben ist dafür die richtige
  Messgröße: klein genug, dass der Lauf nicht abschreckt, und repräsentativ
  genug, um von dort auf die übrigen Bezirke hochzurechnen.

  **Dafür gibt es jetzt einen Knopf:** `GET /osm/regions/:slug/storage`
  (`osm.admin`) liefert die Größe der Regionsdatenbank, aufgeschlüsselt nach
  Tabellen, dazu die POI-Zahl je getroffenem Tag. Einmal vor dem Neuimport
  lesen, einmal danach — die Differenz ist der Preis.

  Beim Vergleichen zwei Dinge beachten. Erstens: `totalMb` gegen `totalMb`
  vergleichen, nicht gegen `tableMb`. Der Gesamtwert enthält Indizes und TOAST
  und ist das, was die Platte spürt; `tableMb` ist nur der Heap. Zweitens: Der
  größte Teil einer Region sind die **osm2pgsql-Middle-Tables**
  (`planet_osm_*`), die für die Replikation vorgehalten werden und mit einem
  breiteren POI-Filter kaum wachsen. Wer nur die Gesamtgröße betrachtet,
  unterschätzt den relativen Zuwachs von `osm_pois` deshalb erheblich — die
  Aufschlüsselung ist genau dafür da.

  **Vorher-Messung** (vor dem Reimport mit dem breiteren Filter, gelesen über
  den Knopf in der Admin-Oberfläche):

  | Region     | DB gesamt  | `osm_pois` gesamt | `osm_pois` Heap | POIs   |
  |------------|-----------:|-------------------:|----------------:|-------:|
  | Schwaben   | 729.17 MB  | 4.82 MB             | 2.62 MB          | 16.249 |
  | Oberbayern | 1337.6 MB  | 8.75 MB             | 4.84 MB          | 31.017 |

  Beide Regionen sind zu diesem Zeitpunkt noch vor dem Schema, das
  `shape`/`facade_azimuth` mitführt — `poisWithShape`/`poisWithFacadeAzimuth`
  stehen entsprechend auf 0. Die POI-Verteilung ist zu diesem Zeitpunkt stark
  von `historic=*` und `tourism=*` dominiert (`historic=wayside_cross` allein
  8.630 Zeilen in Oberbayern); Gastronomie und Alltagsinfrastruktur fehlen
  komplett.

  **Nachher-Messung** (nach dem Reimport mit dem breiteren Filter):

  | Region     | DB gesamt  | `osm_pois` gesamt | `osm_pois` Heap | POIs   |
  |------------|-----------:|-------------------:|----------------:|-------:|
  | Schwaben   | 1484.74 MB | 20.2 MB             | 12.01 MB         | 30.443 |
  | Oberbayern | 3059.78 MB | 43.12 MB            | 25.54 MB         | 67.310 |

  **Differenz:**

  | Region     | DB gesamt         | `osm_pois` gesamt | `osm_pois` Heap | POIs             |
  |------------|-------------------:|-------------------:|-----------------:|------------------:|
  | Schwaben   | +755.57 MB (+104 %) | +15.38 MB          | +9.39 MB          | +14.194 (+87 %)   |
  | Oberbayern | +1722.18 MB (+129 %) | +34.37 MB         | +20.7 MB          | +36.293 (+117 %)  |

  **Der eigentliche Befund liegt woanders, als die Vorüberlegung vermutet
  hat:** Fast der gesamte Größenzuwachs kommt nicht von Gastronomie und
  Alltagsinfrastruktur, sondern davon, dass `planet_osm_nodes` — vorher in
  keiner der beiden Regionen überhaupt vorhanden — jetzt mitgeführt wird:
  741.3 MB in Schwaben (98 % des gesamten Zuwachses dort), 1484.65 MB in
  Oberbayern (86 % des Zuwachses). `osm_pois` selbst wächst nur um
  15–34 MB — trivial gegen die Node-Tabelle.

  Das ist keine Folge der breiteren POI-Filter. `geo/src/import.ts` ruft
  osm2pgsql seit jeher mit `--slim` **ohne** `--drop` auf — bewusst so, weil
  `osm2pgsql-replication update` (die stündliche Diff-Anwendung) genau diese
  Middle-Tables braucht und ohne sie mit Exit 1 abbricht (Kommentar dort).
  `planet_osm_nodes` hätte also immer da sein müssen. Dass es vorher fehlte,
  heißt: Schwaben und Oberbayern wurden lange vor dieser Replikations-Policy
  importiert, vermutlich noch mit `--drop` oder einer anderen osm2pgsql-
  Konfiguration — dasselbe Muster wie beim `shape`/`facade_azimuth`-Fehlen
  (§13.0 Sturz-Fix). Der Reimport hat diese Regionen also nicht nur auf den
  neuen POI-Filter, sondern gleich auf mehrere seither eingeführte
  Policies nachgezogen. Für die Kapazitätsplanung heißt das: **Der Faktor
  2–2.3 in der Gesamtgröße ist überwiegend der Preis fürs
  Replikationsfähig-Werden (Node-Vorhalten), nicht für Gastronomie.** Bei
  einem Rollout auf weitere Regierungsbezirke, die noch nie reimportiert
  wurden, dürfte ein ähnlicher Sprung auftreten — planbar ist er trotzdem:
  einmalig pro Region, nicht laufend.

### 13.1 Die Schritte

1. **`geo /pois/search` gegen den heutigen Datenbestand** — Flächen- und
   Umkreissuche mit Kategoriefilter. **Ohne Neuimport:** Sehenswürdigkeiten
   liegen bereits in `osm_pois`, und für den ersten Planer genügen sie, weil
   der Mittagsblock ohnehin nur ein Zeitfenster ist (§10.3). Damit ist der
   langsame Teil (Import) vom schnellen (Query, Solver) entkoppelt.
2. **`trip-planner`, ein Tag, Fußwege per Heuristik** — Constraints per API,
   kein LLM, kein Frontend. Liefert Blöcke mit Spots. Deterministisch testbar.

   **Umgesetzt:** `POST /trip-planner/day`. Bewusst **zustandslos** — der Plan
   wird berechnet und zurückgegeben, nicht gespeichert. Persistenz (§12) käme
   mit Schritt 3, wenn die Neuverteilung sie tatsächlich braucht; sie jetzt
   anzulegen hieße, ein Datenmodell für Mechanik zu bauen, die es noch nicht
   gibt. Die Reihenfolge im Block ist exakt gelöst (Permutation bis sieben
   Stopps), die Auswahl greedy nach Wert je Minute. Nur der letzte
   Spots-Block zahlt den Rückweg zum Anker — das ist der Weg, den man
   tatsächlich geht.
3. **Neuverteilung** — „ab hier, ab jetzt", Vorrat, Verschieben auf Folgetage.
   Bewusst **vor** dem hübschen UI, weil es die Kernmechanik ist.

   **Umgesetzt:** `POST /trip-planner/plans` legt einen mehrtägigen Plan an
   (Tage werden nacheinander aus einem schrumpfenden Vorrat gelöst, damit kein
   Spot zweimal vorkommt), `POST /trip-planner/plans/:id/redistribute` rechnet
   den Rest neu. Hier kommt die Persistenz dazu (Migration `0157_trip_planner`):
   Plan → Tage → Blöcke → Stopps, dazu der Vorrat. Die Entscheidungen bleiben
   in den reinen Modulen — `redistribute.ts` bekommt Zustand herein und gibt
   Zustand heraus, ohne Uhr, Netz oder Datenbank, damit die Neuverteilung im
   Funkloch läuft. Vier Regeln sind wörtlich umgesetzt: nur der Rest wird neu
   gerechnet, angeheftete Stopps bleiben, Verdrängtes geht mit Bonus in den
   Vorrat zurück statt in den Papierkorb, und fallen gelassen wird das
   Niedrigstbewertete.
4. **Importerweiterung** — jetzt, wo der Planer läuft und zeigt, welche Tags er
   wirklich braucht: `opening_hours`, `cuisine`, `wheelchair`, `fee`,
   `website`, **`name:en`**, `diet:*`, `outdoor_seating`, dazu **Gastronomie
   und Alltagsinfrastruktur** (§10.2) und das **Fassadenazimut** (§7.3). Alles,
   was einen Neuimport erzwingt, in einem Zug.

   **Umgesetzt.** Zwei Dinge sind dabei anders gekommen als hier geplant:

   - **Das Polygon bleibt liegen.** Vorgesehen war, das Azimut beim Import zu
     berechnen und die Umrisse zu verwerfen. Das geht nicht: Die stündliche
     Replikation fügt geänderte POIs über dieselbe Tabellendefinition wieder
     ein, und `osm2pgsql --append` scheitert an einer Tabelle, deren Spalten
     nicht mehr passen. Der Umriss bleibt also als Spalte, und ein
     **inkrementeller Nachlauf** (`refreshFacadeAzimuth`) berechnet das Azimut
     für alles, was noch keins hat — nach dem Import und nach jedem
     Replikationslauf.
   - **Berechnet wird über die orientierte Hülle**, nicht über die längste
     Polygonkante: das kleinste gedrehte Rechteck um den Umriss, dessen längere
     Seite die Hauptrichtung angibt. Robuster gegenüber einer einzelnen langen
     Rückwand und ohne Eckpunkt-Iteration, die die Lua-Schnittstelle nicht
     hergibt.

   Die Trennung aus §10.2 ist damit auch im Test verankert: Die Filter des
   Foto-Matchers sind ab jetzt eine **Teilmenge** des Imports, nicht mehr
   deckungsgleich mit ihm — sonst konkurrierten Bäckereien mit
   Sehenswürdigkeiten.
5. **NL-Eingabe** über llm-service (JSON-Schema, strikte Validierung) +
   Mehrtagesplanung.

   **Umgesetzt:** `POST /trip-planner/interpret` — Satz rein, Vorgaben raus.
   Die Mehrtagesplanung kam schon mit Schritt 3 (`days` bis 14), hier kommt
   nur noch die Sprache dazu.

   Drei Entscheidungen, die dabei getroffen wurden:

   - **Getrennter Aufruf statt Textfeld am Plan-Endpunkt.** Der Reisende
     sieht erst, *was verstanden wurde*, und baut dann darauf einen Plan.
     Ein missverstandener Satz kostet so eine Korrektur statt einer falschen
     Reise. `rejected` führt auf, was das Modell vorgeschlagen hat und nicht
     verwendet werden konnte — ein stilles Verschlucken ist damit
     ausgeschlossen.
   - **Das Modell schlägt vor, es bestimmt nicht.** `constraints.ts` ist ein
     reines Modul, das jedes Feld gegen dieselben Grenzen prüft, die auch die
     getippten Endpunkte durchsetzen: erfundene Kategorien fliegen raus, 90
     Tage werden auf 14 gekappt, ein Tempo außerhalb der drei Werte wird
     verworfen. Getestet wird genau das, was Sprachmodelle real falsch machen
     — Prosa statt JSON, Zahlen als Wörter, gedoppelte Einträge.
   - **Keine Koordinaten aus Ortsnamen.** Der Dienst hat keinen
     Vorwärts-Geocoder; `placeHint` gibt den genannten Ort nur zurück, den
     Anker liefert weiterhin der Aufrufer. Aus „Augsburg" Koordinaten zu
     raten wäre genau die selbstbewusste Halb-Antwort, die §15.3 ausschließt.

   Das Kategorien-Vokabular wird zur Laufzeit aus geo geholt (neu:
   `GET /pois/categories` im geo-Client), nicht hier kopiert — eine in geo
   ergänzte Kategorie ist damit sofort per Satz erreichbar. Ein Drift-Test
   (`prompt-vocabulary-sync.test.ts`) hält fest, dass jede Kategorie auch
   wirklich im Prompt landet; sonst bliebe sie unerreichbar, ohne dass
   irgendetwas rot würde.
6. **Etappen, Fixpunkte, zwei Auflösungen** (§4.2–§4.4) — Reisen über mehrere
   Orte, Modus je Etappe, Ankerzonen, Transfertage, harte Uhrzeiten mit
   Rückwärtsrechnung, Vorrat je Etappe, Detaillierung erst am Vorabend.
   Enthält die **Korridorsuche** für geplante Anreisen (Ellipsenfilter, noch
   ohne Router).

   **Teilweise umgesetzt — die Korridorsuche.** `POST /trip-planner/corridor`
   beantwortet „was liegt auf dem Weg, ohne groß umzuwegen?" für eine Fahrt
   von A nach B. In geo ist das eine `corridor`-Option der Flächensuche neben
   `bbox` und `center`; die Bedingung ist die Ellipse aus §4.2, ausgewertet
   von PostGIS.

   Drei Dinge, die dabei entschieden wurden:

   - **Das Umwegbudget zählt hin und zurück.** Ein Spot 500 m neben der Route
     kostet rund 1000 m. Das ist keine Feinheit, sondern der Unterschied
     zwischen einem brauchbaren und einem doppelt so weiten Korridor — die
     Tests pinnen es fest.
   - **Die Ellipse reicht über beide Brennpunkte hinaus.** Ein Ort 300 m
     hinter dem Ziel ist ein legitimer Zwischenstopp. Der Index-Vorfilter ist
     deshalb ein Puffer der halben Nebenachse um die Strecke, nicht um sie
     herum knapp bemessen: `b ≥ Budget/2` gilt immer, damit kann der
     Vorfilter keine Zeile verlieren, die die exakte Bedingung behalten
     würde.
   - **Beide Enden müssen in derselben importierten Region liegen.** Zwei
     Regionen zusammenzunähen hieße, zwei Seiten zu mischen und neu zu
     sortieren — und ließe trotzdem ein Loch, wo nur eine importiert ist. Der
     Endpunkt sagt lieber, welches Ende nicht abgedeckt ist (§15.3).

   Weiterhin **ohne Router**: gemessen wird Luftlinie, was Straßen
   überschätzt und Umwege um einen See unterschätzt. Für ein grobes Budget
   ist das der richtige Tausch, und wenn ein Router kommt, bleibt die
   Ellipse der billige Vorfilter davor.

   **Teilweise umgesetzt — Etappen.** Ein Plan ist jetzt eine Liste von
   Etappen statt eines einzelnen Ankers. Jede Etappe hat eigenen Anker,
   eigenen Fortbewegungsmodus, eigene Regionsdatenbank, optionales
   Startdatum — und damit einen **eigenen Vorrat**: Umverteilt wird nur
   innerhalb einer Etappe, was in der einen Stadt ausfällt, rutscht nicht
   in die nächste.

   - **Die Ankerzone ist eine Toleranz, keine Adresse.** Ist noch nichts
     gebucht, speichert `anchorRadiusM` neben dem Schwerpunkt, wie weit die
     echte Bleibe davon liegen darf. Der Planer rechnet mit dem Schwerpunkt
     und behauptet dabei keine Adresse, die er nicht hat.
   - **Der Modus gehört zur Etappe.** `travelLeg` trennt dafür
     Fahrgeschwindigkeit und Fixkosten je Modus. Das ist nicht Feintuning:
     Nur so verliert der ÖPNV auf 1,5 km gegen das Rad und gewinnt auf
     6 km — eine einzelne Durchschnittsgeschwindigkeit kann das nicht
     ausdrücken, und das Blockbudget wäre an einem der beiden Enden falsch.
   - **Der flache Ein-Stadt-Request bleibt.** Ein Wochenendtrip schickt
     weiterhin `anchor`/`days`; daraus wird eine Etappe. Zwei Vorstellungen
     davon, was ein Plan ist, gibt es dadurch nicht — flussabwärts sieht
     alles nur Etappen.

   Migration `0159_trip_plan_legs`: Tage und Vorrat hängen an der Etappe
   statt am Plan; jeder bestehende Plan wird zur Ein-Etappen-Reise mit
   seinem bisherigen Anker und seiner Region.

   **Teilweise umgesetzt — Fixpunkte.** `fixpoints.ts` legt die Blöcke eines
   Tages auf eine gedachte Uhr und lässt die Fixpunkte sich nehmen, was ihnen
   zusteht. Der Solver bekommt danach nur ein kleineres Budget und erfährt nie,
   was eine Uhrzeit ist — genau die Arbeitsteilung aus §4.4.

   - **Zwei Arten von Fixpunkt, und der Unterschied ist der ganze Punkt.**
     Nach einem `appointment` (gebuchte Führung) ist man zurück und der Tag
     geht weiter; nach einer `departure` (letzter Zug) ist man weg. Beides
     gleich zu behandeln plante einen Abendblock hinter einen Zug, der schon
     abgefahren war — der erste Testlauf hat genau das gezeigt.
   - **Rückwärts gerechnet.** Ein Zug um 18:40 mit 15 min Weg und 20 min
     Puffer bindet ab 18:05; ein Abendblock ab 17:30 behält 35 statt 120
     Minuten. Je näher der Rand, desto härter greift das Budget.
   - **Der Puffer ist nie null.** `MIN_BUFFER_MINUTES` ist ein Boden, kein
     Vorgabewert: Wer ihn auf 0 setzt, hat nicht entschieden zu rennen,
     sondern nicht darüber nachzudenken.
   - **Ein verdrängter Block verschwindet nicht stillschweigend.** Die Antwort
     nennt ihn mit Grund („Letzter Zug 17:45 lässt für ‚Abend' keine Zeit
     mehr") — der Satz, den die App zeigt.

   Migration `0160_trip_plan_fixpoints`: Fixpunkte hängen am Tag, Zeiten als
   Minuten nach Mitternacht ohne Zeitzone. Ein Fixpunkt ist „der 18:40-Zug",
   kein Zeitpunkt auf einer globalen Uhr — und offline auf dem Gerät muss
   dieselbe Rechnung herauskommen.

   **Umgesetzt — Transfertage.** Eine Etappe kann einen `transfer` tragen: die
   Fahrt *in* sie hinein. Daraus werden zwei Dinge, die der Planer schon
   versteht — ein `departure`-Fixpunkt am letzten Tag der Etappe, die man
   verlässt, und ein späterer Beginn am ersten Tag der Etappe, die man betritt.
   Ein Transfertag ist damit keine neue Art Tag, sondern ein gewöhnlicher mit
   einer harten Kante an einem Ende.

   Dabei kam ein Fehler heraus, den erst der Testlauf zeigte: Blöcke sind rein
   relativ, ein späterer Beginn *verschob* sie also, statt sie wegfallen zu
   lassen — der Ankunftstag hatte einen „Vormittag", der um 16:00 begann.
   `scheduleDay` kennt jetzt neben dem tatsächlichen auch den *angenommenen*
   Tagesbeginn: Blöcke, an denen der Tag vorbeigelaufen ist, fallen weg, der
   erste noch erreichte wird angebrochen (Ankunft 16:00 → 90 Minuten Nachmittag,
   dann ganzer Abend). Das greift nur beim Ankunftstag; danach ist der Tag
   wieder relativ und Fixpunkte schieben ihn frei.

   Was *auf* dem Weg liegt, bleibt eine getrennte Frage — die beantwortet die
   Korridorsuche. Wie der Tag gerahmt wird, hängt nicht davon ab, ob jemand
   anhalten will.

   **Umgesetzt — zwei Auflösungen.** `detailDays` (Vorgabe 2) sagt, wie viele
   Tage ab Reisebeginn sofort bis auf Spots geplant werden. Spätere Tage
   bekommen ihren **Rahmen** — Blöcke mit Budgets, Fixpunkte — und bleiben
   ansonsten in Reiseauflösung; `POST /trip-planner/plans/:planId/days/detail`
   konkretisiert einen davon, üblicherweise am Vorabend.

   - **Ein ungeplanter Tag ist kein leerer Tag.** Der Rahmen ist genau das,
     worüber die Familie vorab abstimmt, also existiert er von Anfang an — der
     letzte Zug hat den Nachmittag des vierten Tages schon gekürzt, bevor
     überhaupt ein Spot für ihn erwogen wurde.
   - **Das Detailbudget wird über die Reise verteilt, nicht je Etappe.** „Die
     nächsten zwei Tage" heißt die nächsten zwei Tage, in welcher Etappe auch
     immer sie liegen.
   - **Der Vorrat wird nicht auf Tage verbraucht, die niemand angeschaut hat.**
     Für einen Wochenendtrip fallen beide Auflösungen zusammen, genau wie §4.3
     es beschreibt.
   - **Einen schon geplanten Tag erneut zu detaillieren wird abgelehnt.** Es
     würde stillschweigend wegwerfen, was angepinnt oder schon besucht ist;
     dafür ist `redistribute` da.

   Migration `0161_trip_plan_day_detail`: `detailed` am Tag, bestehende Zeilen
   gelten als detailliert.
7. **iOS-Oberfläche** — Blockkarten, Karte, Wischgesten, „Heute"-Modus,
   **Übergaben an Karten-Apps** (§9.1) und die Essensliste vor Ort (§10.3).

   **Weitgehend umgesetzt.** Planliste, Tagesansicht mit Blockkarten und
   Auslastung, Karte mit nummerierten Pins, Zeit-Regler, „Heute" mit
   Wischgesten, Kartenübergabe und Essensliste stehen. Erreichbar über den
   Trip-Tab („Urlaubsplanung"); eine eigene Tab-Leiste ist voll, und der
   laufende Trip und die geplante Reise gehören nebeneinander.

   Drei Stellen, an denen die Umsetzung eine Entscheidung erzwang:

   - **Der Zeit-Regler antwortet `nil`, statt zu raten** — vor Tagesbeginn,
     nach Tagesende, in der Lücke einer gebuchten Führung und bei jedem Plan
     ohne Blockzeiten. Ein Regler, der immer irgendwohin zeigt, macht genau
     die Prüfung unmöglich, für die er da ist. Dafür speichert Migration
     `0162` die Uhrzeit jedes Blocks, die `scheduleDay` ohnehin rechnete und
     bis dahin wegwarf.
   - **Abhaken ist kein Umplanen.** `POST /trip-planner/plans/:id/stops/status`
     setzt nur den Status, den eine spätere Umverteilung als „vergangen"
     liest. Über `redistribute` zu gehen hätte den Nachmittag unter dem
     Daumen des Reisenden umsortiert.
   - **`LSApplicationQueriesSchemes` fehlte tatsächlich** — der Stolperstein
     aus §9.1, wörtlich. Ohne den Eintrag meldet `canOpenURL` immer „nicht
     installiert", und die Google-Maps-Option verschwindet ohne Fehler. Ein
     Test liest jetzt die Info.plist als Datei; über `Bundle.main` ging es
     nicht, weil das im Test-Target der Test-Runner ist.

   **Die Essensliste** (`POST /trip-planner/food`) hält die Regeln aus §10.3
   ein: sortiert nach Entfernung, nie nach einer Qualität, die wir nicht
   kennen. Ein fehlendes Tag heißt **unbekannt**, nicht „nein" — ungefilterte
   Listen behalten also alles Ungetaggte, und eine Zeile ohne Angaben bekommt
   keine durchgestrichenen Symbole, sondern gar keine Zeile. `limited` bleibt
   `limited`: „vegan (begrenzt)" ist eine echte Antwort, und sie auf `false`
   zu reduzieren würde ein brauchbares Lokal ausschließen.

   **Verhandeln (§8.4) und der „umplanen"-Knopf (§8.5) sind ebenfalls drin.**

   - **Verschieben rechnet den ganzen Tag neu, nicht die zwei Blöcke.** Ein
     Block beginnt dort, wo der vorige endete — nimmt man den letzten Spot aus
     dem Vormittag, verschiebt sich der Beginn des Nachmittags. Ein Patch der
     beiden angefassten Blöcke ließe den Rest des Tages einen Weg beschreiben,
     den niemand geht.
   - **Ein überfüllter Block wird gemeldet, nicht verweigert.** Der Reisende
     hat bewusst dorthin gezogen; ein roter Block sagt mehr als eine
     abgelehnte Geste. Verschieben *über Etappengrenzen* wird dagegen
     abgelehnt: ein Spot aus Tokio in einem Osaka-Tag würde am falschen Anker
     gemessen und mit dem falschen Modus erreicht.
   - **Der Mittagsblock nimmt nichts an.** Er ist Zeit plus Gegend, kein Lokal
     (§10.3) — ein Museum hineinzuziehen würde ihn stillschweigend zu etwas
     anderem machen.
   - **Umplanen rät nichts.** Position kommt von CoreLocation, aktueller Block
     und Restbudget aus dem Tagesrahmen. Fehlt eines davon — kein Fix, keine
     Blockzeiten, oder gerade läuft kein Block —, sagt der Knopf warum. Ein
     umgeräumter Nachmittag auf Basis einer geratenen Position ist schlechter
     als keiner.

   **Nachtrag — der Einstieg fehlte.** Schritt 7 galt als abgeschlossen,
   obwohl die Planerliste zwar „Sag, wohin und wie lange" versprach, aber
   nirgends eine Stelle bot, das zu sagen: es gab keine Aktion zum Anlegen
   einer Reise. Damit war *alles* aus den Schritten 1–8 aus der App heraus
   unerreichbar — der leere Zustand war das ganze Feature. Nachgereicht als
   `TripNewPlanView`: Formular zuerst, Satz als Beschleuniger darunter, weil
   das Modell auf der eigenen Kiste regelmäßig kalt ist und ein Bildschirm,
   der nur mit Modellantwort funktioniert, manchmal gar nicht funktioniert.
   Der Ort wird über MapKit auf dem Gerät gesucht und muss bestätigt werden;
   ein Satz, der eine andere Stadt nennt, verschiebt das Suchfeld, nie die
   Nadel (§15.3).

   **Nachgereicht: Einstellungen ändern und der Vorrat.** Zwei Lücken, beim
   Ausprobieren gemeldet.

   Das „Wie" — Tempo, Begleitung, Interessen — war genau einmal einstellbar,
   beim Anlegen. `PATCH …/plans/:planId/settings` ändert es nachträglich und
   **plant die Tage neu**, weil Tempo und Begleitung das Blockbudget skalieren:
   ein gespeicherter Wert, der die Tage unberührt ließe, wäre ein Schalter ohne
   Wirkung. Erhalten bleiben der Rahmen (Etappen, Anker, Daten, Modus,
   Suchradius) und **alles, was jemand von Hand in den Vorrat gelegt hat**
   (§9.2) — den Pace zu ändern darf niemandes Recherche kosten. Abgelehnt wird,
   sobald ein Stopp abgehakt ist: ein begonnener Tag ist eine Aufzeichnung, und
   ihn einer nachträglich geänderten Einstellung anzupassen hieße, sie
   umzuschreiben. Dafür gibt es unterwegs „Umplanen" (§5, §8.5), und die
   Ablehnung sagt das.

   Dabei fiel auf, dass die Etappe ihren **Suchradius gar nicht speicherte**
   (ebenso wenig den Tagesbeginn). Ein Neuplanen hätte still auf die Vorgaben
   zurückgegriffen — ein anderes Gebiet als das gewählte. Migration 0165 legt
   beides zur Etappe; `null` heißt weiterhin „Vorgabe", was genau dem
   entspricht, womit ältere Zeilen geplant wurden.

   Der **Vorrat** war seit dem ersten Tag Daten und nirgends sichtbar — nur
   indirekt über „Warum hier?" und die Zeile „Zurück in den Vorrat" nach einer
   Umverteilung. Inzwischen führen vier Wege hinein (§9.2) und keiner führte
   irgendwohin, wo man nachsehen konnte. `TripPoolView` zeigt ihn, bestbewertet
   zuerst, mit den Begründungen und der Markierung „schon eingeplant". Bewusst
   nur lesend: einen Kandidaten in einen bestimmten Block zu setzen ist eine
   Entscheidung, die der Solver mit Budget und Fußweg im Blick trifft — ein
   Bildschirm, der ihn irgendwohin fallen ließe, würde diese Rechnung entweder
   verdoppeln oder ignorieren.

   **Nachgereicht: eine Reise ohne importierte Region.** Der Planer lehnte ab
   („no imported OSM region covers this location") und warf damit alles weg,
   was der Reisende getippt hatte — wegen eines Downloads, den er selbst gar
   nicht anstoßen konnte. §4.3 hat dafür längst eine Auflösung: Der Plan wird
   **mit Rahmen, aber ohne Spots** gespeichert, und der Import wird angefragt.
   Null Kandidaten ergeben genau diesen Rahmen — der Solver füllt das Budget,
   das er bekommt, und ohne Kandidaten entstehen Blöcke ohne Stopps.

   Die Anfrage läuft über dasselbe `createPending` wie die Regionsverwaltung
   und erbt damit deren Regel, statt sie zu umgehen: eine kleine Region lädt
   sofort, eine große wartet auf Freigabe. Wer eine Reise plant, verpflichtet
   den Server nicht durch Eintippen eines Städtenamens zu fünfzig Gigabyte.
   Die Antwort nennt unter `pendingRegions`, worauf welche Etappe wartet;
   `POST …/plans/:planId/plan` füllt sie später und lehnt ab, solange die
   Karten fehlen — „es lädt noch" ist etwas, worauf man warten kann, ein leerer
   Tag ohne Erklärung nicht.

   **Nachgereicht: das Karten-Icon am Stopp.** Es öffnete immer eine Route.
   Eine Route von zu Hause zu einem Café, zu dem man nächsten Monat laufen
   wird, ist eine Zahl, die niemand haben will — am Küchentisch ist die Frage
   „wo ist das?". Läuft kein Trip (`TripStore.isActive`), zeigt dasselbe Icon
   deshalb nur den Punkt. Der Planer entscheidet das nicht selbst anhand von
   Daten: „für Juli geplant" und „gerade unterwegs" sind verschiedene Zustände,
   und nur Trip Mode weiß, welcher gilt.

   Damit ist Schritt 7 abgeschlossen.

   **§9.2 und §9.3 — eigene Funde herein.** Nicht Teil der nummerierten
   Schritte, aber hier eingehängt, weil es die Oberfläche braucht:

   - **Karten-Link** (Fall 1): `trip-planner/map-link.ts` liest Apple-, Google-,
     OSM- und `geo:`-Links. Fragil per Entwurf, also wird nie eine Koordinate
     *abgeleitet* — ein Link mit bloßem Suchbegriff liefert einen Namen und
     keine Position, und der Rückfall ist eine Karte zum Bestätigen.
   - **Artikel** (Fall 2) und **Screenshot** (Fall 3) laufen zusammen, sobald
     Text vorliegt: `article.ts` legt ihn frei, `extract-places.ts` lässt das
     Modell Namen mit **wörtlichem Zitat** ziehen, und ein Eintrag, dessen
     Zitat nicht buchstäblich in der Seite steht, fällt mechanisch weg.
   - **Auflösen** (§9.3 Stufe 4) über `geo`s neuen Namensfilter und
     `resolve-place.ts` — eindeutig / mehrdeutig / keiner, derselbe Baustein,
     den §10.6 für Händlername → POI braucht.
   - **Der Server-Abruf** ist nur die Rückfallebene und hat alle in §9.3
     genannten Vorkehrungen: nur `https`, keine privaten Adressbereiche
     *auch nach einer Weiterleitung*, Zeit- und Größenbegrenzung.
   - **Die Extension gibt ab, sie entscheidet nicht.** Sie legt Link und Text
     in die App-Group; die Bestätigung — welche Reise, welcher von drei Cafés,
     wie lange — passiert in der App, wo der Bildschirm dafür ohnehin steht.

   **Noch offen:** Der Textauszug aus der *geöffneten* Seite (§9.3 Stufe 1,
   `NSExtensionJavaScriptPreprocessingFile`) und damit `WebPage`-Aktivierung;
   solange greift für einen geteilten Link der Server-Abruf.

   **Fall 4, die Suche in der App** (`POST …/search`, `TripPlaceSearchView`):
   der Weg herein, der funktionieren muss, wenn nichts anderes es tut — kein
   Share Sheet, keine Karten-App, kein Sprachmodell. Zwei Dinge sagt die Liste
   ausdrücklich statt durch Weglassen: Was schon im Plan ist, wird **markiert,
   nicht versteckt** (eine still kürzere Liste liest sich wie „nicht in
   OpenStreetMap"), und eine Region, die nicht erreichbar war, wird benannt —
   „nichts gefunden" und „eine Region war nicht erreichbar" sind verschiedene
   Antworten.
8. **Standort** — Geofences um die nächsten Stopps, Erledigt-Erkennung,
   angebotene Neuverteilung, „was ist in der Nähe".

   **Teilweise umgesetzt.** Die Grenze aus §7.1 hat die Aufteilung bestimmt:
   Der Standort bleibt auf dem Gerät, zum Server geht nur das *Ereignis*
   („X war an Y von 13:40 bis 14:20, weil Verweildauer und Foto").
   Eine Tabelle von Koordinaten über die Zeit wäre ein anderes Produkt als ein
   Reisetagebuch.

   - **Erledigt-Erkennung** (`visits.ts`, `POST …/visits`): Die Schwelle ist das
     Größere aus zehn Minuten und einem Viertel der geplanten Dauer — nicht das
     Kleinere. Ein Viertel allein ließe zwei Minuten am Aussichtspunkt zählen,
     zehn Minuten allein einen Gang über den Museumsvorplatz. Für Spots, die
     zwischen zwei anderen liegen, das Anderthalbfache.
   - **Ein Signal fragt, zwei handeln.** Ein falscher Haken kostet einen Wisch,
     ein Fehlalarm unterbricht den Urlaub. Das Urteil wird **serverseitig neu
     gebildet**, nicht dem Gerät geglaubt: Die Regel ist eine Produkt-
     entscheidung, und eine, die an zwei Stellen lebt, driftet.
   - **Ein „nein" wird gemerkt, nicht gelöscht.** Sonst erkennt der nächste Sync
     denselben Aufenthalt und fragt wieder — genau das Nörgeln, das §6.4
     vermeiden will.
   - **Ungeplante Aufenthalte** werden mitgeschrieben (`stop_id` null). Das ist
     die wertvollere Hälfte: die App zeichnet den Tag auf, der stattfand, statt
     den geplanten abzuhaken.
   - **„Was ist in der Nähe?"** (`POST /trip-planner/nearby`) zieht **zuerst aus
     dem Vorrat der Etappe**, erst dahinter aus der Regionssuche. Die Reisenden
     haben dem Planer schon gesagt, was sie mögen; eine frische ungefilterte
     Suche beantwortete eine andere Frage als der Plan, und beide widersprächen
     sich still. Bereits Eingeplantes wird markiert, nicht versteckt.
   - **Die angebotene Neuverteilung** (`TripArrivalHeuristic`) prüft die direkte
     Frage — passt das Übrige in die übrige Zeit? —, nicht einen
     Fortschrittsbruch. „Zwei von vier bei halbem Block" klingt richtig und ist
     es nicht: zwei lange und zwei kurze Stopps machen die Zahl bedeutungslos.
     Zwei Bremsen halten es vom Nörgeln ab: nicht vor der Blockhälfte, und
     einmal je Block.

   - **Die Geofences selbst** (`TripGeofencePlan`, `TripDwellTracker`,
     `TripVisitMonitor`): Region Monitoring um die nächsten ein bis zwei Stopps
     plus significant location change, wie §7.1 es vorgibt. Der Radius richtet
     sich nach der Objektgröße — ein Aussichtspunkt ist ein Punkt, ein Park ist
     dreihundert Meter in jede Richtung, und ein Radius für beides verfehlt
     entweder den einen oder zählt den Vorbeiweg am anderen. Erledigte *und*
     verworfene Stopps bekommen keinen Zaun: der eine wäre eine Weckung ohne
     Inhalt, der andere fragte nach etwas, das man bewusst gestrichen hat.

     Drei Fälle, die still schiefgehen und deshalb ausgeschrieben sind: ein
     doppeltes „entered" (iOS liefert Regionsereignisse mehrfach) darf die Uhr
     nicht zurückstellen, kurz bevor die Verweildauer greift; ein „exited" ohne
     vorheriges „entered" (Kaltstart außerhalb) darf keinen Aufenthalt
     erfinden; und ein laufender Aufenthalt ist „noch hier", nicht „null
     Minuten". Was das Gerät verlässt, ist ausschließlich das Ereignis, nie die
     Spur (§7.1).

   - **Das Fotosignal** (`TripPhotoSignal`): Ein Foto zählt nur, wenn es *dort*
     und *dann* aufgenommen wurde. Streng in beiden Hälften, weil ein Signal
     mit der Verweildauer zusammen ohne Nachfrage handelt — ein Foto *von* der
     Kathedrale vom Hügel gegenüber ist kein Beleg dafür, *an* ihr gewesen zu
     sein.

   **Signal 3 (Zahlung) — entschieden: vorerst weggelassen.** Mit den heutigen
   Daten ist es nicht sauber zu bauen, und ein unsauberes zweites Signal ist
   schlimmer als keines, weil zwei Signale ohne Nachfrage handeln.
   `finance_transaction` führt zwar `counterparty`, aber `booking_date` ist das
   *Buchungs*datum: eine Kartenzahlung bucht typischerweise am nächsten
   Werktag, es gibt also kein Zeitfenster, sondern bestenfalls einen Tag.
   `document_receipt_extraction` führt weder Kaufzeit noch Händlernamen. Dazu
   kommt: **der trip-planner liest keine Finanzdaten** (entschieden). Verweil-
   dauer und Foto tragen die Erkennung; Signal 3 wird erst wieder zum Thema,
   wenn Belege eine echte Kaufzeit samt Händlernamen mitbringen — dann über den
   Baustein aus §10.6, der mit §9.3 Stufe 4 geteilt wird und schon existiert
   (`resolve-place.ts`).

   **Nachgezogen aus §9.1: die Einstellung „Navigation öffnen mit".** Die
   Mechanik stand seit der Kartenübergabe, aber es gab keine Oberfläche, die
   den Wert setzt — praktisch also immer Apple Karten. Google Maps erscheint
   nur, wenn es installiert ist; steht es eingestellt und fehlt, sagt der
   Bildschirm das, statt still Apple zu öffnen.

   **Umgesetzt aus §9.2: der Weg in den Vorrat** (`POST …/finds`). Alle fünf
   Regeln sind im Code sichtbar:

   - **Die richtige Etappe nach Lage.** Ein Café in Osaka geht in die
     Osaka-Etappe, auch wenn du in Tokio stehst. In keiner Etappe → nachfragen,
     nicht die nächstgelegene nehmen: das legte den Fund auf die falsche Woche.
   - **Vorschlag, kein Termin.** Der Fund landet im Vorrat und konkurriert
     dort; nichts plant ihn in einen Tag.
   - **Dubletten werden zusammengeführt**, und die Notizen **beider** bleiben.
     Zwei Leute, die dasselbe Café aus verschiedenen Gründen gut finden, sind
     der Fall, der gut behandelt gehört.
   - **Herkunft bleibt.** Notiz, Quelle und wer ihn beigetragen hat.
   - **Fehlendes wird benannt, nicht geraten.** Ohne OSM-Treffer heißt die
     Kategorie `unknown` und die Antwort nennt, was fehlt. Statt eine Dauer zu
     erfinden, lehnt der Endpunkt ab und bittet um die geschätzte — das ist die
     eine Frage, die §9.2 dem Planer zugesteht. Die Referenz bekommt den
     Präfix `manual:`: ein erfundener `node:`-Eintrag wäre eine Behauptung über
     Daten, die es nicht gibt.

   Offen aus §9.2: die Share-Extension (Fälle 1–3 — Karten-Link, Artikel,
   Screenshot) und die Suche in der App (Fall 4).
9. **Wetter & Licht** — Open-Meteo-Anbindung mit Cache, Indoor/Outdoor-Ableitung,
   Sonnenstandsmodul, Lichthinweise, Abendblock-Vorschlag und der Zeit-Regler
   (§8.3). Das **Horizontprofil** aus dem Höhenmodell (§7.3) gehört hierher —
   ohne es ist die Lichtangabe in bergigem Gelände falsch, nicht bloß ungenau.
10. **Weitere Kontextsignale** — Dokumenten-Fixpunkte, Reisegruppe, dazu die
    **Reisebereitschafts-Prüfung** und die Packliste (§8.6), die beide nur
    vorhandene Zustände zusammentragen.
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
  App nicht (§9.5). Der Rückweg in den Plan muss deshalb so billig sein, dass
  ihn niemand vergisst — eine Wischgeste, kein Formular.
- **Gleichzeitige Änderungen sind aufwendig.** Mehrere Geräte, teils offline,
  am selben Plan (§6.3) sind der teuerste Teil des Mehrbenutzerbetriebs — und
  ohne feingranulare Zusammenführung gehen still Änderungen verloren. Ebenso
  ist die automatische Erledigt-Erkennung (§6.4) in dichten Innenstädten und
  Innenräumen ungenau; deshalb Verweildauer statt Eintritt, zwei Signale für
  stummes Setzen und eine Wischgeste zum Korrigieren.
- **Das Lichtmodell kennt kein Gelände**, solange das Horizontprofil (§7.3)
  nicht vorberechnet ist. In Tälern und Hügelstädten — Lissabon, Prag, alles
  Alpine — liegt es dann systematisch zu spät. Bis dahin gehört die Angabe als
  „bei freiem Horizont" gekennzeichnet.
- **Keine Echtzeit.** Verkehr, Streiks, spontane Schließungen sieht das System
  nicht — bewusste Übergabe an Apple/Google Maps für die Navigation.
- **Speicherbedarf** eines späteren Routers (Valhalla-Kacheln zusätzlich zu den
  PostGIS-Region-DBs) muss in Schritt 12 gemessen und in die Regionsverwaltung
  integriert werden (Region löschen = auch Kacheln löschen).
- **Offline-Karten.** Vektorkacheln aus den PBFs (planetiler + MapLibre) wären
  ein eigener großer Baustein. Zunächst MapKit online; offline gibt es
  Blockliste, Spots und Wegbeschreibung, aber keine Kartendarstellung.

## 15. Entschiedene Fragen

Stand 2026-09-02 sind alle zwölf offenen Fragen beantwortet; die Antworten
stehen unten bei der jeweiligen Frage und sind in die betroffenen Kapitel
eingearbeitet. Die Gliederung nach Dringlichkeit bleibt erhalten, weil sie
zeigt, welche Entscheidung welchen Umsetzungsschritt betrifft.

**Damit ist nichts mehr offen, was den Anfang blockiert.** Neue Fragen, die
während der Umsetzung entstehen, gehören hier ergänzt.

### 15.1 Betrifft Schritt 1

1. **Testumgebung — entschieden: PostGIS.** Die Testumgebung (Sandbox und CI)
   bekommt PostGIS, `osm_pois` wird für Tests von Hand mit einigen Dutzend
   Zeilen befüllt, ganz ohne osm2pgsql. Damit werden Radius, Tag-Prädikat,
   Sortierung und die Reihenfolge von Filter und `LIMIT` (§10.2) wirklich
   geprüft und nicht nur der zusammengebaute SQL-String. Siehe §13.0.
2. **Entwicklungsregion — entschieden: Schwaben, dazu Oberbayern.** Korrektur
   einer früheren Fassung, die hier „Bayern" stehen hatte: Importiert sind
   nicht Bundesländer, sondern **Regierungsbezirke**, und ein bayernweiter
   Datenbestand existiert gar nicht.

   Das ist für die Entwicklung kein Nachteil, sondern ein Vorteil, und zwar aus
   zwei Gründen. Erstens ist ein Regierungsbezirk deutlich kleiner als ein
   Bundesland, der Neuimport nach einer Filteränderung also entsprechend
   kürzer — genau der Zyklus, den Schritt 4 oft durchläuft. Zweitens, und
   wichtiger: **Zwei benachbarte Regionen sind der bessere Testfall als eine
   große.** Etappen haben je eine eigene Regionsdatenbank (§4.2), und
   Augsburg → München ist damit ein echter Etappenwechsel samt Transfer und
   Korridorsuche — in einer einzigen Bayern-Datenbank wäre genau dieser
   Mechanismus nicht prüfbar gewesen.

   **Schwaben** ist die primäre Spielwiese (Augsburg; auch die Testfixtures
   liegen dort), **Oberbayern** die zweite Region für Etappen-, Transfer- und
   Korridortests.

### 15.2 Betrifft Schritt 2

3. **Blockschema — entschieden: Vierteilung als Vorgabe, anpassbar.** Jeder Tag
   entsteht mit Vormittag / Mittag / Nachmittag / Abend; jeder Block lässt sich
   umbenennen, teilen, zusammenlegen oder streichen (§4.1).
4. **Web-Frontend — entschieden: nur iOS, API bleibt neutral.** Die Oberfläche
   entsteht ausschließlich in der iOS-App; dort sind Standort, Geofences,
   Kamera und Trip Mode ohnehin zu Hause. Die Endpunkte werden trotzdem
   frontend-neutral geschnitten, damit ein Web-Frontend später ohne API-Umbau
   nachrüstbar bleibt. Konkret heißt „neutral": keine iOS-spezifischen
   Datenformate oder Feldnamen in den Antworten, kein Zustand, der nur auf dem
   Gerät existiert, und Darstellungsentscheidungen (Formulierungen, Symbole,
   Farben) im Client statt im Server.

### 15.3 Betrifft die Schritte 5 bis 9

5. **Regionsumfang — entschieden: automatisch importieren, nach Frist zum
   Löschen vorschlagen.** Wird ein Reiseziel geplant, für das keine
   Regionsdatenbank existiert, löst der Planer den passenden
   Geofabrik-Import selbst aus — ohne Rückfrage. Der Plattenschutz dafür ist
   bereits vorhanden: Der Importer probt die PBF-Größe per HEAD, rechnet sie mit
   dem Ausdehnungsfaktor hoch und geht bei zu wenig freiem Platz in
   `blocked_disk`, statt die Platte vollzuschreiben
   (`osm-admin/importer.ts`). Zwei Dinge sind dafür noch zu bauen: die
   **Zuordnung Reiseziel → Geofabrik-Ausschnitt** (ein Ortsname muss zur
   richtigen Unterregion führen, und „Hakata" zu Kyushu), und eine ehrliche
   **Fortschrittsanzeige** — ein Import dauert Minuten bis Stunden, so lange gibt
   es für diese Etappe noch keinen Vorrat, und das muss der Planer sagen statt
   leere Ergebnisse zu liefern. Läuft `blocked_disk` an, wird daraus ein
   Hinweis mit Aufräumvorschlag statt einer Fehlermeldung.
   **Aufräumen:** Drei Monate nach Reiseende schlägt die Regionsverwaltung das
   Löschen vor — vorgeschlagen, nicht ausgeführt. Mit zu löschen sind dann auch
   die abgeleiteten Daten der Region (Routing-Kacheln, §12).
6. **Claude API — entschieden: zweispurig bauen.** Jeder Modellaufruf geht über
   eine austauschbare Schnittstelle; das lokale Modell ist die Vorgabe, Opus 5 ein
   **pro Funktion** zuschaltbarer Anbieter (§11.5 — ein globaler Schalter wäre
   die falsche Granularität). Wichtig ist, was die Abstraktion umfassen muss,
   damit sie später trägt: strukturierte Ausgabe mit Schemavalidierung,
   Werkzeugaufrufe, ein Kostenzähler je Funktion und ein **Rückfall auf lokal**,
   wenn kein Netz oder kein Guthaben da ist. Die Anonymisierung aus §11.5
   (abstrakte Gruppenbeschreibung statt Namen, Ankerzone statt Adresse) gehört
   in diese Schicht, nicht in die Aufrufer — sonst wird sie irgendwann
   vergessen.
7. **Automatik-Schwelle — entschieden: fertigen Vorschlag danebenlegen.** Merkt
   die App einen Rückstand oder einen Wetterumschwung, rechnet sie die
   Neuverteilung sofort durch und zeigt das Ergebnis konkret an („Museum raus,
   rutscht auf Freitag — übernehmen?"). Ein Tipp genügt, ein zweiter macht es
   rückgängig. Genau dafür ist der Solver schnell genug (§12), und unterwegs
   will niemand erst einen Knopf suchen, der etwas ausrechnet. Zwei Leitplanken
   dagegen, dass es zur Nörgelei wird: **stets nur ein offener Vorschlag** — ein
   neuer ersetzt den alten, sie stapeln sich nicht —, und ein abgelehnter
   Vorschlag kommt für dieselbe Ursache nicht wieder, bis sich die Lage
   wesentlich ändert.
8. **Lichthinweise — entschieden: voll aktiv für alle.** Lichtfenster stehen auf
   jeder Spot-Karte, beeinflussen still die Reihenfolge im Block und dürfen
   einen Abendblock vorschlagen, den es sonst nicht gäbe. Damit das nicht
   kippt, bleiben die Gewichte aus §7.3 klein: Licht ordnet und schlägt vor, es
   wählt nicht aus und ist nie eine harte Nebenbedingung. Ein Abendvorschlag
   folgt derselben Regel wie jede andere Automatik (Frage 7) — höchstens
   einer offen, abgelehnt heißt erledigt. Abschaltbar bleibt es trotzdem, nur
   eben nicht standardmäßig aus.
9. **Hotelwahl — entschieden: Gegenden bewerten, keine Häuser.** Der Planer
   bewertet Lagen, nicht Betten: „von hier sind zwei Drittel eurer Favoriten in
   20 Minuten erreichbar, und abends hat in der Nähe noch etwas offen". Das
   lässt sich aus OSM belastbar herleiten — Preis, Zimmerqualität und
   Verfügbarkeit nicht, und eine Häuserliste ohne diese Angaben sähe aus wie
   eine Empfehlung, ohne eine zu sein (derselbe Fehler, den §10 für Restaurants
   vermeidet). Gebucht wird woanders; das Ergebnis der Buchung kommt als
   Dokument zurück und macht aus der Zone einen Anker (§3.4).
   Umsetzung: Die Bewertung einer Gegend ist keine neue Maschinerie, sondern
   der vorhandene Planer, probeweise auf mehrere Ankerkandidaten angewandt —
   wie viel Vorrat liegt im Zeitbudget, wenn der Tag hier beginnt und endet.

### 15.4 Betrifft den Mehrbenutzerbetrieb (§6), Schritt 11

10. **Kontingent der Herzenswünsche — entschieden: zwei je drei Tage, pro
    Etappe.** Es skaliert mit der Reiselänge und setzt sich je Etappe zurück —
    wer in Tokio seine zwei gesetzt hat, startet in Osaka wieder frei.
    Aufgerundet, damit eine Zwei-Tage-Etappe nicht leer ausgeht. Zu beachten:
    Bei vier Personen sind das acht Setzungen je drei Tage, genug, um einen
    Tagesplan zu füllen — passt ein Herzenswunsch nicht mehr ins Budget, wird
    er deshalb nicht stillschweigend fallen gelassen, sondern ausdrücklich
    gemeldet („X' Wunsch passt nur, wenn etwas anderes weicht"), und der Zähler
    verfällt nicht.
11. **Splits proaktiv — entschieden: ja, aber nur bei klarem Konflikt.** Der
    Vorschlag erscheint nur, wenn zwei Spots sich zeitlich ausschließen **und**
    jeder für eine andere Person stark gewichtet ist — nicht bei jeder
    rechnerischen Verbesserung. Bei kleinerer Uneinigkeit bleibt der Planer
    still. Formuliert wird er neutral und als eine Möglichkeit unter mehreren
    („eine Möglichkeit wäre …"), nie als Empfehlung an die Gruppe; von Hand
    anzulegen sind Splits ohnehin jederzeit. Für die Schwelle heißt das: Sie
    braucht beide Bedingungen, sonst wird aus der Konfliktlösung eine App, die
    ständig Trennungen anregt.
12. **Sichtbarkeit in der Familie — entschieden: für alle im Trip sichtbar.**
    Jeder sieht, wer welchen Spot besucht hat. Das ist nötig, damit nach einem
    Split klar ist, was der andere Zweig gesehen hat (§6.5), und damit das
    gemeinsame Reisetagebuch stimmt. Drei Grenzen dazu: Geteilt wird
    **ausschließlich das Ereignis** („X war am Tempel"), nie ein laufender
    Standort; die Freigabe ist **pro Person abschaltbar**, dann erscheint der
    Stopp für die anderen nur als erledigt, ohne Namen; und sie endet **mit dem
    Trip** — Besuche werden nicht rückwirkend über abgeschlossene Reisen hinweg
    einsehbar.

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

---

## 19. Marktumfeld

Stand 2026-09-02, auf Basis einer Web-Recherche — teils von Herstellerseiten,
also **Werbeaussagen, keine geprüften Fakten**. Vor strategischen Schlüssen
wäre ein Nachmittag mit zwei, drei dieser Apps und einer echten Reise mehr wert
als jede weitere Suche.

### 19.1 Zwei reife Lager

**KI-Reiseplaner** sind ein voller Markt: Layla baut Mehrstädte-Routen und
Roadtrips mit Tagesplan und Live-Preisen, Mindtrip fährt eine POI-Datenbank in
Millionenhöhe samt Buchungsanbindung auf, Wanderlog ist stark beim
kartenbasierten Umsortieren, Stardrift wirbt mit dem Ändern einzelner Tage ohne
Neubau des Plans (also §5), Stippl ergänzt Budget, Packliste und
Gruppenfreigabe.

**Lichtplaner für Fotografen** sind ebenso ausgereift: PhotoPills, Sun Surveyor,
LightPlan (3D-Gelände, Wolkenüberlagerung), PhotoTime (offline), Golden Hour
(Sonnenazimut, Zeit-Regler). Sie rechnen §7.3 — teils besser, siehe die
Geländeverschattung, die von dort übernommen wurde.

### 19.2 Die Lücke liegt zwischen den Lagern

Es war nichts zu finden, das beides verbindet. **Die Lichtapps planen einen
Shot, die Reiseplaner planen einen Tag — niemand plant den Tag nach dem Licht.**
Dazu kommen zwei Dinge, die keine Marktapp abdeckt, und zwar strukturell:

- **Der private Kontext.** Keine dieser Apps liest die eigene
  Hotelbestätigung aus dem eigenen Dokumentenbestand, weiß aus der
  Gesichtserkennung, wer mitfährt, oder kennt die eigenen Belege. Sie können es
  auch nicht — dafür müssten sie das digitale Leben ihrer Nutzer hosten.
  fk-encore tut das bereits; das ist der eigentliche Graben.
- **Die Schleife unterwegs.** Die Marktapps *erzeugen* Pläne. Dass ein Geofence
  bemerkt, dass die Gruppe um 14 Uhr noch beim ersten Stopp steht, und den
  fertigen Ersatzplan hinlegt (§5, §7.1), war nirgends zu sehen — ebenso wenig
  Gruppenfairness und Splits (§6).

### 19.3 Was daraus für die Prioritäten folgt

**Das Erzeugen eines Reiseplans ist inzwischen ein Gebrauchsartikel.** Dort
gegen Anbieter mit Buchungsdaten und Millionen POIs anzutreten, wäre verlorene
Mühe. Der Wert liegt in der anderen Hälfte: privater Kontext, die Schleife
unterwegs, das Licht.

Das verschiebt die Messlatte für die Schritte 1–3 (§13): Der ehrliche Test ist
nicht „ist der erzeugte Plan so gut wie bei den Großen", sondern **„hält er
stand, wenn der Tag anders läuft, und nutzt er, was nur wir wissen"**.

### 19.4 Ausdrücklicher Nicht-Auftrag: Buchen

Buchungsanbindungen (Unterkunft, Touren, Tickets) sind bei den Marktapps der
Kern des Geschäftsmodells. Für ein selbst gehostetes Familiensystem sind sie
**kein Ziel** — sie brächten Provisionslogik, kommerzielle Datenabhängigkeiten
und genau das bezahlte Ranking, gegen das §3.8 und §10.7 sich entschieden
haben. Der Planer hört bei der Empfehlung auf; gebucht wird woanders, und das
Ergebnis kommt als Dokument zurück (§3.4). Das steht hier, damit die Lücke in
einem Jahr als Entscheidung erkennbar ist und nicht als Versäumnis.
