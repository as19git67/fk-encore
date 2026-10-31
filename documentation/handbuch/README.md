# Benutzerhandbuch: alle Interaktionen, Modul für Modul

Dieses Verzeichnis beschreibt, was eine Nutzerin oder ein Nutzer in der
Web-App tun kann, Seite für Seite und Aktion für Aktion. Es ist zugleich die
Vorlage für die End-to-End-Tests unter `frontend/e2e/`: jede Aktion hat eine
Kennung, und ein Test, der sie prüft, trägt dieselbe Kennung im Namen.

Technische Beschreibungen (Datenmodell, Pipelines, Pläne) stehen weiterhin in
den anderen Dateien unter `documentation/`; hier geht es nur um die Bedienung.

## Gliederung

Eine Datei je Modul, in der Reihenfolge des Hauptmenüs
(`frontend/src/config/modules.ts`):

| Datei | Modul | Stand |
|---|---|---|
| `allgemein.md` | Anmelden, Registrieren, Passwort vergessen, Profil, Navigation, Hauptmenü | **geschrieben** |
| `fotos-galerie.md`, `fotos-alben.md`, `fotos-personen.md`, `fotos-einstellungen.md` | Fotos (Feed, Galerie, Vollbild, Editor, Alben, Personen, Gruppen-Review, Rückblicke, Fotobücher, Einstellungen) | **geschrieben** |
| `dokumente.md` | Dokumente | **geschrieben** |
| `finanzen.md` | Finanzen | **geschrieben** |
| `zaehler.md` | Zähler | **geschrieben**, E2E-Tests für alle 63 Aktionen |
| `assistent.md` | Assistent | **geschrieben** |
| `label.md` | Label | **geschrieben** |
| `sammelmappen.md` | Sammelmappen, Basket, Exporte, geteilte Links | **geschrieben** |
| `admin.md` | Benutzer, Rollen, Jobs, Systemstatus | **geschrieben** |
| `ios.md` | iOS-App (Bildschirm-Ebene; Reiseplaner braucht einen eigenen Durchgang) | **geschrieben** |

Bedienmuster, die in jedem Modul gleich sind (Listen-Toolbar, Auswahlmodus,
„Ablegen“, Basket, Detailseiten mit Zurück-Pfeil, Dialoge, Tastatur), werden
einmal in `allgemein.md` beschrieben und aus den Modulen nur verlinkt.

## Kennungen

Jede Aktion hat eine Kennung aus drei Teilen: `MODUL-SEITE-NN`.

- `MODUL`: `ALG` (Allgemein), `FOT`, `DOK`, `FIN`, `ZAE`, `ASS`, `LAB`,
  `SAM`, `ADM`, `IOS`.
- `SEITE`: drei Buchstaben für die Seite innerhalb des Moduls, in der
  Moduldatei definiert.
- `NN`: laufende Nummer auf dieser Seite, zweistellig.

Eine Kennung wird nie neu vergeben. Fällt eine Aktion weg, bleibt ihr Eintrag
mit dem Vermerk „entfallen“ und dem Datum stehen, damit alte Tests und
Issues weiter auffindbar sind. Neue Aktionen bekommen die nächste freie
Nummer, auch wenn sie inhaltlich zwischen zwei bestehende gehören.

## Aufbau eines Eintrags

Jede Aktion wird in derselben Form beschrieben, denn genau diese Felder
braucht später der Test:

```
### ZAE-LST-03 Zähler anlegen

- **Wo:** Zähler › Liste, Knopf „Neuer Zähler“ oben rechts
- **Recht:** `meters.manage`
- **Vorbedingung:** mindestens eine Gruppe oder „Privat“ als Sichtbarkeit
- **Schritte:** 1. … 2. … 3. …
- **Ergebnis:** neue Kachel in der Liste, Dialog geschlossen
- **Fehler und Grenzfälle:** leerer Name wird abgewiesen; …
- **Test:** `zaehler/liste.spec.ts` (oder „–“)
```

- **Wo** nennt den Weg aus Sicht der Nutzerin: Menüpunkt, Seite, Knopf oder
  Geste. Komponentennamen stehen nur in Klammern, wenn sie für den Test
  nötig sind.
- **Recht** ist der Berechtigungsschlüssel, ohne den der Knopf nicht
  erscheint oder der Server ablehnt. Mehrere Schlüssel werden mit „und“
  verbunden.
- **Vorbedingung** ist der Datenzustand, den ein Test vorher herstellen muss.
- **Schritte** sind nummeriert und so konkret, dass sie sich ohne Nachdenken
  nachspielen lassen.
- **Ergebnis** beschreibt, was sichtbar wird oder sich ändert, einschließlich
  Meldungen im Wortlaut.
- **Fehler und Grenzfälle** nennen abgewiesene Eingaben, leere Zustände und
  was passiert, wenn ein Dienst nicht erreichbar ist.
- **Test** verweist auf die Spec-Datei und den Testnamen. „–“ heißt: noch
  kein Test.

Am Ende jeder Moduldatei steht eine Tabelle aller Kennungen mit dem
Teststatus. So sieht man je Modul auf einen Blick, was schon abgedeckt ist.

## Tests je Modul

Die End-to-End-Tests sind nach Modulen geschnitten, so wie das Handbuch.
Sie gelten für die Web-App; die iOS-App (`ios.md`) bleibt vorerst außen
vor und bekommt keine E2E-Tests (Entscheidung vom 2026-10-31).

- Ein Ordner je Modul unter `frontend/e2e/specs/`, darin eine Datei je
  Seite oder Bereich, zum Beispiel `zaehler/liste.spec.ts`. Die Spalte
  „Test“ nennt den Pfad ab `specs/`.
- Jeder Test heißt nach seiner Kennung, `test('ZAE-LST-03 Zähler anlegen',
  …)`, damit `npm run e2e -- -g ZAE-LST` genau die Tests einer Seite
  startet und die Tabelle am Ende der Moduldatei sich aus den Spec-Dateien
  prüfen lässt. Ein zweiter Test zur selben Aktion (Fehlerfall,
  Grenzfall) trägt dieselbe Kennung.
- Jedes Modul ist ein Paar Playwright-Projekte
  (`frontend/playwright.config.ts`, Liste `MODULES`): `zaehler` führt die
  Specs des Ordners parallel aus, `zaehler-seriell` danach die Dateien
  `*.seriell.spec.ts`. Dorthin gehört, was alle anderen Tests des Moduls
  mitbetrifft, etwa ein Haushalt, der die Sichtbarkeit neuer Zähler ändert.
  Was nur einen Benutzer-Zustand teilt (Schnellerfassung, Postfach der
  Auffälligkeiten), läuft in seiner Datei mit
  `test.describe.configure({ mode: 'serial' })`.
- In der CI läuft je Modul ein eigener Workflow
  (`.github/workflows/e2e-<modul>.yml`, der Job selbst steht einmal in
  `e2e-module.yml`). Er springt nur an, wenn der PR Pfade dieses Moduls
  berührt (Backend-Dienst, Frontend-Views, -Komponenten und API-Client des
  Moduls) oder das, was zu jedem Modul zählt: das Frontend-Gerüst
  (`frontend/src/components/layout/`, `router/`, `config/modules.ts`,
  `App.vue`), die Migrationen und die E2E-Grundlagen (`fixtures/`,
  `global-setup.ts`, `playwright.config.ts`). Zusätzlich läuft jeder
  Modul-Workflow sonntags einmal komplett und lässt sich von Hand starten.
  `.github/workflows/playwright-e2e.yml` führt nur noch die älteren Specs
  direkt unter `specs/` aus (Projekt `chromium`).
- Testdaten legt jeder Test selbst über die API an (`frontend/e2e/fixtures/`),
  mit eindeutigem Namen, damit parallele Tests sich nicht sehen. Die CI
  beginnt jeden Lauf mit einer leeren Datenbank; aufgeräumt wird nur, was
  andere Tests stören würde (Basket, Haushalt). KI-Dienste, OCR, FinTS und
  externe Abrufe (Ortssuche, Benzinpreise, Gradtage) werden im Browser mit
  festen Antworten ersetzt (`page.route`), nie live aufgerufen. Die
  Testspalte vermerkt das als „feste Antwort“.

## Regeln für Beispiele

Beispiele verwenden nur erfundene Werte: `Musterstadt`, `Beispielstraße 1`,
`max@beispiel.test`, Seriennummern wie `SN-0001`. Keine echten Namen,
Adressen, Kontonummern, Zählernummern oder Messwerte aus einem realen
Haushalt, auch nicht in Screenshots.

## Pflege

Wer eine Seite ändert, ändert den Eintrag in derselben Pull-Request. Eine
neue Aktion ohne Eintrag ist unvollständig; ein Eintrag ohne Test bleibt
erlaubt, solange er in der Tabelle als „–“ sichtbar ist.
