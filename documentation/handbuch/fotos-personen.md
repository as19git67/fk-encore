# Fotos: Personen, Gruppen-Review, Rückblicke und Fotobücher

Teil des Moduls Fotos (Rechte und Begriffe in `fotos-galerie.md`).

## Seiten

| Kürzel | Seite | Pfad | Recht |
|---|---|---|---|
| `PER` | Personen | `/fotos/personen` | `people.view` |
| `REV` | Gruppen-Review | `/fotos/review-queue` | `photos.view`; Entscheiden `photos.delete` |
| `RUE` | Rückblicke | `/fotos/rueckblicke` | `photos.view` |
| `FBL` | Fotobücher | `/fotos/fotobuecher` | `photos.view` |
| `FBD` | Fotobuch | `/fotos/fotobuecher/:id` | `photos.view` |

---

## PER: Personen (`/fotos/personen`)

Raster der erkannten Personen (Gesichts-Cluster) mit Beispielgesicht,
Name oder „Unbenannt“ und Fotozahl. Ein Klick öffnet die Person: ihre
Fotos als Raster mit Seitenleiste und Vollbild. Toolbar mit Suche, Filter
(Alle, Mit Namen, Unbenannt) und Sortierung (Foto-Anzahl, Name, Zuletzt
gesehen).

### FOT-PER-01 Person öffnen

- **Wo:** Kachel
- **Recht:** `people.view`
- **Vorbedingung:** Gesichtserkennung hat Cluster gebildet
- **Schritte:**
  1. Kachel anklicken.
- **Ergebnis:** Titel wird der Name, Raster zeigt die Fotos der Person;
  „Zurück zur Übersicht“ führt zurück.
- **Fehler und Grenzfälle:** Ohne Cluster „Keine Personen erkannt“.
- **Test:** –

### FOT-PER-02 Person umbenennen oder zusammenführen

- **Wo:** „Umbenennen“ in `#actions` der Personenseite; Stift an der
  Kachel
- **Recht:** `people.view` (Schreiben an eigenen oder schreibbaren
  Fotos)
- **Vorbedingung:** keine
- **Schritte:**
  1. Dialog „Person umbenennen“: Namen eingeben (zum Beispiel `Erika
     Muster`).
  2. Gibt es den Namen schon, warnt der Dialog und der Knopf heißt
     „Zusammenführen“; sonst „Speichern“.
- **Ergebnis:** Alle Gesichter des Clusters tragen den Namen; beim
  Zusammenführen wandern sie in die bestehende Person. Der Name steht in
  der Seitenleiste jedes Fotos und im Filter „Personen“.
- **Fehler und Grenzfälle:** „Unbenannt“ ist als Name nicht erlaubt.
- **Test:** –

### FOT-PER-03 Person ignorieren

- **Wo:** „Ignorieren“ in `#actions` („Person und alle Gesichter dauerhaft
  ignorieren“)
- **Recht:** `people.view`
- **Vorbedingung:** keine
- **Schritte:**
  1. Knopf, Dialog „Bestätigung“, „Ignorieren“.
- **Ergebnis:** Person verschwindet aus dem Raster; ihre Gesichter werden
  nicht mehr vorgeschlagen.
- **Fehler und Grenzfälle:** keine Rücknahme über die Oberfläche.
- **Test:** –

### FOT-PER-04 Einzelnes Gesicht ignorieren

- **Wo:** Papierkorb „Gesicht ignorieren“ in der Fotozeile der Person;
  Kreuz „Entfernen“ in der Seitenleiste
- **Recht:** `people.view`
- **Vorbedingung:** Foto der Person gewählt
- **Schritte:**
  1. Knopf, bestätigen.
- **Ergebnis:** Das Foto zählt nicht mehr zur Person.
- **Fehler und Grenzfälle:** keine
- **Test:** –

### FOT-PER-05 Foto der Person: Favorit, Ausblenden, Details, In Fotos anzeigen

- **Wo:** Knöpfe über dem Raster und an der Kachel (Herz, Daumen,
  „Details“, „In Fotos anzeigen“)
- **Recht:** Favorit und Ausblenden `photos.delete`, Rest `photos.view`
- **Vorbedingung:** keine
- **Schritte:**
  1. Knopf drücken.
- **Ergebnis:** Status gesetzt; „Details“ öffnet die Seitenleiste; „In
  Fotos anzeigen“ wechselt in die Galerie mit dem Foto.
- **Fehler und Grenzfälle:** keine
- **Test:** –

### FOT-PER-06 Suchen, filtern, sortieren

- **Wo:** Toolbar
- **Recht:** `people.view`
- **Vorbedingung:** keine
- **Schritte:**
  1. Namen suchen; Filter Alle/Mit Namen/Unbenannt; Sortierung.
- **Ergebnis:** Raster folgt; URL spiegelt es.
- **Fehler und Grenzfälle:** keine
- **Test:** –

---

## REV: Gruppen-Review (`/fotos/review-queue`)

Liste offener Gruppen ähnlicher Fotos, je Gruppe die Fotos mit
KI-Bewertung, der KI-Pick markiert, Δ zum zweitbesten. Filter nach
Sicherheit (Alle, Sicher, Mittel, Unsicher) und Art (Alle Gruppen,
Formatpaare). Oben der Knopf „n sichere Gruppen bestätigen“.

### FOT-REV-01 Gruppe entscheiden

- **Wo:** Knöpfe je Gruppe: „KI-Pick übernehmen“ (bei Duplikaten „Bestes
  Duplikat behalten“), „Bestes je Format behalten“, „Alle wählen“,
  „Manuell prüfen“, Klick auf ein Foto wählt es als bestes
- **Recht:** `photos.delete`
- **Vorbedingung:** offene Gruppe
- **Schritte:**
  1. Foto(s) wählen oder KI-Pick übernehmen.
- **Ergebnis:** Nicht gewählte Fotos werden ausgeblendet, die Gruppe
  verschwindet aus der Liste; „Manuell prüfen“ öffnet den Vergleich
  (`FOT-VGL-*`).
- **Fehler und Grenzfälle:** „n endgültig löschen“ gibt es nur bei
  exakten Duplikaten und fragt im Dialog „Duplikate endgültig löschen“
  nach.
- **Test:** –

### FOT-REV-02 Alle sicheren Gruppen bestätigen

- **Wo:** Knopf oben
- **Recht:** `photos.delete`
- **Vorbedingung:** Gruppen mit hoher Sicherheit
- **Schritte:**
  1. Knopf, Dialog „Alle hochkonfidenten Gruppen bestätigen?“, „Ja, alle
     bestätigen“.
- **Ergebnis:** KI-Picks aller sicheren Gruppen gelten.
- **Fehler und Grenzfälle:** keine
- **Test:** –

### FOT-REV-03 Entscheidungen anderer übernehmen

- **Wo:** Dialog „Entscheidungen anderer übernehmen?“ (erscheint, wenn
  Mitglieder desselben Albums schon entschieden haben)
- **Recht:** `photos.delete`
- **Vorbedingung:** fremde Entscheidungen vorhanden
- **Schritte:**
  1. „Übernehmen“ oder „Abbrechen“.
- **Ergebnis:** Die Gruppen gelten auch für den eigenen Blick.
- **Fehler und Grenzfälle:** Die Album-Einstellung „Reviews der anderen“
  steuert, ob gefragt wird.
- **Test:** –

### FOT-REV-04 Nicht dasselbe Motiv / Als Formatpaar / Bilder erklären

- **Wo:** Knöpfe je Gruppe
- **Recht:** `photos.delete`; „Bilder erklären“ `photos.view`
- **Vorbedingung:** keine
- **Schritte:**
  1. Drücken.
- **Ergebnis:** Gruppe aufgelöst bzw. als Formatpaar markiert; „Bilder
  erklären“ öffnet „Was die KI an den Fotos sieht“ mit der Kritik je Foto.
- **Fehler und Grenzfälle:** keine
- **Test:** –

### FOT-REV-05 Foto groß ansehen, mehr laden

- **Wo:** Lupe am Foto („Foto in voller Größe“), Knopf „Mehr laden“
- **Recht:** `photos.view`
- **Vorbedingung:** keine
- **Schritte:**
  1. Drücken.
- **Ergebnis:** Overlay mit dem Foto; nächste Gruppen hängen sich an.
- **Fehler und Grenzfälle:** keine
- **Test:** –

---

## RUE: Rückblicke (`/fotos/rueckblicke`)

Karten mit Erinnerungen (Tage, Reisen, Orte) aus Fotos mit Datum und
Ort; „Aktualisieren“ rechnet neu. Eine Karte öffnet die Detailansicht mit
den Fotos; der Player spielt sie mit Musik.

### FOT-RUE-01 Rückblick abspielen

- **Wo:** Abspiel-Knopf auf der Karte oder „Abspielen“ in der
  Detailansicht
- **Recht:** `photos.view`
- **Vorbedingung:** Rückblicke vorhanden („Noch keine Rückblicke“ sonst)
- **Schritte:**
  1. Drücken; im Player „Zurück“, „Pause“, „Weiter“, „Musik
     stummschalten“, „Andere Musik“, Favorit, „Foto aus Rückblick
     entfernen“, „Schließen“.
- **Ergebnis:** Diashow mit Karten-Intro und Musik.
- **Fehler und Grenzfälle:** Ohne Audio-Erlaubnis des Browsers startet
  die Musik stumm.
- **Test:** –

### FOT-RUE-02 Rückblick sichern oder als Video exportieren

- **Wo:** „Sichern“ und „Video“ in der Detailansicht
- **Recht:** `photos.view`
- **Vorbedingung:** keine
- **Schritte:**
  1. „Sichern“ legt den Rückblick dauerhaft an (sonst wird er beim
     nächsten Rechnen ersetzt); „Video“ rendert eine Videodatei, der
     Knopf zeigt den Fortschritt in Prozent.
- **Ergebnis:** Datei zum Herunterladen.
- **Fehler und Grenzfälle:** Der Export läuft als Job; die Seite darf
  verlassen werden.
- **Test:** –

### FOT-RUE-03 Rückblick ausblenden, Foto entfernen

- **Wo:** „Ausblenden“ in der Detailansicht; Kreuz „Foto aus Rückblick
  entfernen“
- **Recht:** `photos.view`
- **Vorbedingung:** keine
- **Schritte:**
  1. Drücken, Rückfrage „Rückblick ausblenden?“ bestätigen.
- **Ergebnis:** Rückblick erscheint nicht mehr; entfernte Fotos fehlen
  im Player.
- **Fehler und Grenzfälle:** keine
- **Test:** –

---

## FBL: Fotobücher (`/fotos/fotobuecher`)

Liste der Bücher mit Titel, Format, Seiten- und Fotozahl, Stand.

### FOT-FBL-01 Fotobuch öffnen

- **Wo:** Zeile; leerer Zustand verweist auf „Fotobuch gestalten“ in
  Galerie und Album
- **Recht:** `photos.view`
- **Vorbedingung:** Buch vorhanden
- **Schritte:**
  1. Zeile anklicken.
- **Ergebnis:** `FBD`.
- **Fehler und Grenzfälle:** keine
- **Test:** –

---

## FBD: Fotobuch (`/fotos/fotobuecher/:id`)

Titelseite, dann Kapitel mit Doppelseiten; je Seite Layout-Wahl,
Bildunterschriften an/aus, Menü je Foto („Als Titelbild“, „Aus dem Buch
nehmen“). `#actions`: „PDF“, „Diashow“, „KI“, „Buch“, „Auswahl“, im
Mehr-Menü „Neu verteilen“ und „Fotobuch löschen“. Ein Hinweis warnt,
wenn Fotos unter 200 dpi gedruckt würden.

### FOT-FBD-01 Kapitelüberschrift ändern

- **Wo:** Feld „Kapitelüberschrift“; „Übernehmen“ neben einem Vorschlag
  der KI
- **Recht:** Besitzer des Buchs
- **Vorbedingung:** keine
- **Schritte:**
  1. Text ändern (speichert beim Verlassen) oder Vorschlag übernehmen.
- **Ergebnis:** Überschrift auf der Kapitelseite; ein eigener Titel wird
  von der KI nie überschrieben.
- **Fehler und Grenzfälle:** keine
- **Test:** –

### FOT-FBD-02 Layout einer Seite wählen

- **Wo:** Auswahl „Layout von Seite n“
- **Recht:** Besitzer
- **Vorbedingung:** keine
- **Schritte:**
  1. Layout aus den Kandidaten wählen.
- **Ergebnis:** Seite baut sich neu; ein Funkel-Symbol nennt, wenn die KI
  das Layout gewählt hat, mit Grund.
- **Fehler und Grenzfälle:** Angeboten werden nur Layouts, die zu den
  Fotos der Seite passen.
- **Test:** –

### FOT-FBD-03 Bildunterschriften

- **Wo:** Umschalter „Bildunterschriften auf Seite n zeigen/ausblenden“;
  Klick auf eine Unterschrift öffnet „Bildunterschrift“
- **Recht:** Besitzer
- **Vorbedingung:** keine
- **Schritte:**
  1. Text ändern, „Speichern“.
- **Ergebnis:** Eigene Unterschrift ersetzt die der KI dauerhaft.
- **Fehler und Grenzfälle:** keine
- **Test:** –

### FOT-FBD-04 Foto als Titelbild oder aus dem Buch nehmen

- **Wo:** Menü am Foto
- **Recht:** Besitzer
- **Vorbedingung:** keine
- **Schritte:**
  1. Eintrag wählen.
- **Ergebnis:** Titelseite zeigt das Foto bzw. die Seite füllt sich neu.
- **Fehler und Grenzfälle:** keine
- **Test:** –

### FOT-FBD-05 Titel und Format

- **Wo:** „Buch“ → Dialog „Titel und Format“
- **Recht:** Besitzer
- **Vorbedingung:** keine
- **Schritte:**
  1. Titel, Untertitel, Format, Bildunterschriften global; „Speichern“.
- **Ergebnis:** Titelseite und Seitenmaße ändern sich; ein Formatwechsel
  fragt „Neu verteilen?“.
- **Fehler und Grenzfälle:** Titel ist Pflicht.
- **Test:** –

### FOT-FBD-06 Auswahl ändern

- **Wo:** „Auswahl“ → Dialog „Auswahl ändern“
- **Recht:** Besitzer
- **Vorbedingung:** keine
- **Schritte:**
  1. Mindestqualität, Mindestwert Ästhetik, ohne erkennbare Gesichter,
     Höchstzahl, Gewichtung (Personen, Landschaft, Natur, Bauwerke:
     Weniger/Normal/Mehr); „Übernehmen und neu verteilen“.
- **Ergebnis:** Fotos werden neu gewählt und auf Seiten verteilt; eigene
  Unterschriften und Titel bleiben.
- **Fehler und Grenzfälle:** keine
- **Test:** –

### FOT-FBD-07 Vorschläge der KI

- **Wo:** „KI“ → Dialog „Vorschläge der KI“
- **Recht:** Besitzer
- **Vorbedingung:** llm-service
- **Schritte:**
  1. Aufgaben anhaken (Kapitelüberschriften, Bildunterschriften,
     Layouts), „Vorschläge holen“.
- **Ergebnis:** Vorschläge erscheinen neben den Kapiteln und als
  Unterschriften; „Wie oft du Layouts geändert hast“ zeigt die Statistik.
- **Fehler und Grenzfälle:** Läuft als Job; der Dialog zeigt den Stand.
- **Test:** –

### FOT-FBD-08 Als PDF ausgeben

- **Wo:** „PDF“ → Dialog „Als PDF ausgeben“
- **Recht:** `photos.view`
- **Vorbedingung:** keine
- **Schritte:**
  1. Variante wählen (Druckerei mit Umschlag, Beschnitt und Schnittmarken
     oder Selbstdruck), „PDF erstellen“.
- **Ergebnis:** Download-Link, sobald der Export fertig ist.
- **Fehler und Grenzfälle:** keine
- **Test:** –

### FOT-FBD-09 Diashow

- **Wo:** „Diashow“
- **Recht:** `photos.view`
- **Vorbedingung:** Seiten vorhanden
- **Schritte:**
  1. Drücken.
- **Ergebnis:** Player wie bei Rückblicken spielt das Buch Seite für
  Seite.
- **Fehler und Grenzfälle:** keine
- **Test:** –

### FOT-FBD-10 Neu verteilen und löschen

- **Wo:** Mehr-Menü „Neu verteilen“, „Fotobuch löschen“
- **Recht:** Besitzer
- **Vorbedingung:** keine
- **Schritte:**
  1. Rückfrage bestätigen.
- **Ergebnis:** Seiten neu gebaut bzw. Buch gelöscht, zurück zu `FBL`.
- **Fehler und Grenzfälle:** keine
- **Test:** –

---

## Abdeckung

| ID | Aktion | Recht | Test |
|---|---|---|---|
| FOT-PER-01 | Person öffnen | people.view | – |
| FOT-PER-02 | Person umbenennen oder zusammenführen | people.view | – |
| FOT-PER-03 | Person ignorieren | people.view | – |
| FOT-PER-04 | Einzelnes Gesicht ignorieren | people.view | – |
| FOT-PER-05 | Favorit, Ausblenden, Details, In Fotos anzeigen | delete / view | – |
| FOT-PER-06 | Suchen, filtern, sortieren | people.view | – |
| FOT-REV-01 | Gruppe entscheiden | delete | – |
| FOT-REV-02 | Alle sicheren Gruppen bestätigen | delete | – |
| FOT-REV-03 | Entscheidungen anderer übernehmen | delete | – |
| FOT-REV-04 | Nicht dasselbe Motiv / Formatpaar / Bilder erklären | delete | – |
| FOT-REV-05 | Foto groß ansehen, mehr laden | view | – |
| FOT-RUE-01 | Rückblick abspielen | view | – |
| FOT-RUE-02 | Sichern oder Video | view | – |
| FOT-RUE-03 | Ausblenden, Foto entfernen | view | – |
| FOT-FBL-01 | Fotobuch öffnen | view | – |
| FOT-FBD-01 | Kapitelüberschrift ändern | Besitzer | – |
| FOT-FBD-02 | Layout einer Seite wählen | Besitzer | – |
| FOT-FBD-03 | Bildunterschriften | Besitzer | – |
| FOT-FBD-04 | Titelbild / aus dem Buch nehmen | Besitzer | – |
| FOT-FBD-05 | Titel und Format | Besitzer | – |
| FOT-FBD-06 | Auswahl ändern | Besitzer | – |
| FOT-FBD-07 | Vorschläge der KI | Besitzer | – |
| FOT-FBD-08 | Als PDF ausgeben | view | – |
| FOT-FBD-09 | Diashow | view | – |
| FOT-FBD-10 | Neu verteilen und löschen | Besitzer | – |
