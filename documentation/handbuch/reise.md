# Reise

Beobachtet Hotel- und Flugpreise. Ein Hotelwächter prüft ein Hotel für
feste Reisedaten einmal am Tag um 6 Uhr über Google Hotels, ein Flugwächter
eine Strecke für feste Daten oder flexibel in einem Zeitraum um 6:15 Uhr über
Google Flights; beide schreiben bei jeder Prüfung den Verlauf. Beide teilen
sich das Monatskontingent der SerpApi-Suchen.

**Modulrecht:** `module.travel`; die Seite braucht `travel.view`,
Anlegen, Bearbeiten, Prüfen und Löschen `travel.manage`. Die Rolle
„Reise User“ hat alle drei.

## Seiten

| Kürzel | Seite | Pfad | Recht |
|---|---|---|---|
| `HPR` | Hotelpreise | `/reise/hotelpreise` | `travel.view` |
| `FPR` | Flugpreise | `/reise/flugpreise` | `travel.view` |

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
  2. Erwachsene und optional das Alter der Kinder angeben. Bei einer
     geraden Zahl Erwachsener ab vier und ohne Kinder optional „Auch n
     Doppelzimmer à 2 Erwachsene prüfen“: jede Prüfung sucht dann zweimal
     (rund 60 statt 30 Suchen im Monat).
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
  kostenlos stornierbar. Doppelzimmer stehen als „2 × …“ mit dem Preis für
  alle Zimmer und darunter dem Preis je Zimmer; Grenze und „Passend“
  vergleichen die günstigere Art, alle unterzubringen. Ob so viele Zimmer
  frei sind, zeigt erst der Anbieter.
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

---

## FPR: Flugpreise (`/reise/flugpreise`)

Oben die Liste der Flugwächter, darunter für den gewählten Wächter der
beste bekannte Preis, Googles Einschätzung, der Preisverlauf laut Google,
die Flüge der letzten Prüfung, bei einem flexiblen Wächter alle möglichen
Reisen und der Verlauf aller Prüfungen. Der gewählte Wächter steht in der
Adresse (`?watch=<id>`).

### REI-FPR-01 Wächter anlegen

- **Wo:** Knopf „Neuer Wächter“; Dialog „Neuer Flugpreis-Wächter“
- **Recht:** `travel.manage`
- **Schritte:**
  1. Abflug und Ziel als Flughafen-Codes eingeben, mehrere mit Komma
     (z. B. „FRA,HHN“). „Hin und zurück“ oder „Nur hin“ wählen.
  2. Feste Daten: Hinflug und gegebenenfalls Rückflug wählen. Oder
     „Flexibel bei Zeitpunkt und Dauer“ anhaken und den frühesten Hinflug,
     den spätesten Rückflug (bei „Nur hin“: spätesten Hinflug) und die
     Nächte von–bis angeben. Der Dialog nennt, wie viele Reisen das sind;
     geprüft wird eine je Tag.
  3. Erwachsene, Kinder und Kleinkinder auf dem Schoß (zusammen höchstens
     9), Klasse und Umstiege wählen; optional Airlines oder eine Allianz
     („nur diese“ oder „alle außer diesen“) und die Stunden, zwischen denen
     hin und zurück abgeflogen werden soll.
  4. Optional eine Preisgrenze für alle Reisenden (hin und zurück) und die
     Währung.
  5. Push und E-Mail für die Meldung wählen (ohne Grenze gesperrt).
  6. Ende der Beobachtung prüfen: vorbelegt mit dem Tag vor dem letzten
     möglichen Hinflug, höchstens zwei Jahre ab heute. „Anlegen“.
- **Ergebnis:** Der Wächter steht in der Liste und ist gewählt; die erste
  Prüfung macht der Job oder „Jetzt prüfen“.
- **Fehler und Grenzfälle:** „Anlegen“ bleibt gesperrt, solange ein Feld
  fehlt; der Grund steht links in der Fußzeile. Mehr als 120 mögliche
  Reisen oder ein Zeitraum über 180 Tage lehnt der Dialog ab („Zeitraum
  oder Dauer enger fassen“), ebenso der Server.
- **Test:** –

### REI-FPR-02 Jetzt prüfen

- **Wo:** Pfeil-Knopf in der Zeile des Wächters
- **Recht:** `travel.manage`
- **Vorbedingung:** SerpApi-Schlüssel eingerichtet, Wächter nicht beendet
- **Ergebnis:** Meldung „Geprüft (Daten): n Flüge, m Suchen verbraucht“.
  Ein flexibler Wächter prüft dabei die nächste Reise der Reihe.
- **Fehler und Grenzfälle:** Ist SerpApi nicht erreichbar, steht die
  Prüfung mit Fehler im Verlauf. Ist das Monatskontingent verbraucht,
  meldet die Seite das.
- **Test:** –

### REI-FPR-03 Wächter bearbeiten oder pausieren

- **Wo:** Stift in der Zeile; Dialog „Wächter bearbeiten“ mit „Pausiert“
- **Recht:** `travel.manage`
- **Ergebnis:** Die Kriterien gelten ab der nächsten Prüfung; ein anderer
  Zeitraum beginnt die Reihe der möglichen Reisen von vorn.
- **Test:** –

### REI-FPR-04 Preise und Verlauf ansehen

- **Wo:** Strecke in der Liste
- **Recht:** `travel.view`
- **Ergebnis:** Kacheln „Bester Preis“ (bei flexiblen Wächtern mit den
  Daten der günstigsten Reise), „Letzte Prüfung“, „Laut Google“ (günstig,
  üblich oder teuer, mit üblicher Spanne) und „Grenze“; ein Link „In Google
  Flights öffnen“; der Preisverlauf laut Google für die zuletzt geprüften
  Daten mit der Grenze als gestrichelter Linie; die Flüge der letzten
  Prüfung (bei Hin und zurück die Hinflüge mit dem Preis der ganzen Reise);
  nach einer Meldung die Anbieter mit Preis und Tarif; bei flexiblen
  Wächtern „Mögliche Reisen“ mit dem Preis ihrer letzten Prüfung; der
  Verlauf jeder Prüfung.
- **Test:** –

### REI-FPR-05 Meldung bei günstigem Preis

- **Wo:** Push-Benachrichtigung und E-Mail; Push zusätzlich unter Mein
  Profil › Benachrichtigungen („Flugpreise“)
- **Recht:** `travel.view` (der Besitzer des Wächters)
- **Ergebnis:** Fällt bei der Prüfung um 6:15 Uhr der beste Preis unter
  die Grenze, kommt eine Meldung mit Preis, Daten, Airline, Umstiegen und
  Googles Einschätzung, wenn möglich mit den Anbietern; aus der Mail ein
  Knopf zur Suche in Google Flights und einer zum Wächter. Eine weitere
  Meldung kommt nur bei einem neuen Tiefstpreis oder nachdem der Preis
  wieder über der Grenze lag.
- **Fehler und Grenzfälle:** „Jetzt prüfen“ meldet nichts. Für die
  Anbieter braucht die Prüfung ein bis zwei Suchen mehr; ist das
  Kontingent knapp, kommt die Meldung ohne Anbieter.
- **Test:** –

### REI-FPR-06 Wächter löschen

- **Wo:** Papierkorb in der Zeile; Rückfrage „Wächter löschen“
- **Recht:** `travel.manage`
- **Ergebnis:** Wächter und Verlauf sind weg.
- **Test:** –
