# Sammelmappen, Basket, Exporte und geteilte Links

Modulübergreifend: Fotos, Alben, Dokumente, Buchungen, Wertpapiere,
Zähler und Zählerstände lassen sich in benannten Mappen sammeln,
typisiert oder gemischt. Der Basket ist die eine unbenannte Mappe des
Nutzers auf dem Server. Exporte gibt es je Typ mit Profilen, Versand
über Teilen-Menü, E-Mail und Download-Link, anonyme Freigabelinks und
Zeitpläne. Plan: `documentation/plans/sammelmappen.md`.

**Rechte:** Es gibt kein eigenes Modulrecht. Sammelmappen sieht, wer
mindestens einen Typ nutzen darf (`mayUseType`); in einer Mappe sieht
jeder nur die Mitglieder, die er in seinem Modul sehen dürfte. Eine Mappe
gehört ihrem Ersteller; eine Gruppen-Mappe sehen die Gruppenmitglieder.

**Begriffe:**

- **Basket**: Knopf mit Schublade im Hauptmenü, Badge zählt alles darin.
- **Regel-Mappe**: ihr Inhalt ist ein Filter (Fotos, Buchungen,
  Wertpapiere, Zähler), der beim Öffnen und auf „Regel anwenden“ neu
  ausgewertet wird.
- **Export**: eine Datei aus der Mappe (PDF, Excel, CSV, ZIP) nach einem
  Profil.

## Seiten

| Kürzel | Seite | Pfad | Recht |
|---|---|---|---|
| `BSK` | Basket-Schublade | überall (Hauptmenü) | ein Typ nutzbar |
| `ABL` | Dialog „Ablegen“ | überall | ein Typ nutzbar |
| `LST` | Sammelmappen | `/sammelmappen` | ein Typ nutzbar |
| `DET` | Sammelmappe (gemischt) | `/sammelmappen/:id`; typisiert in der Modulliste mit `?collection=<id>` | Zugriff auf die Mappe |
| `EXP` | Dialog „Exportieren“ | aus `DET`, `LST`, Basket | Zugriff |
| `GTL` | Geteilte Sammelmappe (Gast) | `/geteilt/:token` | kein Login |

---

## BSK: Basket

### SAM-BSK-01 Basket öffnen und Mitglieder sehen

- **Wo:** Basket-Knopf im Hauptmenü („… öffnen“)
- **Recht:** ein Typ nutzbar
- **Vorbedingung:** keine
- **Schritte:**
  1. Knopf drücken; Drawer rechts mit „Alle Sammelmappen“ oben, dann die
     Mitglieder nach Typ gruppiert (das eigene Modul zuerst).
  2. Zeile öffnet das Ding; Kreuz „Aus dem Basket nehmen“.
- **Ergebnis:** Badge und Liste stimmen überein.
- **Fehler und Grenzfälle:** In Modulen ohne Stapelaktionen zeigt der
  Drawer nur Liste und Fuß; in Fotos zusätzlich „Fotobuch gestalten“,
  in Dokumenten und Finanzen deren Stapelaktionen über dem Fuß.
- **Test:** –

### SAM-BSK-02 Basket leeren

- **Wo:** „Leeren“ im Fuß
- **Recht:** ein Typ nutzbar
- **Vorbedingung:** Basket nicht leer
- **Schritte:**
  1. Drücken, Dialog „Basket leeren?“ bestätigen.
- **Ergebnis:** Badge auf 0; grüne „Ablegen“-Knöpfe werden wieder
  neutral.
- **Fehler und Grenzfälle:** keine
- **Test:** –

### SAM-BSK-03 Als Sammelmappe speichern

- **Wo:** „Als Sammelmappe speichern“ im Fuß; Dialog mit Feld „z. B.
  Nebenkosten 2026“
- **Recht:** ein Typ nutzbar
- **Vorbedingung:** Basket nicht leer
- **Schritte:**
  1. Name, „Speichern“.
- **Ergebnis:** Neue Mappe mit dem Inhalt; der Basket bleibt, wie er ist.
- **Fehler und Grenzfälle:** Leerer Name sperrt „Speichern“.
- **Test:** –

### SAM-BSK-04 Basket exportieren

- **Wo:** „Exportieren“ im Fuß
- **Recht:** ein Typ nutzbar
- **Vorbedingung:** Basket nicht leer
- **Schritte:** wie `SAM-EXP-01`
- **Ergebnis:** wie dort; der Basket hat keine Zeitpläne.
- **Fehler und Grenzfälle:** keine
- **Test:** –

### SAM-BSK-05 Durch den Basket blättern

- **Wo:** Pfeile in `#actions` jeder Detailseite, deren Objekt im Basket
  liegt
- **Recht:** Modulrecht
- **Vorbedingung:** mindestens zwei Mitglieder desselben Typs
- **Schritte:**
  1. Pfeil drücken.
- **Ergebnis:** Nächstes Objekt, Zähler „n von m“.
- **Fehler und Grenzfälle:** keine
- **Test:** –

---

## ABL: Ablegen

### SAM-ABL-01 In Basket oder Sammelmappe legen

- **Wo:** Aktion „Ablegen“ (grünes Import-Symbol, solange das Ding im
  Basket liegt) auf jeder Detailseite, in jeder Auswahlleiste, an Zeilen
  und Kacheln
- **Recht:** Modulrecht
- **Vorbedingung:** keine
- **Schritte:**
  1. Dialog „Ablegen“: Basket zuoberst, dann die passenden Mappen (Suche
     „Sammelmappe suchen …“), unten „Neue Sammelmappe …“ mit „Anlegen“.
  2. Ziel anhaken; für ein einzelnes Ding ist angehakt, wo es schon
     liegt; Abhaken nimmt es heraus.
  3. „Fertig“.
- **Ergebnis:** Badge bzw. Mappe zählt; Gruppen-Mappen tragen ein
  Gruppensymbol.
- **Fehler und Grenzfälle:** Eine Regel-Mappe lässt sich nicht von Hand
  befüllen und fehlt im Dialog.
- **Test:** –

---

## LST: Sammelmappen (`/sammelmappen`)

Kacheln oder Tabelle aller Mappen mit Typ-Symbol, Name, Inhalt, Tags,
Stern und „⋮“; Toolbar mit Suche, Filter (Typ: Alle/Gemischt/je Typ;
Aktiv/Archiviert; Von mir/Vom Assistenten), Sortierung (Zuletzt
geöffnet, Zuletzt geändert, Name, Anzahl), Ansicht (Kacheln, Tabelle),
Schalter „Nur Favoriten“.

### SAM-LST-01 Neue Sammelmappe

- **Wo:** „Neue Sammelmappe“; Dialog mit Name, Typ („Alle Arten“ oder
  einer), optional Regel (Zähler: Art Strom/Wasser/Gas/Betriebsstunden
  und Standort „z. B. Keller“; Wertpapiere: Depots „Alle Depots“)
- **Recht:** ein Typ nutzbar
- **Vorbedingung:** keine
- **Schritte:**
  1. Felder, „Anlegen“.
- **Ergebnis:** Mappe erscheint; mit Regel ist sie eine Regel-Mappe.
- **Fehler und Grenzfälle:** Leerer Name sperrt „Anlegen“.
- **Test:** –

### SAM-LST-02 Suchen, filtern, sortieren, Favoriten

- **Wo:** Toolbar; Stern „Als Favorit markieren: …“
- **Recht:** ein Typ nutzbar
- **Vorbedingung:** keine
- **Schritte:**
  1. Setzen.
- **Ergebnis:** Liste folgt, alles in der URL; archivierte Mappen nur
  unter „Archiviert“.
- **Fehler und Grenzfälle:** keine
- **Test:** –

### SAM-LST-03 Mappe öffnen

- **Wo:** Kachel („Öffnen: …“)
- **Recht:** Zugriff
- **Vorbedingung:** keine
- **Schritte:**
  1. Anklicken.
- **Ergebnis:** Typisierte Mappe öffnet die Liste ihres Moduls mit
  `?collection=<id>` und Chip „Sammelmappe: …“; gemischte öffnet `DET`.
- **Fehler und Grenzfälle:** keine
- **Test:** –

### SAM-LST-04 Menü „⋮“: Umbenennen, Exportieren, Regel, Album, Freigabelink, Archivieren, Löschen

- **Wo:** „Weitere Aktionen: …“ an der Kachel (dieselben Einträge in
  `DET`)
- **Recht:** Besitzer (Freigabelink: Besitzer)
- **Vorbedingung:** keine
- **Schritte:**
  1. „Umbenennen“: Dialog, „Speichern“.
  2. „Exportieren“: `SAM-EXP-01`.
  3. „Regel jetzt anwenden“ / „Regel beenden“ (Dialog „Regel beenden?“
     macht aus der Regel-Mappe eine feste Mappe mit dem aktuellen Inhalt).
  4. „Album daraus erstellen“: Dialog „Album aus Sammelmappe“ mit Name,
     „Album erstellen“ (nur mit Fotos).
  5. „Freigabelink“: `SAM-DET-05`.
  6. „Archivieren“ / „Zurückholen“.
  7. „Löschen“: Dialog „Sammelmappe löschen?“.
- **Ergebnis:** je Aktion; Löschen entfernt nur die Mappe, nie ihre
  Mitglieder.
- **Fehler und Grenzfälle:** keine
- **Test:** –

---

## DET: Sammelmappe (`/sammelmappen/:id`)

Gemischte Mappe: Gruppen je Typ mit Zähler und „Als Liste öffnen“,
Kacheln mit „Öffnen“ und „Aus der Sammelmappe nehmen“; `#actions`:
Stern, „Exportieren“, „Freigabelink“, „Regel anwenden“, „Album
erstellen“, „Fotobuch gestalten“; Filter nach Typ („Nur für …“),
Sortierung (Hinzugefügt, Datum, Titel), Auswahlmodus mit **einem**
Aktionsmenü: erst was für alles gilt (Herausnehmen, Ablegen), dann die
Stapelaktionen je Typ mit Typ und Anzahl im Text (Dokumente: Als geprüft
markieren, Als steuerrelevant markieren; Buchungen: Als CSV
herunterladen; Fotos: Als Favorit markieren, Zu Alben hinzufügen,
Fotobuch gestalten).

### SAM-DET-01 Gruppe als Liste öffnen

- **Wo:** „Als Liste öffnen“ an der Gruppe
- **Recht:** Modulrecht
- **Vorbedingung:** keine
- **Schritte:**
  1. Drücken.
- **Ergebnis:** Modulliste mit `?collection=<id>`.
- **Fehler und Grenzfälle:** keine
- **Test:** –

### SAM-DET-02 Mitglied herausnehmen

- **Wo:** Kreuz „Aus der Sammelmappe nehmen: …“; im Auswahlmodus
  „Herausnehmen“
- **Recht:** Besitzer
- **Vorbedingung:** keine
- **Schritte:**
  1. Drücken.
- **Ergebnis:** Zähler sinkt; das Ding selbst bleibt.
- **Fehler und Grenzfälle:** In einer Regel-Mappe nicht möglich.
- **Test:** –

### SAM-DET-03 Stapelaktionen je Typ

- **Wo:** Auswahlmodus, Aktionsmenü
- **Recht:** Recht der jeweiligen Aktion
- **Vorbedingung:** Auswahl
- **Schritte:**
  1. Eintrag mit Typ und Anzahl wählen.
- **Ergebnis:** Aktion im Modul ausgeführt (zum Beispiel „3 Dokumente
  als geprüft markieren“).
- **Fehler und Grenzfälle:** Einträge für Typen ohne Auswahl fehlen.
- **Test:** –

### SAM-DET-04 Regel anwenden, Album, Fotobuch

- **Wo:** `#actions`
- **Recht:** Besitzer
- **Vorbedingung:** Regel-Mappe bzw. Fotos in der Mappe
- **Schritte:**
  1. Drücken.
- **Ergebnis:** Inhalt neu ausgewertet; Album mit den Fotos; Fotobuch aus
  der Mappe (`fotos-personen.md`, FBD).
- **Fehler und Grenzfälle:** keine
- **Test:** –

### SAM-DET-05 Freigabelink

- **Wo:** „Freigabelink“ → Dialog „Freigabelink: …“
- **Recht:** Besitzer
- **Vorbedingung:** keine
- **Schritte:**
  1. Gültigkeit (7, 30, 90 Tage, Unbegrenzt), „Link erstellen“.
  2. „Link kopieren“; „Link beenden“ (Dialog „Link beenden?“).
- **Ergebnis:** Seite `GTL` „immer aktuell“: Fotos ohne Metadaten, Alben
  als Abschnitte, Dokumente zum Herunterladen.
- **Fehler und Grenzfälle:** Buchungen, Wertpapiere und Zähler erscheinen
  im Link nicht.
- **Test:** –

---

## EXP: Exportieren

Dialog mit drei Reitern: Zusammenstellen, Verlauf, Regelmäßig.

### SAM-EXP-01 Datei erstellen

- **Wo:** Reiter „Zusammenstellen“: Profil („Eigene Einstellungen“ oder
  gespeichertes), je Typ seine Optionen (Dokumente: Ein PDF oder
  Originale (ZIP); Fotos: Original oder Groß (2560 px); Buchungen: PDF,
  Excel, CSV, Spalten, nach Konto gruppieren mit Reihenfolge der Konten;
  Zähler: Zeitraum Anfang/heute), „Datei erstellen“
- **Recht:** Zugriff
- **Vorbedingung:** Mappe nicht leer
- **Schritte:**
  1. Optionen setzen, „Datei erstellen“.
- **Ergebnis:** Der Reiter zeigt statt des Formulars das Ergebnis mit
  Inhaltsverzeichnis (was nicht in die Datei kam, steht dort mit Grund)
  und darunter „Weitergeben“: „Speichern“, „Teilen“, „E-Mail“, „Link
  kopieren“ gleichrangig; „Als Dokument ablegen“ legt die Datei in die
  Dokumente.
- **Fehler und Grenzfälle:** Ein fehlgeschlagener Lauf bietet
  „Einstellungen prüfen und neu starten“; „Neu zusammenstellen“ zeigt
  wieder das Formular.
- **Test:** –

### SAM-EXP-02 Profil speichern oder löschen

- **Wo:** „Als Profil speichern“, Feld „Name des Profils“, „Speichern“;
  „Profil löschen“
- **Recht:** Zugriff
- **Vorbedingung:** keine
- **Schritte:**
  1. Name, „Speichern“.
- **Ergebnis:** Profil in der Auswahl; auch für Zeitpläne.
- **Fehler und Grenzfälle:** keine
- **Test:** –

### SAM-EXP-03 E-Mail senden

- **Wo:** „E-Mail“ im Abschnitt „Weitergeben“: Empfänger
  (zum Beispiel `max@beispiel.test`, mehrere mit Komma), Absender (App-Adresse oder,
  wenn gleiche Domain, die eigene), „Senden“
- **Recht:** Zugriff
- **Vorbedingung:** Mailversand konfiguriert
- **Schritte:**
  1. Empfänger, „Senden“.
- **Ergebnis:** Eintrag unter „Versendet“ mit Absender und Empfängern;
  Antworten gehen an den Nutzer.
- **Fehler und Grenzfälle:** Große Dateien gehen als Download-Link.
- **Test:** –

### SAM-EXP-04 Verlauf

- **Wo:** Reiter „Verlauf“: „Letzte Exporte“ mit „Herunterladen“, „Als
  Dokument ablegen“, „Weitergeben“, „Export entfernen“; „Versendet“
- **Recht:** Zugriff
- **Vorbedingung:** Exporte
- **Schritte:**
  1. Knopf drücken.
- **Ergebnis:** je Aktion.
- **Fehler und Grenzfälle:** keine
- **Test:** –

### SAM-EXP-05 Zeitplan anlegen, pausieren, ausführen, löschen

- **Wo:** Reiter „Regelmäßig“: „Zeitplan“ → Rhythmus (Wöchentlich,
  Monatlich, Jährlich), Umfang (Nur der abgelaufene Zeitraum, Die ganze
  Mappe), Profil, Empfänger, Absender; „Zeitplan anlegen“ (Dialog
  „Empfänger bestätigen“); je Zeitplan „Jetzt ausführen“, „Pausieren“ /
  „Fortsetzen“, „Zeitplan löschen“
- **Recht:** Besitzer
- **Vorbedingung:** nicht der Basket
- **Schritte:**
  1. Felder, „Zeitplan anlegen“, Empfänger bestätigen.
- **Ergebnis:** Läuft als der, der ihn angelegt hat, mit dessen Rechten
  zur Laufzeit; Ergebnisse im Verlauf.
- **Fehler und Grenzfälle:** keine
- **Test:** –

---

## GTL: Geteilte Sammelmappe (`/geteilt/:token`)

### SAM-GTL-01 Geteilte Mappe ansehen

- **Wo:** Link aus `SAM-DET-05`
- **Recht:** keines
- **Vorbedingung:** gültiger Link
- **Schritte:**
  1. Öffnen; Foto antippen („Foto n groß zeigen“), Dokument
     herunterladen.
- **Ergebnis:** Abschnitte je Album und „Dokumente“, Fotos im Vollbild
  mit Blättern.
- **Fehler und Grenzfälle:** „Link nicht mehr gültig“ nach Ablauf oder
  Beenden; „Hier liegt gerade nichts“ bei leerer Mappe.
- **Test:** –

---

## Abdeckung

| ID | Aktion | Recht | Test |
|---|---|---|---|
| SAM-BSK-01 | Basket öffnen und Mitglieder sehen | Typ nutzbar | – |
| SAM-BSK-02 | Basket leeren | Typ nutzbar | – |
| SAM-BSK-03 | Als Sammelmappe speichern | Typ nutzbar | – |
| SAM-BSK-04 | Basket exportieren | Typ nutzbar | – |
| SAM-BSK-05 | Durch den Basket blättern | Modulrecht | – |
| SAM-ABL-01 | In Basket oder Sammelmappe legen | Modulrecht | – |
| SAM-LST-01 | Neue Sammelmappe | Typ nutzbar | – |
| SAM-LST-02 | Suchen, filtern, sortieren, Favoriten | Typ nutzbar | – |
| SAM-LST-03 | Mappe öffnen | Zugriff | – |
| SAM-LST-04 | Menü „⋮“ | Besitzer | – |
| SAM-DET-01 | Gruppe als Liste öffnen | Modulrecht | – |
| SAM-DET-02 | Mitglied herausnehmen | Besitzer | – |
| SAM-DET-03 | Stapelaktionen je Typ | Recht der Aktion | – |
| SAM-DET-04 | Regel anwenden, Album, Fotobuch | Besitzer | – |
| SAM-DET-05 | Freigabelink | Besitzer | – |
| SAM-EXP-01 | Datei erstellen | Zugriff | – |
| SAM-EXP-02 | Profil speichern oder löschen | Zugriff | – |
| SAM-EXP-03 | E-Mail senden | Zugriff | – |
| SAM-EXP-04 | Verlauf | Zugriff | – |
| SAM-EXP-05 | Zeitplan | Besitzer | – |
| SAM-GTL-01 | Geteilte Mappe ansehen | – | – |
