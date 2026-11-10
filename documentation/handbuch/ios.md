# iOS-App (F4mil / FKPhotos)

Die iOS-App (`ios/`) ist der mobile Zugang zu Fotos, Alben, Personen,
Rückblicken, Gruppen-Review und Suche, synchronisiert die
iPhone-Mediathek auf den Server und enthält den Reiseplaner („Trip“).
Eine Share-Extension nimmt Fotos und Webseiten aus anderen Apps entgegen.
Die Rechte sind dieselben wie im Web (`fotos-galerie.md`); die App zeigt
nur, was der angemeldete Nutzer darf.

Dieser Teil ist auf **Bildschirm-Ebene** geschrieben: je Bildschirm die
Aktionen in einer Liste, nicht je Aktion ein eigener Eintrag mit
Schritten. Der Reiseplaner hat rund 45 Bildschirme und braucht für die
volle Tiefe einen eigenen Durchgang. Regeln für Aktionen an Spots stehen
in `.claude/CLAUDE.md` („Aktionen an Spots in der iOS-App“): was man mit
einem Spot tun kann, ist in Liste, Detail, Pin-Sheet und Karte dasselbe.

## Tabs und Bildschirme

| Kürzel | Tab / Bildschirm | Titel in der App |
|---|---|---|
| `LOG` | Anmeldung | – |
| `FED` | Tab Feed | Feed |
| `ALB` | Tab Alben | Alben, Album, Album-Einstellungen, Freigabe, Filter & Sortierung, Gruppen-Review, Eigene Ansicht |
| `FOT` | Foto-Raster und Vollbild (aus Alben, Suche, Personen) | Details, Datum ändern, Bearbeiten, Zuschnitt, Layout wählen, Collage bearbeiten, Fotos hochladen |
| `PER` | Personen | Personen, Person |
| `RUE` | Rückblicke | Rückblicke, Player |
| `REV` | Gruppen-Review | Gruppen-Review, Bewertung, Auswahl anpassen |
| `SUC` | Tab Suche | Suche |
| `TRP` | Tab Trip | Trip, Trip starten, Trip & Reise |
| `PLN` | Reiseplaner | Neue Reise, Reiseverlauf, Spot hinzufügen mit Wünschen, Tagesablauf, Karte, Ideen, Reisegruppe, Planen mit, Dokumente, Reisebereit?, Danach, Unterwegs ohne Netz, … |
| `ASS` | Assistent (aus der Feed-Toolbar) | Assistent, Neue Unterhaltung, Dokument |
| `SET` | Tab Einstellungen | Profil, Server, Foto-Synchronisierung, Upload-Warteschlange, iPhone-Mediathek, Benachrichtigungen, Suche auf dem iPhone, Trip & Reise, Karten-App, Benutzer, Rollen, Quellen & Lizenzen |
| `SHR` | Share-Extension | Gefunden, Fund übernehmen |

---

## LOG: Anmeldung

### IOS-LOG-01 Anmelden und Server wählen

- Server-URL eintragen (Einstellungen › Server-Verbindung), E-Mail und
  Passwort, „Fertig“. Die Sitzung bleibt bis „Abmelden“ in den
  Einstellungen.
- Fehler: falsche URL oder Zugangsdaten zeigen die Meldung des Servers.
- **Test:** –

---

## FED: Feed

### IOS-FED-01 Feed lesen und reagieren

- Karten der neuesten Fotos; Gefällt mir, Kommentar („Kommentar…“), Foto
  einmal antippen öffnet das Vollbild; oben der Streifen „Rückblicke“ mit
  „Rückblick … abspielen“.
- Nur Fotos aus geteilten Alben; private Alben bleiben draußen, auch für
  ihren Eigentümer.
- Leer: „Kein Feed“.
- **Test:** –

### IOS-FED-02 Geteiltes Album öffnen

- Ein Album, das jemand mit dir teilt, steht einmal als Albumkarte im Feed
  („… hat ein Album mit dir geteilt“, Name, Anzahl, Vorschaubilder), nicht
  mit jedem seiner Fotos. Antippen öffnet das Album.
- Wird die Freigabe zurückgenommen oder verlässt du das Album, verschwindet
  die Karte beim nächsten Laden.
- **Test:** –

---

## ALB: Alben

### IOS-ALB-01 Albenliste

- Alben als Kacheln; Filter (Geteilt, Ansicht), Sortierung (Feld,
  Richtung, Jahr, Monat); „Neues Album erstellen“ (Name, Beschreibung
  optional); „Anpinnen“ / „Angepinnt“; Album antippen öffnet es.
- **Test:** –

### IOS-ALB-02 Album

- Raster mit Monats-Sprüngen, „Karte“ (wenn aktiviert), „Diashow“,
  „Filter“ (Filter & Sortierung: Ausgeblendet, Nur Favoriten,
  Formatvarianten anzeigen, GPS-Standort, Feld, Richtung), „Ansicht: …“
  (Eigene Ansicht gegen Gruppen-Highlights, „Auf Gruppen-Highlights
  zurücksetzen“), „Gruppen-Review“ des Albums, „Album-Einstellungen“,
  „Freigeben…“, Mehrfachauswahl mit „Teilen“, „Zu Album hinzufügen“,
  „Aus „Album“ entfernen“, „Löschen“, „Collage“.
- **Test:** –

### IOS-ALB-03 Album-Einstellungen

- Name, Beschreibung, „Karte aktivieren“, Albumcover („Als Albumcover
  festlegen“, „Albumcover entfernen“), „Album löschen“ mit Rückfrage
  „Album löschen?“.
- **Test:** –

### IOS-ALB-04 Freigabe

- Benutzer und Zugriff (Nur lesen, Bearbeiten, Bearbeiten + Teilen)
  „Hinzufügen“, „Lösen“; „Öffentlichen Link erstellen“ mit Gültigkeit,
  „Link teilen“, „Link löschen“; „Ohne Freigabe schliessen“.
- **Test:** –

### IOS-ALB-05 Fotos hochladen

- „Alle Fotos hochladen“ oder Auswahl aus der Mediathek in ein Album;
  Fortschritt in der Upload-Warteschlange.
- **Test:** –

---

## FOT: Foto-Vollbild und Bearbeitung

### IOS-FOT-01 Vollbild

- Wischen, Zoomen, „Details“ (Metadaten, Ort, Personen, Alben, Text im
  Bild mit „Gesamten Text kopieren“), Favorit, Ausblenden, „Teilen“, „Zu
  Album hinzufügen“, „Diashow“ mit „Intervall“ und „Andere Musik“,
  „Datum ändern“, „Zuschnitt…“ und „Frei zuschneiden und bearbeiten…“,
  Formatvariante wechseln, „Löschen“.
- „Teilen“ (Symbol unten links) öffnet das Teilen-Menü von iOS; F4mil
  selbst steht dort nicht als Ziel, damit ein Foto nicht in die App
  zurückgeteilt wird. Das gilt für jedes Teilen-Menü, das die App öffnet.
- **Test:** –

### IOS-FOT-02 Zuschnitt und Bearbeiten

- „Zuschnitt“: Seitenverhältnis, „Vorschlag … übernehmen“, „Ganzes
  Bild“, „Auf Original zurücksetzen“; „Bearbeiten“ (Rezept-Editor):
  Auto-Levels, Drehen, Regler, „Speichern“, „Zurücksetzen“.
- **Test:** –

### IOS-FOT-03 Collage

- „Layout wählen“, „Collage bearbeiten“ mit „Text hinzufügen“ („Text über
  die Collage …“, Größe, Farbe, Ausrichtung), „Sichern“ / „Teilen“;
  „Keine Collage möglich“ bei falscher Anzahl.
- **Test:** –

---

## PER: Personen

### IOS-PER-01 Personen und Person

- Liste der Personen; Person öffnet ihre Fotos; „Umbenennen“ („Name
  eingeben“, bei vorhandenem Namen „Zusammenführen mit …“),
  „Ignorieren“ („Gesicht ignorieren?“), „Alle ignorieren“ („Alle
  Gesichter ignorieren?“).
- **Test:** –

---

## RUE: Rückblicke

### IOS-RUE-01 Rückblicke abspielen

- Liste; Player mit Pause, Weiter, „Andere Musik“, Favorit, „Foto aus
  Rückblick entfernen“, „Schließen“.
- Mit Apple Music (Profil › „Musik in Rückblicken“, „Apple Music
  verwenden“) und Abo: Musik aus der Mediathek um die Zeit des Rückblicks,
  sonst eine Playlist zur Stimmung; im Player „Anderer Titel“ und
  „Playlist wählen“ („Automatisch“ oder eine eigene Playlist).
- **Test:** –

---

## REV: Gruppen-Review

### IOS-REV-01 Gruppen entscheiden

- Warteschlange mit „Nach Sicherheit filtern“ (Sicherheit); je Gruppe
  „KI-Vorschlag“, „Nur dieses behalten“, „Dieses Foto ausblenden“,
  „Hoch + Quer“ / „Als Formatpaar behandeln“, „Nicht dasselbe Motiv“,
  „Konsens der anderen übernehmen“, „Auswahl anpassen …“, „Vergleichen …“,
  „Rückgängig“, „Später“, „Weitere laden“, „Durch!“ am Ende.
- Vergleich („Bewertung“): zwei Fotos, „Schärfe anzeigen“, „Gleich gut“,
  „Groß ansehen“, „Weiter vergleichen“, „Übernehmen“; Prozentwerte der
  KI je Foto.
- **Test:** –

---

## SUC: Suche

### IOS-SUC-01 Suchen

- Freitext (natürliche Sprache wie im Web), Treffer als Raster; „Keine
  Ergebnisse“. Spotlight-Suche des iPhones über Einstellungen › Suche
  auf dem iPhone („Personen und Alben“, „Text in Fotos“, „Jetzt
  aktualisieren“).
- **Test:** –

---

## TRP: Trip

### IOS-TRP-01 Trip starten und beenden

- „Trip starten“ (Trip-Name, Startort, „Neue Fotos automatisch ins Album
  legen“), während des Trips Fotos im Trip-Album, „Weiter unterwegs“ /
  „Trip beenden“; Vorschläge „Trip-Vorschläge“ mit „Nicht jetzt“ und „In
  dieser Gegend nicht mehr fragen“; „Reisezeiten prüfen“, „Das hier
  merken“, „Plan öffnen“ zum Reiseplaner.
- **Test:** –

---

## PLN: Reiseplaner

Bildschirme (je Titel ein Bildschirm): Neue Reise, Reise, Reiseverlauf
(Aufenthalte und Weiterreisen als eine Kette, Zuhause an beiden Enden,
Plus auf der Linie, Umsortieren, ein Datum im Kopf), Spot hinzufügen (Suche, Chips
Alles, Ideen, Highlights, Ausflüge, Strecken, Essen, Mehr; Abstimmungs-Ring je Idee,
Feste Zeit, Für andere Reisen merken, Priorität, Aus den Ideen entfernen), Tagesablauf (Blöcke, feste Zeiten, Fotostopp,
Wetter, „Ab hier umplanen“, „Umräumen“, „Gruppe trennen“ /
„Wieder zusammen“), Ausflug, Karte, Strecken (anlegen,
auf der Karte, Als GPX exportieren), Reisezeiten prüfen,
Fortbewegung, Ideen (In der Nähe, Ausflug, Essen in der Nähe, Artikel
lesen und auslesen, Artikel-Sprachen, „In eine Reise übernehmen“, „Wer
schreibt mit“), Reisegruppe und Mobilität,
Jemanden eintragen, Planen mit (Teilnehmer, „Rolle übergeben“, „Reise
verlassen“), Dokumente, Reisebereit?, Unterwegs ohne Netz („Plan fürs
Gerät laden“, „Vom Gerät löschen“), Änderungen (Journal), Danach
(Rückblick „Ja, waren wir“), Einstellungen der Reise, Karten-App (Apple
Karten / Google Maps), Spot hinzufügen, Ort bearbeiten, Gefunden / Fund
übernehmen (aus der Share-Extension).

### IOS-PLN-01 Reise anlegen und Aufenthalte planen

- „Neue Reise“ öffnet den leeren Reiseverlauf; das Plus „Aufenthalt
  hinzufügen“ fragt Wo, Von (optional), Wie lange, Vor Ort und ob schon
  etwas gebucht ist. „Hinzufügen“ legt die Reise an und öffnet den
  Reiseverlauf mit einem Namensvorschlag (ändern über Koffer ›
  Einstellungen); dort weitere Aufenthalte und die
  Weiterreisen dazwischen. Ein Plus unter einer Schiffsfahrt fügt einen
  Hafen ein.
- Das Blatt einer Weiterreise hat Verkehrsmittel, Abfahrt und Ankunft,
  Nächte unterwegs und eine Notiz (Flugnummer, Sitzplatz), die auch auf
  ihrer Karte im Verlauf steht. „‹Weiterreise› entfernen“ nimmt
  Verkehrsmittel, Zeiten, Nächte und Notiz weg; die Verbindung zwischen
  den Aufenthalten bleibt mit offenen Zeiten.
- Die Planung eines Aufenthalts beginnt mit seinem Namen, darunter Tage,
  Daten und Unterkunft (unterwegs „Tag n von m · heute“ und das Wetter),
  und der Knopf „Ideen (n) und Suche“ öffnet die Spot-Auswahl. Oben steht
  nur der Weg zurück in den Reiseverlauf. Jeder Tag zeigt im Kopf
  Ankunft bzw. Abfahrt und rechts „verplant von verfügbar“, unterwegs
  „n von m besucht“; jede Karte nennt Art und Dauer, darunter die
  geschätzte Uhrzeit. Ein Ausflugstag trägt oben die Zeile „Ausflug
  nach …“ mit Hin- und Rückweg, „Weg zeigen“ und „Fahrt ändern“.
- Eine Reise öffnet sich mit ihrem Reiseverlauf. Ein Tipp auf einen
  Aufenthalt oder eine seiner Tageszeilen öffnet die Planung des
  Aufenthalts mit allen Tagen auf einem Bildschirm, „Zurück“ führt in den
  Verlauf. Unterwegs öffnet sich die Reise gleich in der Planung, am
  laufenden Tag. Ein Tipp auf einen Tag öffnet diesen Tag für sich
  (Zeitband, Reihenfolge, Pausen); eine Weiterreise zeigt direkt ihren Tag.
- Eine neue Reise beginnt je Aufenthalt mit einer leeren Liste „Ideen“:
  die App sucht und plant nichts selbst. Ideen kommen über „Spot hinzufügen“,
  „Hier, wo ich bin“, Entdecken („Gegend wählen“, „Andere Gegend…“), Teilen
  aus Apple Karten oder Google Maps und „Aus den Ideen übernehmen“; von dort
  legt man sie auf einen Tag. Wird die Reise neu geplant (Einstellung,
  fester Termin, Reiseverlauf), bleiben die Stopps auf ihren Tagen; fällt
  ein Tag weg, gehen seine Stopps zurück zu den Ideen. Auch Reisen von
  vorher sind seit dem Umbau Reisen mit Ideen: ihre Tage, Stopps und
  eigenen Funde bleiben, die gesuchten Kandidaten nicht.
- „Spot hinzufügen“ (im Aufenthalt, am Tag und in der Planung des
  Aufenthalts) ist der eine Weg hinein: ein Suchfeld für einen Namen oder
  einen Karten-Link, darunter die Chips Alles, Ideen, Highlights, Essen
  und Mehr. **Highlights** zeigt, wofür die Gegend um den Aufenthalt
  bekannt ist (Bild, eine Zeile dazu, Entfernung zur Unterkunft), solange
  das lokale Modell noch ordnet nach Bekanntheit mit dem Hinweis „wird
  noch sortiert“. „+ Tag n“ legt einen Treffer auf den vorgeschlagenen
  Tag, langes Drücken auf einen anderen Tag oder nur zu den Ideen; was
  schon dort ist, steht als „In der Reise“ oder „Schon eingeplant“ in der
  Liste. Der Kopf eines Aufenthalts öffnet dieselbe Auswahl über „Spot
  hinzufügen“, „Ideen (n)“, „Ausflüge“ und „Strecken“, jeweils auf ihrem
  Chip. Langes Drücken auf eine Idee (oder ihre Details) bietet dazu
  „Feste Zeit …“ (legt sie auf den Tag und hält die Uhrzeit), „Für später
  merken“, die Priorität und „Aus den Ideen entfernen“.
- **Regen.** Regnet es laut Vorhersage an einem Tag mit Spots draußen,
  steht oben am Tag in der Planung des Aufenthalts ein Hinweis. „Mit Fr
  tauschen“ zeigt erst ein Blatt, welcher Tag was bekommt und was mit
  fester Zeit am Tag bleibt, und tauscht dann; angeboten nur, wenn am
  trockeneren Tag alles drinnen ist. „Nur draußen verschieben“ legt nur
  die Spots draußen auf den trockeneren Tag. Beides lässt sich über die
  Leiste unten oder unter „Änderungen“ zurücknehmen.
- **Abendlicht.** Die Details eines Spots mit Blick (Fotostopp,
  Aussichtspunkt, Fassade mit bekannter Richtung) zeigen das beste Licht
  an den Tagen des Aufenthalts und einen Tag mit Wolken. „+ Tag n am
  Abend“ plant ihn fest am Abend mit dem Grund „Licht“, langes Drücken
  wählt einen anderen Tag; ein späterer Abend ersetzt den früheren.
- **Ausflüge.** Der Chip „Ausflüge“ in „Spot hinzufügen“ zeigt Orte eine
  halbe bis zwei Stunden entfernt, die einen Tag tragen, mit Fahrzeit und
  einigen Sehenswürdigkeiten. „+ Tag n“ macht den Tag zum Ausflug (Hin-
  und Rückweg zählen mit), langes Drücken wählt einen anderen Tag oder
  „Nicht mehr vorschlagen“. Danach sucht die Liste dort, und „+ Tag n“
  legt auf den Ausflugstag, bis man den Chip „Ausflug …“ schließt. Unter
  „Schon geplant“ stehen die Ausflüge des Aufenthalts mit „Dort suchen“.
- **Strecken.** Der Chip „Strecken“ in „Spot hinzufügen“ zeigt die
  ausgeschilderten Wander- und Radwege in der Nähe, die lohnendsten
  zuerst, mit geschätzter Dauer, Länge und Anstieg. Ein Tipp zeigt den
  Verlauf auf der Karte, „+ Tag n“ legt die Strecke auf den Tag, langes
  Drücken wählt einen anderen Tag oder „Als Idee behalten“. Am Tag ist
  sie eine Karte mit Länge, Anstieg und „Weg zum Start“. „Strecke von
  Hand anlegen“ unter der Liste bleibt für einen Weg, den die Karte nicht
  kennt.
- Jede Idee hat eine Priorität: **Muss**, **Will** (Standard) oder **Wenn
  Zeit**. Langes Drücken auf „Zur Reise“ fragt sie beim Übernehmen, beim
  Teilen steht sie als Auswahl dabei; danach ändert man sie im Menü der
  Idee oder des Stopps. Neben dem Namen steht, was zählt: die Priorität,
  ein gebuchtes Ticket, an welchen Tagen des Aufenthalts der Ort laut
  OpenStreetMap geschlossen ist (auf einem Tag: „an diesem Tag
  geschlossen“) oder „Öffnungszeiten unklar“, wenn die App die Angabe
  nicht sicher lesen kann.
- Kürzt oder entfernt eine Änderung im Reiseverlauf schon geplante Tage,
  steht sie unter „Änderungen“ und lässt sich dort mit „Rückgängig“
  zurücknehmen: die alten Tage kommen genau so wieder, wie sie waren.
  Zurücknehmen lässt sich immer nur die letzte solche Änderung; ein
  entfernter Aufenthalt kommt ohne seine Wünsche und Notizen zurück.
- **Test:** –

### IOS-PLN-02 Tag planen

- Spots einplanen, „Auf einen anderen Tag“ schieben, feste Zeit setzen,
  Fotostopp markieren, Abendlicht in den Details des Spots, Wetter prüfen, Route in der
  Karten-App öffnen („Ganzen Block in Karten öffnen“, „Route hierher“),
  „Erledigt“ unterwegs, „Zurück zu den Ideen“.
- Die Details eines Spots sind ein Blatt: oben Bild, Name, Art und
  Entfernung zur Unterkunft mit den Chips für feste Zeit, Priorität und
  Dauer, darunter Ticket, Öffnungszeiten, „Geplant“ und Notiz, dann
  Beschreibung, Bilder und Karte. Unten stehen immer „Route“, „Karte“,
  „Anderer Tag“ (in der Spot-Auswahl „+ Tag n“) und „Mehr“ mit allen
  übrigen Aktionen. Die Spot-Auswahl gliedert sich in „Eure Ideen“ und
  „Highlights in der Nähe“; Eingeplantes zeigt „✓ Tag n“.
- In den Details eines Spots stehen Art, Aufenthaltsdauer und die Namen
  weiter unten; die Art lässt sich dort ändern (nicht bei einer
  Strecke). Die Ideenliste der Spot-Auswahl zeigt unter dem Namen die
  Notiz, sonst die Beschreibung des Orts.
- Hat ein Aufenthalt nur einen Tag, fragt die App nicht nach dem Tag: ein
  Tipp auf eine Idee in der Karte legt sie auf diesen Tag, und das Blatt
  für eine feste Zeit zeigt keine Tagauswahl.
- „Fester Termin …“ an einem Spot fragt nur Uhrzeit, Tag, Grund (Ticket,
  Licht, Reservierung, Ereignis, Abfahrt) und Dauer; Ort und Weg sind die
  des Spots.
- Dieselben Aktionen in Liste, Detail („Alle Details“), Pin-Sheet und
  Karte.
- Die Etappenleiste oben zeigt die Reise als Kette: Aufenthalte als
  Chips, eine Weiterreise mit Nächten als Symbol ihres Verkehrsmittels
  auf der Linie dazwischen. Der Kopf darunter ist immer der Aufenthalt
  (Unterkunft, Fortbewegung) und öffnet dessen Sheet; der Ausflug eines
  Tages steht als erste Zeile im Rahmen des Tages und öffnet den Ausflug.
- Auf einer Reise mit Ideen ist der Tag ein Fenster ohne Vormittag und
  Nachmittag. Oben steht, wie viel verplant ist und wie viel frei bleibt,
  bei jedem Stopp die geschätzte Uhrzeit („ca. 10:40“) und eine Wartezeit,
  wenn er erst später öffnet. „Reihenfolge vorschlagen“ ordnet die Ideen
  des Tages nach Ticket, Öffnungszeiten und Wegen und lässt nichts weg;
  passt der Tag nicht, sind die Ideen markiert, die zurück zu den Ideen
  könnten („Wenn Zeit“ zuerst, nie „Muss“). „Pause“ fügt Mittag, Kaffee
  oder eine kurze Pause am Ende ein; das Kreuz entfernt sie wieder.
  Darüber zeigt ein Band den Tag von Anfang bis Ende: Besuche als Felder,
  Wege als Linien, Pausen gestrichelt, Termine orange, heute ein roter
  Strich für „jetzt“. Ein Tipp auf einen Besuch markiert ihn in der
  Liste. Unter jedem Tag in der Tagesleiste zeigt ein dünner Balken, wie
  voll er ist.
- Restaurants und Cafés unter den Ideen stehen in der Liste unter „Essen
  & Trinken“ und kommen nie in die vorgeschlagene Reihenfolge. An einer
  Pause öffnet „Jetzt aussuchen“ die Lokale in der Nähe, eure eigenen
  Ideen zuerst („eure Idee“); die Wahl öffnet die Karten-App.
- Abstimmen ist auf einer Reise mit Ideen ab Werk aus. Einschalten unter
  Einstellungen › „Planen mit“ › „Abstimmen“; dann trägt jede Idee in
  „Spot hinzufügen“ einen Ring, und die Namen stehen darunter.
- **Test:** –

### IOS-PLN-03 Gemeinsam planen

- Teilnehmer einladen („Planen mit“), Wünsche abstimmen (der Ring an jeder
  Idee in „Spot hinzufügen“: Will ich, Egal, Lieber nicht, Herzenswunsch;
  Namen darunter),
  Ideen teilen („Wer schreibt mit“), Rolle übergeben, Reise verlassen.
- **Test:** –

### IOS-PLN-04 Unterwegs

- Plan offline laden, Dokumente der Reise, Reisebereit?-Checkliste,
  Strecken als GPX, nach der Reise „Danach“.
- Am laufenden Tag zeigt die Aufenthaltsplanung oben das Besuchte, dann
  eine „jetzt“-Linie und was noch kommt; ein Kreis hakt ab, „Doch nicht“
  nimmt es zurück, „Neu ordnen“ plant den Rest ab jetzt.
- „Weg“: zwischen zwei Spots steht eine Wegzeile („9 min zu Fuß ·
  700 m“). Ein Tipp darauf, auf das Etikett eines Wegs auf der Tageskarte,
  auf „Route“ am nächsten Spot oder auf „Route hierher“ in den Details
  öffnet das Blatt mit Von und Nach (tauschbar), einer Dauer je
  Verkehrsmittel, dem Weg auf einer kleinen Karte, der Ankunft gegen
  Öffnungszeit und Ticket und „In der Karten-App starten“. Ein anderes
  Verkehrsmittel gilt nur für diesen Abschnitt; der Tag rechnet mit
  seiner Dauer weiter.
- **Test:** –

---

## SET: Einstellungen

### IOS-SET-01 Profil und Server

- Profil (Name, Rollen, „Abmelden“), Server-Verbindung („Server URL“,
  „Speichern“).
- **Test:** –

### IOS-SET-02 Foto-Synchronisierung

- „Automatisch synchronisieren“, „Nur WLAN“, „Screenshots
  ausschliessen“, Modus (Kopieren, Synchronisieren, Zwei-Wege), Auswahl
  der Alben der Mediathek („Auswahl ändern…“, „Alle Fotos hochladen“,
  „Nur neue ab jetzt“), Ziel-Album, „Vollen Zugriff erlauben“ /
  „Einstellungen öffnen“ bei verweigertem Zugriff, „Hintergrund-Task
  einplanen“, „Zurücksetzen“; Upload-Warteschlange mit Einträgen und
  „Löschen“; iPhone-Mediathek-Browser mit „Mehrere auswählen“,
  „Kopieren“, „Trennen“.
- **Test:** –

### IOS-SET-03 Benachrichtigungen und Spotlight

- „Push auf diesem iPhone“, „Hinweis auf neue Gruppen“, „Einstellungen
  öffnen“; Spotlight wie `IOS-SUC-01`.
- **Test:** –

### IOS-SET-04 Trip & Reise, Karten-App

- Trip-Vorschläge, Auto-Album, Bereich und Modus; Karten-App („Immer
  Apple Karten“, „Immer Google Maps“ oder jedes Mal fragen).
- **Test:** –

### IOS-SET-05 Admin und Quellen

- Benutzer (Liste), Rollen & Berechtigungen (nur mit Admin-Rechten);
  Quellen & Lizenzen (OpenStreetMap, Wikipedia, Wikimedia Commons,
  Wikivoyage, Wikidata, Open-Meteo, Apple Karten und die eingebaute
  Open-Source-Software mit Version, Lizenz- und NOTICE-Text).
- **Test:** –

### IOS-SET-06 Musik in Rückblicken

- „Apple Music verwenden“ fragt einmal nach dem Zugriff auf Apple Music
  und zeigt, ob ein Abo gefunden wurde; ohne Abo bleibt die lizenzfreie
  Musik.
- **Test:** –

---

## ASS: Assistent

### IOS-ASS-01 Fragen stellen

- Einstieg: Sprechblasen-Symbol in der Feed-Toolbar, nur mit dem Recht
  `module.assistant`. Liste der Unterhaltungen (neueste oben, wischen
  löscht), oben rechts „Neue Unterhaltung“.
- Chat: eigene Frage rechts, Antwort links mit den Ergebnisblöcken des
  Servers (Titel, „n von gesamt“, „Liste“ öffnet die Listenseite). Während
  der Antwort stehen die Werkzeugschritte („Buchungen durchsuchen“ …) mit
  Haken, darunter „Abbrechen“. Ein Satz vor einem Werkzeugaufruf bleibt grau
  stehen, eine zurückgenommene Antwort trägt „Zurückgenommen und erneut
  geprüft“.
- Leere Unterhaltung: eine Beispielfrage je Modul, das der Nutzer hat.
  Hinweis über dem Feld, wenn das Modell langsam, ungetestet oder gesperrt
  ist (gesperrt: Feld aus).
- Zeile antippen: Foto, Album, Person oder Rückblick öffnen in der App;
  ein Dokument als PDF-Vorschau mit Teilen; alles andere (Buchungen, Konten,
  Zähler, …) als Webseite im In-App-Browser, angemeldet als der Nutzer der
  App (einmaliger Übergabe-Code, eine Minute gültig; schlägt die Übergabe
  fehl, fragt die Seite einmal nach der Anmeldung).
- Verbindung weg: die Antwort läuft auf dem Server weiter; die App
  verbindet sich bis zu sechsmal neu, danach „Die Verbindung zur laufenden
  Antwort ist abgerissen …“, und die Antwort steht nach dem Neuladen da.
- Vorschläge (Album anlegen, Tags …) erscheinen als Karten „Vorschlag“,
  siehe IOS-ASS-04.
- **Test:** –

### IOS-ASS-02 Assistent zu Fotos fragen

- In der Auswahl (Zeitstrahl, Monatsraster, Album) „Assistent fragen“ in
  der Toolbar, im Menü (⋯) eines Albums „Assistent fragen“ für die
  gezeigten Fotos — nur mit dem Recht `module.assistant` und nur bis 25
  Fotos; ein größeres Album über eine Auswahl fragen.
- Öffnet eine neue Unterhaltung mit den Fotos als Kontext (Chips über dem
  Chat, wie auf der Web-Seite `/assistent?context=`), Beispielfragen zu den
  Fotos.
- **Test:** –

### IOS-ASS-03 Antwort als Mitteilung

- Verlässt man die App, während eine Antwort läuft, läuft sie auf dem
  Server weiter; ist sie fertig und niemand schaut zu, kommt eine Mitteilung
  mit dem Titel der Unterhaltung und dem Anfang der Antwort. Antippen
  öffnet die Unterhaltung. Zurück in der App zeigt der Chat die Antwort
  auch ohne Mitteilung.
- Abschaltbar im Web unter Profil › Benachrichtigungen › „Assistent“.
  Voraussetzung: Mitteilungen in der App eingeschaltet (IOS-SET-03).
- **Test:** –

### IOS-ASS-04 Vorschlag ausführen

- Schlägt der Assistent eine Änderung vor (Album anlegen, Fotos ins Album,
  Favoriten, Tags, Sammelmappe, Bericht, Brief, Collage, Fotobuch …), steht
  sie als Karte „Vorschlag“ mit Status „Wartet auf Bestätigung“ in der
  Antwort — auch schon, während die Antwort noch läuft. Nichts ist
  passiert, bis man „Ausführen“ antippt; „Verwerfen“ legt den Vorschlag ab
  (durchgestrichen). Schlägt das Ausführen fehl, bleibt die Karte offen mit
  dem Fehler und „Erneut ausführen“.
- Die Karte zeigt vorher, was sie tun wird: ein Brief mit Absender,
  Empfänger, Betreff, Text und Anlagen (Lücken `[[…]]` orange), ein
  Textdokument mit seinem Text, eine Collage mit ihren Fotos und der
  Bildunterschrift.
- Ein Brief oder eine Collage wird auf dem Telefon nicht bearbeitet. Bleibt
  im Brief eine Lücke, ist „Ausführen“ aus, die Karte sagt es, und „Im Web“
  öffnet die Unterhaltung angemeldet in der Web-Ansicht zum Ausfüllen.
- Nach dem Ausführen: Ergebniszeile mit Haken, „Ansehen“ öffnet das
  Ergebnis (Album in der App, sonst Web-Ansicht), „PDF ansehen“ zeigt
  Bericht oder Brief als Vorschau mit Teilen, ein Brief zusätzlich „Als
  E-Mail-Entwurf“. Steht auf der Karte „Nach dem Ausführen mache ich
  weiter: …“, stellt der Chat diese Frage von selbst (wartet, bis eine
  laufende Antwort fertig ist). Die Albenliste lädt sich neu, wenn ein
  Album entstanden ist.
- **Test:** –

## SHR: Share-Extension

### IOS-SHR-01 Fotos aus einer anderen App hochladen

- Teilen-Menü → F4mil: „Album (optional)“ wählen, „Hochladen“;
  Fortschritt „n von m hochgeladen“, „Fertig“.
- **Test:** –

### IOS-SHR-02 Webseite als Ort übernehmen

- Teilen-Menü auf einer Webseite: die Extension liest Ort, Zitat und
  Aufenthaltsdauer („Gefunden“), „Wohin“ (Reise oder Ideen), „Zu den
  Kandidaten“ oder „Erstellen“; „Kein Ort gefunden“, wenn die Seite
  keinen Ort nennt. In der App wartet der Fund unter „Fund übernehmen“.
- **Test:** –

---

## Abdeckung

| ID | Bildschirm | Test |
|---|---|---|
| IOS-LOG-01 | Anmelden und Server wählen | – |
| IOS-FED-01 | Feed lesen und reagieren | – |
| IOS-FED-02 | Geteiltes Album öffnen | – |
| IOS-ALB-01 | Albenliste | – |
| IOS-ALB-02 | Album | – |
| IOS-ALB-03 | Album-Einstellungen | – |
| IOS-ALB-04 | Freigabe | – |
| IOS-ALB-05 | Fotos hochladen | – |
| IOS-FOT-01 | Vollbild | – |
| IOS-FOT-02 | Zuschnitt und Bearbeiten | – |
| IOS-FOT-03 | Collage | – |
| IOS-PER-01 | Personen und Person | – |
| IOS-RUE-01 | Rückblicke abspielen | – |
| IOS-REV-01 | Gruppen entscheiden | – |
| IOS-SUC-01 | Suchen | – |
| IOS-TRP-01 | Trip starten und beenden | – |
| IOS-PLN-01 | Reise anlegen und Aufenthalte planen | – |
| IOS-PLN-02 | Tag planen | – |
| IOS-PLN-03 | Gemeinsam planen | – |
| IOS-PLN-04 | Unterwegs | – |
| IOS-ASS-01 | Fragen stellen | – |
| IOS-ASS-02 | Assistent zu Fotos fragen | – |
| IOS-ASS-03 | Antwort als Mitteilung | – |
| IOS-ASS-04 | Vorschlag ausführen | – |
| IOS-SET-01 | Profil und Server | – |
| IOS-SET-02 | Foto-Synchronisierung | – |
| IOS-SET-03 | Benachrichtigungen und Spotlight | – |
| IOS-SET-04 | Trip & Reise, Karten-App | – |
| IOS-SET-05 | Admin und Quellen | – |
| IOS-SHR-01 | Fotos aus einer anderen App hochladen | – |
| IOS-SHR-02 | Webseite als Ort übernehmen | – |
