# Assistent

Ein Chat, der Fragen über alle Daten beantwortet (Finanzen, Dokumente,
Fotos, Zähler, Reisen), nur über bestehende Service-Funktionen als der
fragende Nutzer und nur mit dessen Rechten. Schreibaktionen sind
Vorschläge, die erst nach Bestätigung laufen. Hintergrund:
`documentation/plans/ki-assistent.md` und `assistent-wegfindung.md`.

**Modulrecht:** `module.assistant` (Rolle „Assistent User“) schaltet den
Menüpunkt und das Chat-Symbol in der Kopfzeile frei. Was der Assistent
sehen darf, folgt aus den Modulrechten des Nutzers; der Systemprompt
nennt ihm die Bereiche mit und ohne Berechtigung.

**Begriffe:**

- **Unterhaltung** ist ein Gesprächsfaden mit Verlauf; der Titel entsteht
  aus der ersten Frage.
- **Arbeitskontext** sind Objekte (Fotos, Dokumente, Buchungen), die aus
  einer Auswahlleiste oder einer Detailseite mitgebracht wurden und auf
  die sich die Fragen beziehen.
- **Vorschlag** ist eine Karte für eine Schreibaktion (Tags setzen,
  Sammelmappe anlegen, Brief rendern, Collage, Fotobuch) mit den
  Zuständen Wartet auf Bestätigung, Läuft, Ausgeführt, Verworfen.
- **Nachgesehen** ist die Liste der Werkzeuge, die der Assistent für eine
  Antwort aufgerufen hat.

## Seiten

| Kürzel | Seite | Pfad | Recht |
|---|---|---|---|
| `CHT` | Assistent | `/assistent` (mit `?context=…` aus anderen Modulen) | `module.assistant` |

---

## CHT: Assistent (`/assistent`)

Links (ab `lg`) die Liste der Unterhaltungen, sonst als Drawer über den
Knopf „Unterhaltungen“. In der Mitte der Verlauf, unten die Eingabe
(„Was möchtest du wissen?“) mit Kontextanzeige. Über dem leeren Verlauf
stehen Vorschläge für erste Fragen.

### ASS-CHT-01 Neue Unterhaltung

- **Wo:** Knopf „Neue Unterhaltung“ (Kopf und Liste)
- **Recht:** `module.assistant`
- **Vorbedingung:** keine
- **Schritte:**
  1. Knopf drücken.
- **Ergebnis:** Leerer Verlauf mit Vorschlägen; die Unterhaltung erscheint
  in der Liste, sobald die erste Frage gestellt ist.
- **Fehler und Grenzfälle:** keine
- **Test:** –

### ASS-CHT-02 Frage stellen

- **Wo:** Eingabefeld, Knopf „Frage senden“ (Enter; Umschalt+Enter macht
  eine neue Zeile); Vorschlag-Chips
- **Recht:** `module.assistant`
- **Vorbedingung:** llm-service erreichbar
- **Schritte:**
  1. Frage eingeben, zum Beispiel `Was habe ich 2025 für Strom bezahlt?`,
     senden.
  2. Während der Antwort zeigt der Verlauf „Nachgesehen“ mit den
     laufenden Werkzeugen; „Antwort abbrechen“ stoppt.
- **Ergebnis:** Antwort als Text mit Blöcken (Tabellen, Fotos,
  Dokumente, Summen), darunter Daumen hoch/runter; der Titel der
  Unterhaltung erscheint nach kurzer Zeit.
- **Fehler und Grenzfälle:** Ist der Dienst belegt oder nicht erreichbar,
  steht eine Fehlermeldung im Verlauf, die Frage bleibt im Feld. Eine
  Angabe, die der Prüfer nicht belegen konnte, trägt den Hinweis „konnte
  ich nicht in den gelesenen Daten belegen“.
- **Test:** –

### ASS-CHT-03 Rückfrage auf eine frühere Antwort

- **Wo:** Eingabefeld
- **Recht:** `module.assistant`
- **Vorbedingung:** frühere Antwort mit Ergebnissen
- **Schritte:**
  1. Rückfrage stellen („davon nur die über 100 €“).
- **Ergebnis:** Der Assistent arbeitet auf dem früheren Ergebnis weiter,
  ohne neu zu laden.
- **Fehler und Grenzfälle:** Ältere Runden sind im Verlauf
  zusammengefasst; die Zeilen bleiben erreichbar.
- **Test:** –

### ASS-CHT-04 Ergebnisblöcke nutzen

- **Wo:** Blöcke in der Antwort: Liste ein-/ausklappen, Foto öffnen,
  „Alle n Treffer“ / „Nur die Auswahl“, „Alle n Gruppen“ / „Weniger
  zeigen“, Links auf Dokumente und Buchungen
- **Recht:** `module.assistant` und das Modulrecht des Objekts
- **Vorbedingung:** Antwort mit Block
- **Schritte:**
  1. Element anklicken.
- **Ergebnis:** Ziel öffnet sich im Modul (Galerie mit „Antwort des
  Assistenten“-Chip, Dokumentseite, Buchung).
- **Fehler und Grenzfälle:** keine
- **Test:** –

### ASS-CHT-05 Antwort kopieren oder als Textdokument speichern

- **Wo:** „Beitrag kopieren“, „Als Textdokument speichern“ unter der
  Antwort
- **Recht:** `module.assistant`; speichern `documents.upload`
- **Vorbedingung:** Antwort
- **Schritte:**
  1. Knopf drücken.
- **Ergebnis:** Text in der Zwischenablage bzw. neues Textdokument in den
  Dokumenten mit Link im Toast.
- **Fehler und Grenzfälle:** keine
- **Test:** –

### ASS-CHT-06 Feedback geben

- **Wo:** „Antwort war hilfreich“ / „Antwort war nicht hilfreich“, Feld
  „Was war falsch? (optional)“, „Senden“
- **Recht:** `module.assistant`
- **Vorbedingung:** gespeicherte Antwort
- **Schritte:**
  1. Daumen drücken, optional Text, „Senden“.
- **Ergebnis:** Eintrag mit Frage, Werkzeugspur (ohne Zeileninhalt) und
  Antwort; sichtbar für `data.manage` auf der KI-Benchmark-Seite.
- **Fehler und Grenzfälle:** keine
- **Test:** –

### ASS-CHT-07 Vorschlag ausführen oder verwerfen

- **Wo:** Karte „Vorschlag“ mit „Ausführen“ (nach Fehler „Erneut
  ausführen“) und „Verwerfen“
- **Recht:** das Recht der Aktion (zum Beispiel `write` auf dem Konto)
- **Vorbedingung:** Vorschlag im Zustand „Wartet auf Bestätigung“
- **Schritte:**
  1. Karte lesen; bei einem Brief Lücken `[[…]]` füllen („Zur Lücke“),
     Anlagen über „Dokument als Anlage hinzufügen …“.
  2. „Ausführen“.
- **Ergebnis:** Zustand „Läuft“, dann „Ausgeführt“ mit Link zum Ergebnis
  (Sammelmappe, Dokument, Album); ein Brief bietet „Ansehen“, „PDF
  herunterladen“, „Als E-Mail-Entwurf“.
- **Fehler und Grenzfälle:** Ein Fehler steht auf der Karte, „Erneut
  ausführen“ versucht es noch einmal; „Verwerfen“ ist endgültig.
- **Test:** –

### ASS-CHT-08 Collage aus dem Vorschlag

- **Wo:** Karte „Collage“ mit Layout-Vorschau, Textposition,
  „Herunterladen“
- **Recht:** `photos.view`
- **Vorbedingung:** Vorschlag mit Fotos
- **Schritte:**
  1. Layout und Text wählen, „Herunterladen“ oder ausführen.
- **Ergebnis:** Bilddatei.
- **Fehler und Grenzfälle:** keine
- **Test:** –

### ASS-CHT-09 Arbeitskontext verwalten

- **Wo:** Leiste „Arbeitskontext“ über der Eingabe; Einstieg über „An den
  Assistenten“ in Auswahlleisten und „Antwort entwerfen“ auf
  Dokumentseiten
- **Recht:** `module.assistant`
- **Vorbedingung:** keine
- **Schritte:**
  1. Objekte mitbringen; Kreuz „… aus dem Kontext entfernen“.
- **Ergebnis:** Fragen beziehen sich auf die Objekte („fasse das
  zusammen“, „antworte darauf“); der Kontext hängt an der Unterhaltung.
- **Fehler und Grenzfälle:** Die Kontextanzeige (`ContextMeter`) warnt,
  wenn das Kontextfenster knapp wird.
- **Test:** –

### ASS-CHT-10 Unterhaltung wechseln oder löschen

- **Wo:** Liste bzw. Drawer „Unterhaltungen“; Kreuz „Unterhaltung …
  löschen“
- **Recht:** `module.assistant`
- **Vorbedingung:** Unterhaltungen vorhanden
- **Schritte:**
  1. Eintrag wählen; zum Löschen Kreuz, Dialog „Unterhaltung löschen“
     bestätigen.
- **Ergebnis:** Verlauf wechselt; gelöschte Unterhaltung samt Vorschlägen
  ist weg.
- **Fehler und Grenzfälle:** Ausgeführte Vorschläge bleiben als
  Ergebnisse (Mappen, Dokumente) bestehen.
- **Test:** –

---

## Abdeckung

| ID | Aktion | Recht | Test |
|---|---|---|---|
| ASS-CHT-01 | Neue Unterhaltung | module.assistant | – |
| ASS-CHT-02 | Frage stellen | module.assistant | – |
| ASS-CHT-03 | Rückfrage auf frühere Antwort | module.assistant | – |
| ASS-CHT-04 | Ergebnisblöcke nutzen | module.assistant | – |
| ASS-CHT-05 | Kopieren, als Textdokument speichern | module.assistant | – |
| ASS-CHT-06 | Feedback geben | module.assistant | – |
| ASS-CHT-07 | Vorschlag ausführen oder verwerfen | Recht der Aktion | – |
| ASS-CHT-08 | Collage aus dem Vorschlag | photos.view | – |
| ASS-CHT-09 | Arbeitskontext verwalten | module.assistant | – |
| ASS-CHT-10 | Unterhaltung wechseln oder löschen | module.assistant | – |
