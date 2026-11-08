# Label

Druckt Etiketten auf einem Etikettendrucker: freier Text oder Vorlagen
mit Platzhaltern (Datum, Nutzer), Schriftgröße, Fett, Ausrichtung. Dazu
kommen Scanner-Etiketten: A4-Bögen mit fortlaufenden Nummern `#0001` …
als PDF für einen normalen Drucker.

**Modulrecht:** `module.label`; die Seite braucht `label.view`.

## Seiten

| Kürzel | Seite | Pfad | Recht |
|---|---|---|---|
| `DRK` | Label drucken | `/label` | `label.view` |
| `SCN` | Scanner-Etiketten | `/label/scanner` | `label.view` |

---

## DRK: Label drucken (`/label`)

### LAB-DRK-01 Text drucken

- **Wo:** Feld „Text für das Label…“, Schriftgröße (Klein, Mittel, Groß),
  Schalter „Fett“, Ausrichtung (Links, Zentriert), Auswahl „Drucker
  auswählen“, Knopf „Drucken“
- **Recht:** `label.view`
- **Vorbedingung:** Drucker erreichbar; „Drucker aktualisieren“ lädt die
  Liste neu
- **Schritte:**
  1. Text eingeben, Format wählen, Drucker wählen, „Drucken“.
- **Ergebnis:** Vorschau zeigt das Etikett; der Drucker druckt; ein Toast
  bestätigt.
- **Fehler und Grenzfälle:** Ohne Drucker ist „Drucken“ gesperrt. Ein
  Text, der nicht auf das Etikett passt, wird in der Vorschau
  abgeschnitten gezeigt. Das erkannte Etikettenformat (`labelCode`)
  steht am Drucker.
- **Test:** –

### LAB-DRK-02 Vorlage anlegen oder bearbeiten

- **Wo:** „Neu“, Stift „Vorlage bearbeiten“; Dialog „Vorlage erstellen“
  / „Vorlage bearbeiten“
- **Recht:** `label.view`
- **Vorbedingung:** keine
- **Schritte:**
  1. Name (zum Beispiel `Eingelagert am`), Text mit Platzhaltern über die
     Knöpfe „Platzhalter einfügen“ (Tooltip zeigt Token und Beispiel),
     Schriftgröße, Fett, Ausrichtung, Etikettenformat.
  2. „Speichern“.
- **Ergebnis:** Vorlage steht in der Auswahl „Vorlage für Etikett …
  auswählen“; „Zuletzt verwendet: …“ bietet die letzte an.
- **Fehler und Grenzfälle:** Eine Vorlage für ein anderes
  Etikettenformat ist ausgegraut („Benötigt Etikett …“).
- **Test:** –

### LAB-DRK-03 Vorlage anwenden

- **Wo:** Auswahl oder Knopf „Zuletzt verwendet“
- **Recht:** `label.view`
- **Vorbedingung:** Vorlage
- **Schritte:**
  1. Wählen.
- **Ergebnis:** Text und Format stehen im Formular, Platzhalter sind
  ersetzt; „Drucken“ wie `LAB-DRK-01`.
- **Fehler und Grenzfälle:** keine
- **Test:** –

### LAB-DRK-04 Vorlage löschen

- **Wo:** Papierkorb „Vorlage löschen“, Dialog „Vorlage löschen“
- **Recht:** `label.view`
- **Vorbedingung:** Vorlage
- **Schritte:**
  1. Bestätigen.
- **Ergebnis:** Vorlage weg.
- **Fehler und Grenzfälle:** keine
- **Test:** –

---

## SCN: Scanner-Etiketten (`/label/scanner`)

Bogen Avery Zweckform L4731REV: 7 × 27 = 189 Etiketten (25,4 × 10 mm) je
A4-Seite, Text `#0001` in Roboto 13 pt. Die Nummern zählt der Server je
Nutzer fort; ein Blatt wird nicht als Datei gespeichert, sondern bei
jedem Download aus erster Nummer und Seitenzahl neu erzeugt.

### LAB-SCN-01 Etiketten erzeugen

- **Wo:** Karte „Neues Blatt“, Feld „Seiten“, Knopf „PDF erzeugen“
- **Recht:** `label.print`
- **Vorbedingung:** keine
- **Schritte:**
  1. Seitenzahl wählen (1 bis 10), „PDF erzeugen“.
- **Ergebnis:** Das PDF wird heruntergeladen und steht unter „Erzeugte
  Blätter“; „Nächstes Blatt“ zeigt den nächsten Bereich (nach `#0001 –
  #0189` beginnt das nächste Blatt mit `#0190`).
- **Fehler und Grenzfälle:** Zwei schnelle Klicks bekommen zwei
  aufeinanderfolgende Bereiche, nie denselben. Über `#999999` hinaus
  lehnt der Server ab. Drucken in Originalgröße (100 %), nicht „an Seite
  anpassen“.
- **Test:** –

### LAB-SCN-02 Blatt erneut herunterladen

- **Wo:** Tabelle „Erzeugte Blätter“, Knopf „Herunterladen“
- **Recht:** `label.view`
- **Vorbedingung:** ein erzeugtes Blatt
- **Schritte:**
  1. Herunterladen.
- **Ergebnis:** Dasselbe Blatt als PDF (`Scanner-Etiketten 0001-0189.pdf`),
  mit dem aktuellen Druckversatz.
- **Fehler und Grenzfälle:** Die Liste zeigt die letzten 100 Blätter.
- **Test:** –

### LAB-SCN-03 Blatt aus der Liste entfernen

- **Wo:** Papierkorb „Aus der Liste entfernen“, Dialog „Blatt entfernen“
- **Recht:** `label.print`
- **Vorbedingung:** ein erzeugtes Blatt
- **Schritte:**
  1. Bestätigen.
- **Ergebnis:** Das Blatt ist weg; seine Nummern werden nicht wieder
  vergeben.
- **Fehler und Grenzfälle:** keine
- **Test:** –

### LAB-SCN-04 Nächste Nummer setzen

- **Wo:** Karte „Einstellungen“, Feld „Nächste Nummer“, „Übernehmen“
- **Recht:** `label.print`
- **Vorbedingung:** keine
- **Schritte:**
  1. Nummer eintragen (1 bis 999999), „Übernehmen“.
- **Ergebnis:** Das nächste Blatt beginnt mit dieser Nummer. Gedacht, um
  dort weiterzumachen, wo bisherige Etiketten aufgehört haben.
- **Fehler und Grenzfälle:** Eine Nummer, die schon auf einem Blatt
  stand, wird nicht abgewiesen.
- **Test:** –

### LAB-SCN-05 Druckversatz einstellen

- **Wo:** Karte „Einstellungen“, Knopf „Probeseite“, Felder „Nach rechts
  (mm)“ und „Nach unten (mm)“, „Übernehmen“
- **Recht:** Probeseite `label.view`, Speichern `label.print`
- **Vorbedingung:** keine
- **Schritte:**
  1. „Probeseite“ auf normales Papier drucken (100 %), gegen das Licht
     auf einen Bogen legen.
  2. Abweichung in mm eintragen (−10 bis 10, negativ = nach links/oben),
     „Übernehmen“.
- **Ergebnis:** Jedes PDF, auch ein älteres Blatt beim erneuten Download,
  ist um den Versatz verschoben. Die Probeseite zeigt die Umrisse der
  Etiketten und verbraucht keine Nummern.
- **Fehler und Grenzfälle:** keine
- **Test:** –

---

## Abdeckung

| ID | Aktion | Recht | Test |
|---|---|---|---|
| LAB-DRK-01 | Text drucken | label.view | – |
| LAB-DRK-02 | Vorlage anlegen oder bearbeiten | label.view | – |
| LAB-DRK-03 | Vorlage anwenden | label.view | – |
| LAB-DRK-04 | Vorlage löschen | label.view | – |
| LAB-SCN-01 | Etiketten erzeugen | label.print | – |
| LAB-SCN-02 | Blatt erneut herunterladen | label.view | – |
| LAB-SCN-03 | Blatt aus der Liste entfernen | label.print | – |
| LAB-SCN-04 | Nächste Nummer setzen | label.print | – |
| LAB-SCN-05 | Druckversatz einstellen | label.view / label.print | – |
