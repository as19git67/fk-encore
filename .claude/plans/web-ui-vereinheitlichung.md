# Web-UI vereinheitlichen: Seitenaufbau, Toolbar, Navigation, Selektion

Status: **In Umsetzung** · Issue: [#1272](https://github.com/as19git67/fk-encore/issues/1272) · Branch: `claude/web-app-ui-consistency-h0wd56`

## Umsetzungsstand

- ✅ **Etappe 1 — Fundament** (#1276): Tokens in `style.css`,
  `components/layout/PageLayout.vue` + `pageLayout.ts`, `ScrollX.vue`,
  Overflow-Guard, `.scroll-anchor`, Untermenü als eigene Zeile in `App.vue`,
  `--app-stack-height` per `ResizeObserver`, Breiten-Check im
  Storybook-Test-Runner (`utils/overflowCheck.ts`), Pilot-Views
  `DocumentsView` und `finance/AccountTransactionsView`, Stories
  `Layout/PageLayout`, `Layout/ScrollX`, `Layout/AppShell`.
- ✅ **Etappe 2 — alle Views auf `PageLayout`** (#1277): alle 62 Views unter
  `views/` (inkl. Login/Registrierung/Passwort und `SharedAlbumView`)
  laufen über `PageLayout`; `AdminPage` ist ein dünner Wrapper; View-eigene
  Sticky-Header, `top:`-Offsets und `calc(100dvh - …)` sind weg, der Alias
  `--menubar-height` ist entfernt. `DataTable`s liegen in `ScrollX`.
- ✅ **Etappe 3 — Toolbar-Vertrag** (#1278): `components/layout/ListToolbar.vue`
  + `listToolbar.ts` (Typen, `formatResultCount`, `isSearchHotkey`),
  `composables/useListToolbar.ts` (`useListSearch`, `useListView`,
  `useListToolbar`), generische `FilterChips`, Chip-Mappings in `useFilter`
  (`usePhotoFilterChips`) und `useDocumentFilter` (`useDocumentFilterChips`),
  `EmptyState`, `PageSkeleton`, `ErrorBanner`. Suche liegt in `?q=`,
  Sortierung in `?sortBy/?sortDir`, Ansicht in `?view=`; `useSort` liefert
  zusätzlich `fields` und `select()`, damit die Toolbar das Sortiermenü selbst
  rendert. Stories `Layout/ListToolbar` und `Layout/Listenzustände`.
- ⬜ Etappen 4 bis 6: siehe Sub-Issues #1279 bis #1281.

Abweichungen vom Entwurf (Etappe 1):

- Der Basket-Indicator sitzt bereits in `navbar-end` (Dokumente und
  Finanzen); die gemeinsame Komponente kommt in Etappe 5.
- Die Overflow-Prüfung misst nicht `scrollWidth` des Dokuments (mit
  `overflow-x: clip` bliebe die Seite ohnehin unscrollbar), sondern sucht
  Elemente, die ohne klippenden Vorfahren über den 360px-Viewport ragen.
  Das findet abgeschnittene Inhalte, nicht nur scrollbare Seiten.
- `PageLayout` rendert seinen Sticky-Teil inline, wenn `#module-subheaders`
  fehlt (Storybook, Tests), statt einen Teleport-Fehler zu werfen.

Abweichungen vom Entwurf (Etappe 2):

- Vier `position: sticky`-Stellen bleiben bewusst im Inhalt: die
  Upload-Fortschrittsbalken in Galerie und Albumdetail (`top: 0` im
  scrollenden Inhalt, iOS) und der Schließen-Knopf der mobilen Bottom-Sheets
  in Albumdetail und Personen (innerhalb des fixen Sheets). Keine davon ist
  ein Header oder eine Toolbar.
- `SharedAlbumView` (ohne Login, also ohne App-Shell) zeigt den Albumtitel
  als `h1` über Karte bzw. Raster; im Kartenmodus erscheint der Name damit
  zusätzlich zum Overlay der Karte.
- Ein Seitentitel enthält keine Zähler mehr (die stehen im `hint`), damit
  `document.title` stabil bleibt.

Abweichungen vom Entwurf (Etappe 3):

- `ListToolbar` liegt in `components/layout/` statt direkt in `components/`,
  zusammen mit `PageLayout`, `ScrollX`, `EmptyState`, `PageSkeleton` und
  `ErrorBanner` — es ist dieselbe Familie.
- Statt `ResponsiveToolbar`-Overflow verlieren Filter/Sortierung/Ansicht/
  Auswahl unter `sm` nur ihre Beschriftung und bleiben als Icons in der Zeile.
  Ein Filter-Knopf, der im „…"-Menü verschwindet, ist schlechter zu finden als
  ein Icon. Für die *Aktionen* einer View (Upload, Sprung, Karte) bleibt
  `ResponsiveToolbar` im `#actions`-Slot der Toolbar.
- Die Toolbar hat immer zwei Zeilen (Bedienelemente / Chips + Zähler) statt
  einer auf breiten Schirmen. Das kostet ~1,5rem Höhe, dafür springt beim
  Setzen eines Filters nichts um.
- `search` im Modell ist optional: Listen ohne Suchfeld (Rollen, Jobs) nutzen
  dieselbe Toolbar für Zähler und Zustände.
- Statt `natural?: boolean` hat `ListToolbar` einen `search`-Slot. Galerie und
  Albumdetail setzen dort ihre `NaturalSearchBar` ein; `useListSearch({ manual:
  true })` schreibt den Begriff erst beim Absenden in die URL, weil jede
  Ausführung einen Backend-Roundtrip kostet.
- Ergebniszahl: „Keine Treffer" / „{n} Treffer" / „{loaded} von {total}". Der
  Entwurf nannte durchgehend „{loaded} von {total}"; sobald alles geladen ist,
  liest sich „12 von 12" wie ein Rest, der noch fehlt.
- `DocumentsView` hat seinen kombinierten Query-Writer (`syncQueryParams`)
  verloren. Die Race aus #651 ist strukturell weg, weil Suche, Filter,
  Sortierung und Ansicht alle über `updateRouteQuery` schreiben und das die
  Navigationen serialisiert.
- Der „zuletzt verwendet"-Fallback der Suche liegt in `sessionStorage`, nicht
  in `localStorage`: ein Suchbegriff ist ein „woran ich gerade war", keine
  Einstellung, die einen am nächsten Tag wieder begrüßen soll.
- `filter.open` ist optional. Listen, deren Filter als Dropdown direkt in der
  Toolbar stehen (Zähler- und Finanz-Auffälligkeiten, Steuerliste), liefern
  kein `open` und bekommen keinen Filter-Knopf — nur Chips und Zähler.
- `AlbumsView` und `PersonsView` nutzen weiter ihren eigenen Sortierzustand
  (`utils/albumsViewState.ts` bzw. lokale Refs) und reichen der Toolbar ein
  handgebautes `UseSortReturn`. `useSort` wäre ein zweiter Schreiber für
  `sortBy`/`sortDir` geworden.
- `utils/albumsViewState.ts` besitzt `q` nicht mehr; der Begriff gehört
  `useListSearch`. Ein Link mit nur `?q=` setzt Filter und Sortierung daher
  nicht mehr auf die Voreinstellung zurück.
- `SharedAlbumView` zeigt die Toolbar auch im Kartenmodus. Der Fotofilter
  wirkt dort nur auf die Karte; die Filter- und Raster-Pillen im
  Karten-Overlay entfallen dafür.
- `components/SortMenu.vue` ist gelöscht — die Toolbar rendert das
  Sortiermenü, niemand rief die Komponente mehr auf.
- `UserListView` hatte gar keinen Ladefehler-Zustand (kein `catch`); er kommt
  mit dem `ErrorBanner` neu dazu.
- Die Ergebniszahl ersetzt die bisherigen sechs Formulierungen („N beste
  Treffer", „N von M Dokumenten", „N Buchungen", „N offen", …).

Dieses Dokument trifft die Entscheidungen, die das Issue offen lässt, damit
jede Etappe reine Umsetzung ist. Was hier steht, ist verbindlich für alle
Etappen; Abweichungen werden hier eingetragen, nicht stillschweigend im PR.

## 0. Leitlinien

- **Eine Quelle pro Regel.** Sticky-Höhen, Breakpoints, Abstände, Farben und
  Schriftgrößen stehen genau einmal in `frontend/src/style.css` (Tokens) oder
  in einem Composable. Views lesen sie, definieren sie nie neu.
- **Views füllen Slots, sie bauen kein Layout.** Ein View-SFC enthält nach der
  Umstellung keine Regeln mehr für Header, Toolbar, Sticky, `top:`-Offsets oder
  Seitenbreite. Bleibt View-eigenes CSS, dann nur für den Inhalt selbst.
- **Bestehendes weiterverwenden.** `useScrollRestore`, `useSelection`,
  `useSort`, `ResponsiveToolbar`, `FilterChips`, `AdminPage` und die
  Teleport-Zone `#module-subheaders` sind Ausgangspunkt, kein Wegwerfmaterial.
- **Nur semantische PrimeVue-Variablen** (siehe CSS-Style-Guide in
  `.claude/CLAUDE.md`).

## 1. Seitenskelett

### Entscheidung: Komponente `PageLayout`, keine reinen CSS-Klassen

Grund: Eine Komponente kann den Teleport in den Sticky-Stack, die
`scroll-margin-top`, den Overflow-Guard und den Dokumenttitel selbst
erledigen. Mit reinen Klassen müsste das jede View wiederholen. Die
Klassen gibt es trotzdem (für Storybook und für Sonderfälle), aber sie sind
Implementierungsdetail von `PageLayout`, nicht öffentliche API.

Datei: `frontend/src/components/layout/PageLayout.vue`

```vue
<PageLayout
  title="Dokumente"            <!-- Pflicht, wird <h1> und document.title -->
  :hint="..."                  <!-- optional, Zeile unter dem Titel -->
  scroll="page | self"         <!-- s. u., default "page" -->
  width="normal | wide | full" <!-- default "normal" -->
>
  <template #actions>   … Buttons rechts neben dem Titel (ResponsiveToolbar) </template>
  <template #toolbar>   … Suche / Filter / Sortierung / Auswahl (s. §3) </template>
  <template #notice>    … Message-Banner (Fehler, Hinweis), unter der Toolbar </template>
  <template #default>   … Inhalt </template>
  <template #selection> … Auswahlleiste (s. §6), nur wenn aktiv </template>
</PageLayout>
```

Verhalten:

- `#toolbar` und `#notice` werden per `<Teleport to="#module-subheaders">`
  in den Sticky-Stack gehoben. Damit gibt es genau **einen** Sticky-Stack in
  `App.vue`; der bisherige View-eigene Sticky-Code (`AlbumsView`,
  `DocumentsView`, `GalleryView`, `AlbumDetailView`, `PersonsView`,
  `TransactionDetailView`) entfällt.
- `title` setzt `document.title` als `"<Seite> · <Modul> · fk"`. Der Modulname
  kommt aus `config/modules.ts` über die aktive Route.
- `scroll="page"`: der Inhalt scrollt mit dem Dokument (Standard, Listen mit
  Infinite-Scroll, Detailseiten, Admin).
  `scroll="self"`: `PageLayout` reserviert genau eine Viewport-Höhe unter dem
  Sticky-Stack (`height: calc(100dvh - var(--app-stack-height))`) und der
  Inhalt scrollt in einem eigenen Element (Split-View, virtuelle Galerie).
  Das Scroll-Element ist über `ref` und über
  `provide('pageScroller')` erreichbar, damit `useScrollRestore` es findet.
- `width`: `normal` = max. 1200px zentriert (Formulare, Detail, Admin);
  `wide` = max. 1600px (Tabellen, Finanzen); `full` = volle Breite mit
  Seitenabstand (Galerie, Karten).
- Der `<h1>` steht **im Inhalt**, nicht im Sticky-Stack. Nur Toolbar und
  Notices sind sticky. Grund: Auf dem Handy ist die Sticky-Höhe knapp, der
  Titel ist beim Scrollen entbehrlich, die Toolbar nicht.

Detailseiten nutzen dasselbe `PageLayout` mit `#actions` (Zurück, Vor/Zurück
in Liste, Bearbeiten) und ohne `#toolbar`. `AdminPage.vue` wird ein dünner
Wrapper um `PageLayout` mit `width="normal"` und bleibt für die Admin-Panels
bestehen.

### Tokens (in `style.css`, `:root`)

| Token | Wert | Bedeutung |
| --- | --- | --- |
| `--app-navbar-height` | `3.5rem` | Hauptmenü (heute `--menubar-height`) |
| `--app-submenu-height` | `2.5rem` | Untermenü-Zeile |
| `--app-stack-height` | wird von `App.vue` per `ResizeObserver` gesetzt | Gesamthöhe Navbar + Untermenü + Subheader |
| `--space-1` … `--space-6` | 4 / 8 / 12 / 16 / 24 / 32 px | Abstandsskala (ersetzt `--spacing-*`) |
| `--radius-sm` / `--radius-md` | 4px / 8px | Ecken |
| `--page-gutter` | 16px, ab `md` 24px | Seitenrand |
| `--page-max-normal` / `--page-max-wide` | 1200px / 1600px | Inhaltsbreite |

Alle Elemente, die per `scrollIntoView` angesprungen werden (Listenzeilen,
Anker), bekommen `scroll-margin-top: calc(var(--app-stack-height) + var(--space-2))`
über eine gemeinsame Klasse `.scroll-anchor`.

## 2. Sticky-Stack: Hauptmenü + Untermenü-Zeile

### Entscheidung: Untermenü wird eine eigene Zeile unter dem Hauptmenü

Heute liegt das Untermenü als `.submenu-strip` **in** der Navbar neben dem
Hamburger. Das Issue verlangt eine feste Zeile darunter. Umbau in `App.vue`:

```
.app-toolbar-stack (sticky, top 0, z 1100)
├─ nav.app-navbar      Hamburger · Modulname/Logo · rechts: Basket-Indicator, Suche-Shortcut, Profil, Logout
├─ nav.app-submenu     Untermenü des aktiven Moduls (horizontal scrollbar in sich, nie die Seite)
└─ #module-subheaders  Toolbar + Notices der aktiven View (Teleport-Ziel, leer = display:none)
```

- `app-submenu` wird nur gerendert, wenn ein Modul aktiv ist und Menüpunkte
  hat (Login, Profil, Shared-Album haben keins). Die Höhe ist fest
  (`--app-submenu-height`), damit `--app-stack-height` nicht springt.
- Aktiver Menüpunkt: Unterstrich in `--p-primary-color`, kein Fettdruck mehr
  (`.submenu-item--active` entfällt).
- Gruppen (Zahnrad „Einstellungen") bleiben Popup-Menüs wie heute.
- Der Basket-Indicator (§6) wandert in `navbar-end` und wird pro Modul
  geschaltet.
- `App.vue` misst den Stack mit `ResizeObserver` und schreibt
  `--app-stack-height` auf `.app-container`. Kein View rechnet Offsets selbst.

## 3. Toolbar-Vertrag: Suche, Filter, Sortierung

### Entscheidung: Eine Komponente `ListToolbar` mit einem Adapter-Interface, Filter-Composables bleiben domänenspezifisch

`useFilter` (Fotos) und `useDocumentFilter` (Dokumente) haben unterschiedliche
Filtermodelle und URL-Keys; zusammenlegen lohnt nicht. Stattdessen liefert
jede Liste der Toolbar ein kleines, einheitliches Interface:

```ts
// frontend/src/composables/useListToolbar.ts
export interface ListToolbarModel {
  search: {
    value: Ref<string>              // an URL ?q= gebunden, 300 ms Debounce
    placeholder: string
    natural?: boolean               // NaturalSearchBar statt InputText
  }
  filter?: {
    chips: ComputedRef<FilterChip[]>       // { key, label, remove(): void }
    activeCount: ComputedRef<number>
    open(event: Event): void               // öffnet das domänenspezifische Menü
    clearAll(): void
  }
  sort?: UseSortReturn                     // unverändert aus useSort
  result: {
    loaded: ComputedRef<number>
    total: ComputedRef<number | undefined> // undefined = unbekannt (Suche ohne Count)
    loading: ComputedRef<boolean>
  }
  view?: { options: ViewOption[]; value: Ref<string> }   // Kacheln/Liste, Gruppierung
  selection?: { active: Ref<boolean>; toggle(): void }   // s. §6
}
```

`ListToolbar` rendert daraus **immer in dieser Reihenfolge**:

```
[ Suche ………………… ] [ Filter (n) ] [chip] [chip] [× alle]   „123 von 4.567"   [ Sortierung ] [ Ansicht ] [ Auswählen ]
```

- Auf `< md` bricht die Toolbar in zwei Zeilen: Zeile 1 Suche + Filter +
  Sortierung als Icon-Buttons (via `ResponsiveToolbar`-Overflow), Zeile 2
  Chips + Ergebniszahl. Auswahl-Toggle wandert in den Overflow.
- `FilterChips` wird generisch (`chips: FilterChip[]`) statt an `PhotoFilter`
  gebunden; das Foto-Chip-Mapping zieht in `useFilter` um.
- Ergebniszahl: `"{loaded} von {total}"` bei bekanntem Total, sonst
  `"{loaded} Treffer"`; während `loading` ein kleiner Spinner statt Zahl.
- Tastatur überall gleich: `/` fokussiert die Suche, `Esc` im Suchfeld leert
  es, `Esc` außerhalb schließt Auswahlmodus.
- **Zustand nur in der URL.** Suche (`q`), Filter, Sortierung
  (`sortBy`/`sortDir`), Ansicht (`view`) leben in `route.query`. Der
  sessionStorage-Fallback (`documents.filter`) bleibt nur als
  „zuletzt verwendet" beim Einstieg ohne Query.
- Draft/Applied-Semantik der Filtermenüs bleibt, wie in `useFilter` und
  `useSort` beschrieben.

### Gemeinsame Zustands-Komponenten

| Komponente | Wann | Inhalt |
| --- | --- | --- |
| `EmptyState` | `result.loaded === 0 && !loading` | Icon, Titel, Text, optional Aktion. Bei aktiven Filtern automatisch „Filter zurücksetzen" |
| `PageSkeleton` | erster Ladevorgang | Liste (n Zeilen) oder Grid (n Kacheln), Variante per Prop |
| `ErrorBanner` | Ladefehler | Message severity error mit „Erneut versuchen", im `#notice`-Slot |

Toasts nur für Aktionen (gespeichert, gelöscht), nie für Ladefehler.

## 4. Kein horizontales Scrollen der Seite

- `html, body { overflow-x: clip }` und `.page-content { min-width: 0 }`.
  Jedes Flex-Kind auf Seitenebene bekommt `min-width: 0`.
- Wrapper `ScrollX.vue` (`overflow-x: auto`, Kantenschatten links/rechts per
  `mask-image`, `tabindex="0"` für Tastatur). Pflicht um jede `DataTable`,
  jedes `<pre>`, jede Chart-Zeile und die `RecapFeedStrip`.
- `DataTable` einheitlich mit `scrollable` und `tableStyle="min-width: <n>px"`;
  Spalten mit `min-width` statt fester `width`.
- **Automatischer Check:** `.storybook/test-runner.ts` prüft in `postVisit`
  bei Viewport 360×740, dass `document.documentElement.scrollWidth <=
  clientWidth`. Zusätzlich ein Vitest mit `@vue/test-utils` pro
  Layout-Komponente, der `min-width: 0` an den Flex-Kindern sicherstellt.

## 5. Scroll- und Fokus-Wiederherstellung

### Entscheidung: zentral im Router plus optionaler Anker pro Liste

**Scroll (immer):**

- `router.scrollBehavior` speichert je `history.state.position` den
  Scroll-Offset des aktiven Scrollers (Dokument oder `pageScroller`).
  `useScrollRestore` wird von `PageLayout` automatisch aufgerufen; der Key ist
  `route.name` + serialisierte Query. Views rufen `restore()` nicht mehr selbst;
  `PageLayout` bekommt stattdessen ein `ready`-Prop (Boolean), das die View auf
  `true` setzt, sobald die Daten stehen. Der Restore läuft im nächsten Frame
  nach `ready`.
- Nur `history.back/forward` restauriert (Vue Router liefert `savedPosition`).
  Klick auf Untermenü oder Sidebar startet oben.

**Anker (Listen mit Detail):**

`utils/documentListFocus.ts` wird zu `utils/listAnchor.ts`:

```ts
export interface ListAnchor { kind: string; id: number }
export function saveListAnchor(routeKey: string, anchor: ListAnchor): void
export function takeListAnchor(routeKey: string): ListAnchor | null   // liest und löscht
```

- Die View speichert beim Öffnen eines Eintrags den Anker (`kind` =
  `'document' | 'collection' | 'photo' | 'album' | 'transaction' | …`).
- Beim Zurückkommen: `PageLayout` wartet auf `ready`, ruft
  `props.resolveAnchor?.(anchor)` auf. Die View liefert entweder ein
  `HTMLElement` (normale Liste) oder einen Index (virtuelle Liste) oder
  `null` (nicht mehr vorhanden). Element: `scrollIntoView({ block: 'center' })`
  + `focus({ preventScroll: true })`. Index: `scrollToIndex(index, 'center')`
  auf dem Grid, dann im nächsten Frame die Zelle fokussieren. `null`: Fallback
  auf den gespeicherten Offset.
- **Virtuelle, seitenweise geladene Listen** (Galerie, Dokumente): Wenn der
  Anker nach dem ersten Laden nicht im Datenbestand ist, lädt die View
  weitere Seiten, bis der Anker gefunden ist oder ein Limit von 5 Seiten
  erreicht ist. Danach Fallback auf Offset. Bei der Galerie mit
  Datumsgruppierung wird der Index über `usePhotoGrouping` aus der flachen
  Foto-Liste abgeleitet, wie heute für `cursorIndex`.
- Fokus-Sichtbarkeit: Zeilen und Kacheln sind `tabindex="0"` mit gemeinsamem
  Fokusring (`:focus-visible { outline: 2px solid var(--p-primary-color);
  outline-offset: 2px }`) und der Klasse `.scroll-anchor` (§1).
- Split-View: der Anker ist dort ohnehin die aktive Zeile
  (`activeListItem.ts`); `resolveAnchor` liefert deren Element.

## 6. Mehrfachauswahl und Basket

### Entscheidung: Selection-Bar und Basket-UI als gemeinsame Komponenten, Domänenstores bleiben

**Selection (transient, pro View):**

- Composable `useListSelection<T>()` kapselt `selectMode`, `selectedIds`,
  `useRangeSelect`, `toggle`, `selectAllLoaded`, `invert`, `clear`. Ersetzt die
  beiden lokalen Implementierungen in `GalleryView` und
  `AccountTransactionsView`.
- Komponente `SelectionBar` (Slot `#selection` in `PageLayout`):
  `[n ausgewählt] [Alle n laden/auswählen] [Umkehren] [Aufheben] … [Aktionen ▾] [In den Korb]`.
  Desktop: ersetzt die Toolbar-Zeile im Sticky-Stack, solange `selectMode`
  aktiv ist. Mobil: sticky unten (`position: sticky; bottom: 0`), wie heute
  in der Galerie.
- Gesten überall gleich: Toggle-Button in der Toolbar, Long-Press auf Touch,
  `Shift`+Klick Bereich, `Ctrl/Cmd`+Klick einzeln, `Ctrl/Cmd+A` alle
  geladenen, `Esc` beendet den Modus.
- Modus verlassen leert die transiente Auswahl, nie den Basket.
- Aktionen kommen als `ToolbarItem[]` aus der View (dieselbe Struktur wie
  `ResponsiveToolbar`), damit Overflow und Beschriftung identisch sind.

**Basket (persistent, pro Modul):**

- `useTxSelectionStore` und `useDocSelectionStore` bleiben (Domänen-Aggregate
  wie Summe). Ein neuer Basket-Store für Fotos (`usePhotoSelectionStore`)
  kommt in der letzten Etappe, wenn Alben-Batch-Aktionen darauf umgestellt
  werden.
- `BasketIndicator.vue` ersetzt `TxBasketIndicator` und `DocBasketIndicator`:
  Prop `store` (ein Objekt mit `count`, `items`, `clear`, `remove`) und Prop
  `to` (Route der Basket-Ansicht). Badge, Tooltip, Animation beim Hinzufügen
  identisch.
- `BasketDrawer.vue`: Liste der Einträge mit Entfernen-Button, Fußzeile mit
  `Leeren`, `Alle öffnen` und modulspezifischen Batch-Aktionen (Slot).
  `DocumentsBasketView` und der Finanz-Basket nutzen denselben Drawer.
- Basket-Navigation in Detailansichten (Vor/Zurück innerhalb des Baskets)
  über ein gemeinsames `useBasketNavigation(store, currentId)`.

## 7. Weitere Regeln

### Detailseiten

- `PageLayout` mit `#actions`: `[← Zurück] [◀ ▶ n/m] … [Bearbeiten] [Mehr ▾]`.
- Zurück nutzt `useModuleBack` (vorhanden). Vor/Zurück in Liste nutzt den
  Basket, falls vorhanden, sonst die zuletzt geladene Liste (§5-Anker-Key).
- Bearbeiten-Modus: Speichern (primary) und Abbrechen (secondary) ersetzen
  die Aktionen rechts; Formularinhalt bleibt an Ort und Stelle.

### Dialoge

- Nur PrimeVue `Dialog` und `ConfirmDialog`, keine eigenen Modals.
- Breiten: `sm` 420px (Bestätigung, ein Feld), `md` 640px (Formular),
  `lg` 960px (Vorschau/Tabelle); `< md` immer Vollbild (`:modal="true"`,
  `position="bottom"` mit `max-height: 90dvh`).
- Footer: links Sekundär/Abbrechen, rechts Primär; destruktiv `severity="danger"`
  und immer via `ConfirmDialog` mit expliziter Nennung, was gelöscht wird.
- `Esc` schließt, Enter im letzten Feld bestätigt, Fokus geht beim Öffnen auf
  das erste Feld.

### Buttons und Icons

| Rolle | PrimeVue | Beispiel |
| --- | --- | --- |
| Primäre Aktion der Seite | `severity="primary"` gefüllt | Hochladen, Speichern |
| Sekundäre Aktion | `severity="secondary" outlined` | Exportieren |
| Toolbar-Icon | `text rounded` + `aria-label` + `v-tooltip` | Filter, Sortierung |
| Destruktiv | `severity="danger" outlined` | Löschen |

Icon-Set ausschließlich PrimeIcons; eigene Icons (`pi-link-slash`) in
`style.css` registriert.

### Typografie

| Element | Größe | Gewicht |
| --- | --- | --- |
| `h1` (Seitentitel) | 1.5rem, `< md` 1.25rem | 600 |
| `h2` (Abschnitt) | 1.125rem | 600 |
| `h3` (Karte/Panel) | 1rem | 600 |
| Fließtext | 0.9375rem | 400 |
| Caption/Hint | 0.8125rem, `--p-text-muted-color` | 400 |

Views setzen keine `font-size` auf Überschriften. Abstände nur aus
`--space-*`.

### Breakpoints

| Name | Query | Verhalten |
| --- | --- | --- |
| `sm` | `< 640px` | Toolbar zweizeilig, Dialoge Vollbild, Selection-Bar unten, 2 Grid-Spalten |
| `md` | `640–1023px` | Toolbar einzeilig mit Overflow, Sidebar als Drawer |
| `lg` | `≥ 1024px` | Sidebar inline, 4+ Grid-Spalten |
| `split` | `≥ 1300px` + landscape | Split-View (bestehend, `useSplitView`) |

Als CSS-Custom-Media in `style.css` und als Konstanten in
`composables/useBreakpoint.ts`, damit CSS und JS nicht auseinanderlaufen
(dasselbe Prinzip wie `SPLIT_VIEW_MEDIA_QUERY`).

### Dark Mode, Fokus, Transitions

- Audit-Script `scripts/check-css-tokens.mjs`: schlägt bei
  `--p-surface-*`, Hex-Farben und `rgb(` ohne `rgba(` in `*.vue` an; läuft
  im Pre-Commit-Hook.
- Fokusring global wie in §5; `outline: none` in Views verboten.
- Eine Route-Transition (`fade`, 120 ms) in `App.vue`, eine Overlay-Transition
  (PrimeVue-Standard). View-eigene `<Transition>` nur für Inhaltselemente.

## 8. Etappen

Jede Etappe ist ein Sub-Issue von #1272 und ein eigener PR. Reihenfolge ist
verbindlich, weil jede Etappe auf der vorigen aufbaut.

| Nr. | Etappe | Liefert | Fertig, wenn |
| --- | --- | --- | --- |
| 1 | Fundament | Tokens, `PageLayout`, `ScrollX`, Overflow-Guard, Untermenü-Zeile, `--app-stack-height`, Breiten-Check im Test-Runner | Zwei Pilot-Views (`DocumentsView`, `AccountTransactionsView`) auf `PageLayout`; kein horizontales Scrollen bei 360px in allen Stories |
| 2 | Alle Views auf `PageLayout` | Restliche ~60 Views, View-eigener Sticky-Code gelöscht, `AdminPage` als Wrapper | `grep "position: sticky" src/views` liefert nur Selection-Bars |
| 3 | Toolbar-Vertrag | `useListToolbar`, `ListToolbar`, generische `FilterChips`, `EmptyState`, `PageSkeleton`, `ErrorBanner` | Alle Listen-Views zeigen Chips, Ergebniszahl und gemeinsamen Empty-State; Suche/Filter/Sort nur in URL |
| 4 | Navigations-Gedächtnis | Router-`scrollBehavior`, `ready`-Prop, `listAnchor`, `resolveAnchor` in allen Listen | Zurück aus Detail landet auf der geöffneten Zeile/Kachel (Storybook-Interaction-Test pro Liste) |
| 5 | Selektion und Basket | `useListSelection`, `SelectionBar`, `BasketIndicator`, `BasketDrawer`, `useBasketNavigation` | Galerie, Dokumente, Finanzen mit identischer Bar und identischem Basket |
| 6 | Feinschliff | Detail-Aktionen, Dialog-Größen, Button-Rollen, Typografie, Breakpoints, Token-Audit-Script, Route-Transition | Audit-Script grün; Storybook-Screenshots je Seitenzustand aktualisiert |

Tests: Jede Etappe hält `npm run test` (Backend und Frontend) grün und
ergänzt Stories für neue Komponenten. Screenshot-Vergleich vor/nach je
Etappe im PR.

## 9. Offene Punkte

- Ob Fotos einen eigenen Basket bekommen (Etappe 5/6) oder die Alben-Dialoge
  weiter direkt auf der transienten Auswahl arbeiten. Entscheidung nach
  Etappe 5, wenn die Selection-Bar steht.
- `SharedAlbumView` (ohne Login) nutzt `PageLayout` ohne Untermenü; ob die
  Navbar dort überhaupt erscheint, wird in Etappe 2 entschieden.
