# Admin-Aktionen in die Module verschieben, Admin-Seite „Datenverwaltung" auflösen

Status: **Plan** · Branch: `claude/admin-page-section-split-06k81e`

## Ziel in einem Satz

Modulspezifische Admin-Aktionen wandern in die Einstellungen des jeweiligen
Moduls (Fotos, Dokumente, Finanzen); das Admin-Modul behält nur noch, was
modulübergreifend ist (Benutzer, Rollen, eingeplante Jobs) und bekommt eine
schlanke Systemstatus-Seite als Überblick über alle Warteschlangen.

Das Repo macht es an zwei Stellen schon so: „Konto-Zugriff" (`finance.admin`)
liegt im Finanzen-Modul, die `documents.manage_taxonomy`-Seiten liegen unter
„Dokumente › Einstellungen". Dieser Plan macht das Muster durchgängig.

## Ausgangslage

### Die lange Seite

`frontend/src/views/DataManagementView.vue` (Route `/admin/daten`, Menüpunkt
„Datenverwaltung") hat **2 640 Zeilen** und bündelt elf fachlich unabhängige
Bereiche aus vier Modulen in einer Scroll-Seite:

| # | Abschnitt (Template) | Zeilen | Backend-Endpunkte | Backend-Recht |
|---|---|---|---|---|
| 1 | Scan-Queue (Status, Rescan, Retry, Abbrechen, POI-Neuerkennung ×2, Fehler-Dialog) | 923–1099 | `/photos/scan-queue/*`, `/photos/rescan`, `/photos/poi-redetect*` | `data.manage` |
| 2 | Finance KI-Tagging (Queue-Status, Retry, Abbrechen, Neu einreihen) | 1100–1169 | `/finance/tag-queue/*` | `data.manage` |
| 3 | Dokument-Verarbeitung (Queue-Status, Cancel, Retry, Reclassify-All, Relocate-All) | 1170–1329 | `/document-queue/*`, `/documents/reclassify-all`, `/documents/relocate-all` | Status: `documents.view` · Aktionen: `data.manage` |
| 4 | Korrespondenten-Overrides (`CorrespondentOverridesPanel`) | 1330–1334 | `/documents/correspondent-overrides` | **`documents.manage_taxonomy`** |
| 5 | Ähnliche Fotos gruppieren (Find-Groups, AI-Picks, Kalibrierung, Gewichte, Backfill Dimensionen/Gesichtsschärfe) | 1335–1450 | `/photos/find-groups`, `/photos/groups/*`, `/photos/backfill-*` | `data.manage` |
| 6 | GPS-Koordinaten neu einlesen | 1451–1485 | `/photos/needs-gps-rescan`, `/photos/:id/rescan-gps` | `data.manage` |
| 7 | Auto-Crop neu berechnen | 1486–1512 | `/photos/recompute-auto-crops` | `data.manage` |
| 8 | KI-Crop-Vorschläge neu berechnen | 1513–1563 | `/photos/recompute-transform-suggestions` | `data.manage` |
| 9 | Metadaten aktualisieren | 1564–1587 | `/photos/refresh-metadata`, `/photos/:id/refresh-metadata` | **`photos.refresh_metadata`** |
| 10 | OSM-Regionen (Liste, Vorschlag, Anlegen, Freigeben, Refresh, Löschen, Speicher-Dialog, Bulk-Vorschlag, Reverse-Geocoding-Test) | 1588–1905 + Dialog 2043–2098 | `/osm/regions/*`, `/osm/reverse` | `osm.admin` (bereits `v-if="canManageOsm"`) |
| 11 | Danger Zone (Alle Fotodaten löschen) | 1906–1921 + Dialog 1928–2042 | `/photos/purge` | `photos.purge` (bereits `v-if="canPurgePhotos"`) |
| 12 | Version (Build-Nummer) | 1922–1926 | `/api/build-info` (statisch, ohne Auth) | – |

Der Script-Teil (Zeilen 1–917) hält für alle Bereiche gleichzeitig State,
Handler, Realtime-Abos (`scan-queue`) und einen 5-Sekunden-Poll-Timer für
OSM, egal welchen Abschnitt der Benutzer gerade ansieht.

### Die übrigen Admin-Seiten

Vier weitere Seiten im Admin-Modul sind ebenfalls modulspezifisch und werden
**verbindlich** mitverschoben:

| Heute | View | Route-Recht | Backend | Gehört zu |
|---|---|---|---|---|
| Externe Bibliotheken | `LibrariesView.vue` (1 143 Z.) | `photos.libraries.manage` | `/libraries/*` | Fotos |
| Taxonomie-Cockpit | `TaxonomyCockpitView.vue` (426 Z.) | `data.manage` | `/admin/taxonomy-cockpit*` (Service `documents`) | Dokumente |
| Taxonomie-Tools | `AdminToolsView.vue` (796 Z.) | `data.manage` | `/admin/tools/*` (Service `user`, arbeitet auf Dokument-Taxonomie) | Dokumente |
| KI-Modell | `LlmModelsView.vue` (926 Z.) | `data.manage` | `/admin/llm-configs*`, `/admin/llm-models/*` | Dokumente **und** Finanzen (ein gemeinsamer `llm_service`) |

Im Admin-Modul verbleiben: Benutzer (`users.list`), Benutzer-Detail
(`users.read`), Rollen (`roles.list`), Eingeplante Jobs (`data.manage`,
modulübergreifend).

### Rechte heute

- Der Route-Guard (`meta.permission` in `frontend/src/config/modules.ts`)
  kennt genau **ein** Recht pro Route; `router.beforeEach` prüft es.
- Module werden über ihr `permission`-Feld ein- oder ausgeblendet
  (`photos.view`, `documents.view`, `module.finance`, …, Admin: `users.list`).
  Menüpunkte und Gruppen-Kinder werden in `App.vue` einzeln nach Recht
  gefiltert; leere Gruppen fallen weg.
- Das Backend ist die Autorität (`requirePermission` in jedem Endpunkt);
  Frontend-Guards sind reine UX.
- Die Seed-Rolle `Admin` erhält alle Rechte **außer** `photos.purge` und
  `finance.admin` (bewusst, siehe `db/seed.ts` und `user/admin-guard.ts`).

### Gefundene Rechte-Lücken (heute schon vorhanden)

1. **Metadaten aktualisieren** (Abschnitt 9): Seite verlangt `data.manage`,
   Endpunkt `photos.refresh_metadata`. Mit nur `data.manage` sieht man den
   Button und bekommt 403.
2. **Korrespondenten-Overrides** (Abschnitt 4): Endpunkt verlangt
   `documents.manage_taxonomy`, Seite nur `data.manage`. Panel lädt mit 403.
3. **OSM-Polling** läuft alle 5 s für die gesamte Lebensdauer der Seite.

Beide Rechte-Lücken fallen heute nicht auf, weil die Admin-Rolle alle Rechte
hat. Sie werden beim Umbau geschlossen.

## Zielbild

### Menüstruktur nach dem Umbau

```
Fotos
  Feed · Galerie · Alben · Aktivität · Rückblicke · Personen · Gruppen-Review
  ⚙ Einstellungen (neue Gruppe)
      Scan-Queue                 data.manage
      Wartung                    data.manage
      Externe Bibliotheken       photos.libraries.manage
      OSM-Regionen               osm.admin
      Gefahrenzone               photos.purge

Dokumente
  Alle Dokumente · Arbeitskorb · Später · Sammelmappen · Steuer
  ⚙ Einstellungen (bestehende Gruppe, erweitert)
      Kategorie-Vorschläge       documents.manage_taxonomy   (bleibt)
      Steuer-Hints               documents.manage_taxonomy   (bleibt)
      Hint-Vorschläge            documents.manage_taxonomy   (bleibt)
      Korrespondenten            documents.manage_taxonomy   (neu, aus Abschnitt 4)
      Bezugspersonen             documents.view              (bleibt)
      Gruppen                    groups.view                 (bleibt)
      Verarbeitung               data.manage                 (neu, Abschnitt 3)
      Taxonomie-Cockpit          data.manage                 (aus Admin)
      Taxonomie-Tools            data.manage                 (aus Admin)
      KI-Modell                  data.manage                 (aus Admin)
      Hilfe                      documents.view              (bleibt)

Finanzen
  Übersicht · Konten · Bankkontakte · Analyse · Anomalien · Belegabgleich
  ⚙ Einstellungen (neue Gruppe)
      Konto-Zugriff              finance.admin               (aus dem Strip in die Gruppe)
      KI-Tagging                 data.manage                 (neu, Abschnitt 2)

Admin
  Benutzer                       users.list
  Rollen                         roles.list
  Eingeplante Jobs               data.manage
  Systemstatus                   data.manage                 (neu: Queue-Überblick + Build-Nummer)
```

### Routen

Alle Backend-Pfade bleiben unverändert (auch `/admin/tools/*`,
`/admin/llm-*`, `/admin/taxonomy-cockpit`); der Umbau ist rein Frontend.

| Route | Name | View | `meta.permission` | Inhalt |
|---|---|---|---|---|
| `/fotos/einstellungen/scan-queue` | `fotos-settings-scan-queue` | `PhotoScanQueueView` | `data.manage` | Abschnitt 1 |
| `/fotos/einstellungen/wartung` | `fotos-settings-maintenance` | `PhotoMaintenanceView` | `data.manage` | Abschnitte 5–9; Abschnitt 9 zusätzlich `v-if photos.refresh_metadata` |
| `/fotos/einstellungen/bibliotheken` | `fotos-settings-libraries` | `LibrariesView` (verschoben) | `photos.libraries.manage` | unverändert |
| `/fotos/einstellungen/osm` | `fotos-settings-osm` | `OsmRegionsView` | `osm.admin` | Abschnitt 10 |
| `/fotos/einstellungen/gefahrenzone` | `fotos-settings-purge` | `PhotoPurgeView` | `photos.purge` | Abschnitt 11 |
| `/dokumente/verarbeitung` | `dokumente-verarbeitung` | `DocumentProcessingView` | `data.manage` | Abschnitt 3 |
| `/dokumente/korrespondenten` | `dokumente-korrespondenten` | `CorrespondentOverridesView` | `documents.manage_taxonomy` | Abschnitt 4 |
| `/dokumente/taxonomie-cockpit` | `dokumente-taxonomie-cockpit` | `TaxonomyCockpitView` (verschoben) | `data.manage` | unverändert |
| `/dokumente/taxonomie-tools` | `dokumente-taxonomie-tools` | `AdminToolsView` → umbenannt `TaxonomyToolsView` | `data.manage` | unverändert |
| `/dokumente/ki-modell` | `dokumente-ki-modell` | `LlmModelsView` (verschoben) | `data.manage` | unverändert |
| `/finanzen/ki-tagging` | `finance-tag-queue` | `FinanceTagQueueView` | `data.manage` | Abschnitt 2 |
| `/admin/status` | `admin-status` | `SystemStatusView` | `data.manage` | Queue-Zahlen aller drei Warteschlangen mit Links, Build-Nummer (Abschnitt 12) |

Reihenfolge in `modules.ts` beachten: Die neuen Dokumente-Routen müssen
**vor** `:id` stehen, sonst schluckt die Detail-Route sie (gleiches Muster
wie `hilfe/gradtage` im Zähler-Modul).

**Weiterleitungen** (alte URLs und Bookmarks bleiben gültig):

| Alt | Neu |
|---|---|
| `/admin/daten`, `/data-management` | `/admin/status` |
| `/admin/bibliotheken` | `/fotos/einstellungen/bibliotheken` |
| `/admin/taxonomie-cockpit` | `/dokumente/taxonomie-cockpit` |
| `/admin/tools` | `/dokumente/taxonomie-tools` |
| `/admin/ki-modell` | `/dokumente/ki-modell` |

### Menü-Gruppen in `App.vue`

`App.vue` behandelt heute nur die Dokumente-Gruppe als Zahnrad in der
Navbar (`docSettingsGroup`, nur für `activeModule.id === 'dokumente'`);
alle anderen Gruppen würden generisch als Popup-Button im Strip erscheinen.
Damit Fotos und Finanzen genauso aussehen wie Dokumente, wird die
Sonderbehandlung verallgemeinert: **Die erste `children`-Gruppe jedes
Moduls wird zum Zahnrad in der Navbar.** Das ist eine kleine Änderung
(die `id === 'dokumente'`-Bedingung fällt weg), die Dokumente-Sonderlogik
mit dem Arbeitskorb bleibt.

### Sichtbarkeit und Rechte

1. **Ein Recht pro Route** bleibt die Regel; der Router wird nicht erweitert.
   Bereiche mit eigenem Recht (`osm.admin`, `photos.purge`,
   `photos.libraries.manage`, `documents.manage_taxonomy`) bekommen deshalb
   eigene Routen statt Guards innerhalb einer Seite.
2. **Feinere Rechte per `v-if`**, nicht per deaktiviertem Button
   (Konvention der bisherigen Seite). Betroffen: Metadaten-Karte in
   `PhotoMaintenanceView` (`photos.refresh_metadata`).
3. **Modulrecht kommt hinzu.** Wer eine Admin-Aktion sehen will, braucht
   jetzt zusätzlich das Modulrecht (`photos.view`, `documents.view`,
   `module.finance`). Für Inhaber der Admin-Rolle ändert sich nichts. Eine
   spätere „Operator"-Rolle mit nur `data.manage` müsste auch Modulrechte
   bekommen. Das wird bewusst in Kauf genommen; im Gegenzug entfällt die
   heutige Hürde, dass das Admin-Modul nur mit `users.list` sichtbar ist.
4. **Systemstatus-Seite** zeigt Zahlen (pending/processing/failed) der
   drei Warteschlangen über die bestehenden Status-Endpunkte und verlinkt
   auf die jeweilige Modulseite; Links erscheinen nur mit dem Modulrecht.
   Aktionen gibt es dort keine.
5. **Backend bleibt unangetastet.** Kein Recht und kein Pfad wird geändert.
6. **Storybook-Mock-Benutzer** (`stories/mock-data.ts`) bekommt zusätzlich
   `osm.admin`, `photos.refresh_metadata`, `documents.manage_taxonomy`,
   `module.finance`, `finance.view`, damit alle Seiten darstellbar sind.
   Je verschobener Seite eine Story mit reduzierten Rechten.

### Komponenten-Schnitt

Neuer Ordner `frontend/src/components/admin/`, ein Panel pro Abschnitt nach
dem Vorbild von `CorrespondentOverridesPanel.vue` (eigener State, eigene
API-Aufrufe, kein Prop-Drilling):

| Panel | Aus Abschnitt | Script-Zeilen heute |
|---|---|---|
| `ScanQueuePanel.vue` (+ vorhandener `QueueErrorsDialog`) | 1 | 60–199 |
| `FinanceTagQueuePanel.vue` | 2 | 518–582 |
| `DocumentQueuePanel.vue` | 3 | 584–677 |
| `PhotoGroupingPanel.vue` | 5 | 202–350 |
| `GpsRescanPanel.vue` | 6 | 383–426 |
| `AutoCropPanel.vue` | 7 | 428–431, 459–472 |
| `TransformSuggestionsPanel.vue` | 8 | 433–457 |
| `MetadataRefreshPanel.vue` | 9 | 352–381 |
| `OsmRegionsPanel.vue` (+ `OsmRegionStorageDialog.vue`) | 10 | 683–895 |
| `PhotoPurgePanel.vue` (+ `PhotoPurgeDialog.vue`) | 11 | 474–516 |
| `BuildInfo.vue` | 12 | 679–681 |

Gemeinsame Bausteine:

- `AdminSection.vue`: Wrapper mit Titel, Beschreibung und Slot; übernimmt
  `.data-management-group`, `.danger-zone` und die Hilfsklassen aus dem
  `<style scoped>`-Block (Zeilen 2100–2640). Farben nur über semantische
  PrimeVue-Variablen (siehe `css_style_guide` in der CLAUDE.md).
- `usePolling(fn, intervalMs)`: Composable für den OSM-Timer (Start in
  `onMounted`, Stopp in `onBeforeUnmount`). Der Poll läuft dann nur noch
  auf der OSM-Seite.
- `frontend/src/config/queueOverview.ts`: reine Liste der drei
  Warteschlangen (Label, Status-Loader, Ziel-Route, Modulrecht) für die
  Systemstatus-Seite, plus `visibleQueues(hasPermission)`; ohne DOM
  testbar.

Die vier verschobenen Views (`LibrariesView`, `TaxonomyCockpitView`,
`AdminToolsView`, `LlmModelsView`) werden **nicht** umgebaut, nur
umgehängt (Route, Menü, ggf. Dateiname). Ihr `localStorage`-Schlüssel
(`admin-tools-state-v1`) bleibt, damit gespeicherter Zustand erhalten
bleibt.

## Etappen

Jede Etappe ist für sich mergefähig; alle Seiten bleiben jederzeit
erreichbar (alte Route bis zur Umstellung, danach Weiterleitung).

### Etappe 1 — Vorbereitung ohne Verhaltensänderung

- `AdminSection.vue`, `usePolling`, `queueOverview.ts` (+ Vitest-Test).
- Mock-Berechtigungen in `stories/mock-data.ts` ergänzen.
- `App.vue`: Zahnrad-Gruppe für alle Module verallgemeinern. Sichtbar
  ändert sich nichts, weil nur Dokumente eine Gruppe hat.

### Etappe 2 — Panels extrahieren (1:1)

- Elf Panels nach `components/admin/`, State und Handler mitnehmen.
  `DataManagementView.vue` besteht danach nur aus `<AdminSection>`-Blöcken
  mit je einem Panel. Realtime-Abos wandern in `ScanQueuePanel` bzw.
  `PhotoGroupingPanel`.
- Verifikation: Storybook-Screenshots der bestehenden Stories
  vorher/nachher (`npm run screenshot`), keine sichtbare Änderung.

### Etappe 3 — Fotos › Einstellungen

- Gruppe „Einstellungen" im Fotos-Modul anlegen.
- Fünf Routen/Views: Scan-Queue, Wartung, Bibliotheken (verschoben),
  OSM-Regionen, Gefahrenzone.
- Weiterleitung `/admin/bibliotheken`; Menüpunkt „Externe Bibliotheken" aus
  Admin entfernen.
- Rechte-Feinschliff: Metadaten-Karte hinter `photos.refresh_metadata`.
- Verweis in `ReviewQueueView.vue` (Zeile ~836, „im DataManagement") als
  Router-Link auf `fotos-settings-maintenance`.

### Etappe 4 — Dokumente › Einstellungen und Finanzen › Einstellungen

- Dokumente: Verarbeitung, Korrespondenten (eigene Route mit
  `documents.manage_taxonomy`), Taxonomie-Cockpit, Taxonomie-Tools
  (`AdminToolsView` → `TaxonomyToolsView`), KI-Modell. Routen vor `:id`
  einsortieren. Weiterleitungen für die drei Admin-URLs; Menüpunkte aus
  Admin entfernen.
- Finanzen: Gruppe „Einstellungen" mit Konto-Zugriff (Route unverändert,
  nur Menüplatz) und KI-Tagging.

### Etappe 5 — Admin › Systemstatus, Auflösung der alten Seite

- `SystemStatusView` unter `/admin/status` mit Queue-Überblick und
  Build-Nummer; Menüpunkt „Datenverwaltung" durch „Systemstatus" ersetzen.
- Weiterleitungen `/admin/daten` und `/data-management` auf `/admin/status`.
- `DataManagementView.vue` und `DataManagementView.stories.ts` löschen;
  Stories je neuer View (Leerlauf, Queue aktiv, GPS-Rescan verfügbar bleiben
  erhalten, nur auf die jeweilige Seite verteilt; Stories der verschobenen
  Views bleiben und werden nur umbenannt).
- Doku-Verweise prüfen: `docs/purge.md`, `docs/osm-admin-deployment.md`,
  `docs/external-libraries.md`, `docs/finance-tagging-and-ai.md`.
- `.claude/CLAUDE.md`: Plan-Eintrag auf „umgesetzt" setzen.

## Tests und Absicherung

- **Vitest (Frontend):** `queueOverview.test.ts` (Sichtbarkeit nach
  Rechten); `moduleEntryPath.test.ts` weiter grün; ein Test, dass jede
  Weiterleitung aus der Tabelle oben auf eine existierende Route zeigt
  (Router auflösen, `matched.length > 0`).
- **Backend:** keine Änderung, `npm run test` muss trotzdem vor jedem Push
  laufen (Test-Pflicht aus der CLAUDE.md).
- **Storybook:** je Seite mindestens eine Story; Screenshot-Vergleich nach
  Etappe 2 als Regressionsschutz für das Layout.
- **Manuell:** mit einem Benutzer, der nur `data.manage` plus Modulrechte
  hat, prüfen, dass OSM, Gefahrenzone, Bibliotheken, Korrespondenten und
  Metadaten-Karte nicht erscheinen und keine 403-Meldungen auftauchen; mit
  der Admin-Rolle prüfen, dass Gefahrenzone fehlt (kein `photos.purge`).

## Getroffene Annahmen und offene Punkte

1. **KI-Modell liegt unter Dokumente.** Der `llm_service` wird von Dokumente
   (Klassifikation) und Finanzen (Tag-Vorschläge, Analyse) genutzt. Dokumente
   ist der Hauptnutzer und hat schon die Einstellungs-Gruppe; die
   Finanzen-Seite „KI-Tagging" bekommt einen Hinweis mit Link auf die
   Modellseite. Alternative wäre, KI-Modell unter Admin zu belassen; das
   widerspricht der Vorgabe, alle vier Seiten zu verschieben.
2. **Konto-Zugriff wandert in die Finanzen-Gruppe.** Nur der Menüplatz ändert
   sich, Route und Recht bleiben. Wenn der Punkt im Strip bleiben soll,
   enthält die Gruppe nur KI-Tagging; das funktioniert ebenfalls.
3. **Systemstatus** ist bewusst schreibgeschützt. Wer eingreifen will, folgt
   dem Link ins Modul.
