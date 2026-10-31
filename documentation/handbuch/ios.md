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
| `PLN` | Reiseplaner | Neue Reise, Städte, Kandidaten, Tagesablauf, Karte, Ideen, Wünsche, Reisegruppe, Planen mit, Dokumente, Reisebereit?, Danach, Unterwegs ohne Netz, … |
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
  antippen öffnet das Vollbild; oben der Streifen „Rückblicke“ mit
  „Rückblick … abspielen“.
- Leer: „Kein Feed“.
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

Bildschirme (je Titel ein Bildschirm): Neue Reise, Reise, Städte
(Etappen mit „Anreise einfügen“, „Weiterreise einfügen“, „Heimreise
einfügen“), Kandidaten (Pool mit Einplanen, Für später merken,
Ausblenden, Ausgeblendet), Tagesablauf (Blöcke, feste Zeiten, Fotostopp,
Abendlicht, Wetter, „Ab hier umplanen“, „Umräumen“, „Gruppe trennen“ /
„Wieder zusammen“), Tagesausflug, Ausflug, Karte, Strecken (anlegen,
auf der Karte, in der Nähe, Als GPX exportieren), Reisezeiten prüfen,
Fortbewegung, Ideen (In der Nähe, Ausflug, Essen in der Nähe, Artikel
lesen und auslesen, Artikel-Sprachen, „In eine Reise übernehmen“, „Wer
schreibt mit“), Wünsche (Abstimmung), Reisegruppe und Mobilität,
Jemanden eintragen, Planen mit (Teilnehmer, „Rolle übergeben“, „Reise
verlassen“), Dokumente, Reisebereit?, Unterwegs ohne Netz („Plan fürs
Gerät laden“, „Vom Gerät löschen“), Änderungen (Journal), Danach
(Rückblick „Ja, waren wir“), Einstellungen der Reise, Karten-App (Apple
Karten / Google Maps), Ort suchen, Ort bearbeiten, Gefunden / Fund
übernehmen (aus der Share-Extension).

### IOS-PLN-01 Reise anlegen und Etappen planen

- „Neue Reise“ → „Reise anlegen“; Städte als Etappen; Kandidaten je
  Etappe aus Ideen, Suche („Ort suchen“, „Hier, wo ich bin“) und
  Entdecken („Gegend wählen“, „Andere Gegend…“).
- **Test:** –

### IOS-PLN-02 Tag planen

- Spots einplanen, in einen anderen Block schieben, feste Zeit setzen,
  Fotostopp markieren, Abendlicht nutzen, Wetter prüfen, Route in der
  Karten-App öffnen („Ganzen Block in Karten öffnen“, „Route hierher“),
  „Erledigt“ unterwegs, „Zurück zu den Kandidaten“.
- Dieselben Aktionen in Liste, Detail („Alle Details“), Pin-Sheet und
  Karte.
- **Test:** –

### IOS-PLN-03 Gemeinsam planen

- Teilnehmer einladen („Planen mit“), Wünsche abstimmen („Wünsche“),
  Ideen teilen („Wer schreibt mit“), Rolle übergeben, Reise verlassen.
- **Test:** –

### IOS-PLN-04 Unterwegs

- Plan offline laden, Dokumente der Reise, Reisebereit?-Checkliste,
  Strecken als GPX, nach der Reise „Danach“.
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
  Quellen & Lizenzen (OpenStreetMap, Wikipedia, Wikimedia Commons).
- **Test:** –

---

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
| IOS-PLN-01 | Reise anlegen und Etappen planen | – |
| IOS-PLN-02 | Tag planen | – |
| IOS-PLN-03 | Gemeinsam planen | – |
| IOS-PLN-04 | Unterwegs | – |
| IOS-SET-01 | Profil und Server | – |
| IOS-SET-02 | Foto-Synchronisierung | – |
| IOS-SET-03 | Benachrichtigungen und Spotlight | – |
| IOS-SET-04 | Trip & Reise, Karten-App | – |
| IOS-SET-05 | Admin und Quellen | – |
| IOS-SHR-01 | Fotos aus einer anderen App hochladen | – |
| IOS-SHR-02 | Webseite als Ort übernehmen | – |
