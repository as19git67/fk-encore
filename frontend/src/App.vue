<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import Button from 'primevue/button'
import Menu from 'primevue/menu'
import ConfirmDialog from 'primevue/confirmdialog'
import TxBasketIndicator from './components/finance/TxBasketIndicator.vue'
import { useAuthStore } from './stores/auth'
import { useAnomalyStore } from './stores/finance/anomalies'
import { useFeedBadgeStore } from './stores/feedBadge'
import { modules, detectModule, moduleEntryPath } from './config/modules'
import type { ModuleConfig } from './config/modules'

const auth = useAuthStore()
const anomalyStore = useAnomalyStore()
const feedBadgeStore = useFeedBadgeStore()
const router = useRouter()
const route = useRoute()

feedBadgeStore.init()

watch(
  () => auth.isAuthenticated,
  (authenticated) => {
    if (authenticated && auth.hasPermission('finance.view')) {
      void anomalyStore.refresh()
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
}

// ── Sub-menu items for the active module ─────────────────────────────────────
// Items may be plain links or a group (e.g. the Dokumente "Einstellungen"
// gear) that opens a popup with `children`. Groups whose children are all
// permission-filtered away are dropped entirely.
const subMenuItems = computed(() => {
  if (!activeModule.value) return []
  return activeModule.value.menuItems
    .filter((item) => !item.permission || auth.hasPermission(item.permission))
    .map((item) => {
      const children = item.children
        ?.filter((c) => !c.permission || auth.hasPermission(c.permission))
        .map((c) => ({ label: c.label, icon: c.icon, routeName: c.routeName }))
      return {
        label: item.label,
        icon: item.icon,
        routeName: item.routeName,
        children: children && children.length ? children : undefined,
        badge:
          item.routeName === 'finance-anomalies' && anomalyStore.count > 0
            ? String(anomalyStore.count)
            : item.routeName === 'fotos-feed' && feedBadgeStore.count > 0
              ? String(feedBadgeStore.count)
              : undefined,
      }
    })
    .filter((item) => item.routeName || item.children)
})

// Shared popup for submenu groups. The model is rebuilt on each open so a
// single <Menu> can back every group in the strip.
const groupMenuRef = ref()
const groupMenuModel = ref<Array<Record<string, unknown>>>([])

function openGroupMenu(
  event: Event,
  children: Array<{ label: string; icon: string; routeName?: string }>,
) {
  groupMenuModel.value = children.map((c) => ({
    label: c.label,
    icon: c.icon,
    command: () => {
      if (c.routeName) router.push({ name: c.routeName })
    },
  }))
  groupMenuRef.value?.toggle(event)
}

/** A group is "active" when the current route is one of its children. */
function isGroupActive(children?: Array<{ routeName?: string }>): boolean {
  return !!children?.some((c) => c.routeName && c.routeName === route.name)
}

async function handleLogout() {
  await auth.logout()
  router.push('/login')
}
</script>

<template>
  <div class="app-container">
    <nav v-if="auth.isAuthenticated" class="sticky-navbar">
      <!-- Left: hamburger + active module sub-menu -->
      <div class="navbar-start">
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

        <!-- Sub-menu items shown inline when inside a module -->
        <div v-if="activeModule && subMenuItems.length" class="submenu-strip">
          <template v-for="item in subMenuItems" :key="item.routeName || item.label">
            <!-- Group header (e.g. the Dokumente "Einstellungen" gear) -->
            <Button
              v-if="item.children"
              :label="item.label"
              :icon="item.icon"
              text
              size="small"
              :severity="isGroupActive(item.children) ? 'primary' : 'secondary'"
              :class="{ 'submenu-item--active': isGroupActive(item.children) }"
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
              :class="{ 'submenu-item--active': route.name === item.routeName }"
              @click="item.routeName && router.push({ name: item.routeName })"
            />
          </template>
          <Menu ref="groupMenuRef" :model="groupMenuModel" :popup="true" />
        </div>
      </div>

      <!-- Right: profile + logout (icons only) -->
      <div class="navbar-end">
        <TxBasketIndicator v-if="activeModule?.id === 'finanzen'" />
        <Button
          icon="pi pi-user"
          severity="secondary"
          text
          rounded
          aria-label="Profil"
          v-tooltip.bottom="'Profil'"
          @click="router.push('/profile')"
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

    <main class="content">
      <router-view />
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
  --menubar-height: 3.5rem;
}

/* ── Sticky navbar ──────────────────────────────────────────────────────────── */
.sticky-navbar {
  position: sticky;
  top: 0;
  z-index: 1100;
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: var(--menubar-height);
  padding: 0 0.5rem;
  background: var(--p-content-background);
  border-bottom: 1px solid var(--p-content-border-color);
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.06);
}

.navbar-start {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  min-width: 0;
  overflow: hidden;
}

.navbar-end {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  flex-shrink: 0;
}

/* ── Inline sub-menu strip ──────────────────────────────────────────────────── */
.submenu-strip {
  display: flex;
  align-items: center;
  gap: 0.1rem;
  overflow-x: auto;
  scrollbar-width: none;
  padding-left: 0.25rem;
  border-left: 1px solid var(--p-content-border-color);
  margin-left: 0.25rem;
}

.submenu-strip::-webkit-scrollbar {
  display: none;
}

/* Active submenu item gets a stronger visual */
.submenu-item--active {
  font-weight: 600;
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
  margin: 0 auto;
  padding: 0;
}

/* On mobile (≤768 px) show only icons in the sub-menu strip */
@media (max-width: 768px) {
  .submenu-strip .p-button-label {
    display: none;
  }
  .submenu-strip .p-button {
    padding: 0.5rem;
  }
}
</style>
