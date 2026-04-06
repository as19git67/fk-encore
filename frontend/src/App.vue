<script setup lang="ts">
import { computed } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import Menubar from 'primevue/menubar'
import Button from 'primevue/button'
import ConfirmDialog from 'primevue/confirmdialog'
import { useAuthStore } from './stores/auth'
import { modules, detectModule } from './config/modules'
import type { ModuleConfig } from './config/modules'

const auth = useAuthStore()
const router = useRouter()
const route = useRoute()

/** Active module based on current path, null = all modules mode */
const activeModule = computed<ModuleConfig | null>(() => detectModule(route.path))

/** Build menu items for a single module (flat list) */
function buildModuleMenuItems(mod: ModuleConfig) {
  return mod.menuItems
    .filter((item) => !item.permission || auth.hasPermission(item.permission))
    .map((item) => ({
      label: item.label,
      icon: item.icon,
      command: () => router.push({ name: item.routeName }),
    }))
}

/** Menu items: single module = flat, all modules = grouped with submenus */
const menuItems = computed(() => {
  if (activeModule.value) {
    return buildModuleMenuItems(activeModule.value)
  }

  // All-modules mode: grouped menu with submenus
  return modules
    .filter((mod) => !mod.permission || auth.hasPermission(mod.permission))
    .map((mod) => ({
      label: mod.label,
      icon: mod.icon,
      items: buildModuleMenuItems(mod),
    }))
})

/** Module switcher items (shown in single-module mode to jump to other modules) */
const otherModules = computed(() =>
  modules
    .filter((mod) => mod.id !== activeModule.value?.id)
    .filter((mod) => !mod.permission || auth.hasPermission(mod.permission)),
)

async function handleLogout() {
  await auth.logout()
  router.push('/login')
}
</script>

<template>
  <div class="app-container">
    <Menubar v-if="auth.isAuthenticated" :model="menuItems" class="sticky-menubar">
      <template #start>
        <div v-if="activeModule" class="module-switcher">
          <Button
            v-for="mod in otherModules"
            :key="mod.id"
            :icon="mod.icon"
            :aria-label="mod.label"
            v-tooltip.bottom="mod.label"
            severity="secondary"
            text
            rounded
            size="small"
            @click="router.push(mod.basePath)"
          />
        </div>
      </template>
      <template #end>
        <div class="menu-end">
          <span class="user-name">{{ auth.user?.name }}</span>
          <Button label="Profil" icon="pi pi-user" severity="secondary" text @click="router.push('/profile')" />
          <Button label="Abmelden" icon="pi pi-sign-out" severity="secondary" text @click="handleLogout" />
        </div>
      </template>
    </Menubar>
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

.sticky-menubar {
  position: sticky;
  top: 0;
  z-index: 1100;
}

.content {
  position: relative;
  z-index: 0;
  max-width: none;
  margin: 0 auto;
  padding: 0;
}

.module-switcher {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  margin-right: 0.5rem;
  padding-right: 0.5rem;
  border-right: 1px solid var(--p-content-border-color);
}

.menu-end {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.user-name {
  font-weight: 600;
}

/* Ensure PrimeVue mobile menubar dropdown appears above page content */
.sticky-menubar .p-menubar-root-list {
  z-index: 1100;
}

@media (max-width: 640px) {
  .user-name { display: none; }
  /* Nur Icons in der Menü-Leiste */
  .menu-end :deep(.p-button-label) { display: none; }
  .menu-end :deep(.p-button) { padding: 0.5rem; }
}
</style>
