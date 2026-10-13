# Move admin actions into the modules, dissolve the admin page „Datenverwaltung" (data management)

Status: **Implemented** · Branch: `claude/admin-page-section-split-06k81e`

## Implementation status

- ✅ **Stage 1 — Preparation**: `components/admin/adminPanels.css`, `AdminPage.vue`,
  `composables/usePolling.ts`, `composables/useScanQueueStatus.ts`,
  `config/queueOverview.ts` (+ test), mock permissions, gear group in `App.vue`
  generalized for all modules.
- ✅ **Stage 2 — Panels**: eleven panels under `components/admin/` plus
  `OsmRegionStorageDialog.vue`, taken over 1:1 from the old view.
- ✅ **Stage 3 — Photos › Settings**: scan queue, maintenance, external
  libraries, OSM regions, danger zone.
- ✅ **Stage 4 — Documents/Finance**: processing, correspondents,
  taxonomy cockpit, taxonomy tools, AI model; Finance group with
  account access and AI tagging.
- ✅ **Stage 5 — Admin › System status**: `SystemStatusView`, redirects,
  `DataManagementView` deleted, stories re-created per page, docs updated.

Tests: backend 312 files / 4282 green, frontend 63 / 562 green.

Deviations from the original draft:

- Instead of `AdminSection.vue` (wrapper with slot) there is `AdminPage.vue` (page
  frame with `<h1>`) and `adminPanels.css`. Scoped styles do not reach into
  slot content, so a wrapper could not have styled the panels;
  the panels instead import the shared CSS themselves via
  `<style scoped src="./adminPanels.css">`, which keeps the scope hash.
- `useScanQueueStatus` was added as well: the maintenance actions lock themselves
  while the scan queue is running and used to read that from the same page. Now
  all panels share one status instead of making five requests.
- The maintenance buttons now only check `isActive` instead of additionally the local
  `rescanLoading`/`retryLoading` flags — these belong to the scan queue page and
  are no longer visible from the maintenance page. A started rescan
  sets the queue to active almost immediately, so the lock still applies.

## Goal in one sentence

Module-specific admin actions move into the settings of the respective
module (Photos, Documents, Finance); the admin module keeps only what is
cross-module (users, roles, scheduled jobs) and gets a
slim system status page as an overview of all queues.

The repo already does this in two places: „Konto-Zugriff" (account access, `finance.admin`)
lives in the Finance module, the `documents.manage_taxonomy` pages live under
„Dokumente › Einstellungen" (Documents › Settings). This plan makes the pattern consistent.

## Starting point

### The long page

`frontend/src/views/DataManagementView.vue` (route `/admin/daten`, menu item
„Datenverwaltung") has **2,640 lines** and bundles eleven functionally independent
areas from four modules in one scrolling page:

| # | Section (template) | Lines | Backend endpoints | Backend permission |
|---|---|---|---|---|
| 1 | Scan queue (status, rescan, retry, cancel, POI re-detection ×2, error dialog) | 923–1099 | `/photos/scan-queue/*`, `/photos/rescan`, `/photos/poi-redetect*` | `data.manage` |
| 2 | Finance AI tagging (queue status, retry, cancel, re-enqueue) | 1100–1169 | `/finance/tag-queue/*` | `data.manage` |
| 3 | Document processing (queue status, cancel, retry, reclassify-all, relocate-all) | 1170–1329 | `/document-queue/*`, `/documents/reclassify-all`, `/documents/relocate-all` | Status: `documents.view` · Actions: `data.manage` |
| 4 | Correspondent overrides (`CorrespondentOverridesPanel`) | 1330–1334 | `/documents/correspondent-overrides` | **`documents.manage_taxonomy`** |
| 5 | Group similar photos (find groups, AI picks, calibration, weights, backfill dimensions/face sharpness) | 1335–1450 | `/photos/find-groups`, `/photos/groups/*`, `/photos/backfill-*` | `data.manage` |
| 6 | Re-read GPS coordinates | 1451–1485 | `/photos/needs-gps-rescan`, `/photos/:id/rescan-gps` | `data.manage` |
| 7 | Recompute auto-crop | 1486–1512 | `/photos/recompute-auto-crops` | `data.manage` |
| 8 | Recompute AI crop suggestions | 1513–1563 | `/photos/recompute-transform-suggestions` | `data.manage` |
| 9 | Refresh metadata | 1564–1587 | `/photos/refresh-metadata`, `/photos/:id/refresh-metadata` | **`photos.refresh_metadata`** |
| 10 | OSM regions (list, suggestion, create, approve, refresh, delete, storage dialog, bulk suggestion, reverse-geocoding test) | 1588–1905 + dialog 2043–2098 | `/osm/regions/*`, `/osm/reverse` | `osm.admin` (already `v-if="canManageOsm"`) |
| 11 | Danger zone (delete all photo data) | 1906–1921 + dialog 1928–2042 | `/photos/purge` | `photos.purge` (already `v-if="canPurgePhotos"`) |
| 12 | Version (build number) | 1922–1926 | `/api/build-info` (static, no auth) | – |

The script part (lines 1–917) holds state, handlers, realtime subscriptions
(`scan-queue`) and a 5-second poll timer for OSM for all areas at the same time,
no matter which section the user is currently looking at.

### The remaining admin pages

Four more pages in the admin module are likewise module-specific and are
**mandatorily** moved along:

| Today | View | Route permission | Backend | Belongs to |
|---|---|---|---|---|
| External libraries | `LibrariesView.vue` (1,143 lines) | `photos.libraries.manage` | `/libraries/*` | Photos |
| Taxonomy cockpit | `TaxonomyCockpitView.vue` (426 lines) | `data.manage` | `/admin/taxonomy-cockpit*` (service `documents`) | Documents |
| Taxonomy tools | `AdminToolsView.vue` (796 lines) | `data.manage` | `/admin/tools/*` (service `user`, works on the document taxonomy) | Documents |
| AI model | `LlmModelsView.vue` (926 lines) | `data.manage` | `/admin/llm-configs*`, `/admin/llm-models/*` | Documents **and** Finance (one shared `llm_service`) |

What remains in the admin module: users (`users.list`), user detail
(`users.read`), roles (`roles.list`), scheduled jobs (`data.manage`,
cross-module).

### Permissions today

- The route guard (`meta.permission` in `frontend/src/config/modules.ts`)
  knows exactly **one** permission per route; `router.beforeEach` checks it.
- Modules are shown or hidden via their `permission` field
  (`photos.view`, `documents.view`, `module.finance`, …, Admin: `users.list`).
  Menu items and group children are filtered individually by permission in `App.vue`;
  empty groups are dropped.
- The backend is the authority (`requirePermission` in every endpoint);
  frontend guards are purely UX.
- The seed role `Admin` receives all permissions **except** `photos.purge` and
  `finance.admin` (deliberately, see `db/seed.ts` and `user/admin-guard.ts`).

### Permission gaps found (already present today)

1. **Refresh metadata** (section 9): the page requires `data.manage`, the
   endpoint `photos.refresh_metadata`. With only `data.manage` you see the
   button and get a 403.
2. **Correspondent overrides** (section 4): the endpoint requires
   `documents.manage_taxonomy`, the page only `data.manage`. The panel loads with a 403.
3. **OSM polling** runs every 5 s for the entire lifetime of the page.

Both permission gaps go unnoticed today because the Admin role has all permissions.
They are closed during the rework.

## Target picture

### Menu structure after the rework

```
Fotos
  Feed · Galerie · Alben · Aktivität · Rückblicke · Personen · Gruppen-Review
  ⚙ Einstellungen (new group)
      Scan-Queue                 data.manage
      Wartung                    data.manage
      Externe Bibliotheken       photos.libraries.manage
      OSM-Regionen               osm.admin
      Gefahrenzone               photos.purge

Dokumente
  Alle Dokumente · Arbeitskorb · Später · Sammelmappen · Steuer
  ⚙ Einstellungen (existing group, extended)
      Kategorie-Vorschläge       documents.manage_taxonomy   (stays)
      Steuer-Hints               documents.manage_taxonomy   (stays)
      Hint-Vorschläge            documents.manage_taxonomy   (stays)
      Korrespondenten            documents.manage_taxonomy   (new, from section 4)
      Bezugspersonen             documents.view              (stays)
      Gruppen                    groups.view                 (stays)
      Verarbeitung               data.manage                 (new, section 3)
      Taxonomie-Cockpit          data.manage                 (from Admin)
      Taxonomie-Tools            data.manage                 (from Admin)
      KI-Modell                  data.manage                 (from Admin)
      Hilfe                      documents.view              (stays)

Finanzen
  Übersicht · Konten · Bankkontakte · Analyse · Anomalien · Belegabgleich
  ⚙ Einstellungen (new group)
      Konto-Zugriff              finance.admin               (from the strip into the group)
      KI-Tagging                 data.manage                 (new, section 2)

Admin
  Benutzer                       users.list
  Rollen                         roles.list
  Eingeplante Jobs               data.manage
  Systemstatus                   data.manage                 (new: queue overview + build number)
```

### Routes

All backend paths remain unchanged (including `/admin/tools/*`,
`/admin/llm-*`, `/admin/taxonomy-cockpit`); the rework is purely frontend.

| Route | Name | View | `meta.permission` | Content |
|---|---|---|---|---|
| `/fotos/einstellungen/scan-queue` | `fotos-settings-scan-queue` | `PhotoScanQueueView` | `data.manage` | Section 1 |
| `/fotos/einstellungen/wartung` | `fotos-settings-maintenance` | `PhotoMaintenanceView` | `data.manage` | Sections 5–9; section 9 additionally `v-if photos.refresh_metadata` |
| `/fotos/einstellungen/bibliotheken` | `fotos-settings-libraries` | `LibrariesView` (moved) | `photos.libraries.manage` | unchanged |
| `/fotos/einstellungen/osm` | `fotos-settings-osm` | `OsmRegionsView` | `osm.admin` | Section 10 |
| `/fotos/einstellungen/gefahrenzone` | `fotos-settings-purge` | `PhotoPurgeView` | `photos.purge` | Section 11 |
| `/dokumente/verarbeitung` | `dokumente-verarbeitung` | `DocumentProcessingView` | `data.manage` | Section 3 |
| `/dokumente/korrespondenten` | `dokumente-korrespondenten` | `CorrespondentOverridesView` | `documents.manage_taxonomy` | Section 4 |
| `/dokumente/taxonomie-cockpit` | `dokumente-taxonomie-cockpit` | `TaxonomyCockpitView` (moved) | `data.manage` | unchanged |
| `/dokumente/taxonomie-tools` | `dokumente-taxonomie-tools` | `TaxonomyToolsView` (renamed from `AdminToolsView`) | `data.manage` | unchanged |
| `/dokumente/ki-modell` | `dokumente-ki-modell` | `LlmModelsView` (moved) | `data.manage` | unchanged |
| `/finanzen/ki-tagging` | `finance-tag-queue` | `finance/TagQueueView` | `data.manage` | Section 2 |
| `/admin/status` | `admin-status` | `SystemStatusView` | `data.manage` | Queue numbers of all three queues with links, build number (section 12) |

Mind the order in `modules.ts`: the new Documents routes must come
**before** `:id`, otherwise the detail route swallows them (same pattern
as `hilfe/gradtage` in the meter module).

**Redirects** (old URLs and bookmarks stay valid):

| Old | New |
|---|---|
| `/admin/daten`, `/data-management` | `/admin/status` |
| `/admin/bibliotheken` | `/fotos/einstellungen/bibliotheken` |
| `/admin/taxonomie-cockpit` | `/dokumente/taxonomie-cockpit` |
| `/admin/tools` | `/dokumente/taxonomie-tools` |
| `/admin/ki-modell` | `/dokumente/ki-modell` |

### Menu groups in `App.vue`

Today `App.vue` only treats the Documents group as a gear in the
navbar (`docSettingsGroup`, only for `activeModule.id === 'dokumente'`);
all other groups would appear generically as a popup button in the strip.
So that Photos and Finance look just like Documents, the
special handling is generalized: **The first `children` group of each
module becomes the gear in the navbar.** This is a small change
(the `id === 'dokumente'` condition is dropped), the Documents special logic
with the work basket (Arbeitskorb) stays.

### Visibility and permissions

1. **One permission per route** remains the rule; the router is not extended.
   Areas with their own permission (`osm.admin`, `photos.purge`,
   `photos.libraries.manage`, `documents.manage_taxonomy`) therefore get
   their own routes instead of guards inside a page.
2. **Finer permissions via `v-if`**, not via a disabled button
   (convention of the previous page). Affected: metadata card in
   `PhotoMaintenanceView` (`photos.refresh_metadata`).
3. **Module permission is added.** Anyone who wants to see an admin action
   now additionally needs the module permission (`photos.view`, `documents.view`,
   `module.finance`). For holders of the Admin role nothing changes. A
   later "operator" role with only `data.manage` would also have to
   get module permissions. This is accepted deliberately; in return, the
   current hurdle that the admin module is only visible with `users.list` goes away.
4. **System status page** shows numbers (pending/processing/failed) of the
   three queues via the existing status endpoints and links
   to the respective module page; links appear only with the module permission.
   There are no actions there.
5. **Backend stays untouched.** No permission and no path is changed.
6. **Storybook mock user** (`stories/mock-data.ts`) additionally gets
   `osm.admin`, `photos.refresh_metadata`, `documents.manage_taxonomy`,
   `module.finance`, `finance.view`, so that all pages can be rendered.
   For each moved page a story with reduced permissions.

### Component split

New folder `frontend/src/components/admin/`, one panel per section modeled on
`CorrespondentOverridesPanel.vue` (own state, own
API calls, no prop drilling):

| Panel | From section | Script lines today |
|---|---|---|
| `ScanQueuePanel.vue` (+ existing `QueueErrorsDialog`) | 1 | 60–199 |
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

Shared building blocks:

- `adminPanels.css`: the shared rules (`.data-management-group`,
  queue tables and cards, badges, `.button-row`) from the old
  `<style scoped>` block. Each panel includes them via
  `<style scoped src="./adminPanels.css">`, so it keeps its scope hash.
  `AdminPage.vue` only supplies the page frame with `<h1>`. Colors only via
  semantic PrimeVue variables (see `css_style_guide` in CLAUDE.md).
- `usePolling(fn, intervalMs)`: composable for the OSM timer (start in
  `onMounted`, stop in `onBeforeUnmount`). The poll then only runs
  on the OSM page.
- `frontend/src/config/queueOverview.ts`: plain list of the three
  queues (label, status loader, target route, module permission) for the
  system status page, plus `visibleQueues(hasPermission)`; testable
  without a DOM.

The four moved views (`LibrariesView`, `TaxonomyCockpitView`,
`AdminToolsView`, `LlmModelsView`) are **not** rebuilt, only
re-hung (route, menu, file name if needed). Their `localStorage` key
(`admin-tools-state-v1`) stays so that saved state is
preserved.

## Stages

Each stage is mergeable on its own; all pages remain reachable at all times
(old route until the switch, redirect afterwards).

### Stage 1 — Preparation without behavior change

- `AdminSection.vue`, `usePolling`, `queueOverview.ts` (+ Vitest test).
- Add mock permissions in `stories/mock-data.ts`.
- `App.vue`: generalize the gear group for all modules. Nothing changes
  visibly, because only Documents has a group.

### Stage 2 — Extract panels (1:1)

- Eleven panels to `components/admin/`, taking state and handlers along.
  `DataManagementView.vue` then consists only of `<AdminSection>` blocks
  with one panel each. Realtime subscriptions move into `ScanQueuePanel` and
  `PhotoGroupingPanel` respectively.
- Verification: Storybook screenshots of the existing stories
  before/after (`npm run screenshot`), no visible change.

### Stage 3 — Photos › Settings

- Create the group „Einstellungen" (Settings) in the Photos module.
- Five routes/views: scan queue, maintenance, libraries (moved),
  OSM regions, danger zone.
- Redirect `/admin/bibliotheken`; remove the menu item „Externe Bibliotheken" from
  Admin.
- Permission polish: metadata card behind `photos.refresh_metadata`.
- Reference in `ReviewQueueView.vue` (line ~836, „im DataManagement" (in data management)) as a
  router link to `fotos-settings-maintenance`.

### Stage 4 — Documents › Settings and Finance › Settings

- Documents: processing, correspondents (own route with
  `documents.manage_taxonomy`), taxonomy cockpit, taxonomy tools
  (`AdminToolsView` → `TaxonomyToolsView`), AI model. Sort routes in before
  `:id`. Redirects for the three admin URLs; remove menu items from
  Admin.
- Finance: group „Einstellungen" with account access (route unchanged,
  only the menu location) and AI tagging.

### Stage 5 — Admin › System status, dissolving the old page

- `SystemStatusView` under `/admin/status` with queue overview and
  build number; replace the menu item „Datenverwaltung" with „Systemstatus" (system status).
- Redirects `/admin/daten` and `/data-management` to `/admin/status`.
- Delete `DataManagementView.vue` and `DataManagementView.stories.ts`;
  stories per new view (idle, queue active, GPS rescan available are
  kept, only distributed onto the respective page; stories of the moved
  views stay and are only renamed).
- Check doc references: `documentation/purge.md`, `documentation/osm-admin-deployment.md`,
  `documentation/external-libraries.md`, `documentation/finance-tagging-and-ai.md`.
- `.claude/CLAUDE.md`: set the plan entry to "implemented".

## Tests and safeguards

- **Vitest (frontend):** `queueOverview.test.ts` (visibility by
  permissions); `moduleEntryPath.test.ts` stays green; a test that every
  redirect from the table above points to an existing route
  (resolve router, `matched.length > 0`).
- **Backend:** no change, `npm run test` must still run before every push
  (test obligation from CLAUDE.md).
- **Storybook:** at least one story per page; screenshot comparison after
  stage 2 as regression protection for the layout.
- **Manual:** with a user who only has `data.manage` plus module permissions,
  check that OSM, danger zone, libraries, correspondents and the
  metadata card do not appear and no 403 messages show up; with
  the Admin role check that the danger zone is missing (no `photos.purge`).

## Assumptions made and open points

1. **AI model lives under Documents.** The `llm_service` is used by Documents
   (classification) and Finance (tag suggestions, analysis). Documents
   is the main user and already has the settings group; the
   Finance page „KI-Tagging" gets a note with a link to the
   model page. The alternative would be to leave AI model under Admin; that
   contradicts the requirement to move all four pages.
2. **Account access moves into the Finance group.** Only the menu location
   changes, route and permission stay. If the item is to stay in the strip,
   the group contains only AI tagging; that works as well.
3. **System status** is deliberately read-only. Anyone who wants to intervene follows
   the link into the module.
