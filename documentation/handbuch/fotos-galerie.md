# Fotos: Feed, Galerie, Vollbild und Bearbeitung

Das Modul Fotos verwaltet die Fotosammlung: Import aus Upload und externen
Bibliotheken, Galerie mit Filter und Suche, Vollbild mit Diashow,
Detail-Seitenleiste (Ort, Personen, Tags, Text im Bild, Reaktionen,
Kommentare, Bildwirkung), Vergleich ähnlicher Fotos, Schnitt- und
Belichtungseditor, Alben mit Freigaben, Personen, Rückblicke, Fotobücher
und ein Gruppen-Review für Serien. Diese Datei deckt Feed, Galerie,
Vollbild, Seitenleiste, Vergleich, Editor und Aktivität ab; die übrigen
Seiten stehen in `fotos-alben.md`, `fotos-personen.md` und
`fotos-einstellungen.md`.

**Modulrecht:** `module.photos` schaltet den Menüpunkt „Fotos“ frei.
Darunter gelten:

| Schlüssel | erlaubt |
|---|---|
| `photos.view` | Fotos sehen, Vollbild, Diashow, Suche, Reaktionen und Kommentare |
| `photos.upload` | Fotos hochladen, Beschreibung und Aufnahmedatum ändern, Alben zuweisen, Editor speichern |
| `photos.delete` | Fotos löschen, Favorit und Ausblenden setzen, Link-Sichtbarkeit, Gruppen-Review |
| `albums.manage` | Alben anlegen |
| `people.view` | Seite Personen und Personen-Abschnitt der Seitenleiste |
| `photos.libraries.manage` | externe Bibliotheken |
| `osm.admin` | OSM-Regionen |
| `photos.purge` | Gefahrenzone |
| `data.manage` | Scan-Queue, Wartung, Ästhetik |

Wer ein Foto sieht, bestimmt der Server je Foto (`accessiblePhotoCondition`,
Plan `foto-freigabe.md`): eigene Uploads, Fotos aus Alben, die mit einem
geteilt sind, und Fotos der Bibliotheken, die man sehen darf.

**Begriffe:**

- **Kuratierung** ist der Status eines Fotos je Nutzer: normal, Favorit
  oder ausgeblendet. Ausgeblendete Fotos verschwinden aus Galerie, Alben
  und Rückblicken, bleiben aber erhalten („Ausgeblendet: Mit/Ohne/Nur“ im
  Filter).
- **Gruppe** ist eine Serie ähnlicher Fotos (gleiches Motiv in kurzer
  Folge), für die die KI ein bestes Foto vorschlägt („KI-Pick“). Das
  Gruppen-Review bestätigt oder ändert das.
- **Formatpaar** sind Hoch- und Querformat desselben Motivs; jede Ansicht
  zeigt die Seite, die zur Ausrichtung des Bildschirms passt (Taste R
  wechselt).
- **Link-Sichtbarkeit** sagt, ob ein Foto über einen öffentlichen
  Album-Link zu sehen ist: sichtbar, ausgenommen oder automatisch (die
  Regel blendet Fotos mit unbekannten Gesichtern aus).
- **Text im Bild** ist der OCR-Text eines Fotos; er lässt sich im Vollbild
  markieren und kopieren.

## Seiten

| Kürzel | Seite | Pfad | Recht |
|---|---|---|---|
| `STR` | Feed (Startseite des Moduls) | `/fotos/stream` | `photos.view` |
| `GAL` | Galerie | `/fotos/galerie` | `photos.view` |
| `VOL` | Vollbild (Overlay über Galerie, Album, Personen, Feed) | `?photoId=<id>` | `photos.view` |
| `DET` | Detail-Seitenleiste (neben dem Raster oder als Sheet) | – | `photos.view` |
| `VGL` | Fotos vergleichen (Overlay) | – | `photos.view` |
| `EDT` | Schnitt und Belichtung (Vollbild-Editor) | – | `photos.upload` |
| `AKT` | Aktivität | `/fotos/feed` | `photos.view` |

Das Untermenü zeigt „Feed“, „Galerie“, „Alben“, „Aktivität“, „Rückblicke“,
„Fotobücher“, „Personen“, „Gruppen-Review“ und „Einstellungen“. `/fotos`
leitet auf den Feed um.

---

## STR: Feed (`/fotos/stream`)

Chronologische Karten der neuesten Fotos aller sichtbaren Uploads, je
Karte Bild, Uploader, Datum, Beschreibung, Gefällt-mir, Kommentare. Oben
„Hochladen“ und, sobald neue Fotos eingetroffen sind, der Knopf „Neue
Aktivität“.

### FOT-STR-01 Neue Aktivität laden

- **Wo:** Knopf „Neue Aktivität“ über den Karten
- **Recht:** `photos.view`
- **Vorbedingung:** seit dem Laden sind neue Fotos eingetroffen
- **Schritte:**
  1. Knopf drücken.
- **Ergebnis:** Neue Karten stehen oben, der Knopf verschwindet.
- **Fehler und Grenzfälle:** keine
- **Test:** –

### FOT-STR-02 Hochladen aus dem Feed

- **Wo:** Knopf „Hochladen“
- **Recht:** `photos.upload`
- **Vorbedingung:** keine
- **Schritte:**
  1. Knopf drücken, Dateien wählen (mehrere erlaubt).
  2. Dialog „In welche Alben aufnehmen?“: Alben suchen und anhaken, dann
     „Hochladen“.
- **Ergebnis:** Der Knopf heißt „Lädt…“, danach erscheinen die Fotos als
  Karten und in den gewählten Alben; der Scan (Metadaten, Gesichter,
  Einbettung) läuft im Hintergrund.
- **Fehler und Grenzfälle:** Ein schon vorhandenes Foto (gleicher
  Inhalt) wird übersprungen und gemeldet.
- **Test:** –

### FOT-STR-03 Gefällt mir

- **Wo:** Herz an der Karte
- **Recht:** `photos.view`
- **Vorbedingung:** keine
- **Schritte:**
  1. Herz drücken; nochmal nimmt es zurück.
- **Ergebnis:** Zähler ändert sich; der Uploader sieht es unter
  Aktivität.
- **Fehler und Grenzfälle:** keine
- **Test:** –

### FOT-STR-04 Kommentieren

- **Wo:** Sprechblase „Kommentare“ an der Karte; Feld „Kommentieren…“ und
  „Senden“
- **Recht:** `photos.view`
- **Vorbedingung:** keine
- **Schritte:**
  1. Sprechblase öffnet den Kommentarstrang.
  2. Text eingeben, „Senden“ (oder Enter).
  3. Eigene Kommentare haben ein Menü „Aktionen“ mit Bearbeiten und
     Löschen; „n ältere anzeigen“ klappt den Strang auf.
- **Ergebnis:** Kommentar steht im Strang, Zähler auf der Karte und auf
  der Kachel in der Galerie steigen.
- **Fehler und Grenzfälle:** Leerer Text wird nicht gesendet.
- **Test:** –

### FOT-STR-05 Beschreibung an der Karte

- **Wo:** Knopf „Beschreibung hinzufügen“ bzw. „Beschreibung bearbeiten“
- **Recht:** `photos.upload` (eigene Fotos)
- **Vorbedingung:** keine
- **Schritte:**
  1. Knopf drücken, Text im Feld „Beschreibung…“, Haken speichert, Kreuz
     bricht ab.
- **Ergebnis:** Beschreibung steht auf der Karte und in der Seitenleiste.
- **Fehler und Grenzfälle:** keine
- **Test:** –

### FOT-STR-06 Ausblenden

- **Wo:** Knopf „Ausblenden“ / „Ausblenden aufheben“
- **Recht:** `photos.delete`
- **Vorbedingung:** keine
- **Schritte:**
  1. Knopf drücken.
- **Ergebnis:** Foto bekommt den Status ausgeblendet (siehe Begriffe).
- **Fehler und Grenzfälle:** keine
- **Test:** –

### FOT-STR-07 Vollbild und „Öffnen in…“

- **Wo:** Bild der Karte („Foto im Vollbild öffnen“); Menü „Öffnen in…“
- **Recht:** `photos.view`
- **Vorbedingung:** keine
- **Schritte:**
  1. Bild anklicken: Vollbild `VOL` über dem Feed.
  2. „Öffnen in…“: Galerie oder eines der Alben, in denen das Foto liegt.
- **Ergebnis:** Zielseite mit dem Foto im Blick.
- **Fehler und Grenzfälle:** keine
- **Test:** –

---

## GAL: Galerie (`/fotos/galerie`)

Virtuelles Raster aller sichtbaren Fotos nach Aufnahmedatum; die
Toolbar hat Suche in natürlicher Sprache, Filter, Sortierung, Ansicht,
Ergebniszahl und „Auswählen“. Rechts (ab `lg`) die Detail-Seitenleiste des
Fotos unter dem Cursor, darunter als Sheet. Kacheln zeigen Badges für
Gruppe, Formatpaar, Kommentare und Link-Sichtbarkeit. Das Raster scrollt
in seinem eigenen Kasten; „Zum ältesten“ / „Zum neuesten“ springt ans
Ende.

### FOT-GAL-01 Suchen in natürlicher Sprache

- **Wo:** Suchfeld (Platzhalter „z.B. „Kirchen in München von 2004 bis
  2017““), Knopf „Suchen“, `/` fokussiert
- **Recht:** `photos.view`
- **Vorbedingung:** Einbettungsdienst läuft
- **Schritte:**
  1. Frage eingeben, Enter oder „Suchen“.
- **Ergebnis:** Raster zeigt die Treffer nach Ähnlichkeit; `q` in der
  URL; die Ergebniszahl nennt die Trefferzahl. Zeit- und Ortsangaben im
  Text werden als Filter herausgelöst und als Chips gezeigt.
- **Fehler und Grenzfälle:** Escape leert das Feld. Ohne Dienst steht
  ein Hinweis im `#notice`.
- **Test:** –

### FOT-GAL-02 Filtern

- **Wo:** Knopf „Filter“ öffnet den Dialog „Filter“
- **Recht:** `photos.view`
- **Vorbedingung:** keine
- **Schritte:**
  1. Felder setzen: Ausgeblendet (Ohne, Mit, Nur), Favoriten, Gruppen
     (Einschließen, Ausschließen), Sammelmappe, Alben, Personen,
     Hochgeladen von, Medientyp (Foto, Video, RAW), GPS-Daten (Egal, Ja,
     Nein), In der Nähe (Ort suchen, „Punkt auf Karte setzen“, „Ort des
     ausgewählten Fotos verwenden“, „Aktuellen Standort verwenden“,
     Radius), Gesichter erkannt, Person zugeordnet, Aufnahmedatum (von,
     bis), Kürzlich importiert (Tage).
  2. „Anwenden“; „Zurücksetzen“ leert alles.
- **Ergebnis:** Raster folgt; jeder Filter ist ein Chip und steht in der
  URL; der Zähler am Filter-Knopf entspricht der Chip-Zahl.
- **Fehler und Grenzfälle:** „Aktuellen Standort verwenden“ braucht die
  Standortfreigabe des Browsers; verweigert, bleibt der Filter leer mit
  Hinweis.
- **Test:** –

### FOT-GAL-03 Sortieren

- **Wo:** Sortiermenü
- **Recht:** `photos.view`
- **Vorbedingung:** keine
- **Schritte:**
  1. Aufnahmedatum, Importdatum, Qualität, Ästhetik, Dateiname oder
     Dateigröße und Richtung wählen.
- **Ergebnis:** Raster sortiert neu; `sortBy`/`sortDir` in der URL.
- **Fehler und Grenzfälle:** keine
- **Test:** –

### FOT-GAL-04 Zum ältesten / Zum neuesten

- **Wo:** Knopf mit Doppelpfeil in `#actions`
- **Recht:** `photos.view`
- **Vorbedingung:** mehr Fotos als ein Bildschirm
- **Schritte:**
  1. Knopf drücken.
- **Ergebnis:** Raster springt ans andere Ende, der Knopf dreht sich um.
- **Fehler und Grenzfälle:** keine
- **Test:** –

### FOT-GAL-05 Foto im Vollbild öffnen

- **Wo:** Kachel (Klick oder Enter)
- **Recht:** `photos.view`
- **Vorbedingung:** keine
- **Schritte:**
  1. Kachel anklicken.
- **Ergebnis:** `VOL` öffnet sich; `photoId` steht in der URL, Zurück
  schließt das Vollbild und landet auf der Kachel.
- **Fehler und Grenzfälle:** keine
- **Test:** –

### FOT-GAL-06 Foto mit der Tastatur wählen

- **Wo:** Raster
- **Recht:** `photos.view`
- **Vorbedingung:** keine
- **Schritte:**
  1. Pfeiltasten bewegen den Cursor; die Seitenleiste zeigt das Foto
     unter dem Cursor.
- **Ergebnis:** Fokusring auf der Kachel, Seitenleiste folgt; Enter
  öffnet das Vollbild.
- **Fehler und Grenzfälle:** keine
- **Test:** `gallery.spec.ts` („Pfeiltasten bewegen Cursor, Enter öffnet
  Vollbild“)

### FOT-GAL-07 Hochladen

- **Wo:** Upload-Knopf „Fotos hochladen“ in `#actions`; Drag-and-drop auf
  das Raster
- **Recht:** `photos.upload`
- **Vorbedingung:** keine
- **Schritte:**
  1. Knopf drücken, Dateien wählen; während des Uploads heißt der Knopf
     „Abbrechen“.
- **Ergebnis:** Fotos erscheinen im Raster, Scan im Hintergrund.
- **Fehler und Grenzfälle:** „Abbrechen“ stoppt den Rest; schon
  hochgeladene bleiben. Duplikate werden übersprungen und gemeldet.
- **Test:** –

### FOT-GAL-08 Auswahlmodus

- **Wo:** „Auswählen“ in der Toolbar; Checkbox je Kachel
- **Recht:** `photos.view`
- **Vorbedingung:** keine
- **Schritte:**
  1. Modus starten, Kacheln anhaken; Umschalt+Klick Bereich, Strg/Cmd+A
     alles; Escape beendet.
- **Ergebnis:** `SelectionBar` mit Zähler und den Aktionen aus
  `FOT-GAL-09` bis `FOT-GAL-17`; die Seitenleiste zeigt „n Fotos
  ausgewählt“ mit den gemeinsamen Alben.
- **Fehler und Grenzfälle:** Die Auswahl ist unabhängig vom Basket.
- **Test:** `gallery.spec.ts` („Shift-Klick selektiert ersten und dritten
  Eintrag“, „Strg-/Cmd-Klick toggelt einzelne Auswahl“)

### FOT-GAL-09 Fotos teilen

- **Wo:** „Foto teilen“ / „Fotos teilen“ in der `SelectionBar`
- **Recht:** `photos.view`
- **Vorbedingung:** Auswahl
- **Schritte:**
  1. Aktion drücken.
- **Ergebnis:** Teilen-Menü des Geräts mit den Bilddateien; ohne
  Teilen-Menü ein Download.
- **Fehler und Grenzfälle:** Sehr viele Fotos dauern; der Knopf ist
  solange gesperrt.
- **Test:** –

### FOT-GAL-10 Collage erstellen

- **Wo:** „Collage erstellen“ (ab zwei und bis zu einer festen Höchstzahl
  Fotos)
- **Recht:** `photos.view`
- **Vorbedingung:** passende Anzahl
- **Schritte:**
  1. Dialog: Layout wählen, optional „Text“ mit „Text über die Collage …“,
     Schriftgröße, Ausrichtung, Farbe; „Fertig“, dann „Speichern“ oder
     „Teilen“.
- **Ergebnis:** Collage als Bilddatei; „Speichern“ legt sie als neues Foto
  ab.
- **Fehler und Grenzfälle:** „Zurück“ wechselt zwischen Layout und Text.
- **Test:** –

### FOT-GAL-11 Fotobuch gestalten

- **Wo:** „Fotobuch gestalten“
- **Recht:** `photos.view`
- **Vorbedingung:** Auswahl
- **Schritte:**
  1. Dialog „Fotobuch gestalten“: Titel, Format, Eingrenzung (Qualität,
     Ästhetik, ohne erkennbare Gesichter, Höchstzahl, Gewichtung); „Gestalten“.
- **Ergebnis:** Neues Buch, Seite des Buchs öffnet sich
  (`fotos-personen.md`, FBD).
- **Fehler und Grenzfälle:** Titel ist Pflicht.
- **Test:** –

### FOT-GAL-12 An den Assistenten

- **Wo:** „An den Assistenten“ (bis zu einer festen Höchstzahl Fotos)
- **Recht:** `module.assistant`
- **Vorbedingung:** Auswahl
- **Schritte:**
  1. Aktion drücken.
- **Ergebnis:** Seite des Assistenten mit den Fotos als Arbeitskontext.
- **Fehler und Grenzfälle:** keine
- **Test:** –

### FOT-GAL-13 Ablegen

- **Wo:** „Ablegen“
- **Recht:** `photos.view`
- **Vorbedingung:** Auswahl
- **Schritte:**
  1. Ziel wählen (Basket, Sammelmappe, neue Mappe).
- **Ergebnis:** siehe `sammelmappen.md`.
- **Fehler und Grenzfälle:** keine
- **Test:** –

### FOT-GAL-14 Zu Alben hinzufügen

- **Wo:** „Zu Alben hinzufügen“; auch „Alben bearbeiten“ in der
  Seitenleiste
- **Recht:** `photos.upload`
- **Vorbedingung:** Auswahl
- **Schritte:**
  1. Dialog „Alben zuweisen“: Alben anhaken oder abhaken (teilweise
     zugewiesene sind halb markiert), „Neues Album“ mit „Albumname…“
     legt eines an.
  2. Bestätigen.
- **Ergebnis:** Fotos liegen in den Alben; Album-Chips in der
  Seitenleiste.
- **Fehler und Grenzfälle:** Alben, die man nur lesen darf, fehlen in der
  Liste.
- **Test:** –

### FOT-GAL-15 Beschreibung im Stapel

- **Wo:** „Beschreibung bearbeiten“
- **Recht:** `photos.upload`
- **Vorbedingung:** Auswahl
- **Schritte:**
  1. Dialog „Beschreibung bearbeiten“: Text eingeben, „Übernehmen“.
- **Ergebnis:** Alle gewählten Fotos tragen den Text.
- **Fehler und Grenzfälle:** Ein leerer Text löscht die Beschreibungen
  nach Rückfrage.
- **Test:** –

### FOT-GAL-16 Favorit, Ausblenden, Link-Sichtbarkeit im Stapel

- **Wo:** „Als Favorit markieren“, „Ausblenden“, „Über Freigabe-Links
  freigeben“, „Von Freigabe-Links ausnehmen“, „Link-Sichtbarkeit
  automatisch“, „Alle Fotos mit bekannten Gesichtern freigeben“
- **Recht:** `photos.delete`
- **Vorbedingung:** Auswahl
- **Schritte:**
  1. Aktion drücken.
- **Ergebnis:** Status gesetzt; ausgeblendete Fotos verschwinden aus dem
  Raster (sofern der Filter sie nicht zeigt); das Link-Badge auf der
  Kachel wechselt.
- **Fehler und Grenzfälle:** „Alle Fotos mit bekannten Gesichtern
  freigeben“ wirkt auf die ganze Sammlung, nicht nur die Auswahl, und
  fragt nach.
- **Test:** –

### FOT-GAL-17 Ausgewählte Fotos löschen

- **Wo:** „Ausgewählte Fotos löschen“ (rot)
- **Recht:** `photos.delete`
- **Vorbedingung:** Auswahl
- **Schritte:**
  1. Aktion drücken; Dialog „Fotos löschen“ nennt die Zahl; bestätigen.
- **Ergebnis:** Fotos sind gelöscht (Datei und Datensatz); Raster rückt
  nach.
- **Fehler und Grenzfälle:** Fotos aus einer verlinkten externen
  Bibliothek oder fremde Fotos werden übersprungen; der Dialog „Einige
  Fotos wurden übersprungen“ nennt den Grund je Foto.
- **Test:** –

### FOT-GAL-18 Als Regel-Mappe speichern

- **Wo:** Knopf „Als Regel-Mappe“ in `#actions` (nur mit aktivem Filter,
  nicht im Auswahlmodus, nicht wenn der Filter selbst eine Mappe ist)
- **Recht:** `photos.view`
- **Vorbedingung:** mindestens ein Filter
- **Schritte:**
  1. Dialog: Name, „Speichern“, „Mappe öffnen“.
- **Ergebnis:** Regel-Mappe mit dem Filter als Regel.
- **Fehler und Grenzfälle:** keine
- **Test:** –

### FOT-GAL-19 Gruppen bearbeiten

- **Wo:** grüner Knopf „Gruppen bearbeiten (n offen)“ in `#actions`
- **Recht:** `photos.delete`
- **Vorbedingung:** offene Gruppen im aktuellen Filter
- **Schritte:**
  1. Knopf drücken.
- **Ergebnis:** Vergleich `VGL` startet mit der ersten offenen Gruppe;
  danach die nächste, bis keine mehr offen ist.
- **Fehler und Grenzfälle:** Ohne offene Gruppen fehlt der Knopf; die
  Seite Gruppen-Review (`fotos-personen.md`) ist der Weg über die Liste.
- **Test:** –

### FOT-GAL-20 Antwort des Assistenten anzeigen

- **Wo:** Chip „Antwort des Assistenten: n Fotos“ (über `?ids=` aus dem
  Assistenten)
- **Recht:** `photos.view`
- **Vorbedingung:** Einstieg aus einer Antwort des Assistenten
- **Schritte:**
  1. Chip entfernen zeigt wieder alle Fotos.
- **Ergebnis:** Raster zeigt nur die genannten Fotos.
- **Fehler und Grenzfälle:** keine
- **Test:** –

---

## VOL: Vollbild

Overlay mit dem Foto, Pfeilen „Vorheriges/Nächstes Foto“, einer
Werkzeugleiste und Wischgesten. Pfeiltasten blättern, Escape schließt.
Die Leiste zeigt nur, was der Nutzer darf.

### FOT-VOL-01 Blättern und schließen

- **Wo:** Pfeile, Wischen, Tasten ← →, Escape, Knopf „Vollbild schließen“
- **Recht:** `photos.view`
- **Vorbedingung:** keine
- **Schritte:**
  1. Blättern; Escape.
- **Ergebnis:** `photoId` in der URL folgt; Schließen landet auf der
  Kachel.
- **Fehler und Grenzfälle:** Am Ende der Liste lädt das Raster nach.
- **Test:** –

### FOT-VOL-02 Details ein- und ausblenden (I)

- **Wo:** Knopf „Details“ / Taste I
- **Recht:** `photos.view`
- **Vorbedingung:** keine
- **Schritte:**
  1. Drücken.
- **Ergebnis:** Seitenleiste `DET` neben dem Bild oder als Sheet.
- **Fehler und Grenzfälle:** keine
- **Test:** –

### FOT-VOL-03 Favorit (F) und Ausblenden (X)

- **Wo:** Herz / Daumen; Tasten F und X
- **Recht:** `photos.delete`
- **Vorbedingung:** keine
- **Schritte:**
  1. Drücken; nochmal nimmt es zurück („Favorit entfernen“,
     „Wiederherstellen“).
- **Ergebnis:** Status gesetzt; der Daumen blendet das Foto beim
  Weiterblättern aus dem Raster.
- **Fehler und Grenzfälle:** keine
- **Test:** –

### FOT-VOL-04 Link-Sichtbarkeit (L)

- **Wo:** Ketten-Knopf, Taste L
- **Recht:** `photos.delete`
- **Vorbedingung:** keine
- **Schritte:**
  1. Drücken wechselt sichtbar → ausgenommen → automatisch.
- **Ergebnis:** Tooltip nennt den Stand; Badge auf der Kachel.
- **Fehler und Grenzfälle:** keine
- **Test:** –

### FOT-VOL-05 Formatpaar wechseln (R)

- **Wo:** Knopf mit Hoch/Quer-Symbol, Taste R
- **Recht:** `photos.view`
- **Vorbedingung:** Foto hat eine Orientierungs-Variante
- **Schritte:**
  1. Drücken.
- **Ergebnis:** Die andere Seite des Paars; Badge zeigt, welche.
- **Fehler und Grenzfälle:** Ohne Variante fehlt der Knopf.
- **Test:** –

### FOT-VOL-06 Foto teilen und Link teilen

- **Wo:** „Foto teilen“ (Datei), „Link teilen“ (URL)
- **Recht:** `photos.view`
- **Vorbedingung:** keine
- **Schritte:**
  1. Drücken.
- **Ergebnis:** Teilen-Menü bzw. „Link kopiert“.
- **Fehler und Grenzfälle:** keine
- **Test:** –

### FOT-VOL-07 Text im Bild auswählen (T) und kopieren

- **Wo:** Knopf „Text im Bild auswählen“, Taste T; „Gesamten Text
  kopieren“
- **Recht:** `photos.view`
- **Vorbedingung:** OCR hat Text gefunden
- **Schritte:**
  1. Textmodus einschalten, Wörter mit der Maus markieren und kopieren,
     oder „Gesamten Text kopieren“.
- **Ergebnis:** Text in der Zwischenablage („Kopiert“).
- **Fehler und Grenzfälle:** Ohne OCR-Text fehlt der Knopf.
- **Test:** –

### FOT-VOL-08 Schnitt und Belichtung bearbeiten

- **Wo:** Knopf „Schnitt & Belichtung bearbeiten“
- **Recht:** `photos.upload`
- **Vorbedingung:** keine
- **Schritte:**
  1. Drücken.
- **Ergebnis:** Editor `EDT`.
- **Fehler und Grenzfälle:** keine
- **Test:** –

### FOT-VOL-09 Diashow (S) und Intervall

- **Wo:** „Diashow starten/pausieren“, Taste S; Auswahl
  „Diashow-Intervall“
- **Recht:** `photos.view`
- **Vorbedingung:** keine
- **Schritte:**
  1. Intervall wählen (5 s und mehr), Diashow starten.
- **Ergebnis:** Fotos wechseln im Takt; S pausiert.
- **Fehler und Grenzfälle:** Am Ende stoppt die Diashow.
- **Test:** –

### FOT-VOL-10 Echtes Vollbild

- **Wo:** Knopf „Vollbild“ / „Vollbild beenden (ESC)“
- **Recht:** `photos.view`
- **Vorbedingung:** Browser erlaubt Fullscreen
- **Schritte:**
  1. Drücken.
- **Ergebnis:** Browser-Vollbild; Escape beendet erst das Vollbild, dann
  das Overlay.
- **Fehler und Grenzfälle:** Auf iOS fehlt der Knopf.
- **Test:** –

### FOT-VOL-11 Titelbild setzen (C)

- **Wo:** Taste C bzw. Knopf, nur im Album
- **Recht:** Schreibrecht am Album
- **Vorbedingung:** Vollbild aus einem Album
- **Schritte:**
  1. Drücken.
- **Ergebnis:** Foto ist Titelbild des Albums.
- **Fehler und Grenzfälle:** keine
- **Test:** –

---

## DET: Detail-Seitenleiste

Abschnitte: Vorschau (Klick öffnet Vollbild), „Ablegen“, Beschreibung,
Aufnahmedatum, Ort mit Minikarte, Sehenswürdigkeiten (POI) mit Entfernung
und Trefferwert, Text im Bild, Tags, Personen, Alben, Meinungen (Kuratierung
der anderen), Bildwirkung, Reaktionen, Kommentare, Dateiinformationen.

### FOT-DET-01 Beschreibung bearbeiten

- **Wo:** Stift „Beschreibung bearbeiten“ / „Beschreibung hinzufügen“
- **Recht:** `photos.upload`
- **Vorbedingung:** keine
- **Schritte:**
  1. Stift, Text in „Beschreibung eingeben…“, Haken speichert, Kreuz oder
     Escape bricht ab.
- **Ergebnis:** Beschreibung gespeichert; die Suche findet sie.
- **Fehler und Grenzfälle:** keine
- **Test:** –

### FOT-DET-02 Aufnahmedatum bearbeiten

- **Wo:** Stift „Aufnahmedatum bearbeiten“
- **Recht:** `photos.upload`
- **Vorbedingung:** keine
- **Schritte:**
  1. Datum und Uhrzeit setzen, „Datum speichern“.
- **Ergebnis:** Foto sortiert sich im Raster um; Rückblicke und
  Kapitel der Fotobücher rechnen mit dem neuen Datum.
- **Fehler und Grenzfälle:** Die EXIF-Datei bleibt unverändert.
- **Test:** –

### FOT-DET-03 Ort anzeigen in …

- **Wo:** Orts-Chip; Menü „Foto anzeigen in…“
- **Recht:** `photos.view`
- **Vorbedingung:** GPS-Daten
- **Schritte:**
  1. Chip drücken; Ziel wählen (Karte der App, externe Kartendienste).
- **Ergebnis:** Ziel öffnet sich mit den Koordinaten.
- **Fehler und Grenzfälle:** Ohne GPS steht kein Chip.
- **Test:** –

### FOT-DET-04 Text im Bild kopieren

- **Wo:** Knopf „Text kopieren“ im Abschnitt
- **Recht:** `photos.view`
- **Vorbedingung:** OCR-Text
- **Schritte:**
  1. Drücken.
- **Ergebnis:** „Kopiert“.
- **Fehler und Grenzfälle:** keine
- **Test:** –

### FOT-DET-05 Person entfernen und neu erkennen

- **Wo:** Abschnitt „Personen“: Kreuz „Entfernen“ je Gesicht, Knopf „Neu
  erkennen“
- **Recht:** `people.view`; Schreiben setzt ein eigenes oder
  schreibbares Foto voraus
- **Vorbedingung:** Gesichtserkennung läuft
- **Schritte:**
  1. Kreuz: Gesicht wird für dieses Foto ignoriert.
  2. „Neu erkennen“: Gesichter werden neu gesucht.
- **Ergebnis:** Liste der Personen am Foto ändert sich; die Seite
  Personen zählt neu.
- **Fehler und Grenzfälle:** Ohne Gesichtsdienst ist „Neu erkennen“
  gesperrt. Benannt werden Personen auf der Seite Personen, nicht hier.
- **Test:** –

### FOT-DET-06 Alben bearbeiten

- **Wo:** Knopf „Alben bearbeiten“; Album-Chip „Zu Album … springen“
- **Recht:** `photos.upload`
- **Vorbedingung:** keine
- **Schritte:**
  1. Knopf: Dialog „Alben zuweisen“ wie `FOT-GAL-14`.
  2. Chip: Album öffnet sich mit dem Foto im Blick.
- **Ergebnis:** Zuordnung geändert bzw. Album geöffnet.
- **Fehler und Grenzfälle:** keine
- **Test:** –

### FOT-DET-07 Reaktionen

- **Wo:** Abschnitt „Reaktionen“
- **Recht:** `photos.view`
- **Vorbedingung:** keine
- **Schritte:**
  1. Emoji wählen; nochmal nimmt es zurück.
- **Ergebnis:** Zähler je Emoji; der Uploader sieht es unter Aktivität.
- **Fehler und Grenzfälle:** keine
- **Test:** –

### FOT-DET-08 Kommentare

- **Wo:** Abschnitt „Kommentare“
- **Recht:** `photos.view`
- **Vorbedingung:** keine
- **Schritte:** wie `FOT-STR-04`
- **Ergebnis:** wie `FOT-STR-04`
- **Fehler und Grenzfälle:** keine
- **Test:** –

### FOT-DET-09 Bild erklären lassen

- **Wo:** Abschnitt „Bildwirkung“, Knopf „Bild erklären lassen“ bzw. „Neu
  erklären lassen“
- **Recht:** `photos.view`
- **Vorbedingung:** llm-service erreichbar
- **Schritte:**
  1. Drücken, warten.
- **Ergebnis:** Kurze Kritik in Worten (Komposition, Licht, Motiv), ohne
  Zahl; gespeichert, bis neu erklärt wird.
- **Fehler und Grenzfälle:** Ohne Modell steht ein Hinweis.
- **Test:** –

### FOT-DET-10 Meinungen lesen

- **Wo:** Abschnitt „Meinungen (n Mitglieder)“
- **Recht:** `photos.view`
- **Vorbedingung:** andere, die das Foto auf demselben Weg sehen, haben
  es kuratiert
- **Schritte:**
  1. Lesen.
- **Ergebnis:** Wie viele Favorit bzw. ausgeblendet gesetzt haben.
- **Fehler und Grenzfälle:** Nur Mitsehende zählen (`coViewerIds`).
- **Test:** –

---

## VGL: Fotos vergleichen

Overlay mit zwei Fotos einer Gruppe nebeneinander (bei schmalem
Bildschirm untereinander), Zoom je Bild, Knöpfen je Seite und einer
Leiste. Tastaturkürzel stehen hinter „Hilfe“.

### FOT-VGL-01 Entscheiden

- **Wo:** „ausblenden (1)“, „ausblenden (2)“, „Unentschieden (U,
  Leertaste)“, „Überspringen (S)“
- **Recht:** `photos.delete`
- **Vorbedingung:** Gruppe mit mindestens zwei Fotos
- **Schritte:**
  1. Das schlechtere ausblenden oder Unentschieden; das Overlay zeigt das
     nächste Paar, bis das beste der Gruppe feststeht.
  2. Zum Schluss „Weiter vergleichen“ (nächste Gruppe) oder den
     Bestätigen-Knopf.
- **Ergebnis:** Verlierer sind ausgeblendet, die Gruppe gilt als geprüft;
  die Entscheidung fließt in die Kalibrierung des Auto-Picks ein.
- **Fehler und Grenzfälle:** „Überspringen“ lässt die Gruppe offen.
  „Schließen“ während des Schreibens heißt „Abbrechen“.
- **Test:** –

### FOT-VGL-02 Hilfen beim Vergleich

- **Wo:** „KI-Vorauswahl“, „Sync-Zoom“, „Fokus-Peaking“, „Detaillierte
  KI-Bewertung vergleichen“, „Zoom zurücksetzen“
- **Recht:** `photos.view`
- **Vorbedingung:** keine
- **Schritte:**
  1. Umschalten.
- **Ergebnis:** KI-Vorauswahl markiert den KI-Pick; Sync-Zoom koppelt
  beide Bilder; Fokus-Peaking hebt scharfe Kanten hervor; die
  KI-Bewertung zeigt Schärfe, Belichtung, Gesichter je Bild.
- **Fehler und Grenzfälle:** keine
- **Test:** –

### FOT-VGL-03 Nicht dasselbe Motiv / Als Formatpaar behandeln

- **Wo:** Knöpfe in der Leiste
- **Recht:** `photos.delete`
- **Vorbedingung:** keine
- **Schritte:**
  1. Drücken.
- **Ergebnis:** „Nicht dasselbe Motiv“ löst die Gruppe auf; „Als
  Formatpaar behandeln“ verbindet Hoch- und Querformat, beide bleiben
  sichtbar.
- **Fehler und Grenzfälle:** keine
- **Test:** –

---

## EDT: Schnitt und Belichtung

Vollbild-Editor mit Zuschneiderahmen, Formatwahl, KI-Vorschlag,
Bildanpassungen, Drehung. Die Bearbeitung ist je Nutzer; das Original
bleibt.

### FOT-EDT-01 Zuschneiden und Format

- **Wo:** Rahmen; Abschnitt „Format“ (feste Seitenverhältnisse, „Frei“)
- **Recht:** `photos.upload`
- **Vorbedingung:** keine
- **Schritte:**
  1. Format wählen, Rahmen ziehen; „Speichern“.
- **Ergebnis:** Galerie, Vollbild und Alben zeigen den Schnitt; die
  Seitenleiste nennt „Bearbeitet“.
- **Fehler und Grenzfälle:** „Zurücksetzen“ stellt den Ausgangszustand
  des Editors her; „Bearbeitung löschen“ entfernt die gespeicherte
  Bearbeitung.
- **Test:** –

### FOT-EDT-02 KI-Vorschlag übernehmen

- **Wo:** Abschnitt „KI-Vorschlag“, Knopf „Crop & Belichtung übernehmen
  (Format)“
- **Recht:** `photos.upload`
- **Vorbedingung:** Vorschlag berechnet (Einstellungen › Wartung)
- **Schritte:**
  1. Drücken, prüfen, „Speichern“.
- **Ergebnis:** Rahmen und Regler stehen auf dem Vorschlag.
- **Fehler und Grenzfälle:** keine
- **Test:** –

### FOT-EDT-03 Übernehmen von anderen

- **Wo:** Abschnitt „Übernehmen von anderen“, Knopf mit dem Namen
- **Recht:** `photos.upload`
- **Vorbedingung:** eine andere Person hat das Foto bearbeitet
- **Schritte:**
  1. Drücken.
- **Ergebnis:** Deren Schnitt und Regler als eigener Entwurf.
- **Fehler und Grenzfälle:** keine
- **Test:** –

### FOT-EDT-04 Bildanpassungen und Drehung

- **Wo:** Regler (Helligkeit, Kontrast, Sättigung, …), „Auto“, „Original
  anzeigen (gedrückt halten)“, Drehung 0°/90°/180°/270°
- **Recht:** `photos.upload`
- **Vorbedingung:** keine
- **Schritte:**
  1. Regler ziehen, „Speichern“.
- **Ergebnis:** Anpassungen gespeichert, Vorschau überall.
- **Fehler und Grenzfälle:** „Abbrechen“ verwirft.
- **Test:** –

---

## AKT: Aktivität (`/fotos/feed`)

Liste der Ereignisse zu eigenen Fotos und Alben (Gefällt mir, Reaktion,
Kommentar, Foto in Album, Freigabe).

### FOT-AKT-01 Ereignisse lesen und öffnen

- **Wo:** Zeile; Knopf „Weitere laden“
- **Recht:** `photos.view`
- **Vorbedingung:** keine
- **Schritte:**
  1. Zeile anklicken.
- **Ergebnis:** Foto im Vollbild oder Album; „Weitere laden“ hängt die
  nächste Seite an.
- **Fehler und Grenzfälle:** keine
- **Test:** –

---

## Abdeckung

| ID | Aktion | Recht | Test |
|---|---|---|---|
| FOT-STR-01 | Neue Aktivität laden | view | – |
| FOT-STR-02 | Hochladen aus dem Feed | upload | – |
| FOT-STR-03 | Gefällt mir | view | – |
| FOT-STR-04 | Kommentieren | view | – |
| FOT-STR-05 | Beschreibung an der Karte | upload | – |
| FOT-STR-06 | Ausblenden | delete | – |
| FOT-STR-07 | Vollbild und „Öffnen in…“ | view | – |
| FOT-GAL-01 | Suchen in natürlicher Sprache | view | – |
| FOT-GAL-02 | Filtern | view | – |
| FOT-GAL-03 | Sortieren | view | – |
| FOT-GAL-04 | Zum ältesten / neuesten | view | – |
| FOT-GAL-05 | Foto im Vollbild öffnen | view | – |
| FOT-GAL-06 | Foto mit der Tastatur wählen | view | `gallery.spec.ts` |
| FOT-GAL-07 | Hochladen | upload | – |
| FOT-GAL-08 | Auswahlmodus | view | `gallery.spec.ts` |
| FOT-GAL-09 | Fotos teilen | view | – |
| FOT-GAL-10 | Collage erstellen | view | – |
| FOT-GAL-11 | Fotobuch gestalten | view | – |
| FOT-GAL-12 | An den Assistenten | module.assistant | – |
| FOT-GAL-13 | Ablegen | view | – |
| FOT-GAL-14 | Zu Alben hinzufügen | upload | – |
| FOT-GAL-15 | Beschreibung im Stapel | upload | – |
| FOT-GAL-16 | Favorit, Ausblenden, Link-Sichtbarkeit im Stapel | delete | – |
| FOT-GAL-17 | Ausgewählte Fotos löschen | delete | – |
| FOT-GAL-18 | Als Regel-Mappe speichern | view | – |
| FOT-GAL-19 | Gruppen bearbeiten | delete | – |
| FOT-GAL-20 | Antwort des Assistenten anzeigen | view | – |
| FOT-VOL-01 | Blättern und schließen | view | – |
| FOT-VOL-02 | Details (I) | view | – |
| FOT-VOL-03 | Favorit (F), Ausblenden (X) | delete | – |
| FOT-VOL-04 | Link-Sichtbarkeit (L) | delete | – |
| FOT-VOL-05 | Formatpaar wechseln (R) | view | – |
| FOT-VOL-06 | Foto teilen, Link teilen | view | – |
| FOT-VOL-07 | Text im Bild (T) | view | – |
| FOT-VOL-08 | Editor öffnen | upload | – |
| FOT-VOL-09 | Diashow (S) | view | – |
| FOT-VOL-10 | Echtes Vollbild | view | – |
| FOT-VOL-11 | Titelbild setzen (C) | Album schreiben | – |
| FOT-DET-01 | Beschreibung bearbeiten | upload | – |
| FOT-DET-02 | Aufnahmedatum bearbeiten | upload | – |
| FOT-DET-03 | Ort anzeigen in … | view | – |
| FOT-DET-04 | Text im Bild kopieren | view | – |
| FOT-DET-05 | Person entfernen, neu erkennen | people.view | – |
| FOT-DET-06 | Alben bearbeiten | upload | – |
| FOT-DET-07 | Reaktionen | view | – |
| FOT-DET-08 | Kommentare | view | – |
| FOT-DET-09 | Bild erklären lassen | view | – |
| FOT-DET-10 | Meinungen lesen | view | – |
| FOT-VGL-01 | Entscheiden | delete | – |
| FOT-VGL-02 | Hilfen beim Vergleich | view | – |
| FOT-VGL-03 | Nicht dasselbe Motiv / Formatpaar | delete | – |
| FOT-EDT-01 | Zuschneiden und Format | upload | – |
| FOT-EDT-02 | KI-Vorschlag übernehmen | upload | – |
| FOT-EDT-03 | Übernehmen von anderen | upload | – |
| FOT-EDT-04 | Bildanpassungen und Drehung | upload | – |
| FOT-AKT-01 | Ereignisse lesen und öffnen | view | – |
