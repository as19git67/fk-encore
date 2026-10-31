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
| `allgemein.md` | Anmelden, Registrieren, Passwort vergessen, Profil, Navigation, Hauptmenü | offen |
| `fotos-*.md` | Fotos (Galerie, Alben, Personen, Fotobücher, Rückblicke, Feed/Stream, Review, Einstellungen) | offen |
| `dokumente.md` | Dokumente | offen |
| `finanzen.md` | Finanzen | offen |
| `zaehler.md` | Zähler | **geschrieben** |
| `assistent.md` | Assistent | offen |
| `label.md` | Label | offen |
| `sammelmappen.md` | Sammelmappen, Basket, Exporte, geteilte Links | offen |
| `admin.md` | Benutzer, Rollen, Jobs, Systemstatus | offen |
| `ios.md` | iOS-App | offen |

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
- **Test:** `frontend/e2e/specs/zaehler.spec.ts` › `ZAE-LST-03` (oder „–“)
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

Die End-to-End-Tests sind nach Modulen geschnitten, so wie das Handbuch:

- Eine Spec-Datei je Modul unter `frontend/e2e/specs/`, zum Beispiel
  `zaehler.spec.ts`; große Module dürfen einen Ordner mit einer Datei je
  Seite haben (`fotos/galerie.spec.ts`).
- Jeder Test heißt nach seiner Kennung, `test('ZAE-LST-03 Zähler anlegen',
  …)`, damit `npm run e2e -- -g ZAE-LST` genau die Tests einer Seite
  startet und die Tabelle am Ende der Moduldatei sich aus den Spec-Dateien
  prüfen lässt.
- In der CI läuft je Modul ein eigener Job, der nur anspringt, wenn der PR
  Pfade dieses Moduls berührt (Backend-Dienst, Frontend-Views und
  -Komponenten des Moduls, Migrationen). Das Frontend-Gerüst
  (`frontend/src/components/layout/`, `router`, `config/modules.ts`,
  `App.vue`) zählt zu jedem Modul. Heute gibt es noch einen Lauf für alles
  (`.github/workflows/playwright-e2e.yml`); die Aufteilung kommt mit dem
  ersten modulweisen Spec.
- Testdaten legt jeder Lauf selbst über die API an (`frontend/e2e/fixtures/`)
  und räumt sie wieder ab. KI-Dienste, OCR, FinTS und externe Abrufe
  (Benzinpreise, Gradtage) werden mit festen Antworten ersetzt, nie live
  aufgerufen.

## Regeln für Beispiele

Beispiele verwenden nur erfundene Werte: `Musterstadt`, `Beispielstraße 1`,
`max@beispiel.test`, Seriennummern wie `SN-0001`. Keine echten Namen,
Adressen, Kontonummern, Zählernummern oder Messwerte aus einem realen
Haushalt, auch nicht in Screenshots.

## Pflege

Wer eine Seite ändert, ändert den Eintrag in derselben Pull-Request. Eine
neue Aktion ohne Eintrag ist unvollständig; ein Eintrag ohne Test bleibt
erlaubt, solange er in der Tabelle als „–“ sichtbar ist.
