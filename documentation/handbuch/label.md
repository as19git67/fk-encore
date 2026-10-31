# Label

Druckt Etiketten auf einem Etikettendrucker: freier Text oder Vorlagen
mit Platzhaltern (Datum, Nutzer), Schriftgröße, Fett, Ausrichtung.

**Modulrecht:** `module.label`; die Seite braucht `label.view`.

## Seiten

| Kürzel | Seite | Pfad | Recht |
|---|---|---|---|
| `DRK` | Label drucken | `/label` | `label.view` |

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

## Abdeckung

| ID | Aktion | Recht | Test |
|---|---|---|---|
| LAB-DRK-01 | Text drucken | label.view | – |
| LAB-DRK-02 | Vorlage anlegen oder bearbeiten | label.view | – |
| LAB-DRK-03 | Vorlage anwenden | label.view | – |
| LAB-DRK-04 | Vorlage löschen | label.view | – |
