<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import Button from 'primevue/button'
import Menu from 'primevue/menu'
import ConfirmDialog from 'primevue/confirmdialog'
import { useAuthStore } from './stores/auth'
import { useAnomalyStore } from './stores/finance/anomalies'
import { modules, detectModule } from './config/modules'
import type { ModuleConfig } from './config/modules'

const auth = useAuthStore()
const anomalyStore = useAnomalyStore()
const router = useRouter()
const route = useRoute()

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
      command: () => router.push(mod.basePath),
    }))
)

function toggleHamburgerMenu(event: Event) {
  hamburgerMenuRef.value?.toggle(event)
}

// ── Sub-menu items for the active module ─────────────────────────────────────
const subMenuItems = computed(() => {
  if (!activeModule.value) return []
  return activeModule.value.menuItems
    .filter((item) => !item.permission || auth.hasPermission(item.permission))
    .map((item) => ({
      label: item.label,
      icon: item.icon,
      routeName: item.routeName,
      badge:
        item.routeName === 'finance-anomalies' && anomalyStore.count > 0
          ? String(anomalyStore.count)
          : undefined,
    }))
})

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
          <Button
            v-for="item in subMenuItems"
            :key="item.routeName"
            :label="item.label"
            :icon="item.icon"
            :badge="item.badge"
            text
            size="small"
            :severity="route.name === item.routeName ? 'primary' : 'secondary'"
            :class="{ 'submenu-item--active': route.name === item.routeName }"
            @click="router.push({ name: item.routeName })"
          />
        </div>
      </div>

      <!-- Right: profile + logout (icons only) -->
      <div class="navbar-end">
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
  min-height: 100vh;
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

/* On narrow viewports hide sub-menu item labels, showing only icons */
@media (max-width: 600px) {
  .submenu-strip :deep(.p-button-label) {
    display: none;
  }
  .submenu-strip :deep(.p-button) {
    padding: 0.5rem;
  }
}
</style>
