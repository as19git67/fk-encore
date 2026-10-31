# Dokumente

Das Modul verwaltet PDFs und eigene Textdokumente. Nach dem Hochladen wird
der Text gelesen (bei Scans per OCR), eine lokale KI bestimmt Kategorie,
Titel, Absender, Datum, Dokumentart, Tags, Zusammenfassung, Bezugspersonen
und die Rolle für die Steuererklärung. Alles davon lässt sich prüfen und
ändern; was von Hand festgelegt wurde, überschreibt keine Neuanalyse mehr.
Technischer Hintergrund: `documentation/document-text-extraction.md`,
`document-folders.md`, `tax-document-detection.md`,
`documentation/plans/dokumente-zusammenhang.md`,
`documentation/plans/steuer-belegrolle.md`.

**Modulrecht:** `documents.view` schaltet den Menüpunkt „Dokumente“ frei.

| Schlüssel | erlaubt |
|---|---|
| `documents.view` | Liste, Suche, Detailansicht, Arbeitskorb, Später, Sammelmappen, Bezugspersonen, Hilfe |
| `documents.upload` | Hochladen, Textdokument schreiben, Standardgruppe für neue Dokumente |
| `documents.edit` | Felder und Steuer-Zuordnung bearbeiten, Neu klassifizieren, OCR erzwingen, Datei ersetzen, Entsperren, Cloud-Lehrer vormerken |
| `documents.delete` | Dokument endgültig löschen |
| `documents.manage_taxonomy` | Kategorie-Vorschläge, Steuer-Hints, Hint-Vorschläge, Korrespondenten |
| `groups.view` | Gruppen |
| `data.manage` | Verarbeitung, Duplikate, Taxonomie-Cockpit, Taxonomie-Tools, KI-Modell, KI-Benchmark |
| `module.assistant` | „An den Assistenten“, „Antwort entwerfen“, „Assistent schreiben lassen“ |

**Sichtbarkeit:** Ein Dokument ist privat oder mit einer Gruppe geteilt.
Wer es sieht, bestimmt die Gruppe; was man damit tun darf, bestimmen die
Schlüssel oben.

**Status eines Dokuments** (Chip in Liste und Detail): Warteschlange,
Text-Extraktion, KI-Analyse, Fertig, Fehler, Passwortgeschützt. Statuswechsel
erscheinen live, ohne Neuladen. Dazu die Hinweis-Chips „Neu“ (KI-Zuordnung
noch nicht bestätigt) und „Prüfen · n %“ (Konfidenz unter 60 %).

**Steuer-Rolle:** „Steuerrelevant“ (der Beleg selbst), „Steuerbezug“
(betrifft den Sachverhalt, ist aber kein Beleg) oder „Nicht
steuerrelevant“.

## Seiten

| Kürzel | Seite | Pfad | Recht |
|---|---|---|---|
| `LST` | Alle Dokumente | `/dokumente` | `documents.view` |
| `DET` | Dokumentdetails | `/dokumente/:id` | `documents.view` |
| `UPL` | Hochladen | `/dokumente/upload` | `documents.upload` |
| `TXT` | Textdokument schreiben / bearbeiten | `/dokumente/neu`, `/dokumente/:id/bearbeiten` | `documents.upload` / `documents.edit` |
| `KRB` | Arbeitskorb | `/dokumente/korb` | `documents.view` |
| `SPT` | Später | `/dokumente/spaeter` | `documents.view` |
| `MAP` | Sammelmappen (Dokumente) | `/dokumente/mappen` | `documents.view` |
| `MPD` | Sammelmappe (Detail) | `/dokumente/mappen/:id` | `documents.view` |
| `BZP` | Bezugspersonen & Haushalt | `/dokumente/bezugspersonen` | `documents.view` |
| `GRP` | Gruppen | `/dokumente/gruppen` | `groups.view` |
| `KVS` | Kategorie-Vorschläge | `/dokumente/kategorien/vorschlaege` | `documents.manage_taxonomy` |
| `STH` | Steuer-Hints | `/dokumente/steuer/hints` | `documents.manage_taxonomy` |
| `HVS` | Hint-Vorschläge | `/dokumente/hint-vorschlaege` | `documents.manage_taxonomy` |
| `KOR` | Korrespondenten | `/dokumente/korrespondenten` | `documents.manage_taxonomy` |
| `VER` | Verarbeitung | `/dokumente/verarbeitung` | `data.manage` |
| `DUP` | Duplikate | `/dokumente/duplikate` | `data.manage` |
| `TXC` | Taxonomie-Cockpit | `/dokumente/taxonomie-cockpit` | `data.manage` |
| `TXT2` | Taxonomie-Tools | `/dokumente/taxonomie-tools` | `data.manage` |
| `KIM` | KI-Modell | `/dokumente/ki-modell` | `data.manage` |
| `KIB` | KI-Benchmark | `/dokumente/ki-benchmark` | `data.manage` |
| `HLF` | Hilfe | `/dokumente/hilfe` | `documents.view` |

`/dokumente/steuer` leitet nach Finanzen › Steuer weiter (`finanzen.md`).
Das Untermenü zeigt „Alle Dokumente“, „Arbeitskorb“, „Später“,
„Sammelmappen“ und das Zahnrad „Einstellungen“ mit allen übrigen Seiten
nach Recht gefiltert; darunter „Mein Profil“.

Die gemeinsamen Bedienmuster (Suche mit `/`, Filter-Chips, Sortiermenü,
Auswahlmodus mit `Esc`, `Ctrl/Cmd+A` und Umschalt+Klick, „Ablegen“-Dialog,
Basket-Schublade) stehen in `allgemein.md` und `sammelmappen.md`; hier
steht nur, was das Modul daraus macht.

---

## LST: Alle Dokumente (`/dokumente`)

Volle Breite. Oben rechts: Hilfe (Fragezeichen), Zahnrad „Standard für neue
Dokumente“, „Schreiben“ und „Hochladen“ (die drei letzten nur mit
`documents.upload`). Darunter die Listen-Toolbar, ein Warteschlangen-Streifen,
der nur bei Aktivität erscheint, ein Streifen mit Sammelmappen-Kacheln und
die Liste oder das Kachelraster. Auf breiten Bildschirmen im Querformat
(ab 1300 px) steht rechts die Vorschau des aktuellen Dokuments.

### DOK-LST-01 Dokument öffnen

- **Wo:** Titel in der Zeile (Liste) oder Kachel (Raster), auch per Enter
- **Recht:** `documents.view`
- **Schritte:** 1. Titel anklicken.
- **Ergebnis:** Detailansicht (`DET`). Zurück landet wieder auf dieser Zeile.
  In der geteilten Ansicht zeigt der Klick das Dokument rechts in der
  Vorschau statt zu wechseln; `↑`/`↓` gehen durch die Liste und die Vorschau
  folgt; „Öffnen“ in der Vorschau führt in die volle Detailansicht.
- **Test:** `frontend/e2e/specs/documents.spec.ts` deckt die Suche, nicht
  das Öffnen; sonst –

### DOK-LST-02 Suchen

- **Wo:** Suchfeld der Toolbar, Fokus mit `/`
- **Schritte:** 1. Begriff eingeben; die Liste lädt nach kurzer Pause.
  2. Optional Suchmodus „Hybrid“ (Standard), „Text“ (exakte Wörter) oder
  „Bedeutung“ (semantisch) im Schalter neben dem Feld; der Schalter
  erscheint nur bei aktiver Suche, die Wahl bleibt gespeichert.
- **Ergebnis:** Treffer samt gesetzten Filtern; `q` steht in der URL. Die
  Suche findet auch Dokumente in Sammelmappen und Mappen selbst (Titel,
  Notiz, Zusammenfassung). Kein „Mehr laden“ bei aktiver Suche.
- **Fehler und Grenzfälle:** Keine Treffer: „Keine Treffer für „…““ mit
  Hinweis auf andere Wörter oder einen anderen Suchmodus. `Esc` im Feld
  leert es.
- **Test:** `frontend/e2e/specs/documents.spec.ts` › „Suchfeld ist per
  Tastatur erreichbar und schreibt den Begriff in die URL“

### DOK-LST-03 Filtern

- **Wo:** Filter-Knopf der Toolbar öffnet den Dialog „Filter“
- **Felder:** Kategorie (Baum, Unterkategorien eingerückt, mit Suche),
  Status (Alle, Fertig, In Arbeit, Fehler, Warteschlange, Text-Extraktion),
  Tags, Absender, Korrespondent, Dokumentdatum (von/bis), Steuer (Rolle),
  Dokumentart, Sammelmappe (Auch in Sammelmappen, Ohne Sammelmappen, Nur in
  Sammelmappen, oder eine benannte Mappe), Kategorie-Quelle (Alle, KI
  (lokal), Cloud Teacher, Manuell), Bezugsperson; dazu die Schalter „Nur zu
  prüfen“ (Fehler plus Konfidenz unter 60 %) und „Nur unbestätigte“.
- **Schritte:** 1. Felder setzen. 2. „Anwenden“; „Zurücksetzen“ leert
  alles, „Abbrechen“ verwirft.
- **Ergebnis:** Chips unter der Toolbar, einer je Filter, jeder mit „×“;
  der Zähler am Filter-Knopf stimmt mit der Zahl der Chips überein; alles
  steht in der URL. Bei aktivem Dokumentfilter treten die Mappen-Kacheln
  zurück (Hinweis darüber).
- **Fehler und Grenzfälle:** Leeres Ergebnis mit Filter zeigt „Filter
  zurücksetzen“.
- **Test:** –

### DOK-LST-04 Sortieren

- **Wo:** Sortiermenü der Toolbar
- **Felder:** Hochgeladen (Standard, neueste zuerst), Dokumentdatum, Titel,
  Absender, Dateigröße; Richtung umschaltbar
- **Ergebnis:** `sortBy`/`sortDir` in der URL.
- **Test:** –

### DOK-LST-05 Ansicht wechseln

- **Wo:** Ansicht-Schalter der Toolbar: „Liste“ oder „Kacheln“
- **Ergebnis:** Kacheln zeigen Vorschaubild, Titel, Absender, Datum,
  Kategorie, Mappen und bis zu drei Tags („+n“). `view` in der URL.
- **Test:** –

### DOK-LST-06 Mehr laden

- **Wo:** Knopf „Mehr laden (n von m)“ unter der Liste
- **Vorbedingung:** mehr Dokumente als geladen, keine aktive Suche
- **Ergebnis:** nächste Seite wird angehängt.
- **Test:** –

### DOK-LST-07 Dokument ablegen (Basket oder Sammelmappe)

- **Wo:** „Ablegen“-Symbol in der Zeile oder Kachel; grün, solange das
  Dokument im Basket liegt
- **Ergebnis:** Dialog „Ablegen“ mit Basket zuoberst, passenden Mappen und
  „Neue Sammelmappe“; angehakt ist, wo das Dokument schon liegt. Der Basket
  hält bei Dokumenten das ganze Objekt, deshalb zeigt die Schublade sie mit
  Titel und bietet dort die Stapelaktionen (`sammelmappen.md`).
- **Test:** –

### DOK-LST-08 Mehrere Dokumente auswählen und ablegen

- **Wo:** „Auswählen“ in der Toolbar, dann Kästchen an den Zeilen;
  `Ctrl/Cmd+A` für alle, Umschalt+Klick für einen Bereich; Auswahlzeile mit
  Zähler und Aktionen
- **Aktionen der Auswahlzeile:** „Ablegen“ (Basket oder Mappe) und, mit
  `module.assistant`, „An den Assistenten“ (höchstens 20 Dokumente, sonst
  ausgegraut mit Tooltip)
- **Ergebnis:** Die Auswahl landet im Ziel; der Auswahlmodus bleibt an.
  `Esc` beendet ihn und leert die Auswahl, nie den Basket.
- **Test:** –

### DOK-LST-09 Sammelmappe aus dem Streifen öffnen

- **Wo:** Kachel im Streifen über der Liste (Typ-Symbol, Name, Inhalt, Tags,
  Stern, „⋮“ mit Menü aus `sammelmappen.md`)
- **Ergebnis:** Dokument-Mappe (`MPD`) oder gemischte Mappe
  (`/sammelmappen/:id`).
- **Fehler und Grenzfälle:** Dokumente, die in einer Mappe liegen, sind in
  der Liste ausgeblendet; die Mappe steht für sie. Der Hinweis „Dokumente,
  die in einer Sammelmappe liegen, sind ausgeblendet …“ hat „Auch
  anzeigen“. Bei Suche gilt das nicht.
- **Test:** –

### DOK-LST-10 Liste auf eine Mappe einschränken

- **Wo:** Mappen-Chip an einer Dokumentzeile, Filterfeld „Sammelmappe“ oder
  Aufruf mit `?collection=<id>`
- **Ergebnis:** Nur die Dokumente dieser Mappe, genau eine Mappen-Kachel
  darüber, Chip „Sammelmappe: …“.
- **Test:** –

### DOK-LST-11 Liste auf Herkunftsordner oder Referenznummer einschränken

- **Wo:** Aufruf mit `?folder=<pfad>` (aus den Brotkrumen „Herkunft“ der
  Detailansicht) oder `?ref=<nummer>` (aus einem Referenznummern-Chip)
- **Ergebnis:** alle Dokumente aus dem Ordner abwärts beziehungsweise mit
  dieser Nummer, einzeln aufgelistet, auch wenn sie in Mappen liegen.
- **Test:** –

### DOK-LST-12 Standardgruppe für neue Dokumente setzen

- **Wo:** Zahnrad oben rechts, Dialog „Standard für neue Dokumente“
- **Recht:** `documents.upload`
- **Schritte:** 1. „Privat (Standard)“ oder „Standardmäßig in Gruppe“ mit
  Gruppe wählen. 2. „Speichern“.
- **Ergebnis:** Grüne Meldung „Standard für neue Dokumente gespeichert.“;
  alles, was ab jetzt hochgeladen oder geschrieben wird, bekommt diese
  Sichtbarkeit.
- **Fehler und Grenzfälle:** Ist die Person nicht mehr Mitglied der
  gespeicherten Gruppe, ist das Zahnrad orange und der Dialog warnt; neue
  Dokumente bleiben dann privat, bis eine Gruppe gewählt ist. Ohne Gruppen
  ist die zweite Option ausgegraut.
- **Test:** –

### DOK-LST-13 Warteschlange einsehen

- **Wo:** Streifen „Warteschlange: n aktiv · n wartend · n fehlgeschlagen“
  über der Liste; erscheint nur bei Aktivität
- **Schritte:** 1. Streifen anklicken.
- **Ergebnis:** Tabelle je Dienst (Wartend, Aktiv, Fehler, Fertig); darunter
  „Hängende Jobs“ mit Link zum Dokument, Dienst, Wartezeit, Zurückstellungen
  und Grund. Knöpfe „Fehlgeschlagene wiederholen“ und „Warteschlange
  abbrechen“ (nur sichtbar, wenn es etwas zu wiederholen oder abzubrechen
  gibt).
- **Test:** –

### DOK-LST-14 Zur Hilfe, zum Hochladen, zum Schreiben

- **Wo:** Fragezeichen, „Hochladen“, „Schreiben“ oben rechts
- **Ergebnis:** `HLF`, `UPL`, `TXT`.
- **Test:** –

### DOK-LST-15 Leere Liste

- **Ergebnis:** „Noch keine Dokumente vorhanden“ mit „Lade ein Dokument
  hoch oder lass den Scan-Ordner überwachen.“
- **Test:** –

---

## DET: Dokumentdetails (`/dokumente/:id`)

Kopfzeile: Zurück-Pfeil, Titel, dann Vor/Zurück durch die Sammelmappe oder
den Basket (wenn von dort geöffnet, mit Position „n / m“), „Ablegen“ und
die Aktionsleiste, die in ein Menü „⋮“ faltet, was nicht passt. Links das
PDF (bei Textdokumenten Schalter „Text“ / „PDF“), rechts die Angaben.

Aktionsleiste nach Recht: „Bearbeiten“ (nur Textdokumente, `documents.edit`),
Herunterladen, Drucken, „Wiedervorlage“, „Antwort entwerfen“
(`module.assistant`, nicht bei Textdokumenten), „Vormerken“/„Vorgemerkt“
für den Cloud-Lehrer (`documents.edit`), Hilfe zu den Aktionen, Löschen
(`documents.delete`), „Neu klassifizieren“ und „OCR erzwingen“
(`documents.edit`; die beiden stehen immer im Menü „⋮“).

### DOK-DET-01 Zurück

- **Ergebnis:** vorige Seite, wenn sie im Modul oder modulübergreifend war,
  sonst die Liste. Aus einer Mappe geöffnet: zurück in die Mappe.
- **Test:** –

### DOK-DET-02 Durch Sammelmappe oder Basket blättern

- **Wo:** Pfeile links und rechts der Position in der Kopfzeile
- **Vorbedingung:** aus einer Mappe geöffnet, oder das Dokument liegt im
  Basket
- **Ergebnis:** vorheriges oder nächstes Dokument der Mappe beziehungsweise
  des Baskets; am Ende ist der Pfeil ausgegraut.
- **Test:** –

### DOK-DET-03 Herunterladen

- **Ergebnis:** PDF mit durchsuchbarer Textebene wird gespeichert; bei
  reinen Scans wird die Textebene vorher per OCR erzeugt (Knopf zeigt
  Laden).
- **Test:** –

### DOK-DET-04 Drucken

- **Ergebnis:** Druckdialog des Browsers mit dem PDF. Auf iPhone und iPad
  öffnet der Dialog „Drucken“ mit „Drucken …“ das Teilen-Menü, dort steht
  „Drucken“.
- **Test:** –

### DOK-DET-05 Felder bearbeiten und speichern

- **Wo:** Formular rechts: Titel, Datum (mit Leeren-Knopf), Absender,
  Dok.-Nr., Referenznummern (eine je Zeile, zum Beispiel
  `Versicherungsnummer: AB 123456`), Kategorie (Auswahl mit Suche und
  „Keine“), Dokumentart, Tags (Komma-getrennt), Bezugspersonen (Mehrfach,
  Chips), Sichtbarkeit (Privat / Gruppe mit Auswahl), Zusammenfassung,
  Notizen
- **Recht:** `documents.edit`; sonst sind die Felder nur lesbar und die
  Knöpfe fehlen
- **Schritte:** 1. Felder ändern. 2. „Speichern“; „Zurücksetzen“ stellt die
  gespeicherten Werte wieder her.
- **Ergebnis:** Grüne Meldung; das Dokument gilt als manuell bestätigt:
  blaues Banner „Diese Felder wurden manuell festgelegt und werden bei einer
  KI-Neuanalyse nicht überschrieben.“ Der Chip „Neu“ in der Liste
  verschwindet. Referenznummern erscheinen als Chips, die die Liste filtern
  (DOK-LST-11). Unter der Dokumentart steht, falls bekannt, die
  Aufbewahrungsfrist („voraussichtlich entbehrlich ab …“, Orientierung,
  keine Rechtsberatung).
- **Fehler und Grenzfälle:** Sichtbarkeit „Gruppe“ ohne Gruppe: „Du gehörst
  noch keiner Gruppe an.“ Automatisch erkannte Bezugspersonen tragen ein
  Funkeln; die eigene Auswahl bleibt bei Neuanalyse.
- **Test:** –

### DOK-DET-06 Felder wieder von der KI bestimmen lassen

- **Wo:** Knopf „Wieder von KI bestimmen lassen“ im blauen Banner
- **Recht:** `documents.edit`
- **Ergebnis:** Die manuelle Festlegung ist aufgehoben; die nächste
  Neuanalyse darf die Felder wieder setzen.
- **Test:** –

### DOK-DET-07 Neue Kategorie vorschlagen

- **Wo:** Link „Keine passende Kategorie? Neue vorschlagen“ unter der
  Kategorie
- **Recht:** `documents.edit`
- **Schritte:** 1. Dialog „Neue Kategorie vorschlagen“: Name, optional
  Oberkategorie, Haken „Dokument vorerst auf „Sonstiges“ setzen“.
  2. „Vorschlag einreichen“.
- **Ergebnis:** Vorschlag erscheint unter Kategorie-Vorschläge (`KVS`) mit
  diesem Dokument als Beispiel; grüne Meldung.
- **Test:** –

### DOK-DET-08 Steuer-Zuordnung bearbeiten

- **Wo:** Karte „Steuer“, Knopf „Bearbeiten“
- **Recht:** `documents.edit`
- **Schritte:** 1. Rolle wählen: Steuerrelevant (Beleg), Steuerbezug, Nicht
  steuerrelevant; unter dem Schalter steht die Erklärung der Rolle.
  2. Steuerjahr (Pflicht beim Beleg, optional beim Bezug). 3. Sektionen der
  Steuererklärung anhaken, gruppiert nach Einkünfte, Abzüge, Bescheide,
  Stammdaten. 4. „Speichern“; „Abbrechen“ verwirft.
- **Ergebnis:** Chips der Sektionen mit Funkeln (KI, mit Prozent) oder
  Stift (manuell); Chip „Manuell bestätigt“; Banner, dass Neuanalysen die
  Zuordnung nicht mehr ändern. Die App lernt: dieselbe Dokumentart desselben
  Absenders wird beim nächsten Mal gleich eingeordnet. Beleg-Dokumente
  erscheinen unter Finanzen › Steuer.
- **Fehler und Grenzfälle:** Ein Beleg ohne Jahr oder ohne Sektion wird
  abgewiesen, ein Bezug ohne Sektion ebenso. Der Hinweis „Betrifft eine
  Bezugsperson mit einer absetzbaren Position — bitte prüfen, ob du die
  Ausgabe getragen hast“ verschwindet mit dem Bestätigen.
- **Test:** –

### DOK-DET-09 Steuer-Zuordnung wieder von der KI bestimmen lassen

- **Wo:** Knopf im Banner der Karte „Steuer“
- **Recht:** `documents.edit`
- **Ergebnis:** wie DOK-DET-06 für die Steuerfelder.
- **Test:** –

### DOK-DET-10 Neu klassifizieren

- **Wo:** Menü „⋮“ › „Neu klassifizieren“
- **Recht:** `documents.edit`
- **Ergebnis:** Status springt auf „KI-Analyse“ und läuft live bis
  „Fertig“; manuell bestätigte Felder bleiben.
- **Test:** –

### DOK-DET-11 OCR erzwingen

- **Wo:** Menü „⋮“ › „OCR erzwingen“ (nicht bei Textdokumenten)
- **Recht:** `documents.edit`
- **Ergebnis:** Die Textebene der PDF wird ignoriert und das Dokument
  komplett per OCR neu gelesen, danach neu klassifiziert; Status läuft über
  „Text-Extraktion“ und „KI-Analyse“. Hilft bei Scans mit fehlenden
  Leerzeichen.
- **Test:** –

### DOK-DET-12 Dokument löschen

- **Wo:** Menü „⋮“ › „Löschen“
- **Recht:** `documents.delete`
- **Schritte:** 1. Dialog „Dokument löschen“: „Dokument wirklich endgültig
  löschen? Diese Aktion kann nicht rückgängig gemacht werden.“ 2. Bestätigen.
- **Ergebnis:** Datei und Angaben sind weg; zurück zur Liste. Kein Rückweg.
- **Test:** –

### DOK-DET-13 Auf Wiedervorlage legen

- **Wo:** „Wiedervorlage“ in der Aktionsleiste
- **Schritte:** 1. Dialog „Wiedervorlage“: Datum (frühestens morgen),
  optional Notiz. 2. „Speichern“.
- **Ergebnis:** Das Dokument steht unter Später (`SPT`) und verschwindet
  aus dem Arbeitskorb bis zum Datum.
- **Test:** –

### DOK-DET-14 Antwort mit dem Assistenten entwerfen

- **Wo:** „Antwort entwerfen“ in der Aktionsleiste
- **Recht:** `module.assistant`
- **Ergebnis:** Assistent (`assistent.md`) mit diesem Dokument als
  Arbeitskontext; der fertige Brief wird als Dokument abgelegt und mit dem
  Original verknüpft (Gruppe „Antwort und Bezug“ unter „Verwandte
  Dokumente“).
- **Test:** –

### DOK-DET-15 Für den Cloud-Lehrer vormerken

- **Wo:** „Vormerken“ / „Vorgemerkt“ in der Aktionsleiste
- **Recht:** `documents.edit`
- **Ergebnis:** Das Dokument steht in der Warteschlange des Cloud-Lehrers
  (Taxonomie-Tools); ein zweiter Klick hebt die Vormerkung auf.
- **Test:** –

### DOK-DET-16 Hilfe zu den Aktionen

- **Wo:** Fragezeichen in der Aktionsleiste
- **Ergebnis:** Dialog „Aktionen“ mit einer Zeile je Knopf, nach Recht
  gefiltert.
- **Test:** –

### DOK-DET-17 Fehlgeschlagenes Dokument: Datei ersetzen oder Fehler verwerfen

- **Wo:** rotes Banner „Verarbeitung fehlgeschlagen: …“ mit „Datei
  ersetzen“ und „Fehler verwerfen“
- **Recht:** `documents.edit`
- **Ergebnis:** „Datei ersetzen“ öffnet die Dateiauswahl und startet die
  Verarbeitung mit der neuen PDF neu. „Fehler verwerfen“ setzt das Dokument
  auf „Fertig“, damit es von Hand ausgefüllt werden kann, wenn nur die
  Klassifikation scheiterte.
- **Test:** –

### DOK-DET-18 Passwortgeschütztes PDF entsperren

- **Wo:** gelbes Banner „Passwortgeschützt“ mit Feld „PDF-Passwort“ und
  „Entsperren & speichern“
- **Recht:** `documents.edit`; ohne Recht steht nur der Hinweis
- **Ergebnis:** Das PDF wird entschlüsselt und unverschlüsselt gespeichert;
  die Verarbeitung läuft an; danach ist kein Passwort mehr nötig.
- **Fehler und Grenzfälle:** falsches Passwort: rote Meldung, Status bleibt.
- **Test:** –

### DOK-DET-19 Verknüpfte Buchung öffnen oder trennen

- **Wo:** Abschnitt „Verknüpfte Buchungen“ (nur wenn vorhanden): Knopf mit
  Empfänger und Betrag, daneben „×“
- **Ergebnis:** Knopf öffnet die Buchung in den Finanzen; „×“ fragt
  „Verknüpfung zu dieser Buchung wirklich trennen?“ und entfernt die
  Verknüpfung, die Buchung bleibt.
- **Test:** –

### DOK-DET-20 Verwandte Dokumente

- **Wo:** Karte „Verwandte Dokumente“ unter der Steuer-Karte, eingeklappt
- **Ergebnis:** Gruppen wie „Gleicher Herkunftsordner“, „Gleiche
  Referenznummer“, „Antwort und Bezug“, „Ähnlicher Inhalt“; jede Zeile öffnet
  das Dokument, hat „Ablegen“.
- **Test:** –

### DOK-DET-21 Herkunft, Konfidenz, Briefkopf und Text einsehen

- **Wo:** Block unter den Karten: Dateiname, „Herkunft“ als Brotkrumen (jedes
  Glied filtert die Liste, DOK-LST-11), Konfidenz, „Briefkopf (Bildmodell)“
  mit Datum und Absender je mit „belegt“/„unbelegt“, „Text-Vorschau“ mit
  Knopf „Vollständigen Text anzeigen“
- **Test:** –

### DOK-DET-22 Duplikat-Hinweis

- **Wo:** gelbes Banner „Möglicherweise doppelt vorhanden: #… liest wie
  dieses Dokument.“ mit Links auf die anderen und, mit `data.manage`, „Zur
  Prüfung“ (`DUP`)
- **Test:** –

### DOK-DET-23 Textdokument: Ansicht wechseln und bearbeiten

- **Wo:** Schalter „Text“ / „PDF“ über dem linken Bereich; „Bearbeiten“ in
  der Aktionsleiste
- **Recht:** Bearbeiten mit `documents.edit`
- **Ergebnis:** „Text“ zeigt das gerenderte Markdown, „PDF“ die erzeugte
  Datei; „Bearbeiten“ öffnet `TXT`.
- **Test:** –

---

## UPL: Hochladen (`/dokumente/upload`)

### DOK-UPL-01 Dateien wählen oder ziehen

- **Wo:** Ablagefläche „PDFs hier ablegen – oder klicken, um Dateien
  auszuwählen“; Klick oder Enter öffnet die Dateiauswahl (mehrere PDFs);
  darunter „Ordner auswählen“ für einen ganzen Ordner
- **Recht:** `documents.upload`
- **Ergebnis:** Jede Datei steht in der Warteschlange mit Größe und Status
  „Wartet“. Bei „Ordner auswählen“ merkt sich die App den Pfad innerhalb
  des Ordners als Herkunft des Dokuments.
- **Fehler und Grenzfälle:** Nicht-PDFs werden sofort abgewiesen.
- **Test:** `frontend/e2e/specs/documents.spec.ts` › „Zur Upload-Seite
  navigieren und Datei per File-Input wählen“, „Drag-and-Drop einer PDF auf
  die Dropzone fügt sie der Warteschlange hinzu“, „Enter auf Dropzone öffnet
  den File-Picker“

### DOK-UPL-02 Hochladen

- **Wo:** Knopf „Hochladen“ über der Warteschlange
- **Schritte:** 1. Knopf drücken.
- **Ergebnis:** Jede Zeile läuft durch „Wird hochgeladen…“ zu „Hochgeladen –
  wird klassifiziert“; oben grün „n Dokument(e) hochgeladen. Klassifikation
  läuft im Hintergrund.“ Die Verarbeitung läuft weiter, auch wenn man die
  Seite verlässt. Neue Dokumente bekommen die Standardsichtbarkeit
  (DOK-LST-12).
- **Fehler und Grenzfälle:** „Bereits vorhanden“, wenn eine identische Datei
  schon gespeichert ist (keine zweite Kopie); „Fehler“ mit Meldung, wenn der
  Upload scheitert.
- **Test:** –

### DOK-UPL-03 Warteschlange aufräumen

- **Wo:** „×“ an einer Zeile (nicht während des Hochladens),
  „Abgeschlossene entfernen“
- **Ergebnis:** Zeile beziehungsweise alle fertigen Zeilen verschwinden aus
  der Warteschlange; hochgeladene Dokumente bleiben.
- **Test:** –

### DOK-UPL-04 Zurück

- **Ergebnis:** Liste (`LST`).
- **Test:** –

---

## TXT: Textdokument schreiben (`/dokumente/neu`, `/dokumente/:id/bearbeiten`)

### DOK-TXT-01 Textdokument anlegen

- **Wo:** „Schreiben“ in der Liste
- **Recht:** `documents.upload`
- **Schritte:** 1. Titel eingeben (bis 200 Zeichen). 2. Text im
  Markdown-Editor schreiben. 3. „Speichern“ (aktiv, sobald Titel und Text
  da sind; `Ctrl/Cmd+S` im Editor speichert auch).
- **Ergebnis:** Aus dem Text entsteht ein PDF mit dem heutigen Datum und der
  Person als Absender; es wird wie jedes Dokument eingeordnet; die
  Detailansicht öffnet sich.
- **Test:** –

### DOK-TXT-02 Textdokument bearbeiten

- **Wo:** „Bearbeiten“ in der Detailansicht eines Textdokuments
- **Recht:** `documents.edit`
- **Ergebnis:** Titel und Text sind geladen; „Speichern“ erzeugt das PDF
  neu; „Abbrechen“ oder der Pfeil verwirft.
- **Test:** –

### DOK-TXT-03 Text vom Assistenten schreiben lassen

- **Wo:** Knopf „Assistent“ oben
- **Recht:** `module.assistant`
- **Ergebnis:** Dialog mit Auftrag; der Vorschlag wird in den Editor
  eingefügt und lässt sich vor dem Speichern ändern.
- **Test:** –

---

## KRB: Arbeitskorb (`/dokumente/korb`)

Neu eingescannte Dokumente mit niedriger KI-Konfidenz oder Fehlern; die
Zeile zeigt Vorschaubild, Titel, Chip „Fehler“ oder „Prüfen · n %“,
Absender, Datum und Fehlertext.

### DOK-KRB-01 Dokument öffnen

- **Wo:** Vorschaubild oder Zeile
- **Ergebnis:** `DET`. Dort bestätigen (Speichern) nimmt es aus dem Korb.
- **Test:** –

### DOK-KRB-02 Auswählen

- **Wo:** Kästchen je Zeile, „Alle auswählen (n gewählt)“ oben
- **Ergebnis:** „Wiedervorlage“ und „Ablegen“ oben rechts werden aktiv.
- **Test:** –

### DOK-KRB-03 Auswahl auf Wiedervorlage legen

- **Wo:** „Wiedervorlage“ oben rechts
- **Schritte:** wie DOK-DET-13, für alle gewählten
- **Ergebnis:** Die Dokumente verschwinden aus dem Korb und tauchen am
  gewählten Datum wieder auf; grüne Meldung.
- **Test:** –

### DOK-KRB-04 Auswahl ablegen

- **Wo:** „Ablegen“ oben rechts
- **Ergebnis:** Dialog „Ablegen“ für die gewählten Dokumente.
- **Test:** –

### DOK-KRB-05 Neu laden, leerer Korb

- **Wo:** Pfeil-Knopf oben rechts
- **Ergebnis:** Liste neu; leer: „Der Arbeitskorb ist leer.“
- **Test:** –

---

## SPT: Später (`/dokumente/spaeter`)

Wiedervorlagen, nach Fälligkeit sortiert; überfällige Daten sind
hervorgehoben.

### DOK-SPT-01 Suchen

- **Wo:** Suchfeld der Toolbar
- **Ergebnis:** filtert Titel und Notiz; leer: „Keine Wiedervorlage passt
  zur Suche“.
- **Test:** –

### DOK-SPT-02 Dokument öffnen

- **Ergebnis:** `DET`.
- **Test:** –

### DOK-SPT-03 Wiedervorlage aufheben

- **Wo:** „Aufheben“ an der Zeile
- **Ergebnis:** Zeile verschwindet ohne Rückfrage; das Dokument kehrt, falls
  es noch zu prüfen ist, in den Arbeitskorb zurück.
- **Test:** –

### DOK-SPT-04 Leere Liste

- **Ergebnis:** „Keine Wiedervorlagen geplant“.
- **Test:** –

---

## MAP: Sammelmappen des Moduls (`/dokumente/mappen`)

Dokument-Mappen als Kacheln (dieselbe Kachel und dasselbe Menü wie überall,
`sammelmappen.md`).

### DOK-MAP-01 Neue Mappe anlegen

- **Wo:** „Neue Mappe“ oben rechts
- **Schritte:** 1. Dialog „Neue Sammelmappe“: Titel (Pflicht), Notiz
  (erscheint auf dem Deckblatt). 2. „Anlegen“ oder Enter im Titel.
- **Ergebnis:** Mappe öffnet sich (`MPD`), noch ohne Dokumente.
- **Test:** –

### DOK-MAP-02 Suchen und öffnen

- **Wo:** Suchfeld der Toolbar; Klick auf eine Kachel
- **Ergebnis:** Treffer über Titel, Notiz und Zusammenfassung; Klick öffnet
  `MPD`. Leer: „Noch keine Sammelmappe angelegt“ beziehungsweise „Keine
  Mappe passt zur Suche“.
- **Test:** –

---

## MPD: Sammelmappe mit Dokumenten (`/dokumente/mappen/:id`)

Eine Mappe fasst Dokumente zu einem PDF zusammen (Deckblatt,
Inhaltsverzeichnis, Zusammenfassung, dann die Dokumente in Reihenfolge).
Was in der Mappe über ein Dokument gilt (Reihenfolge, abgewählte Seiten,
Schwärzungen), gehört zur Mappe, nicht zum Dokument.

### DOK-MPD-01 Titel und Notiz ändern

- **Wo:** Titelfeld oben, Feld „Notiz“
- **Ergebnis:** gespeichert beim Verlassen des Felds oder Enter im Titel.
- **Test:** –

### DOK-MPD-02 Freigabe ändern

- **Wo:** Auswahl „Freigabe“ (nur wer die Mappe verwalten darf): „Privat
  (nur für mich)“ oder eine Gruppe
- **Ergebnis:** Chip „Gruppe“ neben dem Titel; alle Mitglieder sehen und
  bearbeiten die Mappe.
- **Fehler und Grenzfälle:** Eine Gruppenmappe darf nur Dokumente
  enthalten, die mit derselben Gruppe geteilt sind; andere werden abgewiesen.
- **Test:** –

### DOK-MPD-03 Mappe als Akte mit Regel führen

- **Wo:** Karte „Akte: Dokumente nach Regel aufnehmen“: Korrespondent,
  Referenznummern (Komma-getrennt), Herkunftsordner (Präfix); Knopf „Als
  Akte mit dieser Regel führen“ beziehungsweise „Regel speichern“, „Regel
  jetzt anwenden“, „Regel abschalten“
- **Ergebnis:** Dokumente, die aus dem Ordner stammen oder eine der Nummern
  tragen, treten selbst bei (Chip „per Regel“ an der Zeile, Zähler „n per
  Regel“); der Korrespondent zählt nur ohne Nummern. Was die Regel aufnahm,
  nimmt sie wieder heraus, wenn es nicht mehr passt; von Hand Hinzugefügtes
  bleibt. Nach „Regel jetzt anwenden“: „Regel angewendet: n aufgenommen, n
  entfernt.“
- **Test:** –

### DOK-MPD-04 Zusammenfassung

- **Wo:** Karte „Zusammenfassung über alle Dokumente“
- **Ergebnis:** wird nach jeder Änderung von der lokalen KI neu erzeugt
  (Chip „wird erstellt“); „Neu erzeugen“ stößt es an; eigener Text im Feld
  überschreibt sie. Fehler stehen gelb darunter.
- **Test:** –

### DOK-MPD-05 Bestandteile des PDFs wählen

- **Wo:** Haken „Deckblatt“, „Inhaltsverzeichnis“, „Zusammenfassung“
- **Ergebnis:** sofort gespeichert; wirkt beim nächsten „PDF erzeugen“.
- **Test:** –

### DOK-MPD-06 Reihenfolge von Hand

- **Wo:** Griff „☰“ links an der Zeile: Ziehen, oder Pfeiltasten auf dem
  fokussierten Griff; nur bei mehr als einem Dokument und ohne automatische
  Sortierung
- **Ergebnis:** Nummern links laufen mit; die Reihenfolge ist die des PDFs.
- **Test:** –

### DOK-MPD-07 Automatisch sortieren

- **Wo:** Zeile „Reihenfolge“: „Von Hand (Ziehen)“ oder bis zu drei Stufen
  aus Korrespondent, Dokumentname, Dokumentdatum, je mit Richtung
- **Ergebnis:** Die Mappe sortiert sich selbst, auch neu hinzugefügte
  Dokumente; die Griffe verschwinden, bis wieder „Von Hand“ gewählt ist.
- **Test:** –

### DOK-MPD-08 Dokument im PDF an- oder abwählen

- **Wo:** Kästchen an der Zeile
- **Ergebnis:** Zähler „n von m im PDF“; die Zeile wird blass; Reihenfolge
  und Seitenwahl bleiben erhalten.
- **Test:** –

### DOK-MPD-09 Seiten wählen und schwärzen

- **Wo:** Knopf „Seiten wählen und schwärzen“ an der Zeile
- **Schritte:** 1. Dialog „Seiten wählen — Titel“ mit Vorschaubildern,
  Suche im Text mit Vor/Zurück, Lupen, „Alle“/„Keine“. 2. Der runde Knopf
  auf einer Seite wählt sie an oder ab; Klick auf die Seite zeigt sie groß.
  3. In der Großansicht „Schwärzen“: Rechteck aufziehen; „Schwärzung
  entfernen“ am Rechteck. 4. „Übernehmen“.
- **Ergebnis:** Zeile zeigt „n von m Seiten“ und die Zahl der Schwärzungen;
  das erzeugte PDF enthält nur die gewählten Seiten mit geschwärzten
  Stellen. Das Original bleibt unverändert.
- **Test:** –

### DOK-MPD-10 Dokument öffnen oder aus der Mappe nehmen

- **Wo:** Vorschaubild oder Titel; „×“ am Ende der Zeile
- **Ergebnis:** Öffnen zeigt `DET` mit Vor/Zurück durch die Mappe; „×“
  entfernt das Dokument aus der Mappe ohne Rückfrage, das Dokument selbst
  bleibt.
- **Test:** –

### DOK-MPD-11 PDF erzeugen, laden, teilen

- **Wo:** Abschnitt unten: „PDF erzeugen“ / „Neu erzeugen“, dann „PDF
  laden“, „PDF teilen“ (wo das Gerät Dateien teilen kann) oder „PDF
  speichern“, „Speichern“
- **Ergebnis:** Der Server baut das PDF im Hintergrund („Du kannst die Seite
  verlassen, es läuft weiter.“); fertig steht Seitenzahl und Größe da. Das
  PDF bleibt, bis sich an der Mappe oder einem Dokument etwas ändert, dann
  muss es neu erzeugt werden. Auf iOS öffnet „PDF teilen“ das Teilen-Menü.
- **Fehler und Grenzfälle:** rote Meldung mit Grund; gelbe Meldung, wenn
  Dokumente nicht übernommen wurden (Datei fehlt, alle Seiten abgewählt,
  nicht sichtbar). Ohne eingeschlossenes Dokument und ohne Deckblatt ist der
  Knopf ausgegraut.
- **Test:** –

### DOK-MPD-12 Leere Mappe

- **Ergebnis:** „Noch keine Dokumente. Über „In Sammelmappe legen“ aus der
  Dokumentenliste oder dem Arbeitskorb hinzufügen.“
- **Test:** –

---

## BZP: Bezugspersonen & Haushalt (`/dokumente/bezugspersonen`)

Personen, die auf Dokumenten vorkommen (Angehörige). Der Klassifizierer
erkennt ihre Namen und vergibt das Beziehungs-Tag; die Beziehungsart
entscheidet, ob Steuerdokumente der Person zur Prüfung markiert werden.

### DOK-BZP-01 Veranlagungsart setzen

- **Wo:** Abschnitt „Veranlagungsart“: Veranlagung (Einzel/Zusammen),
  „Gilt ab Steuerjahr“ (leer = immer), „Speichern“
- **Ergebnis:** Bei Zusammenveranlagung entfällt die Steuer-Prüfung für
  Ehepartner:in und eigene Kinder im Haushalt; wirkt auch in der
  Ausfüllhilfe.
- **Test:** –

### DOK-BZP-02 Bezugsperson hinzufügen

- **Wo:** Abschnitt „Bezugsperson hinzufügen“: Name (wie auf dem Dokument),
  Beziehungs-Tag (zum Beispiel `mutter`), Beziehungsart, Geburtsdatum
  (optional), Kostenträger, „Eigene Steuererklärung ab Steuerjahr“, Haken
  „Im Haushalt“; „Hinzufügen“ (aktiv mit Name und Tag)
- **Ergebnis:** Zeile in der Tabelle; künftige Dokumente mit dem Namen
  bekommen das Tag und die Person.
- **Test:** –

### DOK-BZP-03 Felder in der Tabelle ändern

- **Wo:** Beziehung, Haushalt, Kostenträger, „Eigene Erklärung ab“,
  Steuer-Prüfung (Automatisch, Immer prüfen, Nie prüfen; mit eigener
  Erklärung stattdessen Chip „eigene Akte“) direkt in der Zeile
- **Ergebnis:** sofort gespeichert; Hinweise in der „Spalten-Legende“.
- **Test:** –

### DOK-BZP-04 Bezugsperson entfernen

- **Wo:** Papierkorb am Zeilenende
- **Ergebnis:** Zeile weg nach Rückfrage; Dokumente verlieren die Zuordnung,
  nicht das Tag.
- **Test:** –

---

## GRP: Gruppen (`/dokumente/gruppen`)

Links die Liste der Gruppen mit Mitgliederzahl und eigener Rolle, rechts die
Mitglieder der gewählten Gruppe.

### DOK-GRP-01 Gruppe anlegen

- **Wo:** „Neu“ oben rechts, Dialog „Neue Gruppe“ mit Name
- **Ergebnis:** Gruppe erscheint mit der Person als Besitzer.
- **Test:** –

### DOK-GRP-02 Mitglied hinzufügen

- **Wo:** „Mitglied hinzufügen“ (nur Besitzer): Benutzer suchen, Rolle
  Mitglied oder Besitzer
- **Ergebnis:** Zeile in der Mitgliedertabelle; die Person sieht ab jetzt
  alles, was mit der Gruppe geteilt ist.
- **Test:** –

### DOK-GRP-03 Mitglied entfernen

- **Wo:** Symbol am Zeilenende (nur Besitzer, nicht bei sich selbst)
- **Ergebnis:** Zeile weg; die Person verliert den Zugriff auf Geteiltes.
- **Test:** –

### DOK-GRP-04 Gruppe löschen

- **Wo:** Papierkorb an der Gruppe (nur Besitzer)
- **Ergebnis:** nach Rückfrage weg; geteilte Dokumente, Mappen und Zähler
  werden privat beim jeweiligen Besitzer.
- **Test:** –

---

## KVS: Kategorie-Vorschläge (`/dokumente/kategorien/vorschlaege`)

### DOK-KVS-01 Filtern

- **Wo:** Schalter Offen / Akzeptiert / Abgelehnt in der Toolbar
- **Test:** –

### DOK-KVS-02 Vorschlag akzeptieren

- **Wo:** „Akzeptieren“ an einer offenen Karte (Name, Eltern, Begründung,
  Beispiel-Dokumente als Links)
- **Schritte:** 1. Dialog „Kategorie anlegen“: Name und Slug anpassen; bei
  Slug-Kollision Hinweis, dass die bestehende Kategorie wiederverwendet wird.
  2. „Anlegen“.
- **Ergebnis:** Neue Kategorie im Baum; Karte trägt „Akzeptiert“.
- **Test:** –

### DOK-KVS-03 Vorschlag ablehnen

- **Ergebnis:** Karte trägt „Abgelehnt“; derselbe Vorschlag kommt nicht
  wieder.
- **Test:** –

---

## STH: Steuer-Hints (`/dokumente/steuer/hints`)

Je Anlage der Steuererklärung ein Text, den das Modell als Beschreibung
bekommt (typische Belege, Absender, Abgrenzungen).

### DOK-STH-01 Hint ändern

- **Wo:** Textfeld je Anlage, „Speichern“ (aktiv bei Änderung mit Inhalt)
- **Ergebnis:** Chip „Angepasst“ statt „Standard“, Standardtext darunter
  sichtbar; wirkt beim nächsten Klassifizierungslauf.
- **Test:** –

### DOK-STH-02 Auf Standard zurücksetzen

- **Test:** –

### DOK-STH-03 Dokumente der Anlage neu klassifizieren

- **Wo:** „Dokumente neu klassifizieren“, Dialog mit Haken „Auch manuell
  bestätigte Dokumente einbeziehen (überschreibt Nutzerauswahl nicht)“,
  „Starten“
- **Ergebnis:** alle Dokumente dieser Anlage laufen erneut durch die
  Klassifikation; OCR-Text bleibt.
- **Test:** –

---

## HVS: Hint-Vorschläge (`/dokumente/hint-vorschlaege`)

Wöchentliche Analyse geprüfter Dokumente schlägt bessere Hints je Anlage
und Kategorie vor.

### DOK-HVS-01 Filtern

- **Wo:** Offen / Akzeptiert / Abgelehnt und Alle / Steuer-Hints /
  Kategorie-Hints
- **Test:** –

### DOK-HVS-02 Vorschlag als nützlich markieren oder ablehnen

- **Wo:** „Nützlich“ / „Ablehnen“ an der Karte (Art, Ziel-Slug,
  vorgeschlagener Text, Begründung, bis zu zehn Beispiel-Dokumente)
- **Ergebnis:** Status-Chip; „Nützlich“ ändert den Hint nicht von selbst,
  das geschieht unter `STH`.
- **Test:** –

---

## KOR: Korrespondenten (`/dokumente/korrespondenten`)

### DOK-KOR-01 Override anlegen

- **Wo:** Felder „Absender-Muster“ und „Korrespondent“, „Hinzufügen“
- **Ergebnis:** Dokumente, deren Absender das Muster enthält, bekommen
  diesen Korrespondenten; Zeile in der Tabelle.
- **Test:** –

### DOK-KOR-02 Override löschen

- **Test:** –

---

## VER: Verarbeitung (`/dokumente/verarbeitung`)

Admin-Karten: „Dokument-Verarbeitung“, „Herkunftsordner nachtragen“,
„Scanner-Eingang“.

### DOK-VER-01 Verarbeitung für den Bestand anstoßen

- **Wo:** Karte „Dokument-Verarbeitung“: „Nur KI-Klassifikation“, „OCR +
  Klassifikation“, „Fehlende fortsetzen“, „Dateipfade aktualisieren“,
  „Wortpositionen nachtragen“, „KI-Analyse nachholen“, „Fehlgeschlagene
  wiederholen“, „Abbrechen“
- **Ergebnis:** Jobs landen in der Warteschlange (DOK-LST-13 zeigt den
  Fortschritt); „Abbrechen“ leert wartende Jobs.
- **Test:** –

### DOK-VER-02 Herkunftsordner nachtragen

- **Wo:** Pfad des Quellbaums, „Prüfen“ (Probelauf mit Zählern),
  „Übernehmen“
- **Ergebnis:** Dokumente ohne Herkunft bekommen den Ordner, in dem die
  gleiche Datei (per Prüfsumme) im Quellbaum liegt.
- **Test:** –

### DOK-VER-03 Scanner-Eingang einsehen

- **Wo:** Karte „Scanner-Eingang“, „Neu laden“
- **Ergebnis:** Stand der überwachten Eingangsordner.
- **Test:** –

---

## DUP: Duplikate (`/dokumente/duplikate`)

### DOK-DUP-01 Bestand nach Duplikaten durchsuchen

- **Ergebnis:** „n Paar(e) über der Schwelle, n neu zur Prüfung, n bereits
  bekannt.“
- **Test:** –

### DOK-DUP-02 Automatisch zusammenführen: Prüfen, Zusammenführen, Abhaken

- **Wo:** Karte „Automatisch zusammenführen“: „Prüfen“ (Probelauf),
  „Zusammenführen“ (erst nach Probelauf, rot, mit Rückfrage), „n Paar(e)
  als kein Duplikat“, „Bericht als CSV“
- **Ergebnis:** Fortschrittsbalken; Bericht mit Paaren über Hash im
  Dateinamen und über gleichen Inhalt, abgelehnte mit Grund; beim
  Zusammenführen bleibt das Original, Verknüpfungen wandern hinüber.
- **Test:** –

### DOK-DUP-03 Paar von Hand entscheiden

- **Wo:** Liste „Zur Prüfung“: je Paar beide Seiten mit Vorschaubild,
  Datei, Datum, Absender, Import, Größe, Textquelle, Herkunft und Chips;
  Radio „Bleibt“/„Wird gelöscht“ (Vorschlag markiert); „Kein Duplikat“,
  „Zusammenführen“ (mit Rückfrage)
- **Ergebnis:** Paar verschwindet; grüne Meldung, was zum bleibenden
  Dokument wanderte.
- **Test:** –

---

## TXC: Taxonomie-Cockpit (`/dokumente/taxonomie-cockpit`)

### DOK-TXC-01 Kennzahlen und Trend lesen, Snapshot auslösen

- **Wo:** KPI-Karten (Dokumente gesamt, Klassifiziert, Sonstiges-Quote,
  Ø Confidence, Niedrige Confidence, Teacher-Warteschlange, Offene
  Vorschläge, Kategorien belegt) mit Delta zum Vortag, Empfehlungen,
  Trend-Diagramme; „Snapshot jetzt“ oben rechts
- **Ergebnis:** Ein neuer Snapshot wird erfasst (sonst täglich 04:30 UTC).
- **Test:** –

---

## TXT2: Taxonomie-Tools (`/dokumente/taxonomie-tools`)

### DOK-TXT2-01 Werkzeug starten und verfolgen

- **Wo:** je Werkzeug (Diagnose, Cloud-Audit, Cloud-Teacher,
  Cloud-Teacher-Revert, Scoreboard, …) Optionen wie „Dry Run“,
  Stichprobengrößen, Fokus-Listen, Label; „Starten“, „Abbrechen“, „Log
  leeren“, „Aktualisieren“, Ergebnisdateien zum Laden
- **Ergebnis:** Lauf im Hintergrund, Log in der Karte, Ergebnisdateien
  darunter.
- **Test:** –

---

## KIM: KI-Modell (`/dokumente/ki-modell`)

### DOK-KIM-01 Konfiguration anlegen oder bearbeiten

- **Wo:** „Neue Konfiguration“ / „Bearbeiten“; Dialog mit Abschnitten
  Modell (Label, Dateiname, URL, SHA256), Inferenz (Backend, Beschleuniger,
  Kontext, KV-Typ …), llama-server (Reasoning, Zusatzargumente), Anwendung
- **Ergebnis:** Karte in „Konfigurationen“.
- **Test:** –

### DOK-KIM-02 Konfiguration aktivieren

- **Wo:** „Aktivieren“, Dialog „Modell wechseln“
- **Ergebnis:** Der llm-service lädt das Modell neu; „Aktuell geladen“ zeigt
  Stand und Fehler; „Auf Umgebung zurücksetzen“ nimmt die Konfiguration aus
  der Umgebung.
- **Test:** –

### DOK-KIM-03 Modelldatei laden oder löschen

- **Wo:** „Modell laden“ (URL, Dateiname, SHA256), Fortschritt mit
  „Abbrechen“; Papierkorb an einer Datei
- **Test:** –

---

## KIB: KI-Benchmark (`/dokumente/ki-benchmark`)

### DOK-KIB-01 Lauf starten

- **Wo:** Karte „Neuer Lauf“: Bezeichnung, Fälle (Mehrfachauswahl),
  Datenquelle (feste Werkzeugergebnisse oder synthetische Datenbank),
  „Synthetische Daten behalten“, „Auf dem CPU-Zwilling messen“; „Benchmark
  starten“, „Abbrechen“, „Synthetische Daten entfernen“
- **Ergebnis:** Fortschritt „n von m Fällen“; danach Karte „Lauf „…““ mit
  Trefferquote, Zeiten und jedem Fall samt Antwort.
- **Test:** –

### DOK-KIB-02 Verlauf und Rückmeldungen

- **Wo:** Karte „Verlauf“ (Lauf öffnen, als JSON laden, löschen), Karte
  „Rückmeldungen aus dem Alltag“ (Daumen aus dem Assistenten: „Als Fall
  kopieren“, löschen)
- **Test:** –

---

## HLF: Hilfe (`/dokumente/hilfe`)

### DOK-HLF-01 Hilfe lesen

- **Ergebnis:** Seite mit den Abschnitten Hochladen, Pipeline, Liste,
  Detailansicht, Steuer-Zuordnung, Review, Sammelmappen, Admin,
  Berechtigungen; „Zurück zur Dokumentenliste“ unten, Pfeil oben.
- **Test:** –

---

## Übersicht aller Kennungen

| Kennung | Aktion | Recht | Test |
|---|---|---|---|
| DOK-LST-01 | Dokument öffnen | view | – |
| DOK-LST-02 | Suchen | view | documents.spec.ts |
| DOK-LST-03 | Filtern | view | – |
| DOK-LST-04 | Sortieren | view | – |
| DOK-LST-05 | Ansicht wechseln | view | – |
| DOK-LST-06 | Mehr laden | view | – |
| DOK-LST-07 | Dokument ablegen | view | – |
| DOK-LST-08 | Mehrere auswählen und ablegen | view | – |
| DOK-LST-09 | Mappe aus dem Streifen öffnen | view | – |
| DOK-LST-10 | Auf Mappe einschränken | view | – |
| DOK-LST-11 | Auf Herkunft/Referenz einschränken | view | – |
| DOK-LST-12 | Standardgruppe setzen | upload | – |
| DOK-LST-13 | Warteschlange einsehen | view | – |
| DOK-LST-14 | Hilfe, Hochladen, Schreiben | view/upload | – |
| DOK-LST-15 | Leere Liste | view | – |
| DOK-DET-01 | Zurück | view | – |
| DOK-DET-02 | Durch Mappe/Basket blättern | view | – |
| DOK-DET-03 | Herunterladen | view | – |
| DOK-DET-04 | Drucken | view | – |
| DOK-DET-05 | Felder bearbeiten | edit | – |
| DOK-DET-06 | Felder wieder KI | edit | – |
| DOK-DET-07 | Kategorie vorschlagen | edit | – |
| DOK-DET-08 | Steuer-Zuordnung bearbeiten | edit | – |
| DOK-DET-09 | Steuer wieder KI | edit | – |
| DOK-DET-10 | Neu klassifizieren | edit | – |
| DOK-DET-11 | OCR erzwingen | edit | – |
| DOK-DET-12 | Löschen | delete | – |
| DOK-DET-13 | Wiedervorlage | view | – |
| DOK-DET-14 | Antwort entwerfen | module.assistant | – |
| DOK-DET-15 | Cloud-Lehrer vormerken | edit | – |
| DOK-DET-16 | Hilfe zu den Aktionen | view | – |
| DOK-DET-17 | Datei ersetzen / Fehler verwerfen | edit | – |
| DOK-DET-18 | PDF entsperren | edit | – |
| DOK-DET-19 | Buchung öffnen/trennen | view | – |
| DOK-DET-20 | Verwandte Dokumente | view | – |
| DOK-DET-21 | Herkunft, Briefkopf, Text | view | – |
| DOK-DET-22 | Duplikat-Hinweis | view | – |
| DOK-DET-23 | Textdokument Ansicht/Bearbeiten | view/edit | – |
| DOK-UPL-01 | Dateien wählen oder ziehen | upload | documents.spec.ts |
| DOK-UPL-02 | Hochladen | upload | – |
| DOK-UPL-03 | Warteschlange aufräumen | upload | – |
| DOK-UPL-04 | Zurück | upload | – |
| DOK-TXT-01 | Textdokument anlegen | upload | – |
| DOK-TXT-02 | Textdokument bearbeiten | edit | – |
| DOK-TXT-03 | Assistent schreiben lassen | module.assistant | – |
| DOK-KRB-01 | Öffnen | view | – |
| DOK-KRB-02 | Auswählen | view | – |
| DOK-KRB-03 | Wiedervorlage | view | – |
| DOK-KRB-04 | Ablegen | view | – |
| DOK-KRB-05 | Neu laden, leer | view | – |
| DOK-SPT-01 | Suchen | view | – |
| DOK-SPT-02 | Öffnen | view | – |
| DOK-SPT-03 | Aufheben | view | – |
| DOK-SPT-04 | Leer | view | – |
| DOK-MAP-01 | Mappe anlegen | view | – |
| DOK-MAP-02 | Suchen und öffnen | view | – |
| DOK-MPD-01 | Titel und Notiz | view | – |
| DOK-MPD-02 | Freigabe | Verwalter | – |
| DOK-MPD-03 | Akte mit Regel | view | – |
| DOK-MPD-04 | Zusammenfassung | view | – |
| DOK-MPD-05 | PDF-Bestandteile | view | – |
| DOK-MPD-06 | Reihenfolge von Hand | view | – |
| DOK-MPD-07 | Automatisch sortieren | view | – |
| DOK-MPD-08 | Im PDF an/abwählen | view | – |
| DOK-MPD-09 | Seiten wählen und schwärzen | view | – |
| DOK-MPD-10 | Öffnen / entfernen | view | – |
| DOK-MPD-11 | PDF erzeugen, laden, teilen | view | – |
| DOK-MPD-12 | Leere Mappe | view | – |
| DOK-BZP-01 | Veranlagungsart | view | – |
| DOK-BZP-02 | Bezugsperson hinzufügen | view | – |
| DOK-BZP-03 | Felder ändern | view | – |
| DOK-BZP-04 | Entfernen | view | – |
| DOK-GRP-01 | Gruppe anlegen | groups.view | – |
| DOK-GRP-02 | Mitglied hinzufügen | Besitzer | – |
| DOK-GRP-03 | Mitglied entfernen | Besitzer | – |
| DOK-GRP-04 | Gruppe löschen | Besitzer | – |
| DOK-KVS-01 | Filtern | manage_taxonomy | – |
| DOK-KVS-02 | Akzeptieren | manage_taxonomy | – |
| DOK-KVS-03 | Ablehnen | manage_taxonomy | – |
| DOK-STH-01 | Hint ändern | manage_taxonomy | – |
| DOK-STH-02 | Standard | manage_taxonomy | – |
| DOK-STH-03 | Neu klassifizieren | manage_taxonomy | – |
| DOK-HVS-01 | Filtern | manage_taxonomy | – |
| DOK-HVS-02 | Nützlich / Ablehnen | manage_taxonomy | – |
| DOK-KOR-01 | Override anlegen | manage_taxonomy | – |
| DOK-KOR-02 | Override löschen | manage_taxonomy | – |
| DOK-VER-01 | Verarbeitung anstoßen | data.manage | – |
| DOK-VER-02 | Herkunft nachtragen | data.manage | – |
| DOK-VER-03 | Scanner-Eingang | data.manage | – |
| DOK-DUP-01 | Scan | data.manage | – |
| DOK-DUP-02 | Automatisch zusammenführen | data.manage | – |
| DOK-DUP-03 | Paar entscheiden | data.manage | – |
| DOK-TXC-01 | Cockpit, Snapshot | data.manage | – |
| DOK-TXT2-01 | Werkzeug starten | data.manage | – |
| DOK-KIM-01 | Konfiguration | data.manage | – |
| DOK-KIM-02 | Aktivieren | data.manage | – |
| DOK-KIM-03 | Modelldatei | data.manage | – |
| DOK-KIB-01 | Lauf starten | data.manage | – |
| DOK-KIB-02 | Verlauf, Rückmeldungen | data.manage | – |
| DOK-HLF-01 | Hilfe lesen | view | – |
