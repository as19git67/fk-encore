# Finanzen

Das Modul führt Konten und Depots, holt Buchungen per FinTS von der Bank,
nimmt Bargeldbuchungen von Hand entgegen, verschlagwortet Buchungen (von
Hand und per KI), verknüpft Belege aus den Dokumenten, wertet Depots mit
Tageskursen aus, rechnet eine Prognose bis ins Alter, sammelt steuerrelevante
Belege und führt Betriebe (EÜR). Pläne und Hintergrund:
`documentation/plans/kurse.md`, `portfolio-*`, `betriebe-euer.md`,
`steuer-ausfuellhilfe.md`, `wertpapier-stamm.md`.

**Modulrecht:** `module.finance` schaltet den Menüpunkt „Finanzen“ frei.
Darunter gelten:

| Schlüssel | erlaubt |
|---|---|
| `finance.view` | Konten, Buchungen, Depots, Kurse, Prognose, Zahlungen, Anomalien, Steuer, Betriebe und Belegabgleich sehen und bearbeiten, soweit das Konto es erlaubt |
| `finance.accounts.manage` | Bankkontakte anlegen, synchronisieren, Sync-Zeiten, Konten importieren; Konten anlegen und Stammdaten bearbeiten |
| `finance.admin` | Konto-Zugriff anderer Nutzer vergeben |
| `data.manage` | KI-Tagging-Warteschlange, Belegwerte nachlesen |
| `documents.view` | zusätzlich nötig für die Seite Steuer |

Zusätzlich gilt je Konto ein **Konto-Zugriff** (`read` oder `write`), den
ein Admin unter Einstellungen › Konto-Zugriff vergibt. Ohne `write` lassen
sich Tags, Notizen, Belege, Aufteilung und Steuer-Markierung einer Buchung
nicht ändern; die Knöpfe sind dann ausgeblendet oder deaktiviert.

**Begriffe:**

- **Konto** ist ein Giro-, Tagesgeld-, Festgeld-, Kredit-, Bauspar-,
  Kreditkarten-, Bargeld- oder sonstiges Konto oder ein Depot. Es hängt
  optional an einem **Bankkontakt**, über den die Bank per FinTS
  abgefragt wird. Ein Bargeldkonto hat keinen Bankkontakt; seine Buchungen
  kommen von Hand.
- **Buchung** (Transaktion) ist ein Umsatz eines Kontos mit Datum, Betrag,
  Gegenseite und Verwendungszweck. Tags, Notiz, Steuer-Markierung,
  Aufteilung und verknüpfte Belege gehören dem Nutzer, nicht der Bank.
- **Tag** ist ein Schlagwort an einer Buchung. Die KI schlägt Tags vor,
  übernommen wird nur, was der Nutzer bestätigt (oder in der Stapelaktion
  erlaubt).
- **Sektion** ist eine Gruppe von Konten in der Übersicht (zum Beispiel
  „Girokonten“, „Depots“). Die Zuordnung konfiguriert der Nutzer.
- **Position** ist ein Wertpapier über alle Depots hinweg, erkannt am
  Schlüssel (ISIN oder WKN).
- **Basket** und **Sammelmappe** gelten modulübergreifend, siehe
  `sammelmappen.md`. Buchungen und Wertpapiere lassen sich ablegen.

## Seiten

| Kürzel | Seite | Pfad | Recht |
|---|---|---|---|
| `UEB` | Übersicht | `/finanzen` | `finance.view` |
| `KON` | Konten | `/finanzen/konten` | `finance.view` |
| `BUC` | Buchungen eines Kontos, einer Sektion oder einer Sammelmappe | `/finanzen/uebersicht/konto/:id`, `/finanzen/uebersicht/sektion/:name`, `/finanzen/sammelmappe/:collectionId` | `finance.view` |
| `BNE` | Bargeldbuchung erfassen | `/finanzen/umsaetze/neu` | `finance.view` |
| `BDT` | Buchungsdetails | `/finanzen/umsaetze/:id` | `finance.view` |
| `BKL` | Bankkontakte | `/finanzen/bankkontakte` | `finance.accounts.manage` |
| `BKD` | Bankkontakt | `/finanzen/bankkontakte/:id`, `/finanzen/bankkontakte/neu` | `finance.accounts.manage` |
| `SYN` | Sync-Zeiten | `/finanzen/bankkontakte/:id/zeiten` | `finance.accounts.manage` |
| `POR` | Portfolio | `/finanzen/portfolio` | `finance.view` |
| `POS` | Position | `/finanzen/portfolio/:key` | `finance.view` |
| `KUR` | Kurse | `/finanzen/kurse` | `finance.view` |
| `PRG` | Prognose | `/finanzen/prognose` | `finance.view` |
| `ZAH` | Erwartete Zahlungen | `/finanzen/zahlungen` | `finance.view` |
| `ANO` | Anomalien | `/finanzen/anomalien` | `finance.view` |
| `STR` | Steuer: Belege nach Anlage | `/finanzen/steuer` | `finance.view` und `documents.view` |
| `BET` | Betriebe | `/finanzen/betriebe` | `finance.view` |
| `BTD` | Betrieb | `/finanzen/betriebe/:id` | `finance.view` |
| `BAB` | Belegabgleich | `/finanzen/belegabgleich` | `finance.view` |
| `ZUG` | Einstellungen: Konto-Zugriff | `/finanzen/admin/zugriff` | `finance.admin` |
| `KIT` | Einstellungen: KI-Tagging | `/finanzen/ki-tagging` | `data.manage` |
| `HLF` | Hilfe: Bankkontakte | `/finanzen/bankkontakte/hilfe` | `finance.accounts.manage` |

Das Untermenü zeigt „Übersicht“, „Erwartete Zahlungen“, „Anomalien“,
„Portfolio“, „Kurse“, „Bankkontakte“, „Prognose“, „Steuer“ (mit „Belege
nach Anlage“ und „Betriebe“), „Belegabgleich“, „Einstellungen“ (mit
„Konto-Zugriff“, „KI-Tagging“ und darunter „Mein Profil“) und „Konten“.
Die alten Pfade `/finanzen/umsaetze`, `/finanzen/analyse` und
`/finanzen/lastschriften` leiten auf Übersicht bzw. Erwartete Zahlungen um.

---

## UEB: Übersicht (`/finanzen`)

Die Seite zeigt die Konten nach Sektionen gruppiert, je Konto Name, Bank,
Saldo und Datum des letzten Standes, je Sektion die Summe. Darüber
steht eine Kachel mit der Zahl der offenen Anomalien. Ein Konto ohne
Zuordnung steht in „Weitere Konten“.

### FIN-UEB-01 Buchungen eines Kontos öffnen

- **Wo:** Zeile eines Kontos
- **Recht:** `finance.view`
- **Vorbedingung:** mindestens ein sichtbares Konto
- **Schritte:**
  1. Zeile anklicken oder mit Enter öffnen.
- **Ergebnis:** Seite `BUC` für dieses Konto (`/finanzen/uebersicht/konto/:id`).
- **Fehler und Grenzfälle:** Ein geschlossenes Konto wird nur gezeigt,
  wenn es in der Konfiguration eingeblendet ist.
- **Test:** –

### FIN-UEB-02 Buchungen einer Sektion öffnen

- **Wo:** Überschrift einer Sektion
- **Recht:** `finance.view`
- **Vorbedingung:** Sektion mit mindestens einem Konto
- **Schritte:**
  1. Überschrift anklicken.
- **Ergebnis:** Seite `BUC` mit den Buchungen aller Konten der Sektion
  (`/finanzen/uebersicht/sektion/:name`).
- **Fehler und Grenzfälle:** keine
- **Test:** –

### FIN-UEB-03 Anomalien öffnen

- **Wo:** Kachel „Anomalien“ über den Sektionen
- **Recht:** `finance.view`
- **Vorbedingung:** keine
- **Schritte:**
  1. Kachel anklicken.
- **Ergebnis:** Seite `ANO`.
- **Fehler und Grenzfälle:** Ohne offene Anomalien zeigt die Kachel „0“ und
  führt trotzdem auf die Seite.
- **Test:** –

### FIN-UEB-04 Übersicht konfigurieren

- **Wo:** Knopf „Übersicht konfigurieren“ in `#actions`
- **Recht:** `finance.view`
- **Vorbedingung:** keine
- **Schritte:**
  1. Knopf drücken; Dialog öffnet sich mit den Sektionen und darunter den
     Konten.
  2. Sektionen umbenennen, neu anlegen, löschen oder mit den Pfeilen
     umsortieren.
  3. Konten einer Sektion zuordnen und innerhalb der Sektion sortieren;
     geschlossene Konten ein- oder ausblenden.
  4. „Speichern“.
- **Ergebnis:** Übersicht zeigt die neue Anordnung; sie ist je Nutzer
  gespeichert und bleibt nach Neuladen.
- **Fehler und Grenzfälle:** Eine Sektion mit Konten lässt sich nicht
  löschen, ohne die Konten vorher zu verschieben. „Abbrechen“ verwirft.
- **Test:** –

---

## KON: Konten (`/finanzen/konten`)

Tabelle aller sichtbaren Konten mit Bezeichnung, Typ, Währung, IBAN oder
Kontonummer, Bankkontakt, Status (offen oder geschlossen) und Saldo.

### FIN-KON-01 Konto anlegen

- **Wo:** Knopf „Neues Konto“
- **Recht:** `finance.accounts.manage`
- **Vorbedingung:** keine
- **Schritte:**
  1. Knopf drücken; Dialog „Neues Konto“.
  2. Label eingeben (zum Beispiel `Haushaltskasse`).
  3. Kontotyp wählen: Giro, Tagesgeld, Festgeld, Kredit, Depot, Bausparen,
     Kreditkarte, Bargeld oder Sonstige.
  4. Währung (vorbelegt EUR), optional Kontonummer, IBAN und Bankzugang.
  5. „Speichern“.
- **Ergebnis:** Zeile erscheint in der Tabelle und in der Übersicht unter
  „Weitere Konten“, bis es einer Sektion zugeordnet ist.
- **Fehler und Grenzfälle:** Label ist Pflicht. Ein Bargeldkonto braucht
  keinen Bankzugang; alle anderen Typen bekommen ihre Buchungen nur über
  einen Bankkontakt oder bleiben leer.
- **Test:** –

### FIN-KON-02 Stammdaten bearbeiten

- **Wo:** Stift-Knopf in der Zeile
- **Recht:** `finance.accounts.manage`
- **Vorbedingung:** Konto vorhanden
- **Schritte:**
  1. Stift drücken; Dialog „Stammdaten bearbeiten“ mit denselben Feldern
     wie beim Anlegen.
  2. Felder ändern; zum Schließen „Geschlossen“ anhaken und das
     Schließdatum setzen.
  3. „Speichern“.
- **Ergebnis:** Tabelle und Übersicht zeigen die neuen Werte; ein
  geschlossenes Konto verschwindet aus der Übersicht, sofern geschlossene
  dort ausgeblendet sind.
- **Fehler und Grenzfälle:** Das Schließdatum ist Pflicht, sobald
  „Geschlossen“ gesetzt ist. Der Kontotyp eines Kontos mit Buchungen lässt
  sich ändern, die Buchungen bleiben.
- **Test:** –

### FIN-KON-03 Bargeldbuchung aus der Kontenliste

- **Wo:** Knopf „Manuelle Buchung“ in der Zeile eines Bargeldkontos
- **Recht:** `finance.view` und `write` auf dem Konto
- **Vorbedingung:** Konto vom Typ Bargeld
- **Schritte:**
  1. Knopf drücken.
- **Ergebnis:** Seite `BNE` mit diesem Konto vorausgewählt.
- **Fehler und Grenzfälle:** Bei anderen Kontotypen fehlt der Knopf.
- **Test:** –

### FIN-KON-04 Buchungen des Kontos öffnen

- **Wo:** Zeile
- **Recht:** `finance.view`
- **Vorbedingung:** keine
- **Schritte:**
  1. Zeile anklicken.
- **Ergebnis:** Seite `BUC` des Kontos.
- **Fehler und Grenzfälle:** keine
- **Test:** –

---

## BUC: Buchungen (`/finanzen/uebersicht/konto/:id`, `…/sektion/:name`, `/finanzen/sammelmappe/:collectionId`)

Die Seite listet Buchungen nach Tagen gruppiert, je Karte Gegenseite,
Verwendungszweck, Tags, Betrag und Symbole für Beleg, Notiz, Steuer und
Aufteilung. Die Toolbar zeigt Suche, Filter, Sortierung, Ergebniszahl und
die Summe Σ der gefilterten Buchungen. Bei einem Depot steht über der
Liste der Bestand mit den Positionen, darunter realisierte Gewinne und
Verluste je Jahr. Die Seite zeigt höchstens eine feste Zahl Buchungen je
Ladevorgang und sagt am Ende, wenn der Filter enger sein muss.

### FIN-BUC-01 Suchen

- **Wo:** Suchfeld der Toolbar (`/` fokussiert es)
- **Recht:** `finance.view`
- **Vorbedingung:** keine
- **Schritte:**
  1. Begriff eingeben, zum Beispiel `Strom`.
- **Ergebnis:** Nach kurzer Verzögerung zeigt die Liste nur Buchungen,
  deren Gegenseite, Verwendungszweck, Notiz oder Tag den Begriff enthält;
  `q` steht in der URL, Σ und Ergebniszahl passen sich an.
- **Fehler und Grenzfälle:** Escape im Feld leert es. Ein Reload mit `q`
  zeigt dieselbe Liste.
- **Test:** –

### FIN-BUC-02 Filtern

- **Wo:** Knopf „Filter“ der Toolbar; Panel bleibt offen (Schalter mit
  Zähler)
- **Recht:** `finance.view`
- **Vorbedingung:** keine
- **Schritte:**
  1. Filter öffnen.
  2. Zeitraum über die Schnellwahl (Jahr, Monat oder Von/Bis), Tags,
     Steuer (nur steuerrelevant, nur nicht steuerrelevant), Betrag ab/bis,
     Richtung (Einnahmen, Ausgaben) und Sammelmappe setzen.
- **Ergebnis:** Liste, Σ und Ergebniszahl folgen; jeder Filter steht als
  Chip über der Liste und in der URL; ein Chip lässt sich einzeln
  entfernen.
- **Fehler und Grenzfälle:** „Betrag ab“ größer „Betrag bis“ liefert
  eine leere Liste, keinen Fehler. Die Zahl der Chips entspricht dem
  Zähler am Filter-Knopf.
- **Test:** –

### FIN-BUC-03 Sortieren

- **Wo:** Sortiermenü der Toolbar
- **Recht:** `finance.view`
- **Vorbedingung:** keine
- **Schritte:**
  1. Feld (Datum, Betrag) und Richtung wählen.
- **Ergebnis:** Reihenfolge ändert sich, `sortBy`/`sortDir` stehen in der
  URL.
- **Fehler und Grenzfälle:** keine
- **Test:** –

### FIN-BUC-04 Buchung öffnen

- **Wo:** Karte einer Buchung
- **Recht:** `finance.view`
- **Vorbedingung:** keine
- **Schritte:**
  1. Karte anklicken oder mit Enter öffnen.
- **Ergebnis:** Seite `BDT`. Zurück landet auf derselben Karte (Anker).
- **Fehler und Grenzfälle:** keine
- **Test:** –

### FIN-BUC-05 Auswahlmodus und Mehrfachauswahl

- **Wo:** Knopf „Auswählen“ der Toolbar; Checkbox je Karte
- **Recht:** `finance.view`
- **Vorbedingung:** mindestens eine Buchung
- **Schritte:**
  1. „Auswählen“ drücken.
  2. Karten anhaken; Umschalt+Klick wählt den Bereich, Strg/Cmd+A alles.
- **Ergebnis:** `SelectionBar` erscheint mit Zähler und Summe der
  gewählten Buchungen; Escape beendet den Modus und leert die Auswahl.
- **Fehler und Grenzfälle:** Die Auswahl ist unabhängig vom Basket.
- **Test:** `finance.spec.ts` („Auswahl-Counter spiegelt Klick auf
  Selection-Checkbox“, „Pfeiltasten-Navigation in der DataTable bewegt
  den Fokus zeilenweise“)

### FIN-BUC-06 Tags im Stapel setzen

- **Wo:** Aktion „Tags“ in der `SelectionBar`
- **Recht:** `write` auf den Konten
- **Vorbedingung:** Auswahl nicht leer
- **Schritte:**
  1. Aktion drücken; Dialog mit Tag-Liste und Suchfeld.
  2. Tags anhaken (hinzufügen) oder abhaken (entfernen); Umgang mit
     KI-Tags wählen (behalten, übernehmen oder verwerfen).
  3. „Speichern“.
- **Ergebnis:** Alle gewählten Buchungen tragen die Tags; die Karten
  zeigen sie sofort.
- **Fehler und Grenzfälle:** Ohne Auswahl öffnet sich der Dialog nicht.
  Escape schließt ohne Änderung.
- **Test:** `finance.spec.ts` („Batch-Tag-Dialog öffnet sich erst nach
  Auswahl, schließt mit Escape“)

### FIN-BUC-07 Auswahl ablegen (Basket oder Sammelmappe)

- **Wo:** Aktion „Ablegen“ (grünes Import-Symbol) in der `SelectionBar`;
  dieselbe Aktion im Menü einer Karte
- **Recht:** `finance.view`
- **Vorbedingung:** Auswahl nicht leer
- **Schritte:**
  1. „Ablegen“; Dialog mit Basket oben, passenden Mappen und „Neue
     Sammelmappe“.
  2. Ziel wählen, bestätigen.
- **Ergebnis:** Buchungen liegen im Basket (Badge im Hauptmenü zählt
  hoch) oder in der Mappe. Details in `sammelmappen.md`.
- **Fehler und Grenzfälle:** Ein Ding, das schon im Ziel liegt, ist dort
  angehakt.
- **Test:** –

### FIN-BUC-08 Als Regel-Mappe speichern

- **Wo:** Knopf „Als Regel-Mappe“ der Toolbar
- **Recht:** `finance.view`
- **Vorbedingung:** mindestens ein Filter oder Suchbegriff gesetzt
- **Schritte:**
  1. Knopf drücken; Dialog „Als Regel-Sammelmappe speichern“.
  2. Name eingeben, optional Gruppierung der Zwischensummen (Tag, Monat,
     Quartal, Jahr).
  3. „Speichern“, danach „Mappe öffnen“ oder „Schließen“.
- **Ergebnis:** Neue Regel-Mappe, deren Inhalt der aktuelle Filter ist und
  die Zwischensummen zeigt.
- **Fehler und Grenzfälle:** Leerer Name deaktiviert „Speichern“.
- **Test:** –

### FIN-BUC-09 Bargeldbuchung anlegen

- **Wo:** Knopf „Bargeldbuchung“ der Toolbar
- **Recht:** `write` auf dem Konto
- **Vorbedingung:** Bargeldkonto geöffnet
- **Schritte:**
  1. Knopf drücken.
- **Ergebnis:** Seite `BNE` mit diesem Konto.
- **Fehler und Grenzfälle:** Bei einem Bankkonto fehlt der Knopf.
- **Test:** –

### FIN-BUC-10 Summe der gefilterten Buchungen lesen

- **Wo:** Σ in der Toolbar; Popover beim Anklicken
- **Recht:** `finance.view`
- **Vorbedingung:** keine
- **Schritte:**
  1. Σ anklicken.
- **Ergebnis:** Popover mit Einnahmen, Ausgaben und Saldo der Liste; im
  Auswahlmodus zusätzlich die Summe der Auswahl.
- **Fehler und Grenzfälle:** Bei mehreren Währungen je Währung eine Zeile.
- **Test:** –

### FIN-BUC-11 Depotbestand lesen und Position öffnen

- **Wo:** Tabelle „Bestand“ über der Buchungsliste eines Depots
- **Recht:** `finance.view`
- **Vorbedingung:** Konto vom Typ Depot mit Bestand
- **Schritte:**
  1. Zeile einer Position aufklappen: Verlauf des Bestands und Fakten
     (Kaufkurs, Stück, Wert).
  2. Name anklicken.
- **Ergebnis:** Seite `POS` des Wertpapiers.
- **Fehler und Grenzfälle:** Ohne Tageskurs steht der letzte Bank-Snapshot.
- **Test:** –

### FIN-BUC-12 Depot-Transaktion von Hand anlegen oder löschen

- **Wo:** Knopf „Transaktion hinzufügen“ in der Bestandstabelle; Papierkorb
  an einer manuellen Transaktion
- **Recht:** `write` auf dem Depot
- **Vorbedingung:** Depot
- **Schritte:**
  1. Hinzufügen drücken; Datum, Art (Kauf, Verkauf, Ausschüttung), Stück,
     Kurs und Gebühren eintragen, speichern.
  2. Zum Löschen den Papierkorb drücken und bestätigen.
- **Ergebnis:** Bestand und realisierte Gewinne rechnen neu.
- **Fehler und Grenzfälle:** Transaktionen der Bank lassen sich nicht
  löschen; nur manuelle haben den Papierkorb.
- **Test:** –

### FIN-BUC-13 Sammelmappe mit Buchungen öffnen

- **Wo:** Pfad `/finanzen/sammelmappe/:collectionId` (aus den
  Sammelmappen, dem Basket-Drawer oder einem Filter-Chip)
- **Recht:** `finance.view` und Zugriff auf die Mappe
- **Vorbedingung:** Mappe mit Buchungen
- **Schritte:**
  1. Mappe öffnen.
- **Ergebnis:** Dieselbe Liste mit Chip „Sammelmappe: …“; bei einer
  Regel-Mappe mit Gruppierung darüber die Zwischensummen.
- **Fehler und Grenzfälle:** Eine fremde Mappe ohne Freigabe liefert
  „nicht gefunden“ im `#notice`.
- **Test:** –

### FIN-BUC-14 Weitere Buchungen laden

- **Wo:** Hinweis am Ende der Liste
- **Recht:** `finance.view`
- **Vorbedingung:** mehr Buchungen als das Seitenlimit
- **Schritte:**
  1. Bis ans Ende scrollen.
- **Ergebnis:** Hinweis nennt das Limit und bittet, den Zeitraum oder
  Filter einzugrenzen; Σ gilt für alle gefilterten Buchungen, nicht nur
  die gezeigten.
- **Fehler und Grenzfälle:** keine
- **Test:** –

---

## BNE: Bargeldbuchung erfassen (`/finanzen/umsaetze/neu`)

Formular für eine Buchung auf einem Bargeldkonto. Oben steht der
Kontoname, darunter die Richtung, der Betrag, das Datum, der Empfänger,
Tags, Notiz und „Dokumente verknüpfen“. Unten „Zuletzt verwendet“ mit den
letzten Empfängern.

### FIN-BNE-01 Buchung erfassen

- **Wo:** Formular
- **Recht:** `write` auf einem Bargeldkonto
- **Vorbedingung:** mindestens ein Bargeldkonto; sonst steht nur die
  Warnung „kein Bargeldkonto“
- **Schritte:**
  1. Richtung umschalten (Knopf „− Ausgabe“ / „+ Einnahme“, vorbelegt
     Ausgabe).
  2. Betrag eingeben (Platzhalter `0,00`).
  3. Datum setzen; „Heute“ und „Gestern“ als Schnellwahl.
  4. Empfänger eingeben; die Liste schlägt bekannte Namen vor, ein neuer
     Name erscheint als „+ Neu: …“.
  5. Optional Tags und Notiz.
  6. „Speichern“.
- **Ergebnis:** Buchung erscheint im Konto, die Seite kehrt zur
  Buchungsliste zurück; der Empfänger steht künftig unter „Zuletzt
  verwendet“.
- **Fehler und Grenzfälle:** Betrag 0 oder leer wird abgewiesen (rotes
  Banner oben). „Abbrechen“ verwirft. Ein Datum in der Zukunft ist
  erlaubt.
- **Test:** –

### FIN-BNE-02 Empfänger aus „Zuletzt verwendet“ übernehmen

- **Wo:** Chips unter dem Formular
- **Recht:** wie `FIN-BNE-01`
- **Vorbedingung:** frühere Bargeldbuchungen
- **Schritte:**
  1. Chip anklicken.
- **Ergebnis:** Empfänger und dessen letzte Tags stehen im Formular.
- **Fehler und Grenzfälle:** keine
- **Test:** –

### FIN-BNE-03 Beleg fotografieren

- **Wo:** Kamera-Knopf „Beleg fotografieren“ unter „Dokumente verknüpfen“
- **Recht:** wie `FIN-BNE-01`, zusätzlich `documents.upload`
- **Vorbedingung:** Gerät mit Kamera oder Dateiauswahl
- **Schritte:**
  1. Knopf drücken, Foto aufnehmen oder Datei wählen.
  2. Warten, bis der Status „Beleg wird verarbeitet …“ verschwindet.
- **Ergebnis:** Das Foto wird als Dokument hochgeladen, OCR liest Betrag
  und Datum und füllt leere Felder vor; das Dokument steht unter
  „Ausgewählte Dokumente“ und wird beim Speichern verknüpft.
- **Fehler und Grenzfälle:** Solange der Upload läuft, heißt der
  Speichern-Knopf „Beleg wird verarbeitet …“ und ist gesperrt. Ein
  Upload-Fehler steht unter dem Formular.
- **Test:** –

### FIN-BNE-04 Dokument suchen und verknüpfen

- **Wo:** Suchfeld „Dokument suchen …“ und Lupe
- **Recht:** wie `FIN-BNE-01`, zusätzlich `documents.view`
- **Vorbedingung:** Dokumente vorhanden
- **Schritte:**
  1. Begriff eingeben, Lupe drücken.
  2. In „Gefundene Dokumente“ bei einem Treffer „Auswählen“.
  3. Zum Entfernen in „Ausgewählte Dokumente“ das Kreuz drücken.
- **Ergebnis:** Nach dem Speichern sind die Dokumente mit der Buchung
  verknüpft (Panel „Verknüpfte Belege“ auf `BDT`).
- **Fehler und Grenzfälle:** Kein Treffer zeigt „Nichts gefunden“; ein
  Suchfehler steht rot unter dem Feld.
- **Test:** –

---

## BDT: Buchungsdetails (`/finanzen/umsaetze/:id`)

Detailseite mit Zurück-Pfeil, Blättern durch den Basket, „Ablegen“,
Teilen-Link und „Speichern“. Karten: Kopf mit Betrag, Datum, Gegenseite
und IBAN, „Verknüpfte Belege“, „Tags“, „Notiz“, „KI-Vorschläge“, „Steuer“,
„Aufteilung“, „Weitere Informationen“ und „Wiederkehrende Buchung“ mit
früheren Buchungen derselben Gegenseite.

### FIN-BDT-01 Zurück und Abbrechen

- **Wo:** Pfeil links vom Titel; „Abbrechen“ erscheint statt des Pfeils,
  sobald etwas geändert ist
- **Recht:** `finance.view`
- **Vorbedingung:** keine
- **Schritte:**
  1. Pfeil oder „Abbrechen“ drücken.
- **Ergebnis:** Zurück zur Liste (History, wenn die vorige Seite im Modul
  lag, sonst die Übersicht); ungespeicherte Änderungen werden verworfen.
- **Fehler und Grenzfälle:** keine Rückfrage.
- **Test:** –

### FIN-BDT-02 Durch den Basket blättern

- **Wo:** Pfeile „Vorherige/Nächste Buchung im Basket“ neben dem Titel
- **Recht:** `finance.view`
- **Vorbedingung:** Buchung liegt im Basket mit weiteren Buchungen
- **Schritte:**
  1. Pfeil drücken.
- **Ergebnis:** Nächste Buchung des Baskets öffnet sich; Zähler
  „n von m“ läuft mit.
- **Fehler und Grenzfälle:** Außerhalb des Baskets fehlen die Pfeile.
- **Test:** –

### FIN-BDT-03 Ablegen

- **Wo:** `FileButton` in `#actions`
- **Recht:** `finance.view`
- **Vorbedingung:** keine
- **Schritte:**
  1. Knopf drücken, Ziel wählen (siehe `FIN-BUC-07`).
- **Ergebnis:** Knopf wird grün, solange die Buchung im Basket liegt.
- **Fehler und Grenzfälle:** keine
- **Test:** –

### FIN-BDT-04 Link teilen

- **Wo:** `ShareLink` in `#actions`
- **Recht:** `finance.view`
- **Vorbedingung:** keine
- **Schritte:**
  1. Knopf drücken.
- **Ergebnis:** Link der Seite in der Zwischenablage oder im Teilen-Menü
  des Geräts.
- **Fehler und Grenzfälle:** Der Empfänger braucht selbst Zugriff auf das
  Konto.
- **Test:** –

### FIN-BDT-05 Felder einer Bargeldbuchung ändern

- **Wo:** Kopfkarte
- **Recht:** `write` auf dem Konto
- **Vorbedingung:** Buchung eines Bargeldkontos
- **Schritte:**
  1. Datum, Betrag oder Gegenseite ändern.
  2. „Speichern“.
- **Ergebnis:** Werte sind gespeichert, Liste zeigt sie.
- **Fehler und Grenzfälle:** Bei Bankbuchungen sind diese Felder nur
  lesbar.
- **Test:** –

### FIN-BDT-06 IBAN kopieren

- **Wo:** Kopier-Knopf neben der IBAN der Gegenseite
- **Recht:** `finance.view`
- **Vorbedingung:** Buchung mit IBAN
- **Schritte:**
  1. Knopf drücken.
- **Ergebnis:** IBAN in der Zwischenablage, kurzer Toast.
- **Fehler und Grenzfälle:** keine
- **Test:** –

### FIN-BDT-07 Tag hinzufügen oder entfernen

- **Wo:** Karte „Tags“, Feld mit Autovervollständigung und Knopf „Tag
  hinzufügen“
- **Recht:** `write`
- **Vorbedingung:** keine
- **Schritte:**
  1. Tag eintippen, Vorschlag wählen oder Enter; Chip erscheint.
  2. Kreuz am Chip entfernt ihn.
  3. „Speichern“.
- **Ergebnis:** Tags gespeichert; neue Tags stehen künftig in der
  Autovervollständigung.
- **Fehler und Grenzfälle:** Ein Tag kann nur einmal je Buchung stehen.
- **Test:** `finance.spec.ts` („Tag-AutoComplete: Eingeben + Enter fügt
  Chip hinzu“)

### FIN-BDT-08 Notiz schreiben

- **Wo:** Karte „Notiz“
- **Recht:** `write`
- **Vorbedingung:** keine
- **Schritte:**
  1. Text eingeben, „Speichern“.
- **Ergebnis:** Notiz gespeichert; die Karte in der Liste zeigt das
  Notiz-Symbol und die Suche findet den Text.
- **Fehler und Grenzfälle:** keine
- **Test:** –

### FIN-BDT-09 KI-Vorschläge annehmen oder ablehnen

- **Wo:** Karte „KI-Vorschläge“ mit „Übernehmen“/„Ablehnen“ je Vorschlag
  und „Alle übernehmen“/„Alle ablehnen“
- **Recht:** `write`
- **Vorbedingung:** das KI-Tagging hat Vorschläge für diese Buchung
- **Schritte:**
  1. Je Vorschlag entscheiden oder alle auf einmal.
- **Ergebnis:** Übernommene Tags wandern in die Karte „Tags“, abgelehnte
  verschwinden; die Entscheidung wird sofort gespeichert und fließt in
  spätere Vorschläge ein.
- **Fehler und Grenzfälle:** Ohne Vorschläge fehlt die Karte.
- **Test:** –

### FIN-BDT-10 Steuerrelevanz setzen

- **Wo:** Karte „Steuer“, Checkbox „Buchung ist steuerrelevant“
- **Recht:** `write`
- **Vorbedingung:** keine
- **Schritte:**
  1. Haken setzen oder entfernen, „Speichern“.
- **Ergebnis:** Buchung erscheint in der Ausfüllhilfe unter
  „Steuerrelevante Buchungen nach Tag“ und lässt sich in `BUC` nach Steuer
  filtern.
- **Fehler und Grenzfälle:** keine
- **Test:** –

### FIN-BDT-11 Buchung aufteilen

- **Wo:** Karte „Aufteilung“, Knopf „Buchung aufteilen“ bzw. „Aufteilung
  bearbeiten“
- **Recht:** `write`
- **Vorbedingung:** keine
- **Schritte:**
  1. Knopf drücken; Dialog „Buchung aufteilen“ mit Zeilen aus Teilbetrag,
     Tags und Notiz.
  2. „Teil hinzufügen“ für weitere Zeilen; der Knopf „Restbetrag
     eintragen“ füllt die Differenz in eine Zeile; Kreuz entfernt eine
     Zeile.
  3. „Speichern“.
- **Ergebnis:** Die Karte zeigt die Teile mit Betrag, Tags und Notiz;
  Auswertungen nach Tag rechnen mit den Teilen.
- **Fehler und Grenzfälle:** „Speichern“ bleibt gesperrt, solange die
  Teile nicht genau den Buchungsbetrag ergeben.
- **Test:** –

### FIN-BDT-12 Beleg fotografieren

- **Wo:** Kamera-Knopf in „Verknüpfte Belege“
- **Recht:** `write` und `documents.upload`
- **Vorbedingung:** keine
- **Schritte:**
  1. Foto aufnehmen oder Datei wählen.
- **Ergebnis:** Dokument wird hochgeladen und sofort verknüpft; die Zeile
  erscheint mit Titel und Datum.
- **Fehler und Grenzfälle:** Upload-Fehler als Banner in der Karte.
- **Test:** –

### FIN-BDT-13 Beleg suchen und verknüpfen

- **Wo:** Knopf „Beleg verknüpfen“ öffnet das Panel „Dokument suchen“
- **Recht:** `write` und `documents.view`
- **Vorbedingung:** keine
- **Schritte:**
  1. Begriff eingeben, „Suchen“; Treffer mit Vorschau der ersten Seite
     (Auge-Knopf blendet sie ein).
  2. „Verknüpfen“ an einem Treffer.
- **Ergebnis:** Dokument steht unter „Verknüpfte Belege“; auf der
  Dokumentseite erscheint die Buchung umgekehrt.
- **Fehler und Grenzfälle:** „Verknüpfen schließen“ klappt das Panel zu.
- **Test:** –

### FIN-BDT-14 Vorgeschlagene Belege annehmen oder verwerfen

- **Wo:** Abschnitt „Mögliche Treffer“ im Panel
- **Recht:** `write`
- **Vorbedingung:** der Belegabgleich hat Kandidaten (Betrag und Datum
  passen)
- **Schritte:**
  1. „Annehmen“ oder „Verwerfen“ je Treffer.
- **Ergebnis:** Angenommen = verknüpft; verworfen = taucht nicht wieder
  auf.
- **Fehler und Grenzfälle:** keine
- **Test:** –

### FIN-BDT-15 Beleg öffnen oder Verknüpfung trennen

- **Wo:** Titel des Belegs (öffnet) und Kreuz „Belegverknüpfung trennen“
- **Recht:** öffnen `documents.view`, trennen `write`
- **Vorbedingung:** verknüpfter Beleg
- **Schritte:**
  1. Titel drücken: Dokumentseite mit Rücksprung zur Buchung.
  2. Kreuz drücken, Rückfrage bestätigen.
- **Ergebnis:** Verknüpfung entfernt; das Dokument bleibt bestehen.
- **Fehler und Grenzfälle:** keine
- **Test:** –

### FIN-BDT-16 Wiederkehrende Buchung ansehen und Tags übernehmen

- **Wo:** Karte „Wiederkehrende Buchung“ mit früheren Buchungen derselben
  Gegenseite
- **Recht:** `finance.view`; übernehmen `write`
- **Vorbedingung:** frühere Buchungen mit gleicher Gegenseite
- **Schritte:**
  1. Zeile anklicken; Dialog „Wiederkehrende Buchung“ mit Datum,
     Wertstellung, Betrag, Gegenseite, IBAN, Verwendung und Tags.
  2. „Transaktion öffnen“ wechselt dorthin, „Tags übernehmen“ kopiert die
     Tags in die aktuelle Buchung.
- **Ergebnis:** Tags stehen (noch ungespeichert) in der Karte „Tags“.
- **Fehler und Grenzfälle:** keine
- **Test:** –

### FIN-BDT-17 Bargeldbuchung löschen

- **Wo:** Knopf „Löschen“ am Seitenende
- **Recht:** `write`
- **Vorbedingung:** Buchung eines Bargeldkontos
- **Schritte:**
  1. Knopf drücken, Rückfrage bestätigen.
- **Ergebnis:** Buchung ist weg, Seite kehrt zur Liste zurück.
- **Fehler und Grenzfälle:** Bankbuchungen haben den Knopf nicht.
- **Test:** –

---

## BKL: Bankkontakte (`/finanzen/bankkontakte`)

Tabelle der FinTS-Zugänge mit Name, Bank, letztem Sync, nächstem
geplanten Sync und Knopf „Sync jetzt“. Darüber Karten „TAN offen“ (ein
Sync wartet auf eine TAN) und „Nächster Sync“. Hintergrund in `HLF`.

### FIN-BKL-01 Bankkontakt anlegen

- **Wo:** Knopf „Neu anlegen“
- **Recht:** `finance.accounts.manage`
- **Vorbedingung:** keine
- **Schritte:**
  1. Knopf drücken: Seite `BKD` unter `/finanzen/bankkontakte/neu`.
  2. Name, Bankleitzahl, Anmeldename, Server-URL und PIN eintragen,
     „Speichern“.
  3. „Abrufen“ holt die TAN-Verfahren der Bank; eines wählen und speichern.
- **Ergebnis:** Kontakt steht in der Tabelle; unter „Nicht zugeordnete
  Bankkonten“ erscheinen die Konten der Bank.
- **Fehler und Grenzfälle:** Falsche PIN oder URL meldet die Bank beim
  Abrufen; die Meldung steht als Banner. Die PIN wird nie angezeigt.
- **Test:** –

### FIN-BKL-02 Sync jetzt

- **Wo:** Knopf „Sync jetzt“ in der Zeile
- **Recht:** `finance.accounts.manage`
- **Vorbedingung:** Kontakt mit TAN-Verfahren und zugeordneten Konten
- **Schritte:**
  1. Knopf drücken.
  2. Verlangt die Bank eine TAN, öffnet sich der TAN-Dialog
     (`FIN-BKL-03`).
- **Ergebnis:** Neue Buchungen stehen in den Konten, „Letzter Sync“ zeigt
  jetzt.
- **Fehler und Grenzfälle:** Ein laufender Sync sperrt den Knopf; ein
  Fehler der Bank steht in der Zeile.
- **Test:** –

### FIN-BKL-03 TAN eingeben

- **Wo:** Dialog „TAN erforderlich“ (öffnet sich bei Bedarf überall im
  Modul)
- **Recht:** `finance.accounts.manage`
- **Vorbedingung:** Bank hat eine TAN angefordert
- **Schritte:**
  1. Herausforderung lesen (Text; bei photoTAN das Bild scannen).
  2. TAN eintippen, „Bestätigen“.
- **Ergebnis:** Sync läuft weiter.
- **Fehler und Grenzfälle:** „Abbrechen“ bricht den Sync ab. Nach einem
  endgültigen Fehler heißt der Knopf „Schließen“ und zeigt die Meldung
  der Bank. Eine offene TAN steht als Karte „TAN offen“, von der aus sich
  der Dialog wieder öffnen lässt.
- **Test:** –

### FIN-BKL-04 Bankkontakt öffnen

- **Wo:** Zeile
- **Recht:** `finance.accounts.manage`
- **Vorbedingung:** keine
- **Schritte:**
  1. Zeile anklicken.
- **Ergebnis:** Seite `BKD`.
- **Fehler und Grenzfälle:** keine
- **Test:** –

### FIN-BKL-05 Hilfe öffnen

- **Wo:** Fragezeichen-Knopf in `#actions`
- **Recht:** `finance.accounts.manage`
- **Vorbedingung:** keine
- **Schritte:**
  1. Knopf drücken.
- **Ergebnis:** Seite `HLF`.
- **Fehler und Grenzfälle:** keine
- **Test:** –

---

## BKD: Bankkontakt (`/finanzen/bankkontakte/:id`)

Detailseite mit Karten „Stammdaten“, „Sync“, „Nicht zugeordnete
Bankkonten“, „Konten“ und „Gefahrenzone“.

### FIN-BKD-01 Stammdaten ändern

- **Wo:** Karte „Stammdaten“
- **Recht:** `finance.accounts.manage`
- **Vorbedingung:** keine
- **Schritte:**
  1. Name, Bankleitzahl, Anmeldename, Server-URL oder PIN ändern.
  2. „Speichern“.
- **Ergebnis:** Werte gespeichert; eine neue PIN gilt ab dem nächsten
  Sync.
- **Fehler und Grenzfälle:** Das PIN-Feld ist leer und bleibt beim
  Speichern unverändert, wenn nichts eingegeben wird.
- **Test:** –

### FIN-BKD-02 TAN-Verfahren abrufen und wählen

- **Wo:** Karte „Stammdaten“, Knopf „Abrufen“ neben „TAN-Verfahren“
- **Recht:** `finance.accounts.manage`
- **Vorbedingung:** Zugangsdaten gespeichert
- **Schritte:**
  1. „Abrufen“; die Liste füllt sich mit den Verfahren der Bank.
  2. Verfahren wählen, „Speichern“.
- **Ergebnis:** Verfahren steht am Kontakt; Syncs nutzen es.
- **Fehler und Grenzfälle:** Bank nicht erreichbar oder Zugang abgelehnt:
  Banner mit der Meldung.
- **Test:** –

### FIN-BKD-03 Sync jetzt

- **Wo:** Karte „Sync“, Knopf „Sync jetzt“
- **Recht:** `finance.accounts.manage`
- **Vorbedingung:** wie `FIN-BKL-02`
- **Schritte:** wie `FIN-BKL-02`
- **Ergebnis:** wie `FIN-BKL-02`; die Karte zeigt den Verlauf des Laufs.
- **Fehler und Grenzfälle:** wie `FIN-BKL-02`
- **Test:** –

### FIN-BKD-04 Ab Datum abrufen

- **Wo:** Karte „Sync“, Knopf „Ab Datum abrufen …“
- **Recht:** `finance.accounts.manage`
- **Vorbedingung:** keine
- **Schritte:**
  1. Knopf drücken; Dialog mit Datumsfeld.
  2. Datum wählen; liegt es mehr als 90 Tage zurück, warnt der Dialog,
     dass die Bank eine TAN verlangen wird.
  3. Bestätigen.
- **Ergebnis:** Buchungen ab dem Datum werden geholt; schon vorhandene
  werden nicht doppelt angelegt.
- **Fehler und Grenzfälle:** Manche Banken liefern höchstens ein Jahr
  zurück; die Meldung der Bank erscheint im Verlauf.
- **Test:** –

### FIN-BKD-05 Sync-Zeiten bearbeiten

- **Wo:** Karte „Sync“, Knopf „Sync-Zeiten bearbeiten“
- **Recht:** `finance.accounts.manage`
- **Vorbedingung:** keine
- **Schritte:**
  1. Knopf drücken.
- **Ergebnis:** Seite `SYN`.
- **Fehler und Grenzfälle:** keine
- **Test:** –

### FIN-BKD-06 Bankkonto importieren, verknüpfen oder ignorieren

- **Wo:** Karte „Nicht zugeordnete Bankkonten“
- **Recht:** `finance.accounts.manage`
- **Vorbedingung:** die Bank meldet Konten, die noch keinem Konto der App
  zugeordnet sind
- **Schritte:**
  1. „Importieren“ legt ein neues Konto mit Typ, Währung, IBAN und
     Bezeichnung der Bank an.
  2. „Verknüpfen“ wählt ein bestehendes Konto (zum Beispiel eines, das
     vorher von Hand angelegt war).
  3. „Ignorieren“ blendet das Bankkonto aus.
- **Ergebnis:** Zeile verschwindet aus der Karte; das Konto steht unter
  „Konten“ und wird beim nächsten Sync befüllt.
- **Fehler und Grenzfälle:** Ein ignoriertes Konto lässt sich über
  „Ignorierte anzeigen“ wieder einblenden.
- **Test:** –

### FIN-BKD-07 Konto des Kontakts öffnen

- **Wo:** Karte „Konten“
- **Recht:** `finance.accounts.manage`
- **Vorbedingung:** zugeordnete Konten
- **Schritte:**
  1. Zeile anklicken.
- **Ergebnis:** Seite `BUC` des Kontos.
- **Fehler und Grenzfälle:** keine
- **Test:** –

### FIN-BKD-08 Bankkontakt löschen

- **Wo:** Karte „Gefahrenzone“, Knopf „Löschen“
- **Recht:** `finance.accounts.manage`
- **Vorbedingung:** keine
- **Schritte:**
  1. Knopf drücken, Rückfrage mit dem Namen des Kontakts bestätigen.
- **Ergebnis:** Kontakt und Zugangsdaten sind weg; die Konten bleiben
  mit ihren Buchungen, aber ohne Bankzugang.
- **Fehler und Grenzfälle:** keine Wiederherstellung.
- **Test:** –

---

## SYN: Sync-Zeiten (`/finanzen/bankkontakte/:id/zeiten`)

### FIN-SYN-01 Zeitplan setzen

- **Wo:** Formular mit Zeitzone und Zeitfenstern
- **Recht:** `finance.accounts.manage`
- **Vorbedingung:** keine
- **Schritte:**
  1. Zeitzone wählen.
  2. Zeitfenster hinzufügen: Wochentage anhaken, Uhrzeit `HH:MM`
     eintragen; weitere Fenster mit „Hinzufügen“, Kreuz entfernt eines.
  3. „Speichern“.
- **Ergebnis:** „Nächster Sync“ auf `BKL` zeigt den nächsten Termin; der
  Server synchronisiert zu diesen Zeiten ohne Zutun, solange keine TAN
  nötig ist.
- **Fehler und Grenzfälle:** Ohne Fenster gibt es keinen automatischen
  Sync. Eine ungültige Uhrzeit wird im Feld markiert.
- **Test:** –

---

## POR: Portfolio (`/finanzen/portfolio`)

Übersicht aller Depots: Kennzahlen (Wert, Einstand, Gewinn, Rendite),
Performance, „Zu prüfen“ (Belegabgleich der Depots), Positionstabelle,
Analyse (Allokation, Erträge, Sparpläne), realisierte Gewinne „Pro Jahr“
und die Transaktionen.

### FIN-POR-01 Aktualisieren

- **Wo:** Knopf „Aktualisieren“
- **Recht:** `finance.view`
- **Vorbedingung:** keine
- **Schritte:**
  1. Knopf drücken.
- **Ergebnis:** Kurse werden vom Provider geholt, Werte rechnen neu.
- **Fehler und Grenzfälle:** Außerhalb der Handelszeiten bleiben die
  Kurse; ein Provider-Fehler steht als Banner.
- **Test:** –

### FIN-POR-02 Filtern

- **Wo:** Filter-Panel (Depots, geschlossene Depots, Wertpapier, Art,
  Jahr)
- **Recht:** `finance.view`
- **Vorbedingung:** keine
- **Schritte:**
  1. Panel öffnen, Werte setzen.
- **Ergebnis:** Kennzahlen, Tabellen und Analyse folgen dem Filter; Chips
  und URL spiegeln ihn.
- **Fehler und Grenzfälle:** Ein Klick auf eine Zeile in „Pro Jahr“ setzt
  den Jahresfilter.
- **Test:** –

### FIN-POR-03 Belege einlesen

- **Wo:** Knöpfe „Belege einlesen“, „Belege neu einlesen“, „Aus Giro
  ableiten“
- **Recht:** `finance.view`
- **Vorbedingung:** Depot-Abrechnungen oder Depotauszüge in den Dokumenten
- **Schritte:**
  1. „Belege einlesen“ liest neue Abrechnungen; „neu einlesen“ auch schon
     gelesene; „Aus Giro ableiten“ erzeugt Depot-Transaktionen aus
     Wertpapier-Buchungen des Girokontos.
- **Ergebnis:** Neue Transaktionen und Bestandsstände; Unstimmiges
  landet unter „Zu prüfen“.
- **Fehler und Grenzfälle:** Der Lauf ist ein Job; der Knopf zeigt den
  Fortschritt.
- **Test:** –

### FIN-POR-04 Zeitraum der Performance wählen

- **Wo:** Abschnitt „Performance“, Umschalter 1M / YTD / 1J / 3J / Max und
  „Wert oder Rendite zeigen“
- **Recht:** `finance.view`
- **Vorbedingung:** Kurshistorie
- **Schritte:**
  1. Zeitraum wählen.
- **Ergebnis:** TWR, XIRR und Wertverlauf mit investiertem Kapital für
  den Zeitraum; `period` steht in der URL.
- **Fehler und Grenzfälle:** Tage ohne Kurs erscheinen als Lücke, nicht
  als Nullwert; bei mehreren Währungen je Währung eine Gruppe.
- **Test:** –

### FIN-POR-05 Zu prüfen: Abweichungen bearbeiten

- **Wo:** Abschnitt „Zu prüfen“ mit Gruppen „Beleg und Buchung weichen
  ab“, „Thesaurierung als Dividende gebucht“, „Bestand ohne passende
  Transaktion“, „Erkennung unsicher“, „Neue Wertpapiere“, „Abrechnungen
  ohne Depot“, „Depotauszüge ohne Depot“, „Weitere ignorierte Belege“
- **Recht:** `write` auf dem Depot
- **Vorbedingung:** der Belegabgleich hat etwas gefunden
- **Schritte:**
  1. Je Zeile „Übernehmen“ (Belegwert gilt), „Korrigieren“, „Aufnehmen“
     (neues Wertpapier ins Depot), „Ignorieren“ bzw. „Für Depots
     ignorieren“ oder „Wieder berücksichtigen“/„Wieder vorschlagen“.
- **Ergebnis:** Zeile verschwindet aus der Gruppe; Bestand und
  Transaktionen passen sich an.
- **Fehler und Grenzfälle:** Ein ignorierter Beleg steht unter „Weitere
  ignorierte Belege“ und lässt sich zurückholen.
- **Test:** –

### FIN-POR-06 Position öffnen

- **Wo:** Zeile der Positionstabelle; Balken der Allokation; Zeile der
  Sparpläne
- **Recht:** `finance.view`
- **Vorbedingung:** keine
- **Schritte:**
  1. Zeile anklicken.
- **Ergebnis:** Seite `POS`.
- **Fehler und Grenzfälle:** keine
- **Test:** –

### FIN-POR-07 Allokation und Erträge umschalten

- **Wo:** Abschnitt „Analyse“: „Aufteilen nach“ (Wertpapier, Art,
  Währung) und „Erträge je Monat oder Jahr“
- **Recht:** `finance.view`
- **Vorbedingung:** Bestand
- **Schritte:**
  1. Umschalter wählen.
- **Ergebnis:** Balken bzw. Reihen wechseln; über der Schwelle (Standard
  10 %, einstellbar) steht ein Hinweis am Balken.
- **Fehler und Grenzfälle:** keine
- **Test:** –

### FIN-POR-08 Weitere Transaktionen laden

- **Wo:** Knopf „Mehr laden“ unter der Transaktionstabelle
- **Recht:** `finance.view`
- **Vorbedingung:** mehr Transaktionen als geladen
- **Schritte:**
  1. Knopf drücken.
- **Ergebnis:** Nächste Seite hängt sich an.
- **Fehler und Grenzfälle:** keine
- **Test:** –

---

## POS: Position (`/finanzen/portfolio/:key`)

Seite eines Wertpapiers über alle Depots: Kennzahlen, Performance,
Sparplan, Verlauf (Wert oder Kurs), Nachrichten, Depots und Zuordnung,
Bestandsabgleich, Verkäufe, Pro Jahr, Transaktionen.

### FIN-POS-01 Aktualisieren und Link teilen

- **Wo:** `#actions`
- **Recht:** `finance.view`
- **Vorbedingung:** keine
- **Schritte:**
  1. „Aktualisieren“ holt den Kurs; `ShareLink` kopiert den Link.
- **Ergebnis:** wie `FIN-POR-01` und `FIN-BDT-04`.
- **Fehler und Grenzfälle:** keine
- **Test:** –

### FIN-POS-02 Verlauf lesen

- **Wo:** Abschnitt „Verlauf“ mit Umschalter Wert/Kurs und Zeitraum
- **Recht:** `finance.view`
- **Vorbedingung:** Kurshistorie
- **Schritte:**
  1. Umschalten.
- **Ergebnis:** Diagramm wechselt; Zeitraum in `period`.
- **Fehler und Grenzfälle:** wie `FIN-POR-04`
- **Test:** –

### FIN-POS-03 Nachrichten lesen

- **Wo:** Abschnitt „Nachrichten“
- **Recht:** `finance.view`
- **Vorbedingung:** Nachrichtenquelle für das Papier (EODHD oder Yahoo
  RSS)
- **Schritte:**
  1. Abschnitt öffnen; Zeile anklicken.
- **Ergebnis:** Nachricht öffnet sich in neuem Tab; sie gilt als gelesen,
  der Zähler auf der Kurs-Kachel sinkt.
- **Fehler und Grenzfälle:** Ohne Quelle steht „Keine Nachrichten“.
- **Test:** –

### FIN-POS-04 Zuordnung zu Depots ändern

- **Wo:** Abschnitt „Zuordnung zu Depots“ mit „Ablegen“ und „Aus Depot
  entfernen“
- **Recht:** `write` auf dem Depot
- **Vorbedingung:** keine
- **Schritte:**
  1. Depot wählen und bestätigen bzw. entfernen und Rückfrage bestätigen.
- **Ergebnis:** Papier zählt zum Bestand des Depots oder nicht mehr.
- **Fehler und Grenzfälle:** Ein Papier mit Bestand der Bank lässt sich
  nicht entfernen, solange die Bank es meldet.
- **Test:** –

### FIN-POS-05 Bestandsabgleich prüfen

- **Wo:** Abschnitt „Bestandsabgleich“; Zeile öffnet den Dialog zur
  Abrechnung
- **Recht:** `finance.view`
- **Vorbedingung:** Bestandsstände aus Depotauszügen
- **Schritte:**
  1. Zeile anklicken.
- **Ergebnis:** Dialog zeigt die gelesene Abrechnung mit den im Text
  verankerten Werten und den Beleg daneben.
- **Fehler und Grenzfälle:** keine
- **Test:** –

### FIN-POS-06 Verkäufe, Pro Jahr und Transaktionen lesen

- **Wo:** untere Abschnitte
- **Recht:** `finance.view`
- **Vorbedingung:** Transaktionen
- **Schritte:**
  1. Lesen; eine Zeile in „Pro Jahr“ filtert die Transaktionen auf das
     Jahr.
- **Ergebnis:** realisierter Gewinn je Verkauf (FIFO) und je Jahr.
- **Fehler und Grenzfälle:** keine
- **Test:** –

---

## KUR: Kurse (`/finanzen/kurse`)

Kacheln aller gehaltenen Wertpapiere mit Kurs, Tagesänderung, Sparkline
und Zähler ungelesener Nachrichten; darüber die Gesamtsumme.

### FIN-KUR-01 Kurse abrufen

- **Wo:** Knopf „Kurse jetzt abrufen“
- **Recht:** `finance.view`
- **Vorbedingung:** keine
- **Schritte:**
  1. Knopf drücken.
- **Ergebnis:** Kacheln zeigen neue Kurse und Uhrzeit.
- **Fehler und Grenzfälle:** wie `FIN-POR-01`
- **Test:** –

### FIN-KUR-02 Depots eingrenzen und Zeitspanne wählen

- **Wo:** Filter „Depots eingrenzen“ und Umschalter der Zeitspanne
- **Recht:** `finance.view`
- **Vorbedingung:** keine
- **Schritte:**
  1. Depots wählen, Zeitspanne wählen.
- **Ergebnis:** Kacheln und Sparklines folgen; Einstellungen in der URL.
- **Fehler und Grenzfälle:** keine
- **Test:** –

### FIN-KUR-03 Kachel öffnen

- **Wo:** Kachel; Nachrichten-Badge
- **Recht:** `finance.view`
- **Vorbedingung:** keine
- **Schritte:**
  1. Kachel anklicken, oder das Badge „n neue Nachrichten“.
- **Ergebnis:** Seite `POS`, beim Badge direkt beim Abschnitt
  „Nachrichten“.
- **Fehler und Grenzfälle:** keine
- **Test:** –

### FIN-KUR-04 Zum Portfolio

- **Wo:** Knopf „Portfolio“
- **Recht:** `finance.view`
- **Vorbedingung:** keine
- **Schritte:**
  1. Knopf drücken.
- **Ergebnis:** Seite `POR`.
- **Fehler und Grenzfälle:** keine
- **Test:** –

---

## PRG: Prognose (`/finanzen/prognose`)

Langfristplanung des Haushalts: Personen mit Geburtsdatum und
Zeitpunkten (Ausstieg aus dem Beruf, Rentenbeginn), Einträge (Gehalt,
sonstige Einnahme, Rente/Pension, Kapitallebensversicherung,
Vermögen/Anlage, Lebenshaltung, Krankenversicherung, Ausgabe), Annahmen
und Szenarien. Karten: „Wann aufhören?“, Vergleich aller Kombinationen,
Robustheit, Zielalter, Zeitleiste, Jahr im Detail, „Plan und
Wirklichkeit“, „Haushalt“, „Annahmen und Szenario“ mit Stresstest,
Hinterbliebenen, Ausgaben im Alter und Ausgleich von Abschlägen. Eine
Prognose gehört ihrem Besitzer und kann mit Lese- oder Schreibrecht
geteilt werden; wer eine geteilte angeboten bekommt, kann „Zur geteilten
Prognose wechseln“.

### FIN-PRG-01 Person anlegen, bearbeiten, entfernen

- **Wo:** Knopf „Person“ in `#actions`, „Erste Person anlegen“ im leeren
  Zustand; Stift und Papierkorb in der Karte „Haushalt“
- **Recht:** `finance.view` und Schreibrecht an der Prognose
- **Vorbedingung:** keine
- **Schritte:**
  1. „Person“; Dialog „Neue Person“ mit Bezeichnung und Geburtsdatum.
  2. „Speichern“ (gesperrt, solange ein Feld leer ist).
  3. Entfernen fragt nach und löscht die Person mit ihren Einträgen und
     Zeitpunkten.
- **Ergebnis:** Person steht im Haushalt; die Karten rechnen.
- **Fehler und Grenzfälle:** Ohne Person sind „Eintrag“ und die
  Auswertungen gesperrt.
- **Test:** –

### FIN-PRG-02 Zeitpunkt anlegen oder ändern

- **Wo:** Link „Anlegen“ in „Wann aufhören?“, Zeitpunkte in der Karte
  „Haushalt“
- **Recht:** Schreibrecht
- **Vorbedingung:** Person
- **Schritte:**
  1. Dialog „Neuer Zeitpunkt“: Person, Art (zum Beispiel Ausstieg aus dem
     Beruf, Rentenbeginn), Bezeichnung, Alter oder Datum.
  2. „Speichern“; im Bearbeiten-Dialog gibt es „Löschen“ links.
- **Ergebnis:** Der Zeitpunkt steht an der Person und in der Zeitleiste;
  Einträge können sich darauf beziehen („bis Ausstieg der Person“).
- **Fehler und Grenzfälle:** Ein Zeitpunkt, auf den Einträge zeigen, lässt
  sich löschen; die Einträge laufen dann bis zum Ende.
- **Test:** –

### FIN-PRG-03 Eintrag anlegen, bearbeiten, löschen

- **Wo:** Knopf „Eintrag“ in `#actions` und je Gruppe im Haushalt; Zeile
  eines Eintrags
- **Recht:** Schreibrecht
- **Vorbedingung:** mindestens eine Person
- **Schritte:**
  1. Dialog: Art in Gruppen (Einnahmen, Renten und Versicherungen,
     Vermögen, Ausgaben), Bezeichnung, Person oder Haushalt, Betrag und
     Rhythmus, Beginn und Ende als Datum, Alter oder Zeitpunkt
     (`TimeRefPicker`); je nach Art weitere Felder (Topf, verknüpftes
     Konto, Beitragsende, Auszahlung als Einmalzahlung oder Rente,
     Rentenart, Krankenversicherung in Brücke und Rente).
  2. „Speichern“ (gesperrt, solange die Prüfung einen Fehler nennt);
     „Löschen“ links im Fuß.
- **Ergebnis:** Eintrag steht im Haushalt, Zeitleiste und Kennzahlen
  rechnen neu.
- **Fehler und Grenzfälle:** Persönliche Arten (Gehalt, Rente,
  Versicherung, Krankenversicherung) brauchen eine Person; die anderen
  dürfen dem Haushalt gehören.
- **Test:** –

### FIN-PRG-04 Konten übernehmen

- **Wo:** Link „Ansehen und übernehmen“ im Hinweis über der Seite
- **Recht:** Schreibrecht
- **Vorbedingung:** Konten, die noch keinem Eintrag zugeordnet sind
- **Schritte:**
  1. Dialog „Konten übernehmen“: Konten anhaken, je Konto die Person
     wählen.
  2. „n Konten übernehmen“.
- **Ergebnis:** Je Konto ein Vermögenseintrag mit dem Saldo als
  Startwert, an das Konto gebunden; „Plan und Wirklichkeit“ vergleicht
  später damit.
- **Fehler und Grenzfälle:** keine
- **Test:** –

### FIN-PRG-05 Dokumente und Buchungen eines Eintrags prüfen

- **Wo:** Knopf „Dokumente und Buchungen suchen“ in `#actions`; Link am
  Eintrag
- **Recht:** `finance.view`, Dokumente nur mit `documents.view`
- **Vorbedingung:** Einträge
- **Schritte:**
  1. Dialog „Dokumente und Buchungen · Eintrag“: gefundene Dokumente
     (Rentenbescheid, Dynamik, Nachtrag) mit „Gehört dazu“ / „Nicht dazu“,
     Art je Dokument, „Neu lesen“, „Zuordnung lösen“; „Dokument von Hand
     zuordnen“ mit Suche; „Erhöhung ohne Dokument als abgelehnt
     vermerken“ mit Datum.
  2. Darunter die gefundenen Buchungen mit Zusammenfassung.
- **Ergebnis:** Bestätigte Dokumente liefern den aktuellen Wert des
  Eintrags; der Wert im Haushalt trägt ein Herkunfts-Badge.
- **Fehler und Grenzfälle:** Ein abgelehntes Dokument wird nicht wieder
  vorgeschlagen; der Zähler „n abgelehnte ausgeblendet“ zeigt es.
- **Test:** –

### FIN-PRG-06 Ausstiegsalter spielen

- **Wo:** Karte „Wann aufhören?“: Schieberegler je Person, „Zurücksetzen“
- **Recht:** `finance.view`
- **Vorbedingung:** Person mit Zeitpunkt „Ausstieg aus dem Beruf“
- **Schritte:**
  1. Regler ziehen.
- **Ergebnis:** Alle Karten rechnen mit dem überschriebenen Alter, ohne
  die Prognose zu ändern; „Zurücksetzen“ nimmt es zurück.
- **Fehler und Grenzfälle:** Die Überschreibung geht mit dem Verlassen der
  Seite verloren, es sei denn sie wird als Szenario gespeichert.
- **Test:** –

### FIN-PRG-07 Alle Kombinationen vergleichen

- **Wo:** Knopf „Alle Kombinationen vergleichen“
- **Recht:** `finance.view`
- **Vorbedingung:** zwei Personen
- **Schritte:**
  1. Knopf drücken; Person in Zeilen und Spalten sowie Alter von/bis
     (40–80) wählen.
- **Ergebnis:** Matrix mit dem Vermögen am Ende je Kombination; eine
  Zelle anklicken übernimmt die Alter als Überschreibung.
- **Fehler und Grenzfälle:** keine
- **Test:** –

### FIN-PRG-08 Robustheit, Zielalter, Kaufkraft

- **Wo:** Knopf „Wie robust ist das?“, Feld „Alter“ unter Zielalter,
  Umschalter „Kaufkraft oder nominal“, Auswahl „Frühestmöglich für“
- **Recht:** `finance.view`
- **Vorbedingung:** Einträge
- **Schritte:**
  1. Umschalten bzw. Alter eingeben.
- **Ergebnis:** Robustheit zeigt, wie viel Rendite- oder
  Inflationsabweichung der Plan verträgt; Zielalter zeigt, was nötig ist,
  um mit diesem Alter auszusteigen; Kaufkraft rechnet alle Beträge in
  heutiges Geld.
- **Fehler und Grenzfälle:** „Zurücksetzen“ leert das Zielalter.
- **Test:** –

### FIN-PRG-09 Jahr im Detail

- **Wo:** Zeitleiste; Zeile anklicken
- **Recht:** `finance.view`
- **Vorbedingung:** Einträge
- **Schritte:**
  1. Jahr anklicken.
- **Ergebnis:** Karte „Jahr im Detail“ mit Einnahmen, Ausgaben, Entnahmen
  und Töpfen; Kreuz schließt sie.
- **Fehler und Grenzfälle:** keine
- **Test:** –

### FIN-PRG-10 Annahmen ändern

- **Wo:** Karte „Annahmen und Szenario“: Rendite, Inflation,
  Lohnsteigerung, Reihenfolge der Entnahme, Stresstest, Hinterbliebene
  („Es stirbt“, Rechnung für), Ausgaben im Alter (Bezugsperson, Phasen
  ab Alter mit Faktor), Abschläge ausgleichen (§ 187a SGB VI)
- **Recht:** Schreibrecht zum Speichern; Ansehen reicht zum Spielen
- **Vorbedingung:** keine
- **Schritte:**
  1. Werte ändern; alle Karten rechnen sofort.
- **Ergebnis:** Die Prognose gilt als geändert („dirty“); „Speichern“
  schreibt sie in das gewählte Szenario.
- **Fehler und Grenzfälle:** Ohne Schreibrecht lässt sich spielen, nicht
  speichern.
- **Test:** –

### FIN-PRG-11 Szenario speichern, wechseln, vergleichen, löschen

- **Wo:** Auswahl „Szenario“, „Als neues Szenario“, „Speichern“,
  „Löschen“, Mehrfachauswahl „Szenarien vergleichen“
- **Recht:** Schreibrecht für Speichern und Löschen
- **Vorbedingung:** keine
- **Schritte:**
  1. „Als neues Szenario“: Dialog „Szenario speichern“, Name (zum
     Beispiel `Beide mit 62`), „Speichern“.
  2. Szenario in der Auswahl wechseln; „Speichern“ schreibt Änderungen
     ins gewählte; „Löschen“ entfernt es nach Rückfrage.
  3. Mehrere Szenarien zum Vergleich wählen.
- **Ergebnis:** Zeitleiste zeigt die gewählten Szenarien nebeneinander.
- **Fehler und Grenzfälle:** Das Grundszenario lässt sich nicht löschen.
- **Test:** –

### FIN-PRG-12 Prognose teilen

- **Wo:** Knopf „Teilen“ (nur Besitzer)
- **Recht:** Besitzer der Prognose
- **Vorbedingung:** keine
- **Schritte:**
  1. Dialog „Prognose teilen“: Person oder Gruppe wählen, Recht (Lesen,
     Schreiben), „Freigeben“.
  2. Unter „Geteilt mit“ Recht ändern oder Freigabe beenden.
- **Ergebnis:** Der Empfänger sieht beim Öffnen von `PRG` den Hinweis
  „Zur geteilten Prognose wechseln“.
- **Fehler und Grenzfälle:** Ohne Personen oder Gruppen steht ein
  Hinweis statt der Auswahl.
- **Test:** –

### FIN-PRG-13 Plan und Wirklichkeit

- **Wo:** Karte „Plan und Wirklichkeit“
- **Recht:** `finance.view`
- **Vorbedingung:** Einträge mit verknüpftem Konto
- **Schritte:**
  1. Lesen.
- **Ergebnis:** Je Eintrag der geplante gegen den tatsächlichen Saldo des
  Kontos.
- **Fehler und Grenzfälle:** keine
- **Test:** –

---

## ZAH: Erwartete Zahlungen (`/finanzen/zahlungen`)

Liste der Lastschriften und Überweisungen, die aus den Mandaten und
wiederkehrenden Buchungen für den gewählten Zeitraum erwartet werden,
mit Fälligkeit, Gegenseite, Betrag und Konto; nie Karte oder Bargeld.

### FIN-ZAH-01 Zeitraum und Kanal wählen

- **Wo:** Umschalter „Rest dieses Monats“, „Nächster Monat“, „Nächste 3
  Monate“, „Nächste 12 Monate“ und „Lastschriften und Überweisungen“,
  „Nur Lastschriften“, „Nur Überweisungen und Daueraufträge“
- **Recht:** `finance.view`
- **Vorbedingung:** keine
- **Schritte:**
  1. Umschalten.
- **Ergebnis:** Liste und Summe folgen; `period` und `channel` in der
  URL.
- **Fehler und Grenzfälle:** keine
- **Test:** –

### FIN-ZAH-02 Verlauf einer Zahlung aufklappen

- **Wo:** Pfeil in der Zeile
- **Recht:** `finance.view`
- **Vorbedingung:** frühere Buchungen des Mandats
- **Schritte:**
  1. Pfeil drücken.
- **Ergebnis:** Frühere Buchungen mit Datum und Betrag; Klick öffnet
  `BDT`.
- **Fehler und Grenzfälle:** keine
- **Test:** –

---

## ANO: Anomalien (`/finanzen/anomalien`)

Karten mit Auffälligkeiten: Betragsänderung, möglicherweise doppelt,
neues Lastschriftmandat, erwartete Buchung fehlt.

### FIN-ANO-01 Filtern und aktualisieren

- **Wo:** Typfilter („Alle“, „Betragsänderung“, „Möglicherweise doppelt“,
  „Neues Lastschriftmandat“, „Erwartete Buchung fehlt“), Knopf
  „Aktualisieren“
- **Recht:** `finance.view`
- **Vorbedingung:** keine
- **Schritte:**
  1. Typ wählen; „Aktualisieren“ stößt die Erkennung an.
- **Ergebnis:** Liste folgt; der Zähler auf der Übersichtskachel passt
  sich an.
- **Fehler und Grenzfälle:** keine
- **Test:** –

### FIN-ANO-02 Quittieren

- **Wo:** Knopf „Verstanden“ je Karte; „Alle quittieren“ oben
- **Recht:** `write` auf dem Konto
- **Vorbedingung:** offene Anomalie
- **Schritte:**
  1. Knopf drücken.
- **Ergebnis:** Karte verschwindet, der Zähler sinkt; die Anomalie kommt
  nicht wieder.
- **Fehler und Grenzfälle:** „Alle quittieren“ fragt nach.
- **Test:** –

### FIN-ANO-03 Buchung öffnen, Verlauf, Basket

- **Wo:** „Buchung öffnen“, Verlauf-Umschalter, Basket-Schalter je Karte;
  bei Duplikaten die Liste der Kandidaten
- **Recht:** `finance.view`
- **Vorbedingung:** keine
- **Schritte:**
  1. Knopf drücken.
- **Ergebnis:** `BDT`; Verlauf zeigt frühere Beträge; Basket legt die
  Buchung ab.
- **Fehler und Grenzfälle:** keine
- **Test:** –

---

## STR: Steuer: Belege nach Anlage (`/finanzen/steuer`)

Je Steuerjahr die steuerrelevanten Dokumente, nach Anlage und Sektion
gruppiert, mit Rolle (Beleg oder Bezug) und Prüfstatus; pro Person der
Steuerakte ein Knopf. Die Ausfüllhilfe zeigt die Werte nach Kennzahl.

### FIN-STR-01 Steuerjahr und Person wählen, nur zu prüfen

- **Wo:** Auswahl „Steuerjahr“, Knöpfe der Personen, Schalter „Nur zu
  prüfen“
- **Recht:** `finance.view` und `documents.view`
- **Vorbedingung:** keine
- **Schritte:**
  1. Jahr wählen, Person wählen, Schalter setzen.
- **Ergebnis:** Gruppen zeigen die passenden Dokumente; die Einstellungen
  stehen in der URL.
- **Fehler und Grenzfälle:** Ohne steuerrelevante Dokumente im Jahr ist
  die Seite leer mit Hinweis.
- **Test:** –

### FIN-STR-02 Dokument öffnen

- **Wo:** Zeile
- **Recht:** `documents.view`
- **Vorbedingung:** keine
- **Schritte:**
  1. Zeile anklicken.
- **Ergebnis:** Dokumentseite, Steuerbereich sichtbar; Zurück landet auf
  der Zeile.
- **Fehler und Grenzfälle:** keine
- **Test:** –

### FIN-STR-03 Ausfüllhilfe öffnen

- **Wo:** Knopf „Ausfüllhilfe“
- **Recht:** `finance.view` und `documents.view`
- **Vorbedingung:** Steuerjahr gewählt
- **Schritte:**
  1. Knopf drücken; Dialog „Ausfüllhilfe Steuererklärung JJJJ“.
- **Ergebnis:** Abschnitte „Werte nach Kennzahl“ (Anlage → Person → Zeile
  · Kz → Wert mit Belegen, daneben der Vorjahreswert), „Vorjahr
  vorhanden, Jahr noch ohne Wert“, „Nicht übernommen“, „Anlagen“,
  „Steuerrelevante Buchungen nach Tag“, „Betriebe (EÜR)“, „Depot (Anlage
  KAP)“, „Hinweise“.
- **Fehler und Grenzfälle:** Eine Kennzahl ohne geprüfte Quelle steht
  ohne Nummer.
- **Test:** –

### FIN-STR-04 Wert bestätigen oder korrigieren

- **Wo:** Haken „bestätigen“ und Stift „korrigieren“ je Wert in der
  Ausfüllhilfe; „Nicht bar bezahlt“ bei einem Wert unter „Nicht
  übernommen“
- **Recht:** `write` auf dem Dokument
- **Vorbedingung:** gelesene Werte
- **Schritte:**
  1. Haken: Wert gilt als bestätigt.
  2. Stift: Betrag eingeben, „Speichern“; „Abbrechen“ verwirft.
- **Ergebnis:** Status `confirmed` bzw. `corrected`; eine neue Lesung
  überschreibt beide nicht mehr; Korrekturen dienen als Beispiele für
  spätere Lesungen desselben Absenders.
- **Fehler und Grenzfälle:** keine
- **Test:** –

### FIN-STR-05 Ausfüllhilfe als PDF ablegen

- **Wo:** Knopf „Als PDF ablegen“ im Dialogfuß
- **Recht:** `documents.upload`
- **Vorbedingung:** keine
- **Schritte:**
  1. Knopf drücken.
- **Ergebnis:** PDF mit Werten je Anlage und Person, Anhang je Beleg,
  abgelegt als Dokument in den Dokumenten; Link im Toast.
- **Fehler und Grenzfälle:** keine
- **Test:** –

### FIN-STR-06 Belegwerte nachlesen

- **Wo:** Knopf „Belegwerte nachlesen“
- **Recht:** `data.manage`
- **Vorbedingung:** keine
- **Schritte:**
  1. Knopf drücken, Rückfrage bestätigen.
- **Ergebnis:** Backfill-Job liest alle Belege des Jahres neu; bestätigte
  und korrigierte Werte bleiben.
- **Fehler und Grenzfälle:** Fortschritt in Admin › Jobs.
- **Test:** –

---

## BET: Betriebe (`/finanzen/betriebe`)

Liste der Betriebe im steuerlichen Sinn (verpachtete Landwirtschaft,
Photovoltaik) mit Art, Buchungs-Tag und Jahresergebnis.

### FIN-BET-01 Betrieb anlegen

- **Wo:** Knopf „Neuer Betrieb“
- **Recht:** `finance.view`
- **Vorbedingung:** keine
- **Schritte:**
  1. Dialog: Name (zum Beispiel `PV-Anlage Dach`), Art (Landwirtschaft,
     Photovoltaik, Sonstige), „Speichern“.
- **Ergebnis:** Zeile in der Liste; die Detailseite öffnet sich.
- **Fehler und Grenzfälle:** Name ist Pflicht.
- **Test:** –

### FIN-BET-02 Betrieb öffnen

- **Wo:** Zeile
- **Recht:** `finance.view`
- **Vorbedingung:** keine
- **Schritte:**
  1. Zeile anklicken.
- **Ergebnis:** Seite `BTD`.
- **Fehler und Grenzfälle:** keine
- **Test:** –

---

## BTD: Betrieb (`/finanzen/betriebe/:id`)

Detailseite mit Jahr-Auswahl, Karten „Stammdaten“ (Name, Art,
Buchungs-Tag, bei Photovoltaik Leistung in kWp, Inbetriebnahme und
Status nach § 3 Nr. 72 EStG mit Override), „Anlagegüter“, „EÜR“,
„Flächen“ und „Dokumente“.

### FIN-BTD-01 Stammdaten bearbeiten oder Betrieb löschen

- **Wo:** Stift und Papierkorb in `#actions`
- **Recht:** `finance.view`
- **Vorbedingung:** keine
- **Schritte:**
  1. Stift: Dialog mit den Stammdaten, „Speichern“.
  2. Papierkorb: Rückfrage mit Namen bestätigen.
- **Ergebnis:** Werte gespeichert bzw. Betrieb mit Anlagegütern, Flächen
  und Verknüpfungen gelöscht; die Buchungen bleiben.
- **Fehler und Grenzfälle:** keine
- **Test:** –

### FIN-BTD-02 Jahr wählen

- **Wo:** Auswahl „Jahr“
- **Recht:** `finance.view`
- **Vorbedingung:** keine
- **Schritte:**
  1. Jahr wählen.
- **Ergebnis:** EÜR, AfA und Einspeisung zeigen dieses Jahr.
- **Fehler und Grenzfälle:** keine
- **Test:** –

### FIN-BTD-03 Anlagegut anlegen, bearbeiten, löschen

- **Wo:** Karte „Anlagegüter“: „Neues Anlagegut“, Stift, Papierkorb
- **Recht:** `finance.view`
- **Vorbedingung:** keine
- **Schritte:**
  1. Dialog: Bezeichnung, Anschaffungsdatum, Anschaffungskosten,
     Nutzungsdauer in Jahren, optional Abgang; „Speichern“.
- **Ergebnis:** Zeile mit Buchwert und AfA des Jahres; die EÜR übernimmt
  die AfA.
- **Fehler und Grenzfälle:** Lineare AfA monatsgenau bis 1 €
  Erinnerungswert; ein Abgang beendet die AfA im Abgangsmonat.
- **Test:** –

### FIN-BTD-04 AfA-Plan ansehen

- **Wo:** Knopf „AfA-Plan“ in der Zeile
- **Recht:** `finance.view`
- **Vorbedingung:** Anlagegut
- **Schritte:**
  1. Knopf drücken.
- **Ergebnis:** Dialog mit Jahr, AfA und Restbuchwert über die
  Nutzungsdauer.
- **Fehler und Grenzfälle:** keine
- **Test:** –

### FIN-BTD-05 EÜR lesen, Zeilen zuordnen, PDF

- **Wo:** Karte „EÜR“: Tabelle, Knopf „Zeilen“, Knopf „PDF“
- **Recht:** `finance.view`
- **Vorbedingung:** Buchungen mit dem Buchungs-Tag des Betriebs
- **Schritte:**
  1. „Zeilen“: Dialog, der die weiteren Tags den Zeilen der Anlage EÜR
     zuordnet; Rest fällt unter „Sonstige“; „Speichern“.
  2. „PDF“: erzeugt die EÜR des Jahres als PDF.
- **Ergebnis:** Tabelle mit Betriebseinnahmen, -ausgaben, AfA und
  Ergebnis; PDF zum Herunterladen oder Ablegen.
- **Fehler und Grenzfälle:** Bei steuerfreier Photovoltaik (§ 3 Nr. 72)
  steht die EÜR nur zur Information, mit Hinweis.
- **Test:** –

### FIN-BTD-06 Photovoltaik: Einspeisung und Status

- **Wo:** Karte „Photovoltaik“
- **Recht:** `finance.view`
- **Vorbedingung:** Betrieb der Art Photovoltaik
- **Schritte:**
  1. Lesen; Override des Status über die Stammdaten.
- **Ergebnis:** Einspeisung des Jahres aus dem Energiebericht der Zähler
  (Rolle Einspeisung), abgeleiteter Status steuerfrei/steuerpflichtig.
- **Fehler und Grenzfälle:** Ohne Zähler mit Rolle Einspeisung fehlt der
  Wert, mit Hinweis.
- **Test:** –

### FIN-BTD-07 Fläche anlegen, bearbeiten, löschen

- **Wo:** Karte „Flächen“
- **Recht:** `finance.view`
- **Vorbedingung:** keine
- **Schritte:**
  1. Dialog: Bezeichnung oder Flurstück, Größe, Pächter, Pacht je Jahr,
     „Speichern“.
- **Ergebnis:** Zeile mit Pacht; die Summe steht in der EÜR als Hinweis.
- **Fehler und Grenzfälle:** Pächtername ist ein freier Text; keine
  Verknüpfung zu Personen.
- **Test:** –

### FIN-BTD-08 Dokument verknüpfen oder lösen

- **Wo:** Karte „Dokumente“: „Dokument verknüpfen“, Kreuz je Zeile
- **Recht:** `finance.view` und `documents.view`
- **Vorbedingung:** keine
- **Schritte:**
  1. Dialog: Dokument suchen, Bezug wählen (Betrieb, ein Anlagegut, eine
     Fläche), „Verknüpfen“.
  2. Kreuz löst die Verknüpfung nach Rückfrage.
- **Ergebnis:** Dokument steht in der Karte mit Bezug; die Dokumentseite
  zeigt den Betrieb unter „Verwandte Dokumente“.
- **Fehler und Grenzfälle:** keine
- **Test:** –

---

## BAB: Belegabgleich (`/finanzen/belegabgleich`)

Vorschläge, die Belegdaten (Betrag, Datum, Händler aus OCR) mit
Buchungen zusammenbringen.

### FIN-BAB-01 Vorschlag übernehmen, bearbeiten, verwerfen

- **Wo:** Knöpfe je Karte
- **Recht:** `write` auf dem Konto
- **Vorbedingung:** Vorschläge
- **Schritte:**
  1. „Übernehmen“ verknüpft Beleg und Buchung und übernimmt Tags.
  2. „Bearbeiten“ öffnet die Buchung (`BDT`) mit dem Panel „Beleg
     verknüpfen“.
  3. „Verwerfen“ merkt sich die Ablehnung.
- **Ergebnis:** Karte verschwindet.
- **Fehler und Grenzfälle:** Verworfene Paare werden nicht wieder
  vorgeschlagen.
- **Test:** –

---

## ZUG: Einstellungen: Konto-Zugriff (`/finanzen/admin/zugriff`)

### FIN-ZUG-01 Zugriff vergeben, ändern, entziehen

- **Wo:** Auswahl „Konto“, Liste der Einträge mit Nutzer und Stufe
  (`read`, `write`), „Nutzer hinzufügen“, Kreuz, „Speichern“
- **Recht:** `finance.admin`
- **Vorbedingung:** Konto
- **Schritte:**
  1. Konto wählen.
  2. Nutzer hinzufügen und Stufe wählen, oder Stufe ändern, oder Eintrag
     entfernen.
  3. „Speichern“ (gesperrt, solange nichts geändert ist).
- **Ergebnis:** Der Nutzer sieht das Konto in Übersicht und Konten; mit
  `write` darf er Buchungen bearbeiten.
- **Fehler und Grenzfälle:** Der Besitzer des Kontos lässt sich nicht
  entfernen. Wer sich selbst den Zugriff nimmt, verliert die Sicht
  sofort.
- **Test:** –

---

## KIT: Einstellungen: KI-Tagging (`/finanzen/ki-tagging`)

Warteschlange des Tag-Vorschlagsdienstes mit Zählern (wartend, läuft,
fertig, fehlgeschlagen).

### FIN-KIT-01 Warteschlange steuern

- **Wo:** Knöpfe „Alle einreihen“, „Fehlgeschlagene wiederholen“,
  „Abbrechen“
- **Recht:** `data.manage`
- **Vorbedingung:** keine
- **Schritte:**
  1. Knopf drücken.
- **Ergebnis:** Zähler ändern sich; Vorschläge erscheinen danach in der
  Karte „KI-Vorschläge“ der Buchungen.
- **Fehler und Grenzfälle:** „Alle einreihen“ stellt jede Buchung ohne
  Entscheidung neu an; schon beantwortete Vorschläge bleiben.
- **Test:** –

---

## HLF: Hilfe: Bankkontakte (`/finanzen/bankkontakte/hilfe`)

### FIN-HLF-01 Hilfe lesen

- **Wo:** über den Fragezeichen-Knopf auf `BKL`
- **Recht:** `finance.accounts.manage`
- **Vorbedingung:** keine
- **Schritte:**
  1. Lesen: wie FinTS-Zugänge eingerichtet werden, was die TAN-Verfahren
     bedeuten, warum ein Abruf über 90 Tage eine TAN braucht.
- **Ergebnis:** Zurück führt zu `BKL`.
- **Fehler und Grenzfälle:** keine
- **Test:** –

---

## Abdeckung

| ID | Aktion | Recht | Test |
|---|---|---|---|
| FIN-UEB-01 | Buchungen eines Kontos öffnen | view | – |
| FIN-UEB-02 | Buchungen einer Sektion öffnen | view | – |
| FIN-UEB-03 | Anomalien öffnen | view | – |
| FIN-UEB-04 | Übersicht konfigurieren | view | – |
| FIN-KON-01 | Konto anlegen | accounts.manage | – |
| FIN-KON-02 | Stammdaten bearbeiten | accounts.manage | – |
| FIN-KON-03 | Bargeldbuchung aus der Kontenliste | write | – |
| FIN-KON-04 | Buchungen des Kontos öffnen | view | – |
| FIN-BUC-01 | Suchen | view | – |
| FIN-BUC-02 | Filtern | view | – |
| FIN-BUC-03 | Sortieren | view | – |
| FIN-BUC-04 | Buchung öffnen | view | – |
| FIN-BUC-05 | Auswahlmodus und Mehrfachauswahl | view | `finance.spec.ts` |
| FIN-BUC-06 | Tags im Stapel setzen | write | `finance.spec.ts` |
| FIN-BUC-07 | Auswahl ablegen | view | – |
| FIN-BUC-08 | Als Regel-Mappe speichern | view | – |
| FIN-BUC-09 | Bargeldbuchung anlegen | write | – |
| FIN-BUC-10 | Summe lesen | view | – |
| FIN-BUC-11 | Depotbestand lesen und Position öffnen | view | – |
| FIN-BUC-12 | Depot-Transaktion von Hand | write | – |
| FIN-BUC-13 | Sammelmappe mit Buchungen öffnen | view | – |
| FIN-BUC-14 | Weitere Buchungen laden | view | – |
| FIN-BNE-01 | Buchung erfassen | write | – |
| FIN-BNE-02 | Empfänger aus „Zuletzt verwendet“ | write | – |
| FIN-BNE-03 | Beleg fotografieren | write | – |
| FIN-BNE-04 | Dokument suchen und verknüpfen | write | – |
| FIN-BDT-01 | Zurück und Abbrechen | view | – |
| FIN-BDT-02 | Durch den Basket blättern | view | – |
| FIN-BDT-03 | Ablegen | view | – |
| FIN-BDT-04 | Link teilen | view | – |
| FIN-BDT-05 | Felder einer Bargeldbuchung ändern | write | – |
| FIN-BDT-06 | IBAN kopieren | view | – |
| FIN-BDT-07 | Tag hinzufügen oder entfernen | write | `finance.spec.ts` |
| FIN-BDT-08 | Notiz schreiben | write | – |
| FIN-BDT-09 | KI-Vorschläge annehmen oder ablehnen | write | – |
| FIN-BDT-10 | Steuerrelevanz setzen | write | – |
| FIN-BDT-11 | Buchung aufteilen | write | – |
| FIN-BDT-12 | Beleg fotografieren | write | – |
| FIN-BDT-13 | Beleg suchen und verknüpfen | write | – |
| FIN-BDT-14 | Vorgeschlagene Belege annehmen oder verwerfen | write | – |
| FIN-BDT-15 | Beleg öffnen oder Verknüpfung trennen | write | – |
| FIN-BDT-16 | Wiederkehrende Buchung, Tags übernehmen | write | – |
| FIN-BDT-17 | Bargeldbuchung löschen | write | – |
| FIN-BKL-01 | Bankkontakt anlegen | accounts.manage | – |
| FIN-BKL-02 | Sync jetzt | accounts.manage | – |
| FIN-BKL-03 | TAN eingeben | accounts.manage | – |
| FIN-BKL-04 | Bankkontakt öffnen | accounts.manage | – |
| FIN-BKL-05 | Hilfe öffnen | accounts.manage | – |
| FIN-BKD-01 | Stammdaten ändern | accounts.manage | – |
| FIN-BKD-02 | TAN-Verfahren abrufen und wählen | accounts.manage | – |
| FIN-BKD-03 | Sync jetzt | accounts.manage | – |
| FIN-BKD-04 | Ab Datum abrufen | accounts.manage | – |
| FIN-BKD-05 | Sync-Zeiten bearbeiten | accounts.manage | – |
| FIN-BKD-06 | Bankkonto importieren, verknüpfen, ignorieren | accounts.manage | – |
| FIN-BKD-07 | Konto des Kontakts öffnen | accounts.manage | – |
| FIN-BKD-08 | Bankkontakt löschen | accounts.manage | – |
| FIN-SYN-01 | Zeitplan setzen | accounts.manage | – |
| FIN-POR-01 | Aktualisieren | view | – |
| FIN-POR-02 | Filtern | view | – |
| FIN-POR-03 | Belege einlesen | view | – |
| FIN-POR-04 | Zeitraum der Performance | view | – |
| FIN-POR-05 | Zu prüfen bearbeiten | write | – |
| FIN-POR-06 | Position öffnen | view | – |
| FIN-POR-07 | Allokation und Erträge umschalten | view | – |
| FIN-POR-08 | Weitere Transaktionen laden | view | – |
| FIN-POS-01 | Aktualisieren und Link teilen | view | – |
| FIN-POS-02 | Verlauf lesen | view | – |
| FIN-POS-03 | Nachrichten lesen | view | – |
| FIN-POS-04 | Zuordnung zu Depots ändern | write | – |
| FIN-POS-05 | Bestandsabgleich prüfen | view | – |
| FIN-POS-06 | Verkäufe, Pro Jahr, Transaktionen | view | – |
| FIN-KUR-01 | Kurse abrufen | view | – |
| FIN-KUR-02 | Depots eingrenzen und Zeitspanne | view | – |
| FIN-KUR-03 | Kachel öffnen | view | – |
| FIN-KUR-04 | Zum Portfolio | view | – |
| FIN-PRG-01 | Person anlegen, bearbeiten, entfernen | schreiben | – |
| FIN-PRG-02 | Zeitpunkt anlegen oder ändern | schreiben | – |
| FIN-PRG-03 | Eintrag anlegen, bearbeiten, löschen | schreiben | – |
| FIN-PRG-04 | Konten übernehmen | schreiben | – |
| FIN-PRG-05 | Dokumente und Buchungen eines Eintrags | view | – |
| FIN-PRG-06 | Ausstiegsalter spielen | view | – |
| FIN-PRG-07 | Alle Kombinationen vergleichen | view | – |
| FIN-PRG-08 | Robustheit, Zielalter, Kaufkraft | view | – |
| FIN-PRG-09 | Jahr im Detail | view | – |
| FIN-PRG-10 | Annahmen ändern | schreiben | – |
| FIN-PRG-11 | Szenario speichern, wechseln, vergleichen, löschen | schreiben | – |
| FIN-PRG-12 | Prognose teilen | Besitzer | – |
| FIN-PRG-13 | Plan und Wirklichkeit | view | – |
| FIN-ZAH-01 | Zeitraum und Kanal wählen | view | – |
| FIN-ZAH-02 | Verlauf einer Zahlung | view | – |
| FIN-ANO-01 | Filtern und aktualisieren | view | – |
| FIN-ANO-02 | Quittieren | write | – |
| FIN-ANO-03 | Buchung öffnen, Verlauf, Basket | view | – |
| FIN-STR-01 | Steuerjahr und Person wählen | view | – |
| FIN-STR-02 | Dokument öffnen | documents.view | – |
| FIN-STR-03 | Ausfüllhilfe öffnen | view | – |
| FIN-STR-04 | Wert bestätigen oder korrigieren | write | – |
| FIN-STR-05 | Ausfüllhilfe als PDF ablegen | documents.upload | – |
| FIN-STR-06 | Belegwerte nachlesen | data.manage | – |
| FIN-BET-01 | Betrieb anlegen | view | – |
| FIN-BET-02 | Betrieb öffnen | view | – |
| FIN-BTD-01 | Stammdaten bearbeiten oder löschen | view | – |
| FIN-BTD-02 | Jahr wählen | view | – |
| FIN-BTD-03 | Anlagegut anlegen, bearbeiten, löschen | view | – |
| FIN-BTD-04 | AfA-Plan ansehen | view | – |
| FIN-BTD-05 | EÜR lesen, Zeilen, PDF | view | – |
| FIN-BTD-06 | Photovoltaik | view | – |
| FIN-BTD-07 | Fläche anlegen, bearbeiten, löschen | view | – |
| FIN-BTD-08 | Dokument verknüpfen oder lösen | view | – |
| FIN-BAB-01 | Vorschlag übernehmen, bearbeiten, verwerfen | write | – |
| FIN-ZUG-01 | Zugriff vergeben, ändern, entziehen | finance.admin | – |
| FIN-KIT-01 | Warteschlange steuern | data.manage | – |
| FIN-HLF-01 | Hilfe lesen | accounts.manage | – |
