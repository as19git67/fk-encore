<script setup lang="ts">
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import Menubar from 'primevue/menubar'
import Button from 'primevue/button'
import ConfirmDialog from 'primevue/confirmdialog'
import { useAuthStore } from './stores/auth'

const auth = useAuthStore()
const router = useRouter()

const menuItems = computed(() => {
  const items = []
  if (auth.hasPermission('photos.view')) {
    items.push({ label: 'Fotos', icon: 'pi pi-images', command: () => router.push('/photos') })
  }
  if (auth.hasPermission('people.view')) {
    items.push({ label: 'Personen', icon: 'pi pi-users', command: () => router.push('/people') })
    items.push({ label: 'Gruppen', icon: 'pi pi-th-large', command: () => router.push('/groups') })
  }
  if (auth.hasPermission('users.list')) {
    items.push({ label: 'Benutzer', icon: 'pi pi-users', command: () => router.push('/users') })
  }
  if (auth.hasPermission('roles.list')) {
    items.push({ label: 'Rollen', icon: 'pi pi-shield', command: () => router.push('/roles') })
  }
  return items
})

async function handleLogout() {
  await auth.logout()
  router.push('/login')
}
</script>

<template>
  <div class="app-container">
    <Menubar v-if="auth.isAuthenticated" :model="menuItems">
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
  background: var(--surface-ground);
  color: var(--text-color);
}

.app-container {
  min-height: 100vh;
}

.content {
  max-width: 960px;
  margin: 0 auto;
  padding: 2rem 1rem;
}

.menu-end {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.user-name {
  font-weight: 600;
}
</style>
