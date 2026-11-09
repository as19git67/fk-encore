<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted, onBeforeUnmount } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import Button from 'primevue/button'
import Menu from 'primevue/menu'
import ConfirmDialog from 'primevue/confirmdialog'
import TxBasketIndicator from './components/finance/TxBasketIndicator.vue'
import DocBasketIndicator from './components/documents/DocBasketIndicator.vue'
import SharedBasketIndicator from './components/collections/SharedBasketIndicator.vue'
import DocumentUploadDefaultsHost from './components/documents/DocumentUploadDefaultsHost.vue'
import { useModuleMenuActionsStore } from './stores/moduleMenuActions'
import { useBasketStore } from './stores/basket'
import { useAuthStore } from './stores/auth'
import { useAnomalyStore } from './stores/finance/anomalies'
import { useAccountsStore } from './stores/finance/accounts'
import { useMeterAnomalyStore } from './stores/meterAnomalies'
import { useFeedBadgeStore } from './stores/feedBadge'
import { modules, detectModule, moduleEntryPath } from './config/modules'
import type { ModuleConfig, ModuleMenuItem } from './config/modules'
import { useReferenceData } from './composables/useReferenceData'
import { useAtLeast } from './composables/useBreakpoint'
import { submenuFitsNavbar } from './utils/navbarLayout'
import { usePhotoNavStore } from './stores/photoNav'
import { albumMenuTarget, albumsViewQueryFromStorage, readRememberedAlbumId } from './utils/albumsViewState'

const auth = useAuthStore()

// The basket lives on the server (#1548); load it once someone is signed in
// and forget it when they leave.
const basket = useBasketStore()
watch(
  () => auth.isAuthenticated,
  (signedIn) => {
    if (signedIn) void basket.load()
    else basket.reset()
  },
  { immediate: true },
)
const anomalyStore = useAnomalyStore()
// Kurse and Portfolio hide without a depot among the readable accounts.
const accountsStore = useAccountsStore()
const meterAnomalyStore = useMeterAnomalyStore()
const feedBadgeStore = useFeedBadgeStore()
const router = useRouter()
const route = useRoute()
const { fetchAlbums } = useReferenceData()
const photoNav = usePhotoNavStore()

feedBadgeStore.init()

watch(
  () => auth.isAuthenticated,
  (authenticated) => {
    if (authenticated && auth.hasPermission('finance.view')) {
      void anomalyStore.refresh()
      void accountsStore.ensureLoaded()
    }
    if (!authenticated) accountsStore.reset()
    if (authenticated && auth.hasPermission('meters.view')) {
      void meterAnomalyStore.refresh()
    }
  },
  { immediate: true },
)

watch(
  () => route.name,
  (_name, prev) => {
    if (prev === 'finance-anomalies' && auth.hasPermission('finance.view')) {
      void anomalyStore.refresh()
    }
    if (prev === 'zaehler-anomalien' && auth.hasPermission('meters.view')) {
      void meterAnomalyStore.refresh()
    }
  },
)

const activeModule = computed<ModuleConfig | null>(() => detectModule(route.path))

// ── Hamburger module menu ────────────────────────────────────────────────────
const hamburgerMenuRef = ref()

const moduleMenuItems = computed(() =>
  modules
    .filter((mod) => !mod.permission || auth.hasPermission(mod.permission))
    .map((mod) => ({
      label: mod.label,
      icon: mod.icon,
      class: activeModule.value?.id === mod.id ? 'active-module-item' : '',
      command: () => router.push(moduleEntryPath(mod)),
    }))
)

function toggleHamburgerMenu(event: Event) {
  hamburgerMenuRef.value?.toggle(event)
  // Opening the switcher is a strong navigation signal. Start loading the
  // remembered entry chunk for every visible module after the popup has
  // painted, so the eventual menu click does not appear to do nothing while
  // Vite downloads a lazy route for the first time.
  window.setTimeout(() => {
    for (const mod of modules) {
      if (!mod.permission || auth.hasPermission(mod.permission)) {
        prefetchLocation(moduleEntryPath(mod))
      }
    }
  }, 0)
}

// ── Sub-menu items for the active module ─────────────────────────────────────
// Items may be plain links or a group (e.g. the Dokumente "Einstellungen"
// gear) that opens a popup with `children`. Groups whose children are all
// permission-filtered away are dropped entirely.
const menuActions = useModuleMenuActionsStore()

function itemAllowed(item: ModuleMenuItem) {
  if (item.permission && !auth.hasPermission(item.permission)) return false
  return !item.requiresDepot || accountsStore.hasDepot
}

function visibleItems(items: ModuleMenuItem[]) {
  return items
    .filter(itemAllowed)
    .map((item) => {
      const children = item.children
        ?.filter(itemAllowed)
        .map((c) => ({ label: c.label, icon: c.icon, routeName: c.routeName, action: c.action }))
      return {
        label: item.label,
        icon: item.icon,
        routeName: item.routeName,
        settings: item.settings,
        primary: item.primary,
        children: children && children.length ? children : undefined,
        badge:
          item.routeName === 'finance-anomalies' && anomalyStore.count > 0
            ? String(anomalyStore.count)
            : item.routeName === 'fotos-feed' && feedBadgeStore.count > 0
              ? String(feedBadgeStore.count)
              : item.routeName === 'zaehler-anomalien' && meterAnomalyStore.count > 0
                ? String(meterAnomalyStore.count)
                : undefined,
      }
    })
    .filter((item) => item.routeName || item.children)
}

const subMenuItems = computed(() => (activeModule.value ? visibleItems(activeModule.value.menuItems) : []))

// What holds on every page of the module (upload, help): at the right end of
// the sub-menu row, outside its scroller.
const actionItems = computed(() =>
  activeModule.value?.actionItems ? visibleItems(activeModule.value.actionItems) : [],
)

// A module's settings group is lifted out of the submenu strip and rendered
// as a gear among the meta icons in navbar-end. The group marked `settings`
// becomes that module's gear; other groups (Finanzen › Steuer) stay in the
// strip. The gear is always there: below the module's settings it carries
// the own profile (see settingsMenuItems).
const settingsGroup = computed(() => subMenuItems.value.find((item) => item.settings && item.children))
const stripItems = computed(() =>
  settingsGroup.value
    ? subMenuItems.value.filter((item) => item !== settingsGroup.value)
    : subMenuItems.value,
)

// The gear holds the module's settings (filtered by permission as above) and,
// below them, the own profile, which every signed-in user has. So the gear
// is there in every module, also in those without settings of their own.
interface MenuEntry {
  label: string
  icon: string
  routeName?: string
  /** Opens something in place (see `ModuleMenuItem.action`). */
  action?: string
  separator?: boolean
}
const settingsMenuItems = computed<MenuEntry[]>(() => [
  ...(settingsGroup.value?.children ?? []),
  ...(settingsGroup.value?.children ? [{ label: '', icon: '', separator: true }] : []),
  { label: 'Mein Profil', icon: 'pi pi-user', routeName: 'profile' },
])
const settingsActive = computed(() => isGroupActive(settingsMenuItems.value))
/** An entry of the gear that needs attention (a default that no longer holds). */
const settingsWarn = computed(() =>
  settingsMenuItems.value.some((c) => c.action && menuActions.warn[c.action]),
)

// Mirrors the server's rule (collections/members.ts): collections are open to
// whoever can use at least one type that goes into them.
const mayUseCollections = computed(
  () =>
    (auth.hasPermission('module.documents') && auth.hasPermission('documents.view')) ||
    (auth.hasPermission('module.photos') && auth.hasPermission('photos.view')) ||
    auth.hasPermission('finance.view') ||
    auth.hasPermission('meters.view'),
)

// Shared popup for submenu groups. The model is rebuilt on each open so a
// single <Menu> can back every group in the strip.
const groupMenuRef = ref()
const groupMenuModel = ref<Array<Record<string, unknown>>>([])

function openGroupMenu(
  event: Event,
  children: MenuEntry[],
) {
  groupMenuModel.value = children.map((c) =>
    c.separator
      ? { separator: true }
      : {
          label: c.action && menuActions.warn[c.action] ? `${c.label} (prüfen)` : c.label,
          icon: c.action && menuActions.warn[c.action] ? 'pi pi-exclamation-triangle' : c.icon,
          command: () => {
            if (c.action) menuActions.request(c.action)
            else if (c.routeName) router.push({ name: c.routeName })
          },
        },
  )
  groupMenuRef.value?.toggle(event)
}

/** A group is "active" when the current route is one of its children. */
function isGroupActive(children?: Array<{ routeName?: string }>): boolean {
  return !!children?.some((c) => c.routeName && c.routeName === route.name)
}

function navigateSubMenu(routeName?: string) {
  if (!routeName) return
  if (routeName === 'fotos-albums') {
    const target = albumMenuTarget(route.name, readRememberedAlbumId())
    if (target.name === 'fotos-albums') {
      // Selecting the album toolbar item from an album explicitly means
      // "show the list". Drop the one-shot auto-jump armed by focusing a
      // photo; otherwise AlbumsView immediately reopens the same album and
      // makes this navigation look like a reload.
      photoNav.consumeAlbumJump()
      void router.push({ ...target, query: albumsViewQueryFromStorage() })
    } else {
      void router.push(target)
    }
    return
  }
  void router.push({ name: routeName })
}

function prefetchLocation(location: string | { name: string }) {
  const resolved = router.resolve(location)
  for (const record of resolved.matched) {
    for (const component of Object.values(record.components ?? {})) {
      if (typeof component !== 'function') continue
      try {
        void Promise.resolve((component as () => unknown)()).catch(() => { /* navigation reports failures */ })
      } catch { /* navigation reports failures */ }
    }
  }
  if (resolved.path.startsWith('/fotos/alben')) {
    void fetchAlbums().catch(() => { /* regular view loading reports errors */ })
  }
}

function prefetchSubMenu(routeName?: string) {
  if (routeName !== 'fotos-albums') return
  // Warm both the lazy route chunk and the shared request cache while the
  // pointer/finger approaches the album button. AlbumsView then paints from
  // the same in-flight promise instead of starting a second request.
  prefetchLocation({ name: routeName })
}

async function handleLogout() {
  basket.reset()
  await auth.logout()
  router.push('/login')
}

// ── Sticky stack height ──────────────────────────────────────────────────────
// Navbar, submenu row and whatever the active view lifted into
// #module-subheaders form one sticky block. Its height is measured here and
// published as `--app-stack-height`, so no view computes a `top:` or a
// `calc(100dvh - …)` of its own.
const appContainerRef = ref<HTMLElement | null>(null)
const toolbarStackRef = ref<HTMLElement | null>(null)
let stackObserver: ResizeObserver | null = null

function publishStackHeight() {
  const container = appContainerRef.value
  if (!container) return
  const height = toolbarStackRef.value?.getBoundingClientRect().height ?? 0
  const value = `${Math.round(height)}px`
  container.style.setProperty('--app-stack-height', value)
  // Also on <html>, where a virtual grid reads it (`usePageVirtualizer`) and
  // the page content's `scroll-margin-top` keeps whatever the browser scrolls
  // into view (focus, `scrollIntoView`) clear of the stack.
  document.documentElement.style.setProperty('--app-stack-height', value)
}

function observeStack() {
  stackObserver?.disconnect()
  stackObserver = null
  publishStackHeight()
  if (typeof ResizeObserver === 'undefined' || !toolbarStackRef.value) return
  stackObserver = new ResizeObserver(publishStackHeight)
  stackObserver.observe(toolbarStackRef.value)
}

onMounted(observeStack)
// The stack mounts and unmounts with the session (v-if on isAuthenticated).
watch(toolbarStackRef, observeStack)
onBeforeUnmount(() => stackObserver?.disconnect())

// ── Sub-menu in the navbar (wide screens) ─────────────────────────────────────
// From `xl` on the sub-menu moves up into the navbar's empty middle when all
// of it fits there, so a wide screen spends one row on the app's menus instead
// of two. A module whose menu does not fit keeps its own row. The menu itself
// is rendered once and teleported to whichever place applies.
const navbarRef = ref<HTMLElement | null>(null)
const navbarStartRef = ref<HTMLElement | null>(null)
const navbarEndRef = ref<HTMLElement | null>(null)
const submenuRef = ref<HTMLElement | null>(null)
const wideScreen = useAtLeast('xl')
const submenuInline = ref(false)
let navbarObserver: ResizeObserver | null = null

/** The sub-menu's width with every entry at its natural size, wherever it sits. */
function submenuContentWidth(menu: HTMLElement): number {
  const strip = menu.querySelector<HTMLElement>('.submenu-strip')
  const actions = menu.querySelector<HTMLElement>('.submenu-actions')
  let width = 0
  const items = strip ? Array.from(strip.children) as HTMLElement[] : []
  const first = items[0]
  const last = items[items.length - 1]
  if (first && last) width += last.getBoundingClientRect().right - first.getBoundingClientRect().left
  if (actions) width += actions.getBoundingClientRect().width
  return width
}

function measureSubmenu() {
  const navbar = navbarRef.value
  const menu = submenuRef.value
  if (!wideScreen.value || !navbar || !menu) {
    submenuInline.value = false
    return
  }
  const style = getComputedStyle(navbar)
  const padding = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight)
  submenuInline.value = submenuFitsNavbar({
    navbar: navbar.clientWidth - padding,
    start: navbarStartRef.value?.getBoundingClientRect().width ?? 0,
    end: navbarEndRef.value?.getBoundingClientRect().width ?? 0,
    content: submenuContentWidth(menu),
  })
}

function observeNavbar() {
  navbarObserver?.disconnect()
  navbarObserver = null
  if (typeof ResizeObserver === 'undefined' || !navbarRef.value) return
  navbarObserver = new ResizeObserver(measureSubmenu)
  navbarObserver.observe(navbarRef.value)
}

onMounted(() => {
  observeNavbar()
  measureSubmenu()
  // Web fonts change the entries' widths once they arrive.
  document.fonts?.ready.then(measureSubmenu).catch(() => {})
})
watch(navbarRef, observeNavbar)
watch(
  [wideScreen, stripItems, actionItems, submenuRef],
  () => nextTick(measureSubmenu),
  { deep: true },
)
onBeforeUnmount(() => navbarObserver?.disconnect())
</script>

<template>
  <div ref="appContainerRef" class="app-container">
    <div v-if="auth.isAuthenticated" ref="toolbarStackRef" class="app-toolbar-stack">
      <!-- Row 1: main menu. Left: module switcher + active module; right: meta icons. -->
      <nav ref="navbarRef" class="sticky-navbar app-navbar" aria-label="Hauptmenü">
        <div ref="navbarStartRef" class="navbar-start">
          <Button
            icon="pi pi-bars"
            severity="secondary"
            text
            rounded
            aria-label="Hauptmenü"
            v-tooltip.bottom="'Module'"
            @click="toggleHamburgerMenu"
          />
          <Menu ref="hamburgerMenuRef" :model="moduleMenuItems" :popup="true" />
          <span v-if="activeModule" class="navbar-module" data-testid="navbar-module">
            <i :class="activeModule.icon" aria-hidden="true" />
            <span class="navbar-module-label">{{ activeModule.label }}</span>
          </span>
        </div>

        <!-- Wide screens: the sub-menu, teleported here when it fits (see
             `submenuInline`). -->
        <div id="app-navbar-submenu" class="navbar-submenu" />

        <div ref="navbarEndRef" class="navbar-end">
          <!-- The assistant (#1528), reachable from every module. -->
          <Button
            v-if="auth.hasPermission('module.assistant')"
            v-tooltip.bottom="'Assistent'"
            icon="pi pi-comments"
            :severity="activeModule?.id === 'assistent' ? 'primary' : 'secondary'"
            text
            rounded
            aria-label="Assistent"
            data-testid="navbar-assistant"
            @click="router.push({ name: 'assistent' })"
          />
          <!-- The basket, and through its drawer every collection (#1548).
               Only for someone with a module that can file things at all. -->
          <template v-if="mayUseCollections">
            <DocBasketIndicator v-if="activeModule?.id === 'dokumente'" />
            <TxBasketIndicator v-else-if="activeModule?.id === 'finanzen'" />
            <SharedBasketIndicator v-else />
          </template>
          <!-- Settings: the active module's group, then the own profile.
               Every module has one, since everyone has a profile. -->
          <Button
            :icon="settingsGroup?.icon ?? 'pi pi-cog'"
            text
            rounded
            :severity="settingsWarn ? 'warn' : settingsActive ? 'primary' : 'secondary'"
            :badge="settingsWarn ? '!' : undefined"
            badge-severity="warn"
            :aria-label="settingsWarn ? 'Einstellungen – eine Einstellung braucht Aufmerksamkeit' : 'Einstellungen'"
            aria-haspopup="true"
            v-tooltip.bottom="'Einstellungen'"
            data-testid="navbar-settings"
            @click="openGroupMenu($event, settingsMenuItems)"
          />
          <Button
            icon="pi pi-sign-out"
            severity="secondary"
            text
            rounded
            aria-label="Abmelden"
            v-tooltip.bottom="'Abmelden'"
            @click="handleLogout"
          />
        </div>
      </nav>

      <!-- Row 2: the active module's sub-menu. Always one row of fixed height;
           it scrolls sideways inside itself on a narrow screen, never the page.
           From `xl` on it moves up into the navbar when all of it fits there,
           and this row disappears. -->
      <div id="app-submenu-row" class="app-submenu-row" />
      <Teleport defer :to="submenuInline ? '#app-navbar-submenu' : '#app-submenu-row'">
      <nav
        v-if="activeModule && (stripItems.length || actionItems.length)"
        ref="submenuRef"
        class="app-submenu"
        :class="{ 'app-submenu--inline': submenuInline }"
        data-testid="app-submenu"
        :aria-label="`Untermenü ${activeModule.label}`"
      >
        <div class="submenu-strip">
          <template v-for="item in stripItems" :key="item.routeName || item.label">
            <!-- Group header (a submenu that opens a popup) -->
            <Button
              v-if="item.children"
              :label="item.label"
              :icon="item.icon"
              text
              size="small"
              :severity="isGroupActive(item.children) ? 'primary' : 'secondary'"
              class="submenu-item"
              :class="{ 'submenu-item--active': isGroupActive(item.children) }"
              :aria-label="item.label"
              v-tooltip.bottom="item.label"
              @click="openGroupMenu($event, item.children)"
            />
            <!-- Plain link -->
            <Button
              v-else
              :label="item.label"
              :icon="item.icon"
              :badge="item.badge"
              text
              size="small"
              :severity="route.name === item.routeName ? 'primary' : 'secondary'"
              class="submenu-item"
              :class="{ 'submenu-item--active': route.name === item.routeName }"
              :aria-current="route.name === item.routeName ? 'page' : undefined"
              :aria-label="item.label"
              v-tooltip.bottom="item.label"
              @pointerenter="prefetchSubMenu(item.routeName)"
              @focus="prefetchSubMenu(item.routeName)"
              @click="navigateSubMenu(item.routeName)"
            />
          </template>
        </div>
        <div v-if="actionItems.length" class="submenu-actions" data-testid="app-submenu-actions">
          <Button
            v-for="item in actionItems"
            :key="item.routeName || item.label"
            :label="item.label"
            :icon="item.icon"
            size="small"
            :text="!item.primary"
            :severity="item.primary ? 'primary' : route.name === item.routeName ? 'primary' : 'secondary'"
            class="submenu-action"
            :class="{ 'submenu-action--primary': item.primary }"
            :aria-label="item.label"
            :aria-haspopup="item.children ? 'true' : undefined"
            :aria-current="route.name === item.routeName ? 'page' : undefined"
            v-tooltip.bottom="item.children ? undefined : item.label"
            @click="item.children ? openGroupMenu($event, item.children) : navigateSubMenu(item.routeName)"
          />
        </div>
      </nav>
      </Teleport>
      <DocumentUploadDefaultsHost v-if="activeModule?.id === 'dokumente' && auth.hasPermission('documents.upload')" />
      <Menu ref="groupMenuRef" :model="groupMenuModel" :popup="true" />

      <!-- Row 3: what the active view lifts up here through PageLayout
           (toolbar, notices, selection bar). One stack, no competing offsets. -->
      <div id="module-subheaders" class="module-subheaders" data-testid="module-subheaders" />
    </div>

    <main class="content">
      <!-- The app's one route transition (issue #1281): a 120ms cross-fade,
           `out-in` so only one page exists at a time — two would each teleport
           a toolbar into the sticky stack, and the incoming one would restore
           its scroll position against the outgoing one's height. -->
      <router-view v-slot="{ Component, route }">
        <Transition name="route-fade" mode="out-in">
          <component :is="Component" :key="route.path" />
        </Transition>
      </router-view>
    </main>
    <ConfirmDialog />
  </div>
</template>

<style>
body {
  margin: 0;
  font-family: var(--font-family);
  background: var(--p-content-hover-background);
  color: var(--p-text-color);
}

.app-container {
  /* `100dvh` follows the dynamic viewport (mobile URL bar collapse/expand).
     `100vh` resolves to the *large* viewport height, so on mobile it forced
     the container taller than the visible area — the whole document then
     scrolled a little, dragging each view's subheader up under the sticky
     navbar. Views that need to scroll their own content use min-height as a
     floor and grow beyond the viewport as before. */
  min-height: 100dvh;
  min-width: 0;
}

/* ── Sticky application toolbar stack ─────────────────────────────────────── */
.app-toolbar-stack {
  position: sticky;
  top: 0;
  z-index: 1100;
  background: var(--p-content-hover-background);
}

.sticky-navbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: var(--app-navbar-height);
  padding: 0 0.5rem;
  background: var(--p-content-background);
  border-bottom: 1px solid var(--p-content-border-color);
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.06);
}

.module-subheaders {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  padding: 0.5rem 1rem;
  border-bottom: 1px solid var(--p-content-border-color);
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.04);
}

.module-subheaders:empty {
  display: none;
}

/* A detail page's title row is made of buttons that bring their own height;
   padding above and below it only costs the content room (PageLayout keeps
   a little below whatever follows the title row). */
.module-subheaders:has(> .page-stack > .page-header--sticky:first-child) {
  padding-block: 0;
}

.navbar-start {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  min-width: 0;
  /* No `overflow: hidden` here: it cut the hamburger's focus ring off on the
     left and at the top. The module label truncates itself — the ellipsis
     comes from its own `overflow`, not from this one. */
}

.navbar-end {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  flex-shrink: 0;
}

.navbar-module {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  min-width: 0;
  padding-left: 0.25rem;
  font-weight: 600;
  color: var(--p-text-color);
}
.navbar-module-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ── Sub-menu row ───────────────────────────────────────────────────────────── */
.app-submenu-row {
  height: var(--app-submenu-height);
  padding: 0 0.5rem;
  background: var(--p-content-background);
  border-bottom: 1px solid var(--p-content-border-color);
}
.app-submenu-row:empty {
  display: none;
}
.app-submenu {
  height: 100%;
  display: flex;
  align-items: stretch;
  min-width: 0;
}

/* In the navbar: between the module name and the meta icons, as tall as the
   navbar, so the active entry's underline sits on its bottom edge. */
.navbar-submenu {
  align-self: stretch;
  display: flex;
  flex: 1 1 auto;
  min-width: 0;
  margin-inline: 1rem;
}
.navbar-submenu:empty {
  display: none;
}
.app-submenu--inline {
  flex: 1 1 auto;
}

.submenu-strip {
  display: flex;
  align-items: stretch;
  gap: 0.1rem;
  min-width: 0;
  flex: 1 1 auto;
  overflow-x: auto;
  scrollbar-width: none;
  /* The items are as tall as this strip and the first one starts at its
     left edge, so their focus rings fall exactly where the scroller clips.
     Room on every side, pulled back off the outside. */
  padding: var(--focus-ring-reach);
  margin: calc(-1 * var(--focus-ring-reach));
}

.submenu-strip::-webkit-scrollbar {
  display: none;
}

.submenu-actions {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  flex: 0 0 auto;
  padding-left: var(--space-2);
}

.submenu-item {
  position: relative;
  flex-shrink: 0;
  border-radius: 0;
}

/* The current page: an underline in the primary colour, not bold text, so
   the row does not shift width when the selection moves. */
.submenu-item--active::after {
  content: '';
  position: absolute;
  left: 0.5rem;
  right: 0.5rem;
  bottom: 0;
  height: 2px;
  border-radius: 1px;
  background: var(--p-primary-color);
}

/* Ensure PrimeVue popup menu appears above everything */
.p-menu.p-component {
  z-index: 1200;
}

/* Highlight the currently active module in the hamburger popup */
.p-menu .active-module-item .p-menuitem-link {
  background: var(--p-primary-50, rgba(66, 133, 244, 0.08));
  color: var(--p-primary-color);
  font-weight: 600;
}

.content {
  position: relative;
  z-index: 0;
  max-width: none;
  min-width: 0;
  margin: 0 auto;
  padding: 0;
}

@media (max-width: 767px) {
  .module-subheaders {
    padding: 0.5rem;
  }
  .submenu-strip .p-button {
    padding: 0.4rem 0.6rem;
  }
}

/* Below sm — a phone held upright — the sub-menu drops to icons so the whole
   module fits one row without scrolling sideways. The name of each entry
   stays in `aria-label` and in the tooltip, so nothing is lost to a screen
   reader or to a long press. The module name in the navbar above stays
   written out: it is the one label that says where you are. */
@media (max-width: 639px) {
  .submenu-item .p-button-label,
  .submenu-action .p-button-label {
    display: none;
  }
  .submenu-item .p-button-icon,
  .submenu-action .p-button-icon {
    margin: 0;
  }
  .submenu-strip .p-button {
    padding: 0.4rem 0.75rem;
  }
}
</style>
