# Aufteilung der Admin-Seite „Datenverwaltung" in Bereiche

Status: **Plan** · Branch: `claude/admin-page-section-split-06k81e`

## Ausgangslage

`frontend/src/views/DataManagementView.vue` (Route `/admin/daten`, Menüpunkt
„Datenverwaltung") ist mit **2 640 Zeilen** die mit Abstand größte View im
Frontend. Sie bündelt elf fachlich unabhängige Bereiche aus vier Modulen
(Fotos, Dokumente, Finanzen, OSM/Geo) in einer einzigen Scroll-Seite:

| # | Abschnitt (Template) | Zeilen | Backend-Endpunkte | Backend-Recht |
|---|---|---|---|---|
| 1 | Scan-Queue (Status, Rescan, Retry, Abbrechen, POI-Neuerkennung ×2, Fehler-Dialog) | 923–1099 | `/photos/scan-queue/*`, `/photos/rescan`, `/photos/poi-redetect*` | `data.manage` |
| 2 | Finance KI-Tagging (Queue-Status, Retry, Abbrechen, Neu einreihen) | 1100–1169 | `/finance/tag-queue/*` | `data.manage` |
| 3 | Dokument-Verarbeitung (Queue-Status, Cancel, Retry, Reclassify-All, Relocate-All) | 1170–1329 | `/document-queue/*`, `/documents/reclassify-all`, `/documents/relocate-all` | Status: `documents.view` · Aktionen: `data.manage` |
| 4 | Korrespondenten-Overrides (`CorrespondentOverridesPanel`) | 1330–1334 | `/documents/correspondent-overrides` | **`documents.manage_taxonomy`** |
| 5 | Ähnliche Fotos gruppieren (Find-Groups, AI-Picks neu berechnen, Kalibrierung, Gewichte kalibrieren, Backfill Dimensionen/Gesichtsschärfe) | 1335–1450 | `/photos/find-groups`, `/photos/groups/*`, `/photos/backfill-*` | `data.manage` |
| 6 | GPS-Koordinaten neu einlesen | 1451–1485 | `/photos/needs-gps-rescan`, `/photos/:id/rescan-gps` | `data.manage` |
| 7 | Auto-Crop neu berechnen | 1486–1512 | `/photos/recompute-auto-crops` | `data.manage` |
| 8 | KI-Crop-Vorschläge neu berechnen | 1513–1563 | `/photos/recompute-transform-suggestions` | `data.manage` |
| 9 | Metadaten aktualisieren | 1564–1587 | `/photos/refresh-metadata`, `/photos/:id/refresh-metadata` | **`photos.refresh_metadata`** |
| 10 | OSM-Regionen (Liste, Vorschlag, Anlegen, Freigeben, Refresh, Löschen, Speicher-Dialog, Bulk-Vorschlag, Reverse-Geocoding-Test) | 1588–1905 + Dialog 2043–2098 | `/osm/regions/*`, `/osm/reverse` | `osm.admin` (im Template bereits per `v-if="canManageOsm"`) |
| 11 | Danger Zone (Alle Fotodaten löschen) | 1906–1921 + Dialog 1928–2042 | `/photos/purge` | `photos.purge` (im Template bereits per `v-if="canPurgePhotos"`) |
| 12 | Version (Build-Nummer) | 1922–1926 | `/api/build-info` (statisch, ohne Auth) | – |

Der Script-Teil (Zeilen 1–917) hält für alle Bereiche gleichzeitig State,
Handler, Realtime-Abos (`scan-queue`) und einen 5-Sekunden-Poll-Timer für
OSM, egal welchen Abschnitt der Benutzer gerade ansieht.

### Rechte heute

- Der Route-Guard (`meta.permission` in `frontend/src/config/modules.ts`)
  prüft **nur `data.manage`**. `router.beforeEach` kennt genau ein Recht
  pro Route.
- Innerhalb der Seite gibt es nur zwei Feingranular-Guards:
  `photos.purge` (Danger Zone) und `osm.admin` (OSM-Regionen).
- Das Backend ist die Autorität (`requirePermission` in jedem Endpunkt);
  die Frontend-Guards sind reine UX (nichts anzeigen, was man nicht darf).
- Die Seed-Rolle `Admin` erhält alle Rechte **außer** `photos.purge` und
  `finance.admin` (bewusst, siehe `db/seed.ts` und `user/admin-guard.ts`).
  `osm.admin` und `photos.refresh_metadata` sind in keiner Standardrolle
  außer Admin enthalten.

### Gefundene Rechte-Lücken (heute schon vorhanden)

1. **Metadaten aktualisieren** (Abschnitt 9): Seite verlangt `data.manage`,
   Endpunkt verlangt `photos.refresh_metadata`. Wer nur `data.manage` hat,
   sieht den Button und bekommt beim Klick 403. Umgekehrt kommt jemand mit
   nur `photos.refresh_metadata` gar nicht auf die Seite.
2. **Korrespondenten-Overrides** (Abschnitt 4): Endpunkt verlangt
   `documents.manage_taxonomy`, Seite nur `data.manage`. Gleiches Muster:
   Panel lädt mit 403-Fehler. Fachlich gehört das Panel außerdem eher zu
   „Dokumente › Einstellungen" (dort liegen bereits Kategorie-Vorschläge,
   Steuer-Hints usw. unter `documents.manage_taxonomy`).
3. **OSM-Polling** läuft alle 5 s für die gesamte Lebensdauer der Seite,
   auch wenn nur die Scan-Queue interessiert.

Diese Lücken fallen heute nicht auf, weil die Admin-Rolle alle Rechte hat.
Beim Aufteilen sollen sie mit geschlossen werden.

## Zielbild

### Routen und Views

`/admin/daten` bleibt bestehen (auch die Legacy-Weiterleitung
`/data-management`) und wird zur **Übersichtsseite** mit Kacheln je Bereich.
Jede Kachel erscheint nur, wenn der Benutzer das Recht des Bereichs hat.
Darunter liegen eigene Routen:

| Route | View | Route-Guard (`meta.permission`) | Inhalt (Panels) | Zusätzliche Guards im Template |
|---|---|---|---|---|
| `/admin/daten` | `DataManagementOverviewView` | `data.manage` | Kacheln zu den Bereichen, Build-Nummer (Abschnitt 12) | Kacheln je nach Recht |
| `/admin/daten/fotos-queue` | `PhotoScanQueueView` | `data.manage` | Abschnitt 1 | – |
| `/admin/daten/fotos-wartung` | `PhotoMaintenanceView` | `data.manage` | Abschnitte 5, 6, 7, 8, 9 | Abschnitt 9 nur mit `photos.refresh_metadata` |
| `/admin/daten/dokumente` | `DocumentProcessingView` | `data.manage` | Abschnitt 3 (+ 4, siehe Entscheidung unten) | Abschnitt 4 nur mit `documents.manage_taxonomy` |
| `/admin/daten/finanzen` | `FinanceTagQueueView` | `data.manage` | Abschnitt 2 | – |
| `/admin/daten/osm` | `OsmRegionsView` | `osm.admin` | Abschnitt 10 inkl. Speicher-Dialog | – |
| `/admin/daten/gefahrenzone` | `PhotoPurgeView` | `photos.purge` | Abschnitt 11 inkl. Bestätigungs-Dialog | – |

Begründung für den Schnitt:

- **Ein Recht pro Route.** Der Router prüft genau ein `meta.permission`;
  Bereiche mit eigenem Recht (`osm.admin`, `photos.purge`) bekommen eine
  eigene Route, dann muss der Router nicht erweitert werden.
- **Ein Modul pro Seite.** Fotos, Dokumente, Finanzen und OSM sind
  getrennt; wer einen Bereich sucht, findet ihn über den Menüpunkt statt
  per Scrollen.
- **Fotos in zwei Seiten:** Die Scan-Queue ist die Seite, die man bei
  laufenden Importen offen hat (Realtime-Updates); die Wartungs-Aktionen
  (Gruppierung, GPS, Crops, Metadaten) sind gelegentliche Einmal-Aktionen.
  Zusammen wären das wieder ~500 Template-Zeilen.
- **Gefahrenzone separat**, weil `photos.purge` bewusst nicht in der
  Admin-Rolle steckt und die Seite nur für Inhaber sichtbar sein soll.

Warum keine Tabs in einer View: Tabs würden die Datei nicht kleiner machen,
Deep-Links und die Menü-Rechte-Filterung müssten nachgebaut werden, und alle
Timer/Realtime-Abos liefen weiter gleichzeitig.

### Menü

In `modules.ts` wird der Menüpunkt „Datenverwaltung" zur **Gruppe mit
`children`** (das Muster gibt es schon bei „Dokumente › Einstellungen";
`App.vue` blendet Kinder ohne Recht aus und lässt leere Gruppen ganz weg):

```ts
{
  label: 'Datenverwaltung', icon: 'pi pi-database',
  children: [
    { label: 'Übersicht',            icon: 'pi pi-th-large',          routeName: 'admin-data',            permission: 'data.manage' },
    { label: 'Foto-Scan-Queue',      icon: 'pi pi-spinner',           routeName: 'admin-data-photo-queue', permission: 'data.manage' },
    { label: 'Foto-Wartung',         icon: 'pi pi-wrench',            routeName: 'admin-data-photo-maint', permission: 'data.manage' },
    { label: 'Dokument-Verarbeitung',icon: 'pi pi-file',              routeName: 'admin-data-documents',   permission: 'data.manage' },
    { label: 'Finance KI-Tagging',   icon: 'pi pi-tags',              routeName: 'admin-data-finance',     permission: 'data.manage' },
    { label: 'OSM-Regionen',         icon: 'pi pi-map',               routeName: 'admin-data-osm',         permission: 'osm.admin' },
    { label: 'Gefahrenzone',         icon: 'pi pi-exclamation-triangle', routeName: 'admin-data-purge',    permission: 'photos.purge' },
  ],
}
```

Hinweis: `App.vue` sucht mit `subMenuItems.find(item => item.children)`
genau **eine** Gruppe für den Zahnrad-Button. Im Admin-Modul gibt es dann
nur diese eine Gruppe, das reicht. Die generische Darstellung mehrerer
Gruppen (Zeile ~224) existiert ebenfalls, falls später mehr dazukommt.

### Komponenten-Schnitt

Neuer Ordner `frontend/src/components/admin/`, ein Panel pro Abschnitt,
nach dem Vorbild von `CorrespondentOverridesPanel.vue` (eigener State, eigene
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
  die CSS-Klassen `.data-management-group`, `.danger-zone` und die
  Hilfsklassen aus dem `<style scoped>`-Block (Zeilen 2100–2640), damit die
  Optik unverändert bleibt und nicht in elf Dateien dupliziert wird.
  Erlaubte Farben nur über semantische PrimeVue-Variablen (siehe
  `css_style_guide` in der CLAUDE.md).
- `usePolling(fn, intervalMs)`: Composable für den OSM-Timer (Start in
  `onMounted`, Stopp in `onBeforeUnmount`). Damit läuft der Poll nur noch
  auf der OSM-Seite.
- `frontend/src/config/adminDataSections.ts`: eine reine Liste der
  Bereiche (`routeName`, Label, Icon, Beschreibung, `permission`), aus der
  sowohl die Menü-Kinder als auch die Übersichts-Kacheln erzeugt werden.
  Dazu die Funktion `visibleAdminDataSections(hasPermission)`; sie ist
  ohne DOM testbar (Vitest).

Die Views selbst werden dünn: Überschrift + Panels, keine eigene Logik.

### Rechte-Regeln für die neuen Seiten

1. **Route-Guard = Minimum, um überhaupt etwas Sinnvolles zu sehen.**
   Für die Fotos-/Dokumente-/Finanzen-Seiten ist das `data.manage`, weil
   alle Aktions-Endpunkte es verlangen. OSM und Gefahrenzone haben ihr
   eigenes Recht.
2. **Feinere Rechte per `v-if` im Template**, nicht per deaktiviertem
   Button. Das ist die Konvention der bisherigen Seite (OSM, Purge).
   Betroffen: `MetadataRefreshPanel` (`photos.refresh_metadata`) und
   `CorrespondentOverridesPanel` (`documents.manage_taxonomy`).
3. **Übersichtsseite** zeigt nur Kacheln mit Recht. Hat der Benutzer nur
   `data.manage`, fehlen OSM und Gefahrenzone; hat er nur `osm.admin`,
   kommt er über die Übersicht nicht hin, aber der Menü-Kindeintrag
   „OSM-Regionen" ist sichtbar und die Route direkt erreichbar.
4. **Backend bleibt Autorität.** Es werden keine Backend-Rechte geändert.
   Frontend-Guards werden auf die tatsächlich verlangten Rechte der
   aufgerufenen Endpunkte gesetzt (Tabelle oben).
5. **Storybook-Mock-Benutzer** (`stories/mock-data.ts`) bekommt zusätzlich
   `osm.admin`, `photos.refresh_metadata`, `documents.manage_taxonomy`,
   damit die Vollansicht darstellbar ist. Je Seite eine zweite Story mit
   reduzierten Rechten, die das Ausblenden sichtbar macht.

Bekannte, bewusst nicht angefasste Einschränkung: Das Admin-Modul selbst
ist an `users.list` gebunden (`modules.ts`, `permission: 'users.list'`).
Wer nur `data.manage` oder `osm.admin` hat, sieht das Modul gar nicht. Das
ist ein separates Thema (Modul-Sichtbarkeit = „mindestens ein Menüpunkt
sichtbar") und gehört nicht in diesen Umbau.

## Etappen

Jede Etappe ist für sich mergefähig; die Seite bleibt zu jedem Zeitpunkt
benutzbar.

### Etappe 1 — Vorbereitung ohne Verhaltensänderung

- `AdminSection.vue` anlegen, gemeinsames CSS aus der View hineinziehen.
- `usePolling` Composable anlegen.
- `adminDataSections.ts` mit `visibleAdminDataSections()` + Vitest-Test.
- Mock-Berechtigungen in `stories/mock-data.ts` ergänzen.

### Etappe 2 — Panels extrahieren (1:1)

- Elf Panels nach `components/admin/` verschieben, State und Handler
  mitnehmen. `DataManagementView.vue` besteht danach nur noch aus
  `<AdminSection>`-Blöcken mit je einem Panel.
- Realtime-Abos (`useRealtimeEvent('scan-queue', …)`) wandern in
  `ScanQueuePanel` bzw. `PhotoGroupingPanel`.
- Verifikation: Storybook-Screenshots der bestehenden Stories vorher/nachher
  vergleichen (`npm run screenshot`), keine sichtbare Änderung.

### Etappe 3 — Routen, Views, Menü

- Sechs neue Views + Übersichtsseite anlegen, Routen in `modules.ts`
  eintragen (Namen `admin-data-*`), Menüpunkt zur Gruppe machen.
- Übersichtsseite mit Kacheln aus `adminDataSections.ts`; Build-Nummer in
  die Fußzeile der Übersicht.
- Text-Verweis in `ReviewQueueView.vue` (Zeile ~836, „im DataManagement")
  auf die neue Foto-Wartungs-Seite umstellen (als Router-Link).
- Doku-Verweise auf `/admin/daten` prüfen: `docs/purge.md`,
  `docs/osm-admin-deployment.md`.

### Etappe 4 — Rechte-Feinschliff

- `MetadataRefreshPanel` hinter `photos.refresh_metadata`.
- `CorrespondentOverridesPanel` hinter `documents.manage_taxonomy`.
  **Entscheidung nötig:** Panel auf der Dokument-Verarbeitungs-Seite lassen
  (mit Guard) oder als eigenen Menüpunkt nach „Dokumente › Einstellungen"
  verschieben. Empfehlung: verschieben, weil dort alle anderen
  `documents.manage_taxonomy`-Seiten liegen und die Zielgruppe (Taxonomie-
  Pfleger) nicht zwingend `data.manage` hat.
- Stories mit reduzierten Rechten je Seite.

### Etappe 5 — Aufräumen

- `DataManagementView.vue` löschen, `DataManagementView.stories.ts` durch
  Stories je neuer View ersetzen (Leerlauf, Queue aktiv, GPS-Rescan
  verfügbar bleiben erhalten, nur auf die jeweilige Seite verteilt).
- `.claude/CLAUDE.md`: Plan-Eintrag auf „umgesetzt" setzen.

## Tests und Absicherung

- **Vitest (Frontend):** `adminDataSections.test.ts` (Sichtbarkeit nach
  Rechten), bestehende `moduleEntryPath.test.ts` weiter grün.
- **Backend:** keine Änderung, `npm run test` muss trotzdem vor jedem Push
  laufen (Test-Pflicht aus der CLAUDE.md).
- **Storybook:** je Seite mindestens eine Story; Screenshot-Vergleich nach
  Etappe 2 als Regressionsschutz für das Layout.
- **Manuell:** mit einem Benutzer, der nur `data.manage` hat, prüfen, dass
  OSM, Gefahrenzone, Metadaten-Karte und Korrespondenten-Panel nicht
  erscheinen und keine 403-Meldungen auftauchen.

## Offene Entscheidungen

1. Korrespondenten-Overrides: auf der Admin-Seite lassen oder nach
   „Dokumente › Einstellungen" verschieben (Empfehlung: verschieben).
2. Übersichtsseite mit Kacheln (Empfehlung) oder `/admin/daten` direkt auf
   die Foto-Scan-Queue umleiten.
3. Build-Nummer: Fußzeile der Übersicht (Empfehlung) oder zusätzlich im
   Profil anzeigen.
