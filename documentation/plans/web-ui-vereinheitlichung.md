# Unify the web UI: page structure, toolbar, navigation, selection

Status: **Implemented** · Issue: [#1272](https://github.com/as19git67/fk-encore/issues/1272) · Branch: `claude/web-app-ui-consistency-h0wd56`

## Implementation status

- ✅ **Stage 1 — Foundation** (#1276): tokens in `style.css`,
  `components/layout/PageLayout.vue` + `pageLayout.ts`, `ScrollX.vue`,
  overflow guard, `.scroll-anchor`, submenu as its own row in `App.vue`,
  `--app-stack-height` via `ResizeObserver`, width check in the
  Storybook test runner (`utils/overflowCheck.ts`), pilot views
  `DocumentsView` and `finance/AccountTransactionsView`, stories
  `Layout/PageLayout`, `Layout/ScrollX`, `Layout/AppShell`.
- ✅ **Stage 2 — all views on `PageLayout`** (#1277): all 62 views under
  `views/` (incl. login/registration/password and `SharedAlbumView`)
  run through `PageLayout`; `AdminPage` is a thin wrapper; view-specific
  sticky headers, `top:` offsets and `calc(100dvh - …)` are gone, the alias
  `--menubar-height` is removed. `DataTable`s sit in `ScrollX`.
- ✅ **Stage 3 — toolbar contract** (#1278): `components/layout/ListToolbar.vue`
  + `listToolbar.ts` (types, `formatResultCount`, `isSearchHotkey`),
  `composables/useListToolbar.ts` (`useListSearch`, `useListView`,
  `useListToolbar`), generic `FilterChips`, chip mappings in `useFilter`
  (`usePhotoFilterChips`) and `useDocumentFilter` (`useDocumentFilterChips`),
  `EmptyState`, `PageSkeleton`, `ErrorBanner`. Search lives in `?q=`,
  sorting in `?sortBy/?sortDir`, view in `?view=`; `useSort` additionally
  provides `fields` and `select()` so that the toolbar renders the sort menu itself.
  Stories `Layout/ListToolbar` and `Layout/Listenzustände` (list states).
- ✅ **Stage 4 — navigation memory** (#1279): `utils/listAnchor.ts`
  (`saveListAnchor`, `takeListAnchor`, `anchorKey`, `focusListAnchor`) and
  `utils/scrollMemory.ts` (offset per route, origin of the navigation).
  `router.scrollBehavior` only remembers whether the navigation came from
  history; a `beforeEach` writes the offset on leaving. `PageLayout`
  restores both as soon as `ready` is true: first the row
  (`resolveAnchor` or `data-anchor` in the page content), otherwise the offset —
  and the latter only on back/forward. Connected: documents, tax list,
  folders (Sammelmappen), transactions, meters, albums, persons, admin users.
  `useScrollRestore`, `documentListFocus` and `taxListFocus` are deleted.
- ✅ **Stage 5 — selection and basket** (#1280): `composables/useListSelection.ts`
  (selection mode, range via shift-click, all/invert/clear,
  `Ctrl/Cmd+A`) replaces the three separate implementations;
  `components/layout/SelectionBar.vue` is the one selection row in the
  `#selection` slot — at the bottom edge on the phone. Actions come as
  `ToolbarItem[]` and run through `ResponsiveToolbar`.
  `components/BasketIndicator.vue` is the shared shell for button, badge
  and drawer; documents and finance only fill rows and footer.
  `composables/useBasketNavigation.ts` pages through the basket — now also in the
  transaction detail page. `useRangeSelect` is deleted.
- ✅ **Stage 6 — polish** (#1281):
  - ✅ Color audit `scripts/check-css-tokens.mjs` (surface scale, hex, opaque
    `rgb()`), in the pre-commit hook over the staged styles, with its own tests.
    The 235 findings in 49 files are cleaned up: almost all were
    `var(--p-token, #hex)` fallback values, the rest are palette tokens
    (`--p-red-500` & co.), `color-mix()` tints instead of fixed light tints,
    or deliberately fixed media surfaces with `/* audit-ok: … */`.
  - ✅ Type scale `--text-xs` … `--text-7xl` in `style.css`; the ~20 sizes that grew
    over time are rounded to the nearest rung (no
    spot shifts by more than ~1.5px). Focus everywhere as
    `var(--focus-ring)` / `var(--focus-ring-offset)`; `NaturalSearchBar` had
    `outline: none` without replacement and a dead `--primary-200` shadow. The
    audit now additionally rejects literal `font-size` values and
    PrimeVue 3 names — 33 of which were still in the tree
    (`MeterQuickEntryView`, `MeterQuickEntryConfigView`, the job badges in
    `adminPanels.css`).
  - ✅ `filter.expanded`: the filter button of the transaction list toggles
    a panel, but looked the same open and closed. Now filled instead of
    outlined, with `aria-expanded`; views with an overlay menu omit it.
  - ✅ `composables/useBreakpoint.ts`: `BREAKPOINTS` (xs 480, sm 640, md 768,
    lg 1024, xl 1280), `from()`/`upTo()`, `useMediaQuery`, `useAtLeast`,
    `useBelow`. The five hand-built `matchMedia` blocks (gallery,
    album detail, meter detail, `useSplitView`) use it. The boundary at
    768px was contradictory: `max-width: 768px` and `min-width: 768px`
    claimed the same width, at exactly 768px both the desktop margin and
    `.mobile-hidden` applied. Now every boundary separates cleanly
    (`767`/`768`, `639`/`640`).
  - ✅ One route transition in `App.vue`: 120ms crossfade, `out-in`
    (two simultaneously mounted pages would each teleport a toolbar into the
    sticky stack), and none at all with `prefers-reduced-motion`.
  - ✅ Clipped focus rings (report from production): the ring extends
    4px beyond its element, so every clipping container cuts it off. Affected were the hamburger icon (`.navbar-start` had
    an `overflow: hidden` that it does not need), the submenu entries
    (the strip scrolls horizontally and thereby also clips vertically) and the
    folder rows (they fill the scrolling column). Now the
    container makes room via `--focus-ring-reach`.
  - ✅ The remaining places: `meta-panel` (document detail), the
    DataTable header row (global, PrimeVue's own scroller), `ScrollX` and
    the photo mini-map. The latter cannot make room — its
    `overflow: hidden` rounds the tiles —, so the link draws its
    ring inside (`--focus-ring-offset-inset`). All stories are clean, the
    check (`utils/focusRingCheck.ts`) now runs for every story instead of
    opt-in. What it no longer reports: 1px containers of
    screen-reader fields, elements with the ring inside, and elements that
    extend *beyond* the edge — that is overflow and has its own
    check.
  - ✅ Dialogs: 40 different width notations became three classes
    (`dialog-sm` 420, `dialog-md` 640, `dialog-lg` 960), which cap themselves
    at the viewport minus page margin; no dialog carries its own
    `maxWidth` or `breakpoints` anymore. Below `sm` a dialog takes the full
    width and at most `90dvh`. The photo editor stays fullscreen.
    Footers were already the right way round in 52 of 66; the one real
    swap (`TransactionDetailView`) has been flipped. The supposed
    outliers with three buttons are `v-if` states and thus fine.
  - ✅ Detail pages: `UserDetailView` was the only one without a
    back button — now the same as everywhere, via `useModuleBack`.
  - ✅ 46 icon buttons without a label received an `aria-label` —
    delete, rename, move, submit were all "button" to a screen reader.
    Toggles (favorite, hide) name their state. `scripts/check-button-labels.mjs` enforces this, in the
    pre-commit hook, with its own tests. The first count was 48 and wrong: a `=>`
    in a handler ended the tag match too early. The parser now respects
    quotation marks; a button in an `aria-hidden` subtree
    (`ResponsiveToolbar`'s measuring row) is exempt.
  - ✅ `composables/useFocusTrap.ts` (reported from production): The
    recap "dialog" was none at all — a hand-built `<div>` above the
    page, without `role`, without focus, without Escape. PrimeVue's `Dialog` does
    all of that on its own (measured), the hand-built overlays do not.
    Connected: recap detail, fullscreen, photo compare and the
    bottom sheets in album detail and persons — the latter only below `md`,
    above that the same markup is a normal column. Story
    `Views/RecapsView` (incl. "Detail geöffnet", detail opened) makes the reported case
    checkable in the first place.
  - ✅ Stories per page state — each of the 64 views now has one
    (79 story files, 303 checks in the test runner). Scaffolding:
    `stories/storyRoute.ts` (`routeFromParameters`) sets the stub router to
    the route of a story and holds the view back until navigation has settled
    — otherwise a view loads in `onMounted` against the route it
    happened to be mounted on, and the "no results" story showed the
    unfiltered list. `stories/finance-mock-data.ts` collects the
    finance fixtures. So far: `AccountTransactionsView` (one of the two
    pilot views, until now without a story), `AccountsView`, `RecapsView` — each with
    content, empty, loading, error and phone width. Plus `OverviewView` and
    `BankcontactsView`. `TagQueueView` needs none: its ten lines
    are a frame around `FinanceTagQueuePanel`, which already has its story.
    The rest follows in stages: the remaining finance pages, documents
    (basket, folders, later, tax file, the two suggestion lists, the
    section hints), meters (evaluations, anomalies,
    quick entry), photos (gallery, feed, review queue, danger zone),
    labels and the admin pages (groups, reference persons, jobs,
    AI model, taxonomy cockpit and tools). Each page with content, without
    content, while loading and — where the page draws it — with
    load error.

    This found two real bugs: the chart in the taxonomy cockpit
    extended beyond the page margin at 360px (Chart.js writes the
    canvas size in pixels and only corrects it once its observer has seen the
    new box), and the face rectangle in fullscreen sat beside
    the face as soon as the photo had black bars at the sides: the
    slot container of `HeicImage` spanned the image box instead of the image in the `staticSlot` case.
    Both fixed, both measured by a story rather than assumed
    (`Components/FullscreenOverlay` → "Mit
    Gesichtsrechteck" (with face rectangle), `Components/FacePhotoGrid`).

Deviations from the draft (stage 1):

- The basket indicator already sits in `navbar-end` (documents and
  finance); the shared component comes in stage 5.
- The overflow check does not measure `scrollWidth` of the document (with
  `overflow-x: clip` the page would stay unscrollable anyway), but looks for
  elements that extend beyond the 360px viewport without a clipping ancestor.
  This finds clipped content, not just scrollable pages.
- `PageLayout` renders its sticky part inline if `#module-subheaders`
  is missing (Storybook, tests), instead of throwing a teleport error.

Deviations from the draft (stage 2):

- Four `position: sticky` places deliberately remain in the content: the
  upload progress bars in gallery and album detail (`top: 0` in the
  scrolling content, iOS) and the close button of the mobile bottom sheets
  in album detail and persons (inside the fixed sheet). None of them is
  a header or a toolbar.
- `SharedAlbumView` (without login, thus without app shell) shows the album title
  as `h1` above the map or grid; in map mode the name thus appears
  in addition to the map overlay.
- A page title no longer contains counters (they are in the `hint`), so that
  `document.title` stays stable.

Deviations from the draft (stage 3):

- `ListToolbar` lives in `components/layout/` instead of directly in `components/`,
  together with `PageLayout`, `ScrollX`, `EmptyState`, `PageSkeleton` and
  `ErrorBanner` — it is the same family.
- Instead of `ResponsiveToolbar` overflow, filter/sorting/view/
  selection below `sm` only lose their label and stay in the row as icons.
  A filter button that disappears into the "…" menu is harder to find than
  an icon. For a view's *actions* (upload, jump, map) `ResponsiveToolbar`
  stays in the `#actions` slot of the toolbar.
- The toolbar always has two rows (controls / chips + counter) instead of
  one on wide screens. This costs ~1.5rem of height, but in return nothing jumps
  when a filter is set.
- `search` in the model is optional: lists without a search field (roles, jobs) use
  the same toolbar for counters and states.
- Instead of `natural?: boolean`, `ListToolbar` has a `search` slot. Gallery and
  album detail put their `NaturalSearchBar` there; `useListSearch({ manual:
  true })` only writes the term to the URL on submit, because every
  execution costs a backend roundtrip.
- Result count: „Keine Treffer" (no results) / „{n} Treffer" (n results) / „{loaded} von {total}" (loaded of total). The
  draft consistently said „{loaded} von {total}"; once everything is loaded,
  "12 of 12" reads like a remainder that is still missing.
- `DocumentsView` lost its combined query writer (`syncQueryParams`).
  The race from #651 is structurally gone because search, filter,
  sorting and view all write via `updateRouteQuery`, which serializes the
  navigations.
- The "last used" fallback of the search lives in `sessionStorage`, not
  in `localStorage`: a search term is a "what I was just working on", not a
  setting that should greet you again the next day.
- `filter.open` is optional. Lists whose filters are dropdowns directly in the
  toolbar (meter and finance anomalies, tax list) supply
  no `open` and get no filter button — only chips and counters.
- `AlbumsView` and `PersonsView` continue to use their own sort state
  (`utils/albumsViewState.ts` resp. local refs) and hand the toolbar a
  hand-built `UseSortReturn`. `useSort` would have become a second writer for
  `sortBy`/`sortDir`.
- `utils/albumsViewState.ts` no longer owns `q`; the term belongs to
  `useListSearch`. A link with only `?q=` therefore no longer resets filter and sorting
  to the default.
- `SharedAlbumView` shows the toolbar in map mode as well. The photo filter
  only affects the map there; the filter and grid pills in the
  map overlay are dropped.
- `components/SortMenu.vue` is deleted — the toolbar renders the
  sort menu, nobody called the component anymore.
- `UserListView` had no load error state at all (no `catch`); it gains one
  with the `ErrorBanner`.
- The result count replaces the previous six phrasings („N beste
  Treffer" (N best results), „N von M Dokumenten" (N of M documents), „N Buchungen" (N transactions), „N offen" (N open), …).

Deviations from the draft (stage 4):

- `resolveAnchor` reports `true` instead of an index. A virtual grid does not
  have its cell in the DOM yet; `scrollToAlbum`/`scrollToPerson`/
  `scrollToIndex` can handle that, `PageLayout` cannot. So the view says "done",
  instead of teaching `PageLayout` a grid API.
- The gallery and the album grid get no row anchor: there the
  cursor (`?photoId`, `aroundPhotoId`) is the memory, and a raw offset in
  a virtual, page-wise loaded list points to nothing anyway.
  The "load up to 5 more pages" mentioned in the issue is thus dropped.
- The remembered anchor is one-shot and lives in `sessionStorage`; the
  long-lived "last opened album/last selected person"
  (`localStorage`, `photoNav`) continues to exist alongside it — it answers the
  other question, namely what the list opens with on a fresh visit.
- Instead of Storybook interaction tests per list type, Vitest tests check the
  contract (`PageLayout.test.ts`: row beats offset, offset only from
  history, nothing before `ready`; `listAnchor.test.ts`, `scrollMemory.test.ts`).
  The round trip list → detail → back depends on real history; the existing
  `collectionBackNav.test.ts` runs it against a real router.
- `finance/AccountsView` gets no anchor: its rows open a
  dialog, not a route.

Deviations from the draft (stage 5):

- The selection row does *not* replace the toolbar row, it comes below it. A
  change in the number of rows in the sticky stack changes its height and thus the
  height of every scrolling page — exactly the movement that #1311 eliminated.
- Documents get a real selection mode: the checkboxes only appear
  with „Auswählen" (select). Before, they were always visible, which made it the one list
  that felt different.
- „Aufheben" (clear) in finance clears the selection and no longer ends the mode;
  the X ends it. Before, the same button did both.
- A long press on touch still does not start selection mode. The
  grids use tapping in the mode, and a long press collides there with the
  browser's context menu; that stays for stage 6 if it is missing.
- `ToolbarItem` gained a `disabled`: the gallery's actions
  are locked during a running batch action, and this state would have been lost
  when moving into the bar otherwise.
- The two basket stores stay as they are. The draft wanted a factory;
  but they differ only in two domain extras (`sum` and
  `currency` here, `addAll` and `indexOf` there), and a factory with two
  special cases is more scaffolding than savings. What was duplicated was the *surface* —
  it now lives in `BasketIndicator`.
- `DocumentsBasketView` (the work basket, #750) is left out: it is a
  queue, not a basket, and shares only the word with it.

This document makes the decisions that the issue leaves open, so that
each stage is pure implementation. What is written here is binding for all
stages; deviations are recorded here, not silently in the PR.

## 0. Guidelines

- **One source per rule.** Sticky heights, breakpoints, spacing, colors and
  font sizes exist exactly once in `frontend/src/style.css` (tokens) or
  in a composable. Views read them, never redefine them.
- **Views fill slots, they do not build layout.** After the conversion a view SFC contains
  no rules for header, toolbar, sticky, `top:` offsets or
  page width anymore. If view-specific CSS remains, then only for the content itself.
- **Reuse what exists.** `useScrollRestore`, `useSelection`,
  `useSort`, `ResponsiveToolbar`, `FilterChips`, `AdminPage` and the
  teleport zone `#module-subheaders` are the starting point, not throwaway material.
- **Only semantic PrimeVue variables** (see the CSS style guide in
  `.claude/CLAUDE.md`).

## 1. Page skeleton

### Decision: `PageLayout` component, not pure CSS classes

Reason: A component can handle the teleport into the sticky stack, the
`scroll-margin-top`, the overflow guard and the document title itself. With plain classes
every view would have to repeat that. The
classes exist anyway (for Storybook and special cases), but they are an
implementation detail of `PageLayout`, not public API.

File: `frontend/src/components/layout/PageLayout.vue`

```vue
<PageLayout
  title="Dokumente"            <!-- required, becomes <h1> and document.title -->
  :hint="..."                  <!-- optional, line below the title -->
  scroll="page | self"         <!-- see below, default "page" -->
  width="normal | wide | full" <!-- default "normal" -->
>
  <template #actions>   … buttons to the right of the title (ResponsiveToolbar) </template>
  <template #toolbar>   … search / filter / sorting / selection (see §3) </template>
  <template #notice>    … message banner (error, hint), below the toolbar </template>
  <template #default>   … content </template>
  <template #selection> … selection bar (see §6), only when active </template>
</PageLayout>
```

Behavior:

- `#toolbar` and `#notice` are lifted into the sticky stack via
  `<Teleport to="#module-subheaders">`. This gives exactly **one** sticky stack in
  `App.vue`; the previous view-specific sticky code (`AlbumsView`,
  `DocumentsView`, `GalleryView`, `AlbumDetailView`, `PersonsView`,
  `TransactionDetailView`) is dropped.
- `title` sets `document.title` as `"<Page> · <Module> · fk"`. The module name
  comes from `config/modules.ts` via the active route.
- `scroll="page"`: the content scrolls with the document (default, lists with
  infinite scroll, detail pages, admin).
  `scroll="self"`: `PageLayout` reserves exactly one viewport height below the
  sticky stack (`height: calc(100dvh - var(--app-stack-height))`) and the
  content scrolls in an element of its own (split view, virtual gallery).
  The scroll element is reachable via `ref` and via
  `provide('pageScroller')`, so that `useScrollRestore` finds it.
- `width`: `normal` = max. 1200px centered (forms, detail, admin);
  `wide` = max. 1600px (tables, finance); `full` = full width with
  page margin (gallery, maps).
- The `<h1>` sits **in the content**, not in the sticky stack. Only toolbar and
  notices are sticky. Reason: On the phone the sticky height is tight, the
  title is dispensable while scrolling, the toolbar is not.

Detail pages use the same `PageLayout` with `#actions` (back, prev/next
in list, edit) and without `#toolbar`. `AdminPage.vue` becomes a thin
wrapper around `PageLayout` with `width="normal"` and remains for the admin panels.

### Tokens (in `style.css`, `:root`)

| Token | Value | Meaning |
| --- | --- | --- |
| `--app-navbar-height` | `3.5rem` | Main menu (today `--menubar-height`) |
| `--app-submenu-height` | `2.5rem` | Submenu row |
| `--app-stack-height` | set by `App.vue` via `ResizeObserver` | Total height of navbar + submenu + subheader |
| `--space-1` … `--space-6` | 4 / 8 / 12 / 16 / 24 / 32 px | Spacing scale (replaces `--spacing-*`) |
| `--radius-sm` / `--radius-md` | 4px / 8px | Corners |
| `--page-gutter` | 16px, from `md` 24px | Page margin |
| `--page-max-normal` / `--page-max-wide` | 1200px / 1600px | Content width |

All elements that are jumped to via `scrollIntoView` (list rows,
anchors) get `scroll-margin-top: calc(var(--app-stack-height) + var(--space-2))`
via a shared class `.scroll-anchor`.

## 2. Sticky stack: main menu + submenu row

### Decision: the submenu becomes its own row below the main menu

Today the submenu sits as `.submenu-strip` **in** the navbar next to the
hamburger. The issue demands a fixed row below it. Rework in `App.vue`:

```
.app-toolbar-stack (sticky, top 0, z 1100)
├─ nav.app-navbar      Hamburger · module name/logo · right: basket indicator, search shortcut, profile, logout
├─ nav.app-submenu     Submenu of the active module (scrolls horizontally within itself, never the page)
└─ #module-subheaders  Toolbar + notices of the active view (teleport target, empty = display:none)
```

- `app-submenu` is only rendered if a module is active and has menu items
  (login, profile, shared album have none). The height is fixed
  (`--app-submenu-height`), so that `--app-stack-height` does not jump.
- Active menu item: underline in `--p-primary-color`, no bold anymore
  (`.submenu-item--active` is dropped).
- Groups (gear „Einstellungen", settings) remain popup menus as today.
- The basket indicator (§6) moves into `navbar-end` and is switched
  per module.
- `App.vue` measures the stack with `ResizeObserver` and writes
  `--app-stack-height` onto `.app-container`. No view computes offsets itself.

## 3. Toolbar contract: search, filter, sorting

### Decision: one `ListToolbar` component with an adapter interface, filter composables stay domain-specific

`useFilter` (photos) and `useDocumentFilter` (documents) have different
filter models and URL keys; merging them is not worth it. Instead each list
supplies the toolbar with a small, uniform interface:

```ts
// frontend/src/composables/useListToolbar.ts
export interface ListToolbarModel {
  search: {
    value: Ref<string>              // bound to URL ?q=, 300 ms debounce
    placeholder: string
    natural?: boolean               // NaturalSearchBar instead of InputText
  }
  filter?: {
    chips: ComputedRef<FilterChip[]>       // { key, label, remove(): void }
    activeCount: ComputedRef<number>
    open(event: Event): void               // opens the domain-specific menu
    clearAll(): void
  }
  sort?: UseSortReturn                     // unchanged from useSort
  result: {
    loaded: ComputedRef<number>
    total: ComputedRef<number | undefined> // undefined = unknown (search without count)
    loading: ComputedRef<boolean>
  }
  view?: { options: ViewOption[]; value: Ref<string> }   // tiles/list, grouping
  selection?: { active: Ref<boolean>; toggle(): void }   // see §6
}
```

`ListToolbar` renders from this **always in this order**:

```
[ Search ………………… ] [ Filter (n) ] [chip] [chip] [× all]   „123 von 4.567"   [ Sorting ] [ View ] [ Select ]
```

- Below `md` the toolbar breaks into two rows: row 1 search + filter +
  sorting as icon buttons (via `ResponsiveToolbar` overflow), row 2
  chips + result count. The selection toggle moves into the overflow.
- `FilterChips` becomes generic (`chips: FilterChip[]`) instead of being bound to `PhotoFilter`;
  the photo chip mapping moves into `useFilter`.
- Result count: `"{loaded} von {total}"` (loaded of total) with known total, otherwise
  `"{loaded} Treffer"` (results); while `loading` a small spinner instead of the number.
- Keyboard the same everywhere: `/` focuses the search, `Esc` in the search field clears
  it, `Esc` outside closes selection mode.
- **State only in the URL.** Search (`q`), filter, sorting
  (`sortBy`/`sortDir`), view (`view`) live in `route.query`. The
  sessionStorage fallback (`documents.filter`) remains only as
  "last used" when entering without a query.
- The draft/applied semantics of the filter menus stay as described in `useFilter` and
  `useSort`.

### Shared state components

| Component | When | Content |
| --- | --- | --- |
| `EmptyState` | `result.loaded === 0 && !loading` | Icon, title, text, optional action. With active filters automatically „Filter zurücksetzen" (reset filters) |
| `PageSkeleton` | first load | List (n rows) or grid (n tiles), variant via prop |
| `ErrorBanner` | load error | Message severity error with „Erneut versuchen" (try again), in the `#notice` slot |

Toasts only for actions (saved, deleted), never for load errors.

## 4. No horizontal scrolling of the page

- `html, body { overflow-x: clip }` and `.page-content { min-width: 0 }`.
  Every flex child at page level gets `min-width: 0`.
- Wrapper `ScrollX.vue` (`overflow-x: auto`, edge shadow left/right via
  `mask-image`, `tabindex="0"` for keyboard). Mandatory around every `DataTable`,
  every `<pre>`, every chart row and the `RecapFeedStrip`.
- `DataTable` uniformly with `scrollable` and `tableStyle="min-width: <n>px"`;
  columns with `min-width` instead of fixed `width`.
- **Automatic check:** `.storybook/test-runner.ts` checks in `postVisit`
  at viewport 360×740 that `document.documentElement.scrollWidth <=
  clientWidth`. Additionally a Vitest with `@vue/test-utils` per
  layout component that ensures `min-width: 0` on the flex children.

## 5. Scroll and focus restoration

### Decision: central in the router plus an optional anchor per list

**Scroll (always):**

- `router.scrollBehavior` stores, per `history.state.position`, the
  scroll offset of the active scroller (document or `pageScroller`).
  `useScrollRestore` is called automatically by `PageLayout`; the key is
  `route.name` + serialized query. Views no longer call `restore()` themselves;
  instead `PageLayout` gets a `ready` prop (boolean) that the view sets to
  `true` as soon as the data is in place. The restore runs in the next frame
  after `ready`.
- Only `history.back/forward` restores (Vue Router supplies `savedPosition`).
  A click on submenu or sidebar starts at the top.

**Anchor (lists with detail):**

`utils/documentListFocus.ts` becomes `utils/listAnchor.ts`:

```ts
export interface ListAnchor { kind: string; id: number }
export function saveListAnchor(routeKey: string, anchor: ListAnchor): void
export function takeListAnchor(routeKey: string): ListAnchor | null   // reads and deletes
```

- When opening an entry the view saves the anchor (`kind` =
  `'document' | 'collection' | 'photo' | 'album' | 'transaction' | …`).
- On return: `PageLayout` waits for `ready`, calls
  `props.resolveAnchor?.(anchor)`. The view supplies either an
  `HTMLElement` (normal list) or an index (virtual list) or
  `null` (no longer present). Element: `scrollIntoView({ block: 'center' })`
  + `focus({ preventScroll: true })`. Index: `scrollToIndex(index, 'center')`
  on the grid, then focus the cell in the next frame. `null`: fallback
  to the stored offset.
- **Virtual, page-wise loaded lists** (gallery, documents): If the
  anchor is not in the data after the first load, the view loads
  further pages until the anchor is found or a limit of 5 pages
  is reached. Then fallback to offset. For the gallery with
  date grouping, the index is derived via `usePhotoGrouping` from the flat
  photo list, as today for `cursorIndex`.
- Focus visibility: rows and tiles are `tabindex="0"` with a shared
  focus ring (`:focus-visible { outline: 2px solid var(--p-primary-color);
  outline-offset: 2px }`) and the class `.scroll-anchor` (§1).
- Split view: the anchor there is the active row anyway
  (`activeListItem.ts`); `resolveAnchor` returns its element.

## 6. Multi-selection and basket

### Decision: selection bar and basket UI as shared components, domain stores remain

**Selection (transient, per view):**

- Composable `useListSelection<T>()` encapsulates `selectMode`, `selectedIds`,
  `useRangeSelect`, `toggle`, `selectAllLoaded`, `invert`, `clear`. Replaces the
  two local implementations in `GalleryView` and
  `AccountTransactionsView`.
- Component `SelectionBar` (slot `#selection` in `PageLayout`):
  `[n selected] [load/select all n] [Invert] [Clear] … [Actions ▾] [Add to basket]`.
  Desktop: replaces the toolbar row in the sticky stack as long as `selectMode`
  is active. Mobile: sticky at the bottom (`position: sticky; bottom: 0`), as today
  in the gallery.
- Gestures the same everywhere: toggle button in the toolbar, long press on touch,
  `Shift`+click range, `Ctrl/Cmd`+click single, `Ctrl/Cmd+A` all
  loaded, `Esc` ends the mode.
- Leaving the mode clears the transient selection, never the basket.
- Actions come as `ToolbarItem[]` from the view (same structure as
  `ResponsiveToolbar`), so that overflow and labeling are identical.

**Basket (persistent, per module):**

- `useTxSelectionStore` and `useDocSelectionStore` remain (domain aggregates
  such as sum). A new basket store for photos (`usePhotoSelectionStore`)
  comes in the last stage, when album batch actions are switched to it.
- `BasketIndicator.vue` replaces `TxBasketIndicator` and `DocBasketIndicator`:
  prop `store` (an object with `count`, `items`, `clear`, `remove`) and prop
  `to` (route of the basket view). Badge, tooltip, animation on adding
  identical.
- `BasketDrawer.vue`: list of the entries with remove button, footer with
  `Leeren` (clear), `Alle öffnen` (open all) and module-specific batch actions (slot).
  `DocumentsBasketView` and the finance basket use the same drawer.
- Basket navigation in detail views (prev/next within the basket)
  via a shared `useBasketNavigation(store, currentId)`.

## 7. Further rules

### Detail pages

- `PageLayout` with `#actions`: `[← Back] [◀ ▶ n/m] … [Edit] [More ▾]`.
- Back uses `useModuleBack` (exists). Prev/next in list uses the
  basket if present, otherwise the most recently loaded list (§5 anchor key).
- Edit mode: Save (primary) and Cancel (secondary) replace
  the actions on the right; form content stays in place.

### Dialogs

- Only PrimeVue `Dialog` and `ConfirmDialog`, no custom modals.
- Widths: `sm` 420px (confirmation, one field), `md` 640px (form),
  `lg` 960px (preview/table); `< md` always fullscreen (`:modal="true"`,
  `position="bottom"` with `max-height: 90dvh`).
- Footer: secondary/cancel on the left, primary on the right; destructive `severity="danger"`
  and always via `ConfirmDialog` with an explicit statement of what is deleted.
- `Esc` closes, Enter in the last field confirms, focus goes to the
  first field when opening.

### Buttons and icons

| Role | PrimeVue | Example |
| --- | --- | --- |
| Primary action of the page | `severity="primary"` filled | Upload, save |
| Secondary action | `severity="secondary" outlined` | Export |
| Toolbar icon | `text rounded` + `aria-label` + `v-tooltip` | Filter, sorting |
| Destructive | `severity="danger" outlined` | Delete |

Icon set exclusively PrimeIcons; custom icons (`pi-link-slash`) registered in
`style.css`.

### Typography

| Element | Size | Weight |
| --- | --- | --- |
| `h1` (page title) | 1.5rem, `< md` 1.25rem | 600 |
| `h2` (section) | 1.125rem | 600 |
| `h3` (card/panel) | 1rem | 600 |
| Body text | 0.9375rem | 400 |
| Caption/hint | 0.8125rem, `--p-text-muted-color` | 400 |

Views set no `font-size` on headings. Spacing only from
`--space-*`.

### Breakpoints

| Name | Query | Behavior |
| --- | --- | --- |
| `sm` | `< 640px` | Toolbar two rows, dialogs fullscreen, selection bar at the bottom, 2 grid columns |
| `md` | `640–1023px` | Toolbar single row with overflow, sidebar as drawer |
| `lg` | `≥ 1024px` | Sidebar inline, 4+ grid columns |
| `split` | `≥ 1300px` + landscape | Split view (existing, `useSplitView`) |

As CSS custom media in `style.css` and as constants in
`composables/useBreakpoint.ts`, so that CSS and JS do not drift apart
(same principle as `SPLIT_VIEW_MEDIA_QUERY`).

### Dark mode, focus, transitions

- Audit script `scripts/check-css-tokens.mjs`: fails on
  `--p-surface-*`, hex colors and `rgb(` without `rgba(` in `*.vue`; runs
  in the pre-commit hook.
- Focus ring global as in §5; `outline: none` in views forbidden.
- One route transition (`fade`, 120 ms) in `App.vue`, one overlay transition
  (PrimeVue default). View-specific `<Transition>` only for content elements.

## 8. Stages

Each stage is a sub-issue of #1272 and its own PR. The order is
binding, because each stage builds on the previous one.

| No. | Stage | Delivers | Done when |
| --- | --- | --- | --- |
| 1 | Foundation | Tokens, `PageLayout`, `ScrollX`, overflow guard, submenu row, `--app-stack-height`, width check in the test runner | Two pilot views (`DocumentsView`, `AccountTransactionsView`) on `PageLayout`; no horizontal scrolling at 360px in all stories |
| 2 | All views on `PageLayout` | Remaining ~60 views, view-specific sticky code deleted, `AdminPage` as wrapper | `grep "position: sticky" src/views` yields only selection bars |
| 3 | Toolbar contract | `useListToolbar`, `ListToolbar`, generic `FilterChips`, `EmptyState`, `PageSkeleton`, `ErrorBanner` | All list views show chips, result count and a shared empty state; search/filter/sort only in URL |
| 4 | Navigation memory | Router `scrollBehavior`, `ready` prop, `listAnchor`, `resolveAnchor` in all lists | Back from detail lands on the opened row/tile (Storybook interaction test per list) |
| 5 | Selection and basket | `useListSelection`, `SelectionBar`, `BasketIndicator`, `BasketDrawer`, `useBasketNavigation` | Gallery, documents, finance with identical bar and identical basket |
| 6 | Polish | Detail actions, dialog sizes, button roles, typography, breakpoints, token audit script, route transition | Audit script green; Storybook screenshots updated per page state |

Tests: Each stage keeps `npm run test` (backend and frontend) green and
adds stories for new components. Screenshot comparison before/after each
stage in the PR.

## 9. Open points

- ~~Whether photos get a basket of their own~~ — **decided (stage 5): no.**
  The photo actions (albums, collage, sharing, curation) all work on
  the selection that is currently visible; a persistent basket only pays off
  when you gather photos from several albums, and there is so far
  no way for that in the UI. The selection bar now provides everything
  the dialogs need. If the cross-album case comes, `useSelection` with a `storageKey` is
  all that is missing.
- `SharedAlbumView` (without login) uses `PageLayout` without a submenu; whether the
  navbar appears there at all will be decided in stage 2.
