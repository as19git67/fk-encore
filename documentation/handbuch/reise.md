# Reise

Beobachtet Hotelpreise für feste Reisedaten. Ein Wächter prüft ein Hotel
einmal am Tag um 6 Uhr über Google Hotels und schreibt bei jeder Prüfung den Verlauf.

**Modulrecht:** `module.travel`; die Seite braucht `travel.view`,
Anlegen, Bearbeiten, Prüfen und Löschen `travel.manage`. Die Rolle
„Reise User“ hat alle drei.

## Seiten

| Kürzel | Seite | Pfad | Recht |
|---|---|---|---|
| `HPR` | Hotelpreise | `/reise/hotelpreise` | `travel.view` |

---

## HPR: Hotelpreise (`/reise/hotelpreise`)

Oben die Liste der Wächter, darunter für den gewählten Wächter die Preise
der letzten Prüfung, ihre Tarife und der Verlauf aller Prüfungen. Der
gewählte Wächter steht in der Adresse (`?watch=<id>`).

### REI-HPR-01 Wächter anlegen

- **Wo:** Knopf „Neuer Wächter“; Dialog „Neuer Hotelpreis-Wächter“
- **Recht:** `travel.manage`
- **Schritte:**
  1. Hotel eingeben (Name, gern mit Ort), Anreise und Abreise wählen.
  2. Erwachsene und optional das Alter der Kinder angeben.
  3. Optional eine Grenze pro Nacht inklusive Steuern; Währung (EUR).
  4. „Nur kostenlos stornierbare Tarife zählen“ (an) und „Nur Tarife mit
     Frühstück zählen“ (aus) festlegen.
  5. Unter „Melden, wenn der Preis unter die Grenze fällt“ Push und E-Mail
     wählen (beide an; ohne Grenze gesperrt).
  6. Ende der Beobachtung prüfen: vorbelegt mit dem Tag vor der Anreise,
     höchstens zwei Jahre ab heute. „Anlegen“.
- **Ergebnis:** Der Wächter steht in der Liste und ist gewählt; die erste
  Prüfung macht der Job oder „Jetzt prüfen“.
- **Fehler und Grenzfälle:** „Anlegen“ bleibt gesperrt, solange ein Feld
  fehlt; der Grund steht links in der Fußzeile. Abreise vor Anreise,
  mehr als 30 Nächte, ein Ende nach der Anreise oder mehr als zwei Jahre
  voraus lehnt auch der Server ab.
- **Test:** –

### REI-HPR-02 Jetzt prüfen

- **Wo:** Pfeil-Knopf in der Zeile des Wächters
- **Recht:** `travel.manage`
- **Vorbedingung:** SerpApi-Schlüssel eingerichtet, Wächter nicht beendet
- **Ergebnis:** Meldung „Geprüft: n Tarife, m Suchen verbraucht“; Kacheln,
  Tarife und Verlauf zeigen die neue Prüfung.
- **Fehler und Grenzfälle:** Findet Google kein Hotel oder ist SerpApi
  nicht erreichbar, steht die Prüfung mit Fehler im Verlauf. Ist das
  Monatskontingent verbraucht, meldet die Seite das.
- **Test:** –

### REI-HPR-03 Wächter bearbeiten oder pausieren

- **Wo:** Stift in der Zeile; Dialog „Wächter bearbeiten“ mit „Pausiert“
- **Recht:** `travel.manage`
- **Ergebnis:** Die Kriterien gelten ab der nächsten Prüfung; ein anderer
  Hotelname sucht das Hotel neu.
- **Test:** –

### REI-HPR-04 Preise und Verlauf ansehen

- **Wo:** Name des Hotels in der Liste
- **Recht:** `travel.view`
- **Ergebnis:** Kacheln „Passend“, „Günstigster Tarif“, „Stornierbar“,
  „Stornierbar mit Frühstück“, „Grenze“, „Bisher bester“; Tabelle der
  Tarife der letzten Prüfung; Tabelle „Verlauf“ mit jeder Prüfung. Ein
  Preis unter der Grenze ist hervorgehoben. Ein Anbieter, den Google nur
  mit Preis nennt, steht mit Storno „unbekannt“; der Name des Anbieters
  führt zum Angebot. Ein Tarif mit unbekanntem Storno zählt nie als
  kostenlos stornierbar.
- **Test:** –

### REI-HPR-06 Meldung bei günstigem Preis

- **Wo:** Push-Benachrichtigung und E-Mail; ein- und ausschalten im Dialog
  des Wächters, Push zusätzlich unter Mein Profil › Benachrichtigungen
  („Hotelpreise“)
- **Recht:** `travel.view` (der Besitzer des Wächters)
- **Ergebnis:** Fällt bei der Prüfung um 6 Uhr der passende Preis unter
  die Grenze, kommt eine Meldung mit Preis, Anbieter, Daten und Storno,
  aus der Mail ein Knopf zum Angebot und einer zum Wächter. Eine weitere
  Meldung kommt nur bei einem neuen Tiefstpreis, oder nachdem der Preis
  zwischendurch wieder über der Grenze lag. Die Seite nennt den zuletzt
  gemeldeten Preis.
- **Fehler und Grenzfälle:** „Jetzt prüfen“ meldet nichts. Ohne Grenze
  gibt es keine Meldung. Wer die Kriterien ändert, bekommt den nächsten
  Preis unter der Grenze wieder gemeldet. Ohne eingerichteten Mailserver
  kommt nur der Push.
- **Test:** –

### REI-HPR-05 Wächter löschen

- **Wo:** Papierkorb in der Zeile; Rückfrage „Wächter löschen“
- **Recht:** `travel.manage`
- **Ergebnis:** Wächter und Verlauf sind weg.
- **Test:** –
