# Zähler

Das Modul verwaltet Haushaltszähler (Strom, Wasser, Gas) und
Betriebsstundenzähler, nimmt Ablesungen entgegen (von Hand, per Foto oder
über einen API-Schlüssel von einem Gerät) und wertet den Verbrauch aus.
Technischer Hintergrund: `documentation/utility-meters.md`.

**Modulrecht:** `module.meters` schaltet den Menüpunkt „Zähler“ frei.
Darunter gibt es drei Schlüssel:

| Schlüssel | erlaubt |
|---|---|
| `meters.view` | Zähler, Ablesungen, Auswertungen und Auffälligkeiten sehen |
| `meters.read_entry` | Ablesungen erfassen und eigene korrigieren, Auffälligkeiten bestätigen oder verwerfen |
| `meters.manage` | Zähler anlegen, bearbeiten, löschen, Geräte wechseln, API-Schlüssel, Haushalt, Tarife und Annahmen, Prüfung von Hand starten |

Zusätzlich gilt je Zähler: Bearbeiten, Löschen, Gerätewechsel und
API-Schlüssel kann nur, wer den Zähler besitzt oder Besitzer seiner Gruppe
ist (im Folgenden „Besitzerrecht“). Andere Mitglieder der Gruppe sehen den
Zähler und dürfen ablesen.

**Begriffe:**

- **Zähler** ist die Messstelle (zum Beispiel „Strom Haus“). Sie bleibt
  bestehen, auch wenn das Gerät getauscht wird.
- **Gerät** ist der physische Zähler mit Seriennummer, Einbaudatum und
  Startwert. Ein Zähler hat genau ein aktives Gerät und beliebig viele
  ersetzte.
- **Ablesung** ist ein Wert des aktiven Geräts zu einem Zeitpunkt.
- **Gesamt (absolut)** ist der über alle Geräte fortlaufende Stand: Summe
  der Verbräuche aller Geräte. Er fällt beim Gerätewechsel nicht auf null.
- **Report-Rolle** sagt dem Energiebericht, was ein Zähler misst (Netzbezug,
  Einspeisung, PV-Produktion, Wärmepumpe gesamt, Heizung gesamt, Heizung PV,
  Warmwasser gesamt, Warmwasser PV, E-Auto/Wallbox gesamt, E-Auto/Wallbox PV,
  Verdichter-Betriebsstunden, Wasser Hausanschluss).
- **Haushalt** ist die eine Gruppe, mit der neue Zähler automatisch geteilt
  werden und deren Tarife und Wohnort für alle Mitglieder gelten.

## Seiten

| Kürzel | Seite | Pfad | Recht |
|---|---|---|---|
| `LST` | Liste | `/zaehler` | `meters.view` |
| `DET` | Zählerdetails | `/zaehler/:id` | `meters.view` |
| `SCH` | Schnellerfassung | `/zaehler/schnellerfassung` | `meters.read_entry` |
| `SKO` | Schnellerfassung konfigurieren | `/zaehler/schnellerfassung/konfiguration` | `meters.read_entry` |
| `AUS` | Auswertungen | `/zaehler/auswertungen` | `meters.view` |
| `AUF` | Auffälligkeiten | `/zaehler/auffaelligkeiten` | `meters.view` |
| `HLF` | Hilfe: Gradtage | `/zaehler/hilfe/gradtage` | `meters.view` |

Das Untermenü des Moduls zeigt „Zähler“, „Auswertungen“, „Schnellerfassung“
und „Auffälligkeiten“; die Konfiguration und die Hilfe erreicht man von
ihren Seiten aus.

---

## LST: Liste (`/zaehler`)

Die Seite zeigt alle sichtbaren Zähler als Kacheln: Symbol und Name,
Typ-Chip, Rollen-Chip (falls gesetzt), Standort, Sichtbarkeit
(„Privat“, Gruppenname oder Haushalt), „Letzter Stand“ mit Zeitpunkt und
„Gesamt (absolut)“.

### ZAE-LST-01 Zähler öffnen

- **Wo:** Klick auf eine Kachel, oder Kachel mit Tab anfahren und Enter oder
  Leertaste drücken
- **Recht:** `meters.view`
- **Vorbedingung:** mindestens ein sichtbarer Zähler
- **Schritte:** 1. Kachel anklicken
- **Ergebnis:** Zählerdetails (`DET`) des Zählers. Beim Zurückkehren steht
  die Liste wieder auf dieser Kachel (Anker, siehe `allgemein.md`).
- **Fehler und Grenzfälle:** Klicks auf die Knöpfe in der Kachel
  („Ablegen“, Stift, Papierkorb) öffnen den Zähler nicht.
- **Test:** `zaehler/liste.spec.ts`

### ZAE-LST-02 Zu den Auswertungen wechseln

- **Wo:** Knopf „Auswertungen“ oben rechts
- **Recht:** `meters.view`
- **Schritte:** 1. Knopf drücken
- **Ergebnis:** Seite Auswertungen (`AUS`)
- **Test:** `zaehler/liste.spec.ts`

### ZAE-LST-03 Zähler anlegen

- **Wo:** Knopf „Neuer Zähler“ oben rechts
- **Recht:** `meters.manage`
- **Vorbedingung:** keine
- **Schritte:**
  1. Knopf drücken; Dialog „Neuer Zähler“ öffnet sich, der Fokus liegt im
     Feld „Name“.
  2. Name eingeben (zum Beispiel `Strom Haus`).
  3. Typ wählen: Strom, Wasser, Gas oder Betriebsstunden. Beim Wechsel wird
     die Einheit passend vorbelegt (kWh, m³, h).
  4. Optional Report-Rolle, Einheit, Standort, Nachkommastellen (0 bis 3),
     Sichtbarkeit (Privat oder eine Gruppe; vorbelegt ist der Haushalt,
     falls einer festgelegt ist) und Notizen.
  5. Unter „Erstes Gerät“ Seriennummer, „Eingebaut am“ (Datum mit Uhrzeit)
     und Startwert eintragen.
  6. „Speichern“.
- **Ergebnis:** Dialog schließt, neue Kachel erscheint in der Liste, der
  Zähler hat ein aktives Gerät mit dem angegebenen Startwert.
- **Fehler und Grenzfälle:** Ein leerer Name wird abgewiesen: rotes Banner
  „Name darf nicht leer sein“ über der Liste, der Dialog bleibt mit den
  Eingaben offen. „Abbrechen“ oder Escape verwirft die Eingaben.
- **Test:** `zaehler/liste.spec.ts`

### ZAE-LST-04 Zähler bearbeiten

- **Wo:** Stift-Symbol in der Kachel („Bearbeiten“)
- **Recht:** `meters.manage` und Besitzerrecht
- **Vorbedingung:** ein Zähler, den die Person bearbeiten darf; bei anderen
  Zählern fehlt das Symbol
- **Schritte:** 1. Stift drücken; Dialog „Zähler bearbeiten“ mit den
  Stammdaten (ohne Geräteteil). 2. Felder ändern. 3. „Speichern“.
- **Ergebnis:** Kachel zeigt die neuen Werte.
- **Fehler und Grenzfälle:** Wechsel der Sichtbarkeit von einer Gruppe auf
  „Privat“ macht den Zähler für alle anderen unsichtbar.
- **Test:** `zaehler/liste.spec.ts`

### ZAE-LST-05 Zähler löschen

- **Wo:** Papierkorb-Symbol in der Kachel („Löschen“)
- **Recht:** `meters.manage` und Besitzerrecht
- **Schritte:** 1. Papierkorb drücken. 2. Bestätigungsdialog „Zähler
  löschen“ mit dem Text „Zähler „…“ mit allen Geräten und Ablesungen
  löschen? Diese Aktion kann nicht rückgängig gemacht werden.“ mit
  „Endgültig löschen“ bestätigen.
- **Ergebnis:** Kachel verschwindet; Geräte und Ablesungen sind mit gelöscht.
- **Fehler und Grenzfälle:** „Abbrechen“ lässt alles unverändert. Dies ist
  die einzige Aktion des Moduls ohne Rückweg.
- **Test:** `zaehler/liste.spec.ts`

### ZAE-LST-06 Zähler ablegen (Basket oder Sammelmappe)

- **Wo:** grünes „Ablegen“-Symbol in der Kachel
- **Recht:** `meters.view`
- **Schritte:** 1. Symbol drücken; Dialog „Ablegen“ (siehe
  `sammelmappen.md`) mit Basket zuoberst und passenden Mappen.
  2. Ziel anhaken oder „Neue Sammelmappe“.
- **Ergebnis:** Zähler liegt im Basket oder in der Mappe; das Symbol ist
  grün, solange er im Basket liegt.
- **Test:** `zaehler/liste.spec.ts`

### ZAE-LST-07 Liste auf eine Sammelmappe einschränken

- **Wo:** Aufruf mit `?collection=<id>`, zum Beispiel aus einer Mappe oder
  der Schublade des Baskets
- **Recht:** `meters.view`
- **Schritte:** 1. Mappe mit Zählern öffnen.
- **Ergebnis:** Über der Liste steht die Mappenzeile mit Namen und „×“; nur
  die Zähler der Mappe werden gezeigt. „×“ zeigt wieder alle.
- **Fehler und Grenzfälle:** leere Mappe: „In dieser Sammelmappe liegen
  keine Zähler.“
- **Test:** `zaehler/liste.spec.ts`

### ZAE-LST-08 Haushalt festlegen

- **Wo:** Knopf „Haushalt“ oben rechts
- **Recht:** `meters.manage`; speichern kann nur ein Besitzer der gewählten
  Gruppe (andere Gruppen sind in der Auswahl ausgegraut)
- **Vorbedingung:** mindestens eine Gruppe, deren Besitzer die Person ist
- **Schritte:** 1. Knopf drücken; Dialog „Haushalt“ erklärt die Wirkung.
  2. Gruppe wählen. 3. „Speichern“ (nur aktiv, wenn sich die Auswahl
  geändert hat).
- **Ergebnis:** Dialog schließt, die Liste lädt neu; besitzt die Person
  private Zähler, erscheint das Banner aus ZAE-LST-09. Neue Zähler werden ab
  jetzt mit dieser Gruppe geteilt (Sichtbarkeit vorbelegt mit
  „… (Haushalt)“); Tarife und Wohnort der Person werden in den Haushalt
  kopiert, falls er noch keine hat.
- **Fehler und Grenzfälle:** ohne Gruppe steht im Feld „Keine Gruppe
  vorhanden“ und Speichern bleibt aus. Ein Fehler des Servers erscheint im
  Dialog.
- **Test:** `zaehler/haushalt.seriell.spec.ts`

### ZAE-LST-09 Alle privaten Zähler mit dem Haushalt teilen

- **Wo:** blaues Hinweisbanner „… deiner Zähler sind noch privat und für den
  Haushalt „…“ unsichtbar.“ mit Knopf „Alle mit dem Haushalt teilen“
- **Recht:** `meters.manage`
- **Vorbedingung:** ein Haushalt ist festgelegt und die Person besitzt
  mindestens einen privaten Zähler; das Banner fehlt, wenn die Liste auf
  eine Mappe eingeschränkt ist
- **Schritte:** 1. Knopf drücken.
- **Ergebnis:** alle eigenen privaten Zähler zeigen die Sichtbarkeit des
  Haushalts; Banner verschwindet; grüne Meldung mit der Anzahl.
- **Test:** `zaehler/haushalt.seriell.spec.ts`

### ZAE-LST-10 Leere Liste

- **Wo:** Liste ohne sichtbare Zähler
- **Ergebnis:** Text „Noch keine Zähler angelegt.“; mit `meters.manage`
  bleibt „Neuer Zähler“ der Weg weiter.
- **Test:** `zaehler/liste.spec.ts` (Zählerliste als feste Antwort)

---

## DET: Zählerdetails (`/zaehler/:id`)

Kopfzeile mit Zurück-Pfeil, Name als Titel und den Aktionen „Ablegen“,
„Link teilen“, „Neue Ablesung“, Stift und Papierkorb (die drei letzten nach
Recht). Darunter Typ, Rolle, Standort und Sichtbarkeit, dann drei Kennzahlen:
„Letzter Stand“, „Gesamt (absolut)“ und „Aktives Gerät“ (Seriennummer).
Dann die Abschnitte Verbrauch, Gerätehistorie, Ablesungen und (nur mit
Besitzerrecht) API-Keys.

### ZAE-DET-01 Zurück

- **Wo:** Pfeil links vom Titel
- **Schritte:** 1. Pfeil drücken
- **Ergebnis:** zurück zur vorigen Seite, wenn sie im Modul Zähler lag oder
  eine modulübergreifende Seite war (Assistent, Sammelmappen), sonst zur
  Liste (`LST`).
- **Test:** `zaehler/detail.spec.ts`

### ZAE-DET-02 Link teilen

- **Wo:** Knopf „Link teilen“ in den Aktionen
- **Recht:** `meters.view`
- **Ergebnis:** Teilen-Menü des Geräts oder Link in der Zwischenablage; der
  Link führt auf diese Detailseite und setzt Anmeldung voraus.
- **Test:** `zaehler/detail.spec.ts`

### ZAE-DET-03 Zähler ablegen

Wie ZAE-LST-06, Knopf in den Aktionen der Detailseite.

- **Test:** `zaehler/detail.spec.ts`

### ZAE-DET-04 Zähler bearbeiten

Wie ZAE-LST-04, Stift in den Aktionen; Änderungen erscheinen sofort in Titel
und Kopfzeile.

- **Test:** `zaehler/detail.spec.ts`

### ZAE-DET-05 Zähler löschen

Wie ZAE-LST-05 (Papierkorb in den Aktionen); nach dem Löschen landet man
auf der Liste.

- **Test:** `zaehler/detail.spec.ts`

### ZAE-DET-06 Verbrauchsreport umschalten

- **Wo:** Abschnitt „Verbrauch“, Schalter Woche / Monat / Jahr
- **Recht:** `meters.view`
- **Vorbedingung:** mindestens zwei Ablesungen; sonst steht dort „Noch nicht
  genug Ablesungen für einen Verbrauchsreport.“
- **Schritte:** 1. Granularität wählen.
- **Ergebnis:** Kennzahl „Ø Verbrauch“ mit Trend und Basis („… abgeschlossene
  Monate, Trend: … Werte“), Balkendiagramm und Tabelle mit Verbrauch,
  Vorjahr, Veränderung (absolut und Prozent, rot für mehr, grün für
  weniger), Von und Bis.
- **Fehler und Grenzfälle:** Ein Zeitraum, der nur teilweise abgelesen ist,
  trägt ein Ausrufezeichen mit Tooltip („Nur teilweise abgelesen (… % des
  Zeitraums)“); ein rechnerisch verteilter Zeitraum (Ablesungen liegen im
  Mittel weiter auseinander als der Zeitraum lang ist) ein Regler-Symbol.
  Beide zählen nicht in den Durchschnitt.
- **Test:** `zaehler/detail.spec.ts`

### ZAE-DET-07 Gerät ersetzen

- **Wo:** Abschnitt „Gerätehistorie“, Knopf „Gerät ersetzen“
- **Recht:** `meters.manage` und Besitzerrecht
- **Schritte:** 1. Knopf drücken; Dialog „Gerät ersetzen“ mit Hinweis, dass
  das alte Gerät mit dem Endstand abgeschlossen wird und der absolute Stand
  fortläuft. 2. „Wechsel am“ (Datum und Uhrzeit), „Endstand altes Gerät“,
  „Seriennummer neu“, „Startwert neu“ (zum Beispiel `0`). 3. „Ersetzen“.
- **Ergebnis:** In der Gerätehistorie steht das alte Gerät mit „Bis“ und
  Endwert als „ersetzt“, das neue als „aktiv“; „Aktives Gerät“ in der
  Kopfzeile zeigt die neue Seriennummer; „Gesamt (absolut)“ ist unverändert
  hoch, „Letzter Stand“ zeigt den neuen Startwert.
- **Fehler und Grenzfälle:** Ein Wechselzeitpunkt vor der letzten Ablesung
  oder ein Endstand unter der letzten Ablesung wird abgewiesen; die Meldung
  erscheint als Banner.
- **Test:** `zaehler/detail.spec.ts`

### ZAE-DET-08 Gerät bearbeiten

- **Wo:** Stift in der Zeile der Gerätehistorie („Gerät bearbeiten“)
- **Recht:** `meters.manage` und Besitzerrecht
- **Schritte:** 1. Stift drücken; Dialog „Gerät bearbeiten“ mit
  Seriennummer, „Eingebaut am“, Startwert, „Ausgebaut am“ (mit Leeren-Knopf),
  Endwert und Notiz. 2. Ändern. 3. „Speichern“.
- **Ergebnis:** Zeile zeigt die neuen Werte; „Gesamt (absolut)“ wird neu
  gerechnet, wenn Start- oder Endwert geändert wurden.
- **Fehler und Grenzfälle:** Ein „Ausgebaut am“ am aktiven Gerät macht es
  nicht zum ersetzten Gerät; dafür ist ZAE-DET-07 da.
- **Test:** `zaehler/detail.spec.ts`

### ZAE-DET-09 Neuestes Gerät löschen

- **Wo:** Papierkorb in der Zeile der Gerätehistorie
- **Recht:** `meters.manage` und Besitzerrecht
- **Vorbedingung:** nur das neueste Gerät und nur ohne Ablesungen; sonst ist
  der Knopf ausgegraut mit Tooltip „Nur neuestes Gerät ohne Ablesungen
  löschbar“
- **Schritte:** 1. Papierkorb drücken. 2. Dialog „Gerät löschen“ mit
  „Löschen“ bestätigen.
- **Ergebnis:** Zeile verschwindet; war ein Vorgänger vorhanden, wird es
  wieder das aktive Gerät.
- **Test:** `zaehler/detail.spec.ts`

### ZAE-DET-10 Ablesung erfassen

- **Wo:** Knopf „Neue Ablesung“ in den Aktionen oder im Abschnitt
  „Ablesungen“
- **Recht:** `meters.read_entry`
- **Schritte:** 1. Knopf drücken; Dialog „Neue Ablesung“, Zeitpunkt ist mit
  jetzt vorbelegt. 2. Zählerstand
  eingeben (Nachkommastellen wie am Zähler eingestellt). 3. Optional Notiz.
  4. „Speichern“.
- **Ergebnis:** Ablesung steht oben in der Tabelle mit Datum, Wert, Absolut,
  Quelle `manual` und Notiz; „Letzter Stand“ und „Gesamt (absolut)“ sind
  aktualisiert; der Verbrauchsreport lädt neu.
- **Fehler und Grenzfälle:** Ein Wert unter dem Startwert des Geräts oder
  ein Zeitpunkt vor dem Einbau wird abgewiesen. Ein Wert, der kleiner ist als
  die vorige Ablesung, ergibt negativen Verbrauch und wird ebenfalls
  abgewiesen. Die Meldung erscheint als Banner.
- **Test:** `zaehler/detail.spec.ts`

### ZAE-DET-11 Zählerstand per Foto erkennen

- **Wo:** Kamera-Knopf neben dem Feld „Zählerstand“ im Dialog „Neue
  Ablesung“ (nur beim Anlegen, nicht beim Bearbeiten)
- **Recht:** `meters.read_entry`
- **Vorbedingung:** der OCR-Dienst läuft
- **Schritte:** 1. Kamera drücken; auf dem Handy öffnet sich die Kamera, am
  Rechner die Dateiauswahl (Bilder). 2. Foto des Zählwerks aufnehmen oder
  wählen.
- **Ergebnis:** Das Feld „Zählerstand“ ist mit dem erkannten Wert gefüllt,
  die Notiz lautet `OCR (… %)` mit der Sicherheit der Erkennung. Der Wert
  ist nur ein Vorschlag; gespeichert wird erst mit „Speichern“.
- **Fehler und Grenzfälle:** Kein Wert erkannt: gelbe Meldung „Kein
  Zählerstand erkannt. Bitte manuell eingeben.“ Dienst nicht erreichbar:
  gelbe Meldung mit der Fehlermeldung oder „OCR-Dienst nicht erreichbar“.
  Das Foto wird nicht gespeichert.
- **Test:** `zaehler/detail.spec.ts` (OCR feste Antwort)

### ZAE-DET-12 Ablesung bearbeiten

- **Wo:** Stift in der Zeile der Ablesung
- **Recht:** `meters.manage`, oder `meters.read_entry` für eigene Ablesungen
  (bei fremden fehlen Stift und Papierkorb)
- **Schritte:** 1. Stift drücken; Dialog „Ablesung bearbeiten“ mit
  Zeitpunkt, Zählerstand und Notiz, ohne Kamera. 2. Ändern. 3. „Speichern“.
- **Ergebnis:** Zeile zeigt die neuen Werte; Kennzahlen und Report werden neu
  geladen.
- **Fehler und Grenzfälle:** dieselben Plausibilitätsregeln wie ZAE-DET-10.
- **Test:** `zaehler/detail.spec.ts`

### ZAE-DET-13 Ablesung löschen

- **Wo:** Papierkorb in der Zeile der Ablesung
- **Recht:** wie ZAE-DET-12
- **Schritte:** 1. Papierkorb drücken. 2. Dialog „Ablesung löschen“,
  „Ablesung wirklich löschen?“, mit „Löschen“ bestätigen.
- **Ergebnis:** Zeile verschwindet; Kennzahlen und Report werden neu
  geladen.
- **Test:** `zaehler/detail.spec.ts`

### ZAE-DET-14 Ablesung ablegen

- **Wo:** „Ablegen“-Symbol in der Zeile der Ablesung
- **Recht:** `meters.view`
- **Ergebnis:** Die einzelne Ablesung liegt als Nachweis im Basket oder in
  einer Mappe (zum Beispiel die Ablesung beim Auszug), unabhängig vom
  Zähler.
- **Test:** `zaehler/detail.spec.ts`

### ZAE-DET-15 Durch die Ablesungen blättern

- **Wo:** Seitensteuerung unter der Tabelle „Ablesungen“
- **Vorbedingung:** mehr als 20 Ablesungen
- **Ergebnis:** je 20 Ablesungen pro Seite, neueste zuerst.
- **Test:** `zaehler/detail.spec.ts`

### ZAE-DET-16 Zahlung mit einer Ablesung verknüpfen

- **Wo:** Spalte „Zahlung“ in der Tabelle „Ablesungen“: Ketten-Symbol
  („Zahlung verknüpfen“) oder Euro-Symbol mit Anzahl („Verknüpfte Zahlungen
  anzeigen“)
- **Recht:** `finance.view` zum Sehen, `meters.read_entry` zum Verknüpfen
- **Vorbedingung:** mindestens ein Finanzkonto mit Buchungen, das die Person
  sehen darf
- **Schritte:** 1. Symbol drücken; Dialog „Zahlungen zur Ablesung“ mit den
  Abschnitten „Verknüpft“ und „Zahlung suchen“. 2. Suchbegriff (Empfänger,
  Verwendungszweck oder Betrag) eingeben und „Suchen“; leer sucht ±45 Tage um
  die Ablesung. 3. In der Trefferliste „Verknüpfen“ drücken.
- **Ergebnis:** Buchung steht unter „Verknüpft“; in der Tabelle zeigt das
  Euro-Symbol die Anzahl. Dieselbe Verknüpfung ist in den Finanzen an der
  Buchung sichtbar.
- **Fehler und Grenzfälle:** Ohne `finance.view` fehlt die Spalte ganz.
  Ohne `meters.read_entry` zeigt der Dialog nur „Verknüpft“ ohne Knöpfe.
- **Test:** `zaehler/detail.spec.ts` (Demo-Buchung aus `E2E_SEED_DEMO`)

### ZAE-DET-17 Verknüpfung einer Zahlung lösen

- **Wo:** Dialog „Zahlungen zur Ablesung“, Abschnitt „Verknüpft“, Knopf
  „Lösen“ an der Buchung
- **Recht:** `meters.read_entry`
- **Ergebnis:** Buchung verschwindet aus „Verknüpft“; die Buchung selbst
  bleibt in den Finanzen unverändert.
- **Test:** `zaehler/detail.spec.ts` (Demo-Buchung aus `E2E_SEED_DEMO`)

### ZAE-DET-18 API-Schlüssel anlegen

- **Wo:** Abschnitt „API-Keys“, Knopf „Neuer Key“
- **Recht:** `meters.manage` und Besitzerrecht (der Abschnitt fehlt sonst)
- **Schritte:** 1. Knopf drücken; Dialog „Neuer API-Key“. 2. Bezeichnung
  eingeben (Platzhalter „z.B. Shelly EM“); „Erstellen“ ist erst mit Text
  aktiv. 3. „Erstellen“.
- **Ergebnis:** Der Dialog zeigt den Token einmalig mit dem Hinweis „Der
  Token wird nur einmal angezeigt. Jetzt kopieren!“ und einem
  Kopieren-Knopf. Nach „Schließen“ steht der Schlüssel in der Tabelle mit
  Name, „Erstellt“, „Zuletzt genutzt: nie“ und Status „aktiv“.
- **Fehler und Grenzfälle:** Der Token lässt sich später nicht noch einmal
  anzeigen; wer ihn verliert, legt einen neuen an. Ein Gerät sendet damit
  Ablesungen an den Ingest-Endpunkt (`documentation/utility-meters.md`,
  Abschnitt 3.2); diese erscheinen mit Quelle `api`.
- **Test:** `zaehler/detail.spec.ts`

### ZAE-DET-19 API-Schlüssel löschen

- **Wo:** Papierkorb in der Zeile des Schlüssels
- **Recht:** `meters.manage` und Besitzerrecht
- **Schritte:** 1. Papierkorb drücken. 2. Dialog „API-Key löschen“ mit
  „Löschen“ bestätigen.
- **Ergebnis:** Zeile verschwindet; das Gerät bekommt ab sofort
  `unauthenticated`.
- **Test:** `zaehler/detail.spec.ts`

### ZAE-DET-20 Unbekannter Zähler

- **Wo:** Aufruf einer Kennung, die es nicht gibt oder die die Person nicht
  sehen darf
- **Ergebnis:** Text „Zähler nicht gefunden.“; die Aktionen in der Kopfzeile
  fehlen.
- **Test:** `zaehler/detail.spec.ts`

---

## SCH: Schnellerfassung (`/zaehler/schnellerfassung`)

Eine persönliche Ablese-Liste: alle Zähler, die die Person in der
Konfiguration (`SKO`) ausgewählt hat, untereinander mit einem gemeinsamen
Datum. Gedacht für den Rundgang am Monatsersten.

### ZAE-SCH-01 Konfiguration öffnen

- **Wo:** Zahnrad oben rechts („Schnellerfassung konfigurieren“) oder,
  solange die Liste leer ist, der Knopf „Konfiguration öffnen“ im Hinweis
  „Konfiguriere zuerst mindestens einen Zähler.“
- **Recht:** `meters.read_entry`
- **Ergebnis:** Seite `SKO`
- **Test:** `zaehler/schnellerfassung.spec.ts`

### ZAE-SCH-02 Datum für alle Werte setzen

- **Wo:** Feld „Datum“ oben in der Karte „Ablesungen erfassen“
- **Vorbelegung:** heute
- **Ergebnis:** Jede Ablesung, die danach auf dieser Seite gespeichert wird,
  trägt dieses Datum (ohne Uhrzeit). Schon gespeicherte Werte bleiben, wie
  sie sind.
- **Test:** `zaehler/schnellerfassung.spec.ts`

### ZAE-SCH-03 Einen Wert erfassen

- **Wo:** Zeile eines Zählers: Eingabefeld (Platzhalter ist die Einheit),
  Kamera, Knopf „Speichern“. Unter dem Namen steht „Vorher: … · Datum“ mit
  der letzten Ablesung.
- **Recht:** `meters.read_entry`
- **Vorbedingung:** mindestens ein konfigurierter Zähler
- **Schritte:** 1. Wert eingeben. 2. „Speichern“ in derselben Zeile.
- **Ergebnis:** Knopf wird grün mit „Gespeichert“, unter der Zeile steht
  „Gespeichert“. „Vorher“ bleibt bis zum nächsten Laden der Seite beim alten
  Wert. Eine weitere Änderung im Feld setzt den Knopf wieder auf
  „Speichern“.
- **Fehler und Grenzfälle:** Leeres Feld: gelbe Meldung „Bitte einen
  Zählerstand eingeben.“ Ein unplausibler Wert (unter der letzten Ablesung)
  wird vom Server abgewiesen; die Meldung steht gelb unter der Zeile, die
  anderen Zeilen bleiben unberührt.
- **Test:** `zaehler/schnellerfassung.spec.ts`

### ZAE-SCH-04 Wert per Foto erkennen

- **Wo:** Kamera-Knopf in der Zeile
- **Ergebnis:** Feld ist mit dem erkannten Wert gefüllt, darunter steht
  „OCR …%“. Gespeichert wird erst mit „Speichern“ (ZAE-SCH-03); die Ablesung
  bekommt dann die Quelle `ocr` und „OCR …%“ als Notiz.
- **Fehler und Grenzfälle:** wie ZAE-DET-11, Meldungen stehen unter der
  Zeile.
- **Test:** `zaehler/schnellerfassung.spec.ts` (OCR feste Antwort)

### ZAE-SCH-05 Alle eingegebenen Werte speichern

- **Wo:** Knopf „Alle eingegebenen speichern“ unter der Liste
- **Vorbedingung:** mindestens eine Zeile mit Wert, der noch nicht
  gespeichert ist; sonst ist der Knopf ausgegraut
- **Schritte:** 1. Werte in mehreren Zeilen eingeben. 2. Knopf drücken.
- **Ergebnis:** Jede ausgefüllte Zeile wird einzeln gespeichert und grün;
  Zeilen ohne Wert werden übersprungen. Eine Gesamtmeldung gibt es nicht.
- **Fehler und Grenzfälle:** Schlägt eine Zeile fehl, steht die Meldung an
  dieser Zeile, die übrigen sind trotzdem gespeichert.
- **Test:** `zaehler/schnellerfassung.spec.ts`

---

## SKO: Schnellerfassung konfigurieren (`/zaehler/schnellerfassung/konfiguration`)

Welche Zähler in der Schnellerfassung stehen und in welcher Reihenfolge. Die
Liste gehört der Person, nicht dem Haushalt; sie darf jeden sichtbaren
Zähler enthalten, auch geteilte.

### ZAE-SKO-01 Zurück zur Erfassung

- **Wo:** Pfeil links vom Titel („Zurück zur Erfassung“)
- **Ergebnis:** Seite `SCH`
- **Test:** `zaehler/schnellerfassung.spec.ts`

### ZAE-SKO-02 Zähler hinzufügen

- **Wo:** Auswahlfeld „Zähler hinzufügen …“ (mit Filter) und Knopf
  „Hinzufügen“
- **Recht:** `meters.read_entry`
- **Vorbedingung:** mindestens ein sichtbarer Zähler, der noch nicht in der
  Liste ist; das Auswahlfeld zeigt nur solche
- **Schritte:** 1. Zähler wählen. 2. „Hinzufügen“ (erst dann aktiv).
- **Ergebnis:** Zähler steht am Ende der nummerierten Liste; der Chip oben
  zählt hoch („3 Zähler“); grüne Meldung; die Konfiguration ist sofort
  gespeichert.
- **Test:** `zaehler/schnellerfassung.spec.ts`

### ZAE-SKO-03 Reihenfolge ändern

- **Wo:** Pfeile „Zähler nach oben“ und „Zähler nach unten“ in der Zeile
- **Vorbedingung:** mindestens zwei Zähler; am Rand ist der jeweilige Pfeil
  ausgegraut
- **Ergebnis:** Zeile wandert um eine Position; die Schnellerfassung zeigt
  dieselbe Reihenfolge.
- **Test:** `zaehler/schnellerfassung.spec.ts`

### ZAE-SKO-04 Zähler aus der Liste nehmen

- **Wo:** „×“ in der Zeile („Zähler aus der Schnellerfassung nehmen“)
- **Ergebnis:** Zeile verschwindet ohne Rückfrage; der Zähler selbst und
  seine Ablesungen bleiben unverändert; er ist im Auswahlfeld wieder
  wählbar.
- **Test:** `zaehler/schnellerfassung.spec.ts`

### ZAE-SKO-05 Leere Konfiguration

- **Ergebnis:** Text „Noch keine Zähler ausgewählt. Füge oben die Zähler
  hinzu, die du regelmäßig abliest.“
- **Test:** `zaehler/schnellerfassung.spec.ts`

---

## AUS: Auswertungen (`/zaehler/auswertungen`)

Berichte über alle sichtbaren Zähler. Jeder Abschnitt erscheint nur, wenn
seine Daten vorhanden sind; eine Person mit einem einzigen Wasserzähler
sieht nur den Verbrauchstrend. Über den Abschnitten steht, welcher
Tarifsatz den Kosten zugrunde liegt (Haushalt oder persönlich).

Abschnitte in dieser Reihenfolge: Verbrauchstrend, Energie,
Wirtschaftlichkeit (Amortisation, Kosten je Anwendung, Wasserkosten),
Vergleichsrechnungen (Gasheizung, Benziner), Anlagenzustand (Strom je
Verdichterstunde, PV-Ertrag je kWp, Wasser-Grundlast, Laufzeitanteil),
Saisonprofil, Heizung witterungsbereinigt, Abschläge vs. Ist-Kosten. Die
Formeln stehen in `documentation/utility-meters.md`, Abschnitt 5.

### ZAE-AUS-01 Zur Zählerliste wechseln

- **Wo:** Knopf „Zähler“ oben rechts; bei leerer Liste zusätzlich der Link
  „Zur Zählerverwaltung“ im Hinweis „Noch keine Zähler angelegt — ohne
  Ablesungen gibt es nichts auszuwerten.“
- **Ergebnis:** Seite `LST`
- **Test:** `zaehler/auswertungen.spec.ts` (leere Liste als feste Antwort)

### ZAE-AUS-02 Trend-Kachel öffnen

- **Wo:** Abschnitt „Verbrauchstrend“: eine Kachel je Zähler mit Summe der
  letzten 12 Monate, Veränderung gegenüber den 12 Monaten davor (Pfeil,
  absolut und Prozent) und Sparkline
- **Recht:** `meters.view`
- **Vorbedingung:** mindestens ein Zähler mit auswertbaren Ablesungen;
  sonst „Noch keine auswertbaren Ablesungen vorhanden.“
- **Schritte:** 1. Kachel anklicken.
- **Ergebnis:** Zählerdetails (`DET`) dieses Zählers.
- **Fehler und Grenzfälle:** Eine abgeleitete Kachel, die mehrere Zähler
  zusammenfasst, reagiert nicht auf Klick. Ohne volles Vorjahr steht statt
  der Veränderung die Richtung aus der Regression mit der Zahl der
  Rollwerte.
- **Test:** `zaehler/auswertungen.spec.ts`

### ZAE-AUS-03 Energiebericht umschalten

- **Wo:** Abschnitt „Energie“, Schalter Monat / Jahr
- **Vorbedingung:** Zähler mit den Rollen Netzbezug, Einspeisung und
  PV-Produktion, jeweils mit Ablesungen; sonst fehlt der Abschnitt oder
  zeigt „Noch keine vollständigen PV-Zeiträume mit Bezug, Einspeisung und
  Produktion vorhanden.“
- **Ergebnis:** Kennzahl-Kacheln (Ø Bezug, Ø Einspeisung, Ø Produktion,
  Ø Eigenverbrauch, Ø Gesamtverbrauch, Ø Autarkie, Ø Eigenverbrauchsquote;
  mit Wärmepumpen-Rollen zusätzlich die Aufteilung; mit Tarifen die
  Kostenkacheln), YTD-Vergleich zum Vorjahr und die Tabelle je Monat
  (letzte 12) oder je Jahr (alle). Teilweise abgelesene Zeiträume sind
  markiert und zählen nicht in die Durchschnitte.
- **Fehler und Grenzfälle:** Tragen zwei Zähler dieselbe Rolle, warnt ein
  gelbes Banner und der Bericht nimmt nur den ersten.
- **Test:** `zaehler/auswertungen.spec.ts`

### ZAE-AUS-04 Hilfe zu den Energie-Kennzahlen

- **Wo:** Knopf „Hilfe“ im Abschnitt „Energie“
- **Ergebnis:** Dialog „Energie-Kennzahlen“ mit den Formeln und dem gerade
  betrachteten Zeitraum. Schließen mit „×“ oder Escape.
- **Test:** `zaehler/auswertungen.spec.ts`

### ZAE-AUS-05 Tarife und Annahmen öffnen

- **Wo:** Knopf „Tarife & Annahmen“ oben rechts
- **Recht:** `meters.manage`
- **Ergebnis:** Dialog „Tarife & Annahmen verwalten“ mit Formular oben und
  den vorhandenen Einträgen nach Kategorie gruppiert darunter (Art, Betrag,
  „ab Datum“, Name, Steuerstatus, Leistungsgrenze).
- **Test:** `zaehler/auswertungen.spec.ts`

### ZAE-AUS-06 Tarif oder Annahme anlegen

- **Wo:** Formular im Dialog „Tarife & Annahmen verwalten“
- **Recht:** `meters.manage`
- **Schritte:** 1. „Art“ wählen (Arbeitspreis, Grundpreis,
  Einspeisevergütung, Eigenverbrauchswert, Gaspreis, Benzinpreis,
  Wasserpreis, Jahresarbeitszahl, Kesselwirkungsgrad, Verbrauch E-Auto oder
  Benziner, PV-Anlagenleistung, PV-Invest, CO₂-Faktoren und weitere; unter
  dem Feld steht eine Erklärung der Art, die Einheit wird vorbelegt).
  2. „Gültig ab“, „Betrag“, Einheit; optional „Name / Tarif“, „Grenze kW“,
  „Steuerstatus“. 3. „Speichern“.
- **Ergebnis:** Eintrag erscheint in seiner Kategorie; Formular ist leer
  (ohne eigene Meldung). Kosten und Vergleichsrechnungen rechnen ab dem
  Gültigkeitsdatum mit dem neuen Wert, tagesanteilig innerhalb eines Monats.
- **Fehler und Grenzfälle:** Fehler stehen rot im Dialog. Gehört die Person
  zu einem Haushalt, gilt der Eintrag für den ganzen Haushalt (Zeile oben im
  Dialog).
- **Test:** `zaehler/auswertungen.spec.ts`

### ZAE-AUS-07 Tarif oder Annahme bearbeiten

- **Wo:** Stift an einem Eintrag
- **Schritte:** 1. Stift drücken; das Formular springt in den
  Bearbeitungsmodus mit dem Banner „Bearbeite Preisänderung #…“. 2. Ändern.
  3. „Änderung speichern“; „Abbrechen“ leert das Formular wieder.
- **Ergebnis:** Eintrag zeigt die neuen Werte.
- **Test:** `zaehler/auswertungen.spec.ts`

### ZAE-AUS-08 Tarif oder Annahme löschen

- **Wo:** Papierkorb an einem Eintrag
- **Schritte:** 1. Papierkorb drücken. 2. Dialog „Strompreis löschen“,
  „Preisänderung „…“ ab … löschen?“, mit „Löschen“ bestätigen.
- **Ergebnis:** Eintrag verschwindet; Kosten rechnen wieder mit dem
  vorigen gültigen Wert.
- **Test:** `zaehler/auswertungen.spec.ts`

### ZAE-AUS-09 Benzinpreise abrufen

- **Wo:** Knopf „Benzinpreise abrufen“ im Dialog „Tarife & Annahmen
  verwalten“
- **Recht:** `meters.manage`
- **Vorbedingung:** ein Zähler mit Rolle „E-Auto/Wallbox gesamt“ und
  Ablesungen; der Server erreicht das EU-Ölbulletin
- **Ergebnis:** Für jeden Monat mit Wallbox-Ablesung ohne Benzinpreis wird
  das Monatsmittel (Euro-Super 95, Bundesdurchschnitt inklusive Steuern) als
  Annahme angelegt; vorhandene Werte bleiben; grüne Meldung mit der Anzahl.
- **Fehler und Grenzfälle:** Keine Netzverbindung oder keine passenden
  Monate: rote beziehungsweise grüne Meldung mit „0“.
- **Test:** `zaehler/auswertungen.spec.ts` (Ölbulletin feste Antwort)

### ZAE-AUS-10 Preisreihen aus Datei importieren

- **Wo:** Knopf „Datei importieren“ im Dialog „Tarife & Annahmen verwalten“
- **Schritte:** 1. Knopf drücken; Dateiauswahl (JSON). 2. Datei wählen.
- **Ergebnis:** Einträge aus der Datei erscheinen in ihren Kategorien; grüne
  Meldung mit der Anzahl. Format: `documentation/utility-meters.md`,
  Abschnitt „File import of series“.
- **Fehler und Grenzfälle:** Ungültige Datei: rote Meldung, nichts
  importiert.
- **Test:** `zaehler/auswertungen.spec.ts`

### ZAE-AUS-11 Wohnort für Gradtagzahlen setzen

- **Wo:** Abschnitt „Heizung witterungsbereinigt“, Karte „Wohnort für
  Gradtagzahlen“ (nur mit `meters.manage`)
- **Schritte:** 1. Im Feld „Ort suchen (Stadt oder Gemeinde)“ einen Ort
  eingeben, „Suchen“. 2. Treffer wählen. Alternativ „Koordinaten eingeben“:
  Bezeichnung, Breitengrad, Längengrad, „Speichern“; „Ortssuche“ wechselt
  zurück.
- **Ergebnis:** Karte zeigt Bezeichnung und Koordinaten; ab jetzt holt ein
  täglicher Lauf die Gradtagzahlen für diesen Ort. Bei Haushalt gilt der Ort
  für alle Mitglieder.
- **Test:** `zaehler/auswertungen.spec.ts` (Ortssuche feste Antwort)

### ZAE-AUS-12 Gradtagzahlen sofort abrufen

- **Wo:** Knopf „Gradtagzahlen abrufen“ in derselben Karte
- **Vorbedingung:** Wohnort gesetzt; der Server erreicht das
  Open-Meteo-Archiv
- **Ergebnis:** Gradtage werden für alle Monate mit Heizungsablesung geholt;
  der Abschnitt lädt neu und zeigt „Gradtagzahlen liegen für … gemessene
  Monate vor.“, die Tabellen „Jahre“ und „Monate“ bekommen die Spalten
  Gradtage, je Gradtag und Normaljahr beziehungsweise Normalmonat.
- **Fehler und Grenzfälle:** Ohne Gradtage rechnet der Abschnitt mit dem
  typischen Monatsprofil (Spalten „Typisch“ und „Abweichung“).
- **Test:** `zaehler/auswertungen.spec.ts` (Open-Meteo feste Antwort)

### ZAE-AUS-13 Wohnort entfernen

- **Wo:** Knopf „Entfernen“ in derselben Karte
- **Ergebnis:** Kein Wohnort mehr; bereits geholte Gradtage bleiben, neue
  kommen nicht dazu.
- **Test:** `zaehler/auswertungen.spec.ts`

### ZAE-AUS-14 Hilfe „Was sind Gradtage?“

- **Wo:** Knopf im Abschnitt „Heizung witterungsbereinigt“
- **Ergebnis:** Seite `HLF` mit Erklärung; der Pfeil dort führt zurück.
- **Test:** `zaehler/auswertungen.spec.ts`

---

## AUF: Auffälligkeiten (`/zaehler/auffaelligkeiten`)

Postfach der täglichen Prüfung: Sie vergleicht den Tagesverbrauch der
letzten Ableseintervalle mit dem bisherigen Verlauf und mit dem gleichen
Zeitraum des Vorjahres. Jede Karte zeigt Art, Zähler (als Link), Zeitraum,
Meldung, Abweichung in σ und, falls vorhanden, den Vorjahreswert.

### ZAE-AUF-01 Filtern

- **Wo:** Listen-Toolbar: Auswahl „Umfang“ (Offen / Alle) und „Art der
  Auffälligkeit“ (Alle Arten oder eine Art)
- **Ergebnis:** Liste passt sich an; die Filter stehen in der URL, so dass
  ein Reload oder ein geteilter Link dieselbe Sicht zeigt. Bei „Alle“ trägt
  jede Karte einen Status-Chip (offen, bestätigt, verworfen).
- **Fehler und Grenzfälle:** Leer gefiltert: „Keine Auffälligkeiten“ mit
  „Mit anderen Filtereinstellungen findet sich vielleicht etwas.“ und
  „Filter zurücksetzen“. Ohne Filter und ohne Fund: „Keine offenen
  Auffälligkeiten“ / „Die tägliche Prüfung hat nichts gefunden.“
- **Test:** `zaehler/auffaelligkeiten.spec.ts`

### ZAE-AUF-02 Liste neu laden

- **Wo:** Knopf „Aktualisieren“ oben rechts
- **Ergebnis:** Liste wird neu geholt; während des Ladens ist der Knopf
  ausgegraut.
- **Test:** `zaehler/auffaelligkeiten.spec.ts`

### ZAE-AUF-03 Prüfung sofort ausführen

- **Wo:** Knopf „Jetzt prüfen“ oben rechts („Die tägliche Prüfung sofort
  ausführen“)
- **Recht:** `meters.manage`
- **Ergebnis:** Die Prüfung läuft über alle sichtbaren Zähler; neue Funde
  erscheinen als offene Karten; bekannte werden nicht doppelt angelegt.
- **Test:** `zaehler/auffaelligkeiten.spec.ts`

### ZAE-AUF-04 Zähler aus einer Karte öffnen

- **Wo:** Zählername in der Karte
- **Ergebnis:** Zählerdetails (`DET`).
- **Test:** `zaehler/auffaelligkeiten.spec.ts`

### ZAE-AUF-05 Auffälligkeit bestätigen

- **Wo:** Knopf „Bestätigen“ an einer offenen Karte
- **Recht:** `meters.read_entry`
- **Ergebnis:** Karte verschwindet aus „Offen“ und steht unter „Alle“ mit
  Chip „bestätigt“. Eine Bestätigung hält fest, dass die Abweichung echt
  war (zum Beispiel ein Leck).
- **Test:** `zaehler/auffaelligkeiten.spec.ts`

### ZAE-AUF-06 Auffälligkeit verwerfen

- **Wo:** Knopf „Verwerfen“ an einer offenen Karte
- **Recht:** `meters.read_entry`
- **Ergebnis:** wie ZAE-AUF-05 mit Chip „verworfen“.
- **Test:** `zaehler/auffaelligkeiten.spec.ts`

### ZAE-AUF-07 Alle offenen verwerfen

- **Wo:** Knopf „Alle verwerfen“ oben rechts; erscheint nur, wenn die
  gefilterte Liste offene Karten enthält
- **Recht:** `meters.read_entry`
- **Ergebnis:** alle offenen Karten der aktuellen Filterung sind verworfen;
  die Seite zeigt „Keine offenen Auffälligkeiten“.
- **Fehler und Grenzfälle:** Es werden nur die gerade gefilterten Karten
  verworfen, nicht die anderer Arten.
- **Test:** `zaehler/auffaelligkeiten.spec.ts`

### ZAE-AUF-08 Wieder öffnen

- **Wo:** Knopf „Wieder öffnen“ an einer bestätigten oder verworfenen Karte
  (Umfang „Alle“)
- **Recht:** `meters.read_entry`
- **Ergebnis:** Karte ist wieder offen.
- **Test:** `zaehler/auffaelligkeiten.spec.ts`

---

## HLF: Hilfe Gradtage (`/zaehler/hilfe/gradtage`)

### ZAE-HLF-01 Hilfe lesen und zurück

- **Wo:** über ZAE-AUS-14 oder direkt per Pfad
- **Ergebnis:** Erklärung, was Gradtagzahlen sind und wie der
  witterungsbereinigte Heizverbrauch entsteht. Der Pfeil führt zur vorigen
  Seite im Modul, sonst zur Liste.
- **Test:** `zaehler/auswertungen.spec.ts`

---

## Übersicht aller Kennungen

| Kennung | Aktion | Recht | Test |
|---|---|---|---|
| ZAE-LST-01 | Zähler öffnen | view | `zaehler/liste.spec.ts` |
| ZAE-LST-02 | Zu den Auswertungen wechseln | view | `zaehler/liste.spec.ts` |
| ZAE-LST-03 | Zähler anlegen | manage | `zaehler/liste.spec.ts` |
| ZAE-LST-04 | Zähler bearbeiten | manage + Besitzer | `zaehler/liste.spec.ts` |
| ZAE-LST-05 | Zähler löschen | manage + Besitzer | `zaehler/liste.spec.ts` |
| ZAE-LST-06 | Zähler ablegen | view | `zaehler/liste.spec.ts` |
| ZAE-LST-07 | Liste auf Sammelmappe einschränken | view | `zaehler/liste.spec.ts` |
| ZAE-LST-08 | Haushalt festlegen | manage + Gruppenbesitzer | `zaehler/haushalt.seriell.spec.ts` |
| ZAE-LST-09 | Alle privaten Zähler teilen | manage | `zaehler/haushalt.seriell.spec.ts` |
| ZAE-LST-10 | Leere Liste | view | `zaehler/liste.spec.ts` (Zählerliste als feste Antwort) |
| ZAE-DET-01 | Zurück | view | `zaehler/detail.spec.ts` |
| ZAE-DET-02 | Link teilen | view | `zaehler/detail.spec.ts` |
| ZAE-DET-03 | Zähler ablegen | view | `zaehler/detail.spec.ts` |
| ZAE-DET-04 | Zähler bearbeiten | manage + Besitzer | `zaehler/detail.spec.ts` |
| ZAE-DET-05 | Zähler löschen | manage + Besitzer | `zaehler/detail.spec.ts` |
| ZAE-DET-06 | Verbrauchsreport umschalten | view | `zaehler/detail.spec.ts` |
| ZAE-DET-07 | Gerät ersetzen | manage + Besitzer | `zaehler/detail.spec.ts` |
| ZAE-DET-08 | Gerät bearbeiten | manage + Besitzer | `zaehler/detail.spec.ts` |
| ZAE-DET-09 | Neuestes Gerät löschen | manage + Besitzer | `zaehler/detail.spec.ts` |
| ZAE-DET-10 | Ablesung erfassen | read_entry | `zaehler/detail.spec.ts` |
| ZAE-DET-11 | Zählerstand per Foto erkennen | read_entry | `zaehler/detail.spec.ts` (OCR feste Antwort) |
| ZAE-DET-12 | Ablesung bearbeiten | read_entry (eigene) / manage | `zaehler/detail.spec.ts` |
| ZAE-DET-13 | Ablesung löschen | read_entry (eigene) / manage | `zaehler/detail.spec.ts` |
| ZAE-DET-14 | Ablesung ablegen | view | `zaehler/detail.spec.ts` |
| ZAE-DET-15 | Durch Ablesungen blättern | view | `zaehler/detail.spec.ts` |
| ZAE-DET-16 | Zahlung verknüpfen | finance.view + read_entry | `zaehler/detail.spec.ts` (Demo-Buchung aus `E2E_SEED_DEMO`) |
| ZAE-DET-17 | Zahlungsverknüpfung lösen | read_entry | `zaehler/detail.spec.ts` (Demo-Buchung aus `E2E_SEED_DEMO`) |
| ZAE-DET-18 | API-Schlüssel anlegen | manage + Besitzer | `zaehler/detail.spec.ts` |
| ZAE-DET-19 | API-Schlüssel löschen | manage + Besitzer | `zaehler/detail.spec.ts` |
| ZAE-DET-20 | Unbekannter Zähler | view | `zaehler/detail.spec.ts` |
| ZAE-SCH-01 | Konfiguration öffnen | read_entry | `zaehler/schnellerfassung.spec.ts` |
| ZAE-SCH-02 | Datum setzen | read_entry | `zaehler/schnellerfassung.spec.ts` |
| ZAE-SCH-03 | Einen Wert erfassen | read_entry | `zaehler/schnellerfassung.spec.ts` |
| ZAE-SCH-04 | Wert per Foto erkennen | read_entry | `zaehler/schnellerfassung.spec.ts` (OCR feste Antwort) |
| ZAE-SCH-05 | Alle Werte speichern | read_entry | `zaehler/schnellerfassung.spec.ts` |
| ZAE-SKO-01 | Zurück zur Erfassung | read_entry | `zaehler/schnellerfassung.spec.ts` |
| ZAE-SKO-02 | Zähler hinzufügen | read_entry | `zaehler/schnellerfassung.spec.ts` |
| ZAE-SKO-03 | Reihenfolge ändern | read_entry | `zaehler/schnellerfassung.spec.ts` |
| ZAE-SKO-04 | Zähler aus Liste nehmen | read_entry | `zaehler/schnellerfassung.spec.ts` |
| ZAE-SKO-05 | Leere Konfiguration | read_entry | `zaehler/schnellerfassung.spec.ts` |
| ZAE-AUS-01 | Zur Zählerliste wechseln | view | `zaehler/auswertungen.spec.ts` (leere Liste als feste Antwort) |
| ZAE-AUS-02 | Trend-Kachel öffnen | view | `zaehler/auswertungen.spec.ts` |
| ZAE-AUS-03 | Energiebericht umschalten | view | `zaehler/auswertungen.spec.ts` |
| ZAE-AUS-04 | Hilfe Energie-Kennzahlen | view | `zaehler/auswertungen.spec.ts` |
| ZAE-AUS-05 | Tarife und Annahmen öffnen | manage | `zaehler/auswertungen.spec.ts` |
| ZAE-AUS-06 | Tarif anlegen | manage | `zaehler/auswertungen.spec.ts` |
| ZAE-AUS-07 | Tarif bearbeiten | manage | `zaehler/auswertungen.spec.ts` |
| ZAE-AUS-08 | Tarif löschen | manage | `zaehler/auswertungen.spec.ts` |
| ZAE-AUS-09 | Benzinpreise abrufen | manage | `zaehler/auswertungen.spec.ts` (Ölbulletin feste Antwort) |
| ZAE-AUS-10 | Preisreihen importieren | manage | `zaehler/auswertungen.spec.ts` |
| ZAE-AUS-11 | Wohnort setzen | manage | `zaehler/auswertungen.spec.ts` (Ortssuche feste Antwort) |
| ZAE-AUS-12 | Gradtagzahlen abrufen | manage | `zaehler/auswertungen.spec.ts` (Open-Meteo feste Antwort) |
| ZAE-AUS-13 | Wohnort entfernen | manage | `zaehler/auswertungen.spec.ts` |
| ZAE-AUS-14 | Hilfe Gradtage öffnen | view | `zaehler/auswertungen.spec.ts` |
| ZAE-AUF-01 | Filtern | view | `zaehler/auffaelligkeiten.spec.ts` |
| ZAE-AUF-02 | Liste neu laden | view | `zaehler/auffaelligkeiten.spec.ts` |
| ZAE-AUF-03 | Prüfung sofort ausführen | manage | `zaehler/auffaelligkeiten.spec.ts` |
| ZAE-AUF-04 | Zähler aus Karte öffnen | view | `zaehler/auffaelligkeiten.spec.ts` |
| ZAE-AUF-05 | Bestätigen | read_entry | `zaehler/auffaelligkeiten.spec.ts` |
| ZAE-AUF-06 | Verwerfen | read_entry | `zaehler/auffaelligkeiten.spec.ts` |
| ZAE-AUF-07 | Alle offenen verwerfen | read_entry | `zaehler/auffaelligkeiten.spec.ts` |
| ZAE-AUF-08 | Wieder öffnen | read_entry | `zaehler/auffaelligkeiten.spec.ts` |
| ZAE-HLF-01 | Hilfe lesen | view | `zaehler/auswertungen.spec.ts` |
